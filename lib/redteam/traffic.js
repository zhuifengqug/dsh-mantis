/**
 * MITM 录制数据层（P3a）—— spool → assets.db 的幂等入库与查询。
 *
 * 为什么分两段：
 *   · 代理侧（{@link module:./proxy.js}）只把每条事务写成 `<spool>/flows.jsonl` 一行 + `<spool>/blobs/<sha256>`，
 *     不碰 SQLite：宿主进程里的 `DatabaseSync` 是唯一写者，跨进程直写会撞 SQLITE_BUSY；
 *   · 入库侧（本文件）逐行读 JSONL，靠 `flow_key` 做 `INSERT OR IGNORE`，把 blob 搬到
 *     `<靶标目录>/traffic/blobs/<前两位>/<sha256>`，消费掉的行归档进 `flows.jsonl.done`。
 * 幂等：同一份 spool 反复 ingest，行数不变、blob 只有一份。
 *
 * 零外部依赖：只用 node: 内置模块。
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** 单方向 body 在库里留的预览字符数；全文在 blob 文件里。 */
export const PREVIEW_MAX = 4096

/** 追加一行 JSONL 的默认文件名。 */
export const FLOW_FILE = 'flows.jsonl'
export const FLOW_DONE_FILE = 'flows.jsonl.done'

export function sha256Hex(value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 幂等键：sha256(session_key + idx + method + url + started_at)。
 * 加 idx 是为了同一毫秒内同一 URL 的并发请求不会互相覆盖。
 */
export function flowKeyOf(flow) {
  const parts = [
    String(flow.session_key || ''),
    String(flow.idx === undefined ? '' : flow.idx),
    String(flow.method || ''),
    String(flow.url || ''),
    String(flow.started_at || ''),
  ]
  return sha256Hex(parts.join('\n'))
}

/** 靶标目录下的流量根。 */
export function trafficDirOf(dir) {
  return join(String(dir), 'traffic')
}

/** blob 根（相对靶标目录为 `traffic/blobs`）。 */
export function blobsDirOf(dir) {
  return join(trafficDirOf(dir), 'blobs')
}

/** blob 在库里的相对路径（相对靶标目录）。 */
export function blobRelPath(sha) {
  const hex = String(sha || '')
  return 'traffic/blobs/' + hex.slice(0, 2) + '/' + hex
}

export function spoolPathsOf(spoolDir) {
  return {
    dir: String(spoolDir),
    flow: join(String(spoolDir), FLOW_FILE),
    done: join(String(spoolDir), FLOW_DONE_FILE),
    blobs: join(String(spoolDir), 'blobs'),
  }
}

/* ------------------------------------------------------------------ body 处理 */

const TEXTUAL_HINT = /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql|sqli?te)|image\/svg)/i

function looksTextual(buf, contentType) {
  if (TEXTUAL_HINT.test(String(contentType || ''))) return true
  const head = buf.subarray(0, Math.min(buf.length, 512))
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return false
  }
  return true
}

/** 预览文本：文本类解码成 UTF-8 截断，二进制返回 null（解析后的原文请走 traffic_blob）。 */
export function previewOf(buf, contentType) {
  if (!buf || buf.length === 0) return null
  if (!looksTextual(buf, contentType)) return null
  const text = buf.toString('utf8')
  return text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text
}

function headerJson(headers) {
  if (!headers) return null
  try { return JSON.stringify(headers) } catch { return null }
}

/* ------------------------------------------------------------------ 写 spool */

/**
 * 把一条事务写进 spool：body 落 `<spool>/blobs/<sha256>`，元数据追加成一行 JSONL。
 * 返回可以直接入库的行对象（含 `flow_key`、blob 相对路径）。
 */
export function writeFlowToSpool(spoolDir, flow) {
  const paths = spoolPathsOf(spoolDir)
  mkdirSync(paths.blobs, { recursive: true })
  const row = buildRow(flow)
  const put = (buf) => {
    if (!buf || buf.length === 0) return null
    const sha = sha256Hex(buf)
    const file = join(paths.blobs, sha)
    if (!existsSync(file)) writeFileSync(file, buf)
    return sha
  }
  const reqSha = put(flow.req_body)
  const respSha = put(flow.resp_body)
  if (reqSha) {
    row.req_body_sha256 = reqSha
    row.req_body_file = blobRelPath(reqSha)
  }
  if (respSha) {
    row.resp_body_sha256 = respSha
    row.resp_body_file = blobRelPath(respSha)
  }
  appendFileSync(paths.flow, JSON.stringify(row) + '\n', 'utf8')
  return row
}

