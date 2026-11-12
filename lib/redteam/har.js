/**
 * HAR 导入（P3 方案 b）—— 把外部代理导出的 HAR 映射进 traffic_flow。
 *
 * 为什么有这个文件：
 *   内置 MITM 代理要装自签 CA、改浏览器代理，成本高；多数人手里已经有
 *   Burp / mitmproxy / Chrome DevTools 的抓包结果。这里只做「读 HAR → 落库」，
 *   不监听端口、不生成证书、不碰系统信任库。
 *
 * 与内置录制共用同一张表、同一套查询与绑定：
 *   traffic_search / traffic_get / traffic_blob / traffic_bind 对导入流量与
 *   录制流量一视同仁；靠 `source='har'` 区分来源。
 *
 * 幂等：flow_key = sha256('har' + idx + method + url + startedDateTime)，
 *   同一份 HAR 重复导入只会有第一次生效（INSERT OR IGNORE）。
 *
 * 零外部依赖：只用 node: 内置模块。
 */
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildRow, insertFlowRow, flowKeyOf, sha256Hex, blobsDirOf, blobRelPath,
} from './traffic.js'

/** 单方向 body 最多落盘多少字节；超出部分丢弃并在行上标 truncated。 */
export const HAR_MAX_BODY = 8 * 1024 * 1024

/** 把 HAR 的 [{name,value}] 头数组折成对象；重名用逗号合并（HTTP 语义）。 */
export function headerObject(list) {
  const out = {}
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.name) continue
    const key = String(item.name)
    const value = item.value === undefined || item.value === null ? '' : String(item.value)
    out[key] = Object.prototype.hasOwnProperty.call(out, key) ? out[key] + ', ' + value : value
  }
  return out
}

function findHeader(headers, name) {
  const want = String(name).toLowerCase()
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === want) return String(value)
  }
  return null
}

/** HAR content.text（可能 base64）→ Buffer。 */
function contentBuffer(content) {
  if (!content || typeof content.text !== 'string' || content.text === '') return null
  return content.encoding === 'base64'
    ? Buffer.from(content.text, 'base64')
    : Buffer.from(content.text, 'utf8')
}

/** 请求体：postData.text 优先，否则把 params 拼成 urlencoded。 */
function requestBuffer(postData) {
  if (!postData) return null
  if (typeof postData.text === 'string' && postData.text !== '') {
    return Buffer.from(postData.text, 'utf8')
  }
  if (Array.isArray(postData.params) && postData.params.length > 0) {
    const text = postData.params
      .filter((p) => p && p.name !== undefined)
      .map((p) => encodeURIComponent(String(p.name)) + '=' + encodeURIComponent(String(p.value === undefined ? '' : p.value)))
      .join('&')
    return Buffer.from(text, 'utf8')
  }
  return null
}

function capBody(buf, max) {
  if (!buf || buf.length === 0) return { buf: null, truncated: false }
  if (buf.length <= max) return { buf, truncated: false }
  return { buf: buf.subarray(0, max), truncated: true }
}

/** 解析 HAR 文本，返回 log.entries（非法输入抛错）。 */
export function parseHar(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('HAR 内容为空')
  let obj
  try {
    obj = JSON.parse(text)
  } catch (error) {
    throw new Error('HAR 不是合法 JSON：' + (error && error.message ? error.message : String(error)))
  }
  const entries = obj && obj.log && Array.isArray(obj.log.entries) ? obj.log.entries : null
  if (!entries) throw new Error('HAR 缺少 log.entries（不是浏览器/Charles/mitmproxy 导出的 HAR？）')
  return entries
}

function writeBlob(dir, buf) {
  const sha = sha256Hex(buf)
  const sub = join(blobsDirOf(dir), sha.slice(0, 2))
  const file = join(sub, sha)
  if (!existsSync(file)) {
    mkdirSync(sub, { recursive: true })
    writeFileSync(file, buf)
  }
  return { sha, rel: blobRelPath(sha) }
}