/** 由代理侧事务对象构造库行（不含 blob 搬家）。 */
export function buildRow(flow) {
  const startedAt = flow.started_at || new Date().toISOString()
  const finishedAt = flow.finished_at || new Date().toISOString()
  const duration = Number.isFinite(Number(flow.duration_ms))
    ? Math.max(0, Math.trunc(Number(flow.duration_ms)))
    : Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt))
  const reqBody = Buffer.isBuffer(flow.req_body) ? flow.req_body : null
  const respBody = Buffer.isBuffer(flow.resp_body) ? flow.resp_body : null
  const headers = flow.resp_headers || {}
  const contentType = flow.resp_content_type
    || headers['content-type'] || headers['Content-Type'] || null
  const reqTotal = Number.isFinite(Number(flow.req_bytes))
    ? Number(flow.req_bytes)
    : (reqBody ? reqBody.length : 0)
  const respTotal = Number.isFinite(Number(flow.resp_bytes))
    ? Number(flow.resp_bytes)
    : (respBody ? respBody.length : 0)
  return {
    flow_key: flow.flow_key || flowKeyOf(Object.assign({}, flow, { started_at: startedAt })),
    session_id: flow.session_id === undefined ? null : flow.session_id,
    method: flow.method || 'GET',
    url: flow.url || '',
    host: flow.host || '',
    scheme: flow.scheme || 'http',
    path: flow.path || '',
    status: Number.isFinite(Number(flow.status)) ? Number(flow.status) : null,
    req_headers: headerJson(flow.req_headers),
    req_body: flow.req_preview !== undefined ? flow.req_preview : previewOf(reqBody, flow.req_content_type),
    req_body_file: null,
    req_body_bytes: reqTotal,
    req_body_sha256: null,
    req_body_truncated: flow.req_truncated ? 1 : 0,
    resp_headers: headerJson(flow.resp_headers),
    resp_body: flow.resp_preview !== undefined ? flow.resp_preview : previewOf(respBody, contentType),
    resp_body_file: null,
    resp_body_bytes: respTotal,
    resp_body_sha256: null,
    resp_body_truncated: flow.resp_truncated ? 1 : 0,
    resp_content_type: contentType ? String(contentType) : null,
    bytes: reqTotal + respTotal,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: duration,
    tool: flow.tool || null,
    agent: flow.agent || null,
    asset_id: flow.asset_id === undefined ? null : flow.asset_id,
    vuln_id: flow.vuln_id === undefined ? null : flow.vuln_id,
    finding_id: flow.finding_id === undefined ? null : flow.finding_id,
    step_id: flow.step_id === undefined ? null : flow.step_id,
    source: flow.source || 'mitm',
    note: flow.note || (flow.error ? 'error: ' + flow.error : null),
    created_at: new Date().toISOString(),
  }
}

/* ------------------------------------------------------------------ 入库 */

function sqlValue(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

/**
 * 插一行（`INSERT OR IGNORE`，靠 flow_key 去重）。
 * @returns `true` = 真的插进去了；`false` = 已存在（重复 ingest）。
 */
export function insertFlowRow(db, row) {
  const cols = Object.keys(row)
  const sql = 'INSERT OR IGNORE INTO traffic_flow (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')'
  const stmt = db.prepare(sql)
  const result = stmt.run(...cols.map((c) => sqlValue(row[c])))
  return Number(result && result.changes) > 0
}

/** 把一个 spool blob 搬进靶标 blob 目录；返回是否真的搬了。 */
export function moveBlob(spoolDir, dir, sha) {
  if (!sha) return false
  const from = join(spoolPathsOf(spoolDir).blobs, sha)
  if (!existsSync(from)) return false
  const target = join(blobsDirOf(dir), sha.slice(0, 2), sha)
  if (existsSync(target)) {
    try { rmSync(from, { force: true }) } catch { /* 删不掉不影响正确性 */ }
    return false
  }
  mkdirSync(join(blobsDirOf(dir), sha.slice(0, 2)), { recursive: true })
  try {
    renameSync(from, target)
  } catch {
    /* 跨盘 rename 会 EXDEV：退化成拷贝 + 删源 */
    copyFileSync(from, target)
    try { rmSync(from, { force: true }) } catch { /* ignore */ }
  }
  return true
}