/**
 * 把 HAR 导入当前靶标库。
 *
 * @param db  - 靶标库句柄（DatabaseSync）
 * @param dir - 靶标目录（blob 落到 `<dir>/traffic/blobs/`）
 * @param text - HAR 原文
 * @param options - `{ engagementId, target, maxBody }`
 * @returns `{ ok, parsed, imported, dup_skipped, skipped, errors }`
 */
export function importHar(db, dir, text, options = {}) {
  if (!db) throw new Error('importHar 需要数据库句柄')
  const entries = parseHar(text)
  const maxBody = Number.isFinite(Number(options.maxBody)) && Number(options.maxBody) > 0
    ? Math.trunc(Number(options.maxBody))
    : HAR_MAX_BODY
  const engagementId = options.engagementId === undefined || options.engagementId === null ? '' : String(options.engagementId)
  const target = options.target === undefined || options.target === null ? '' : String(options.target)
  const result = { ok: true, parsed: entries.length, imported: 0, dup_skipped: 0, skipped: 0, errors: [] }

  for (let idx = 0; idx < entries.length; idx += 1) {
    const entry = entries[idx]
    try {
      const req = entry && entry.request
      if (!req || !req.url) { result.skipped += 1; continue }
      let url
      try { url = new URL(String(req.url)) } catch { result.skipped += 1; continue }

      const method = String(req.method || 'GET').toUpperCase()
      const startedAt = entry.startedDateTime || new Date().toISOString()
      const resp = entry.response || {}
      const reqHeaders = headerObject(req.headers)
      const respHeaders = headerObject(resp.headers)
      const reqCt = findHeader(reqHeaders, 'content-type')
      const respCt = (resp.content && resp.content.mimeType) || findHeader(respHeaders, 'content-type') || null

      const reqRaw = requestBuffer(req.postData)
      const respRaw = contentBuffer(resp.content)
      const reqCap = capBody(reqRaw, maxBody)
      const respCap = capBody(respRaw, maxBody)

      const row = buildRow({
        flow_key: flowKeyOf({ session_key: 'har', idx, method, url: String(req.url), started_at: startedAt }),
        method,
        url: String(req.url),
        host: url.host,
        scheme: url.protocol.replace(/:$/, ''),
        path: url.pathname + url.search,
        status: Number.isFinite(Number(resp.status)) ? Number(resp.status) : null,
        req_headers: reqHeaders,
        resp_headers: respHeaders,
        req_body: reqCap.buf,
        resp_body: respCap.buf,
        req_content_type: reqCt,
        resp_content_type: respCt,
        req_bytes: reqRaw ? reqRaw.length : 0,
        resp_bytes: respRaw ? respRaw.length : 0,
        req_truncated: reqCap.truncated,
        resp_truncated: respCap.truncated,
        started_at: startedAt,
        duration_ms: Number.isFinite(Number(entry.time)) ? Number(entry.time) : 0,
        tool: 'har',
        source: 'har',
        engagement_id: engagementId,
        target,
      })

      if (reqCap.buf && reqCap.buf.length > 0) {
        const blob = writeBlob(dir, reqCap.buf)
        row.req_body_sha256 = blob.sha
        row.req_body_file = blob.rel
      }
      if (respCap.buf && respCap.buf.length > 0) {
        const blob = writeBlob(dir, respCap.buf)
        row.resp_body_sha256 = blob.sha
        row.resp_body_file = blob.rel
      }

      if (insertFlowRow(db, row)) result.imported += 1
      else result.dup_skipped += 1
    } catch (error) {
      result.ok = false
      result.skipped += 1
      result.errors.push('entry[' + idx + ']：' + (error && error.message ? error.message : String(error)))
    }
  }
  return result
}

export default { parseHar, importHar, headerObject, HAR_MAX_BODY }