/**
 * 把 spool 里的行幂等入库。
 * @param db - 靶标库句柄（`DatabaseSync`）。
 * @param options - `{ spoolDir, dir, limit }`；limit 缺省不限条数。
 * @returns `{ ok, ingested, dup_skipped, blobs_moved, remaining, errors }`
 */
export function ingestSpool(db, options = {}) {
  const spoolDir = options.spoolDir
  const dir = options.dir
  if (!spoolDir) throw new Error('ingestSpool 需要 spoolDir')
  if (!db) throw new Error('ingestSpool 需要数据库句柄')
  const paths = spoolPathsOf(spoolDir)
  const result = { ok: true, ingested: 0, dup_skipped: 0, blobs_moved: 0, remaining: 0, errors: [] }
  if (!existsSync(paths.flow)) return result

  let raw = ''
  try { raw = readFileSync(paths.flow, 'utf8') } catch (error) {
    result.ok = false
    result.errors.push('读 spool 失败： ' + (error && error.message ? error.message : String(error)))
    return result
  }
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.trunc(Number(options.limit))
    : Number.POSITIVE_INFINITY
  const lines = raw.split('\n').filter((line) => line.trim() !== '')
  const consumed = []
  const remain = []
  for (const line of lines) {
    if (consumed.length >= limit) { remain.push(line); continue }
    let row
    try { row = JSON.parse(line) } catch { remain.push(line); continue }
    try {
      if (insertFlowRow(db, row)) result.ingested += 1
      else result.dup_skipped += 1
      if (dir) {
        if (moveBlob(spoolDir, dir, row.req_body_sha256)) result.blobs_moved += 1
        if (moveBlob(spoolDir, dir, row.resp_body_sha256)) result.blobs_moved += 1
      }
      consumed.push(line)
    } catch (error) {
      /* 入库失败的行留在 spool：修好之后还能再跑一遍，不丢流量 */
      result.ok = false
      result.errors.push(error && error.message ? error.message : String(error))
      remain.push(line)
    }
  }
  if (consumed.length > 0) {
    try { appendFileSync(paths.done, consumed.join('\n') + '\n', 'utf8') } catch { /* 归档失败不阻断 */ }
  }
  try {
    writeFileSync(paths.flow, remain.length > 0 ? remain.join('\n') + '\n' : '', 'utf8')
  } catch (error) {
    result.ok = false
    result.errors.push('回写 spool 失败： ' + (error && error.message ? error.message : String(error)))
  }
  result.remaining = remain.length
  return result
}

/* ------------------------------------------------------------------ 会话审计 */

export function startTrafficSession(db, session) {
  if (!db) return null
  const stmt = db.prepare(
    'INSERT INTO traffic_session (port, pid, status, filter, ca_sha256, spool_dir, started_at, flows, note)'
    + ' VALUES (?,?,?,?,?,?,?,?,?)',
  )
  const result = stmt.run(
    sqlValue(session.port), sqlValue(session.pid), session.status || 'running',
    sqlValue(session.filter), sqlValue(session.ca_sha256), sqlValue(session.spool_dir),
    session.started_at || new Date().toISOString(), 0, sqlValue(session.note),
  )
  return Number(result.lastInsertRowid)
}

export function finishTrafficSession(db, id, patch = {}) {
  if (!db || id === undefined || id === null) return false
  const stmt = db.prepare(
    'UPDATE traffic_session SET status=?, stopped_at=?, flows=COALESCE(?, flows), note=COALESCE(?, note) WHERE id=?',
  )
  stmt.run(
    patch.status || 'stopped',
    patch.stopped_at || new Date().toISOString(),
    patch.flows === undefined ? null : Number(patch.flows),
    patch.note === undefined ? null : String(patch.note),
    id,
  )
  return true
}

export function bumpSessionFlows(db, id, flows) {
  if (!db || id === undefined || id === null) return false
  db.prepare('UPDATE traffic_session SET flows=? WHERE id=?').run(Number(flows) || 0, id)
  return true
}

export function listTrafficSessions(db, limit = 20) {
  if (!db) return []
  const n = Math.min(Math.max(Number(limit) || 20, 1), 200)
  return db.prepare('SELECT * FROM traffic_session ORDER BY id DESC LIMIT ?').all(n)
}

/* ------------------------------------------------------------------ 查询 */

function parseJsonMaybe(text) {
  if (typeof text !== 'string' || text === '') return null
  try { return JSON.parse(text) } catch { return text }
}

/**
 * 条件查流量。
 * @param filters - `{ q, host, url, method, status, vuln_id, finding_id, session_id, since, until, limit }`
 */
export function searchFlows(db, filters = {}) {
  if (!db) return { total: 0, items: [] }
  const where = []
  const args = []
  const like = (v) => '%' + String(v) + '%'
  if (filters.q) {
    where.push('(url LIKE ? OR host LIKE ? OR path LIKE ? OR req_headers LIKE ? OR resp_headers LIKE ?)')
    const v = like(filters.q)
    args.push(v, v, v, v, v)
  }
  if (filters.host) { where.push('host = ?'); args.push(String(filters.host)) }
  if (filters.url) { where.push('url LIKE ?'); args.push(like(filters.url)) }
  if (filters.method) { where.push('UPPER(method) = ?'); args.push(String(filters.method).toUpperCase()) }
  if (Number.isFinite(Number(filters.status))) { where.push('status = ?'); args.push(Number(filters.status)) }
  if (Number.isFinite(Number(filters.vuln_id))) { where.push('vuln_id = ?'); args.push(Number(filters.vuln_id)) }
  if (Number.isFinite(Number(filters.finding_id))) { where.push('finding_id = ?'); args.push(Number(filters.finding_id)) }
  if (Number.isFinite(Number(filters.session_id))) { where.push('session_id = ?'); args.push(Number(filters.session_id)) }
  if (filters.since) { where.push('started_at >= ?'); args.push(String(filters.since)) }
  if (filters.until) { where.push('started_at <= ?'); args.push(String(filters.until)) }
  const clause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 5000)
  const total = Number(db.prepare('SELECT COUNT(*) n FROM traffic_flow' + clause).get(...args).n)
  const items = db.prepare(
    'SELECT id, method, url, host, scheme, path, status, started_at, duration_ms,'
    + ' req_body_bytes, resp_body_bytes, resp_content_type, req_body_truncated, resp_body_truncated,'
    + ' vuln_id, finding_id, step_id, asset_id, session_id, tool, agent'
    + ' FROM traffic_flow' + clause + ' ORDER BY id DESC LIMIT ?',
  ).all(...args, limit)
  return { total, items }
}

/** 取一条完整行，并解析头为对象。 */
export function getFlow(db, id) {
  if (!db) return null
  const row = db.prepare('SELECT * FROM traffic_flow WHERE id = ?').get(Number(id))
  if (!row) return null
  return Object.assign({}, row, {
    req_headers: parseJsonMaybe(row.req_headers),
    resp_headers: parseJsonMaybe(row.resp_headers),
  })
}

/** spool 里还有多少行没入库（面板「流量」页的待入库提示）。 */
export function countPendingFlows(spoolDir) {
  if (!spoolDir) return 0
  const file = spoolPathsOf(spoolDir).flow
  if (!existsSync(file)) return 0
  try {
    const text = readFileSync(file, 'utf8')
    return text.split('\n').filter((line) => line.trim() !== '').length
  } catch { return 0 }
}

/** blob 的绝对路径（读全文用）。 */
export function blobPathOf(dir, row, which) {
  const rel = which === 'req' ? row.req_body_file : row.resp_body_file
  if (!rel) return null
  const abs = join(String(dir), rel)
  return existsSync(abs) ? abs : null
}

/** 目录是否像一个已存在的流量根（面板/测试判断用）。 */
export function hasTraffic(dir) {
  try { return statSync(trafficDirOf(dir)).isDirectory() } catch { return false }
}

export default {
  PREVIEW_MAX,
  sha256Hex,
  flowKeyOf,
  trafficDirOf,
  blobsDirOf,
  blobRelPath,
  spoolPathsOf,
  previewOf,
  buildRow,
  writeFlowToSpool,
  insertFlowRow,
  moveBlob,
  ingestSpool,
  startTrafficSession,
  finishTrafficSession,
  bumpSessionFlows,
  listTrafficSessions,
  searchFlows,
  getFlow,
  countPendingFlows,
  blobPathOf,
  hasTraffic,
}
