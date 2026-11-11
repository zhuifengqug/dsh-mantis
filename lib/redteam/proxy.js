/**
 * 内建 MITM 录制代理（P3a）—— 可启停、默认不自启。
 *
 * 形态：
 *   · 一个 `http.Server` 同时吃明文代理请求（absolute-form URI）和 `CONNECT` 隧道；
 *   · CONNECT 命中录制范围时先回 `200 Connection Established`，再把 socket 交给一个
 *     共享的 `https.Server`（SNICallback 按 SNI 主机现签叶子证书）做 TLS 解密，
 *     解出来的请求按路径转发到真目标；
 *   · 未命中 filter 的 CONNECT 走裸隧道直通（只记一条 CONNECT 行，不落 body）；
 *   · 每条事务写 `<spool>/flows.jsonl` + `<spool>/blobs/<sha256>`，随后立刻在宿主进程
 *     幂等入库（见 traffic.js）——代理从不直接写 SQLite。
 *
 * 落地边界：
 *   · 只监听 127.0.0.1（显式传 host 才放开），默认绝不开机自启；
 *   · 对上游恒 `rejectUnauthorized:false`：我们是记录者，采信目标自己的证书；
 *   · 证书/CA 全部落在 `caDirOf(root)`，绝不碰系统/浏览器信任库（信任由用户手动做，见 ca.js guideText）。
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'

import { ensureCa, ensureLeaf, caDirOf } from './ca.js'
import { makeGate } from './intercept.js'
import { mitmConfigOf } from './platform-config.js'
import {
  writeFlowToSpool, ingestSpool, startTrafficSession, finishTrafficSession, bumpSessionFlows, flowKeyOf,
} from './traffic.js'

/** 在跑代理的内存登记表：session_key → proxy。 */
const RUNNING = new Map()

const HOP_BY_HOP = new Set([
  'proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding',
])

function nowIso() {
  return new Date().toISOString()
}

/** 拆 authority：支持 `[::1]:443`、`host:port`、`host`。 */
export function splitHostPort(authority, fallbackPort) {
  const raw = String(authority || '')
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end > 0) {
      const host = raw.slice(1, end)
      const rest = raw.slice(end + 1)
      const port = rest.startsWith(':') ? Number(rest.slice(1)) : fallbackPort
      return { host, port: Number.isFinite(port) && port > 0 ? port : fallbackPort }
    }
  }
  const first = raw.indexOf(':')
  if (first > 0 && first === raw.lastIndexOf(':')) {
    const port = Number(raw.slice(first + 1))
    return { host: raw.slice(0, first), port: Number.isFinite(port) && port > 0 ? port : fallbackPort }
  }
  return { host: raw, port: fallbackPort }
}

/** 限长 body 收集器：保留前 limit 字节，同时记真实总长与是否截断。 */
function collector(limit) {
  const max = Math.max(0, Math.trunc(Number(limit) || 0))
  const chunks = []
  let size = 0
  let total = 0
  let truncated = false
  return {
    push(chunk) {
      if (!chunk || chunk.length === 0) return
      total += chunk.length
      if (size >= max) { truncated = true; return }
      const room = max - size
      if (chunk.length <= room) { chunks.push(chunk); size += chunk.length; return }
      chunks.push(chunk.subarray(0, room))
      size += room
      truncated = true
    },
    body() { return chunks.length > 0 ? Buffer.concat(chunks) : null },
    get total() { return total },
    get truncated() { return truncated },
  }
}

function outboundHeaders(headers) {
  const out = {}
  for (const [key, value] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(String(key).toLowerCase())) out[key] = value
  }
  return out
}

/** 命中录制范围？（filter 空 = 全录；`/re/` 走正则；其余逗号分隔的主机片段） */
export function recordable(proxy, host) {
  const filter = String(proxy.filter || '').trim()
  if (filter === '') return true
  const h = String(host || '').toLowerCase()
  if (filter.length > 2 && filter.startsWith('/') && filter.endsWith('/')) {
    try { return new RegExp(filter.slice(1, -1), 'i').test(h) } catch { return true }
  }
  return filter.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .some((part) => h === part || h.endsWith('.' + part) || h.includes(part))
}

/** 把请求解析成 `{scheme, host, path}`（明文代理可能是 absolute-form）。 */
function normalizeTarget(req, scheme, host) {
  const raw = String(req.url || '/')
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw)
      return { scheme: url.protocol.replace(':', ''), host: url.host, path: (url.pathname || '/') + (url.search || '') }
    } catch { /* 落到下面按 origin-form 处理 */ }
  }
  return { scheme, host: host || req.headers.host || '', path: raw }
}

/* ------------------------------------------------------------------ 状态文件 */

function statePath(root) {
  return join(String(root), 'mitm', 'state.json')
}

function writeState(root, state) {
  const file = statePath(root)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 读磁盘上的代理状态（跨进程/重启后面板判断用）。 */
export function readProxyState(root) {
  const file = statePath(root)
  if (!existsSync(file)) return { running: false }
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return { running: false } }
}

/* ------------------------------------------------------------------ 录制 */

function record(proxy, flow) {
  if (!proxy.recording) return
  try {
    writeFlowToSpool(proxy.spool_dir, flow)
    proxy.flowCount += 1
    scheduleFlush(proxy)
  } catch (error) {
    proxy.errors.push('写 spool 失败： ' + (error && error.message ? error.message : String(error)))
  }
}

function scheduleFlush(proxy) {
  if (proxy.flushScheduled) return
  proxy.flushScheduled = true
  setImmediate(() => {
    proxy.flushScheduled = false
    flushNow(proxy)
  })
}

/** 把 spool 里的行入库（幂等）。没有 db 就只攒 spool。 */
export function flushNow(proxy) {
  if (!proxy || !proxy.db) return { ok: true, skipped: true, remaining: 0 }
  try {
    const result = ingestSpool(proxy.db, { spoolDir: proxy.spool_dir, dir: proxy.dir })
    if (proxy.session_id !== null && proxy.session_id !== undefined) {
      try { bumpSessionFlows(proxy.db, proxy.session_id, proxy.flowCount) } catch { /* 审计计数失败不阻断 */ }
    }
    return result
  } catch (error) {
    proxy.errors.push('ingest 失败： ' + (error && error.message ? error.message : String(error)))
    return { ok: false, error: String(error && error.message ? error.message : error) }
  }
}

/* ------------------------------------------------------------------ 转发 */

function handleRequest(proxy, req, res, ctx) {
  const startedAt = nowIso()
  const startedMs = Date.now()
  const target = normalizeTarget(req, ctx.scheme, ctx.host)
  const recording = proxy.recording && recordable(proxy, target.host)
  const { host, port } = splitHostPort(target.host, ctx.port || (target.scheme === 'https' ? 443 : 80))
  const reqBody = collector(proxy.record_body_max)
  const respBody = collector(proxy.record_body_max)
  const reqHeaders = Object.assign({}, req.headers)
  let status = null
  let respHeaders = null
  let finished = false

  const finish = (errorNote) => {
    if (finished) return
    finished = true
    if (!recording) return
    record(proxy, {
      flow_key: flowKeyOf({ session_key: proxy.session_key, idx: proxy.flowCount + 1, method: req.method, url: urlOf(target), started_at: startedAt }),
      session_id: proxy.session_id === undefined ? null : proxy.session_id,
      method: req.method,
      url: urlOf(target),
      host: target.host,
      scheme: target.scheme,
      path: target.path,
      status,
      req_headers: reqHeaders,
      req_body: reqBody.body(),
      req_bytes: reqBody.total,
      req_truncated: reqBody.truncated,
      resp_headers: respHeaders,
      resp_body: respBody.body(),
      resp_bytes: respBody.total,
      resp_truncated: respBody.truncated,
      resp_content_type: respHeaders ? (respHeaders['content-type'] || null) : null,
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startedMs,
      tool: proxy.tool,
      agent: proxy.agent,
      source: 'mitm',
      error: errorNote || null,
    })
  }

  /* 审批门（P3c）：命中规则的请求不发上游，就地回 403 + 待批 id。
     人批完、客户端**原样重试**即通过（pending_key 保证复用同一行）。非命中一律直通。 */
  if (proxy.gate) {
    let verdict = null
    try {
      verdict = proxy.gate({ method: req.method, url: urlOf(target), host: target.host, path: target.path })
    } catch { verdict = null }
    if (verdict && verdict.action === 'block') {
      const pendingId = verdict.pending ? verdict.pending.id : null
      const ruleId = verdict.pending ? verdict.pending.rule_id : null
      const denied = verdict.effect === 'deny'
      const payload = JSON.stringify({
        ok: false,
        error_kind: denied ? 'intercept_denied' : 'approval_required',
        rule_id: ruleId,
        intercept_pending_id: pendingId,
        hint: denied
          ? ('请求被拦截规则拒绝：' + (verdict.reason || ''))
          : (verdict.reason && verdict.reason.indexOf('已被拒绝') === 0
            ? verdict.reason + '；需要重新批准才能放行，面板里可以重新排队'
            : ('已挂起待人工批准 #' + pendingId + '；面板放行后原样重试本请求')),
        reason: verdict.reason || null,
      })
      status = 403
      respHeaders = {
        'content-type': 'application/json; charset=utf-8',
        'x-mantis-intercept': denied ? 'denied' : 'pending',
        'x-mantis-intercept-rule': String(ruleId || ''),
        'x-mantis-intercept-pending': pendingId === null ? '' : String(pendingId),
        'content-length': String(Buffer.byteLength(payload)),
      }
      try { res.writeHead(403, respHeaders) } catch { /* ignore */ }
      try { res.end(payload) } catch { /* ignore */ }
      respBody.push(Buffer.from(payload))
      /* 客户端可能还在发 body：读掉它，别让 socket 卡在 half-open */
      req.on('data', () => { /* drain */ })
      req.resume()
      finish('intercept:' + (denied ? 'deny:' : 'pending:') + String(ruleId || '-'))
      return
    }
  }

  const upstream = (target.scheme === 'https' ? https : http).request({    protocol: target.scheme + ':',
    hostname: host,
    port,
    path: target.path,
    method: req.method,
    headers: outboundHeaders(req.headers),
    rejectUnauthorized: false,
    servername: net.isIP(host) ? undefined : host,
  })

  upstream.on('response', (upstreamRes) => {
    status = upstreamRes.statusCode
    respHeaders = Object.assign({}, upstreamRes.headers)
    res.writeHead(status, outboundHeaders(upstreamRes.headers))
    upstreamRes.on('data', (chunk) => { respBody.push(chunk) })
    upstreamRes.on('end', () => { res.end(); finish() })
    upstreamRes.on('error', (error) => { res.destroy(); finish(error && error.message) })
    upstreamRes.pipe(res)
  })
  upstream.on('error', (error) => {
    try { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }) } catch { /* ignore */ }
    try { res.end('mitm upstream error: ' + (error && error.message ? error.message : String(error))) } catch { /* ignore */ }
    finish(error && error.message)
  })

  req.on('data', (chunk) => { reqBody.push(chunk) })
  req.on('aborted', () => { finish('client aborted') })
  req.on('close', () => { if (!finished && !req.complete) finish('client closed') })
  req.pipe(upstream)
}

function urlOf(target) {
  return target.scheme + '://' + target.host + target.path
}

/* ------------------------------------------------------------------ 隧道 */

function handleTunnel(proxy, clientSocket, head, host, port, req) {
  const startedAt = nowIso()
  const startedMs = Date.now()
  const recording = proxy.recording && recordable(proxy, host)
  let reqBytes = 0
  let respBytes = 0
  let done = false
  const finish = (note) => {
    if (done) return
    done = true
    if (!recording) return
    const url = 'https://' + host + (port === 443 ? '' : ':' + port)
    record(proxy, {
      flow_key: flowKeyOf({ session_key: proxy.session_key, idx: proxy.flowCount + 1, method: 'CONNECT', url, started_at: startedAt }),
      session_id: proxy.session_id === undefined ? null : proxy.session_id,
      method: 'CONNECT',
      url,
      host,
      scheme: 'https',
      path: '',
      status: null,
      req_headers: req ? Object.assign({}, req.headers) : null,
      req_bytes: reqBytes,
      resp_bytes: respBytes,
      started_at: startedAt,
      finished_at: nowIso(),
      duration_ms: Date.now() - startedMs,
      tool: proxy.tool,
      agent: proxy.agent,
      source: 'mitm',
      note: note || 'tunnel',
    })
  }
  const upstream = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-mantis\r\n\r\n')
    if (head && head.length) upstream.write(head)
    clientSocket.on('data', (chunk) => { reqBytes += chunk.length })
    upstream.on('data', (chunk) => { respBytes += chunk.length })
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  })
  upstream.on('error', () => { try { clientSocket.destroy() } catch { /* ignore */ } ; finish('tunnel error') })
  clientSocket.on('error', () => { try { upstream.destroy() } catch { /* ignore */ } })
  upstream.on('close', () => { try { clientSocket.destroy() } catch { /* ignore */ } ; finish('tunnel') })
}

/* ------------------------------------------------------------------ CONNECT → MITM */

function innerServerOf(proxy) {
  if (proxy.inner) return proxy.inner
  ensureCa(proxy.ca_dir)
  const fallback = ensureLeaf(proxy.ca_dir, 'localhost')
  const inner = https.createServer({
    key: fallback.key,
    cert: fallback.crt,
    SNICallback: (servername, cb) => {
      try {
        const leaf = ensureLeaf(proxy.ca_dir, servername || 'localhost')
        cb(null, tls.createSecureContext({ key: leaf.key, cert: leaf.crt }))
      } catch (error) { cb(error) }
    },
  }, (req, res) => {
    /* 解密后的请求只有 origin-form：真主机/端口要从 CONNECT 那一跳记下的映射里取，
       Host 头里往往不带端口（浏览器默认 443），靠它转发会打到 443 上去。 */
    const conn = proxy.connTargets.get(connKey(req.socket))
    const headerHost = req.headers.host || (req.socket && req.socket.servername) || 'unknown'
    const port = conn ? conn.port : 443
    const host = conn && port !== 443 ? splitHostPort(headerHost, port).host + ':' + port : headerHost
    handleRequest(proxy, req, res, { scheme: 'https', host, port })
  })
  inner.on('tlsClientError', () => { /* 客户端不认证书就断，不刷屏 */ })
  inner.on('clientError', () => { /* 同上 */ })
  proxy.inner = inner
  return inner
}

function connKey(socket) {
  if (!socket) return ''
  return String(socket.remoteAddress || '') + '|' + String(socket.remotePort || '')
}

function handleConnect(proxy, req, clientSocket, head) {
  clientSocket.on('error', () => { /* 客户端断开很常见 */ })
  const { host, port } = splitHostPort(req.url, 443)
  const inScope = proxy.recording && recordable(proxy, host)
  if (!inScope) {
    handleTunnel(proxy, clientSocket, head, host, port, req)
    return
  }
  let inner
  try {
    inner = innerServerOf(proxy)
  } catch (error) {
    /* CA 起不来（openssl 缺失且 DER 兜底也失败）时退直通：宁可不录，也不能把用户的网断掉 */
    proxy.errors.push('CA 初始化失败，转直通： ' + (error && error.message ? error.message : String(error)))
    handleTunnel(proxy, clientSocket, head, host, port, req)
    return
  }
  clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dsh-mantis\r\n\r\n')
  if (head && head.length) clientSocket.unshift(head)
  proxy.connTargets.set(connKey(clientSocket), { host, port })
  clientSocket.on('close', () => { proxy.connTargets.delete(connKey(clientSocket)) })
  inner.emit('connection', clientSocket)
}

/* ------------------------------------------------------------------ 启停 */

function listen(server, host, port, portMax) {
  return new Promise((resolve, reject) => {
    const attempt = (candidate) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && candidate < portMax) {
          attempt(candidate + 1)
          return
        }
        reject(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve(candidate)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(candidate, host)
    }
    attempt(port)
  })
}

/**
 * 启一个录制代理。
 * @param options - `{ root, dir, db, agent, tool, port, portMax, recordBodyMax, filter, host, caDir, sessionKey, spoolDir }`
 * @returns 代理句柄：`{ port, host, session_id, session_key, spool_dir, flowCount, flush(), stop(), status() }`
 */
export async function startMitmProxy(options = {}) {
  const root = options.root
  if (!root) throw new Error('startMitmProxy 需要 root')
  const cfg = mitmConfigOf(options)
  const bindHost = options.host || '127.0.0.1'
  const sessionKey = options.sessionKey || (nowIso().replace(/[^0-9]/g, '') + '-' + process.pid)
  const spoolDir = options.spoolDir || join(String(root), 'mitm', 'spool', sessionKey)
  mkdirSync(spoolDir, { recursive: true })
  const caDir = options.caDir || caDirOf(root, null)

  const proxy = {
    root,
    dir: options.dir || null,
    db: options.db || null,
    agent: options.agent || null,
    tool: options.tool || null,
    filter: cfg.filter,
    record_body_max: cfg.recordBodyMax,
    ca_dir: caDir,
    session_key: sessionKey,
    spool_dir: spoolDir,
    session_id: null,
    flowCount: 0,
    errors: [],
    recording: true,
    flushScheduled: false,
    sockets: new Set(),
    connTargets: new Map(),
    initialised: false,
    reuse: options.reuse === undefined ? true : Boolean(options.reuse),
    /* 审批门（P3c）：有 db 就自动接上（配置 mode='off' 时内部直接 pass，零开销）。
       `options.gate` 可以塞一个自定义判定函数（测试/宿主注入）；`options.intercept:false` 关掉。 */
    gate: typeof options.gate === 'function'
      ? options.gate
      : (options.db && options.intercept !== false ? makeGate({ root, db: options.db }) : null),
  }

  if (proxy.db) {
    try {
      proxy.session_id = startTrafficSession(proxy.db, {
        port: null, pid: process.pid, status: 'running', filter: cfg.filter,
        ca_sha256: null, spool_dir: spoolDir, started_at: nowIso(), note: 'mitm start',
      })
    } catch (error) {
      proxy.errors.push('建 session 失败： ' + (error && error.message ? error.message : String(error)))
      proxy.db = null
    }
  }

  const server = http.createServer((req, res) => handleRequest(proxy, req, res, { scheme: 'http' }))
  server.on('connect', (req, socket, head) => handleConnect(proxy, req, socket, head))
  server.on('upgrade', (req, socket, head) => {
    const target = normalizeTarget(req, 'http', null)
    const { host, port } = splitHostPort(target.host, 80)
    handleTunnel(proxy, socket, head, host, port, req)
  })
  server.on('connection', (socket) => {
    proxy.sockets.add(socket)
    socket.on('close', () => proxy.sockets.delete(socket))
  })
  proxy.server = server

  const port = await listen(server, bindHost, cfg.port, cfg.portMax)
  proxy.port = port
  proxy.host = bindHost
  proxy.started_at = nowIso()

  if (proxy.db && proxy.session_id !== null) {
    try { proxy.db.prepare('UPDATE traffic_session SET port = ? WHERE id = ?').run(port, proxy.session_id) } catch { /* 审计列可缺 */ }
  }

  proxy.status = () => {
    let caReady = false
    try { caReady = existsSync(join(caDir, 'ca.crt')) } catch { caReady = false }
    return {
      running: proxy.recording,
      port,
      host: bindHost,
      session_id: proxy.session_id,
      session_key: sessionKey,
      spool_dir: spoolDir,
      dir: proxy.dir,
      filter: proxy.filter,
      flows: proxy.flowCount,
      ca_dir: caDir,
      ca_ready: caReady,
      errors: proxy.errors.slice(-20),
      started_at: proxy.started_at,
      proxy: 'http://' + bindHost + ':' + port,
    }
  }

  proxy.flush = () => flushNow(proxy)

  proxy.stop = async () => {
    if (!proxy.recording && !server.listening) return proxy.status()
    proxy.recording = false
    flushNow(proxy)
    for (const socket of proxy.sockets) { try { socket.destroy() } catch { /* ignore */ } }
    await new Promise((resolve) => { try { server.close(() => resolve()) } catch { resolve() } })
    if (proxy.inner) {
      try { proxy.inner.close(() => {}) } catch { /* ignore */ }
    }
    if (proxy.db && proxy.session_id !== null) {
      try {
        finishTrafficSession(proxy.db, proxy.session_id, { status: 'stopped', flows: proxy.flowCount })
      } catch { /* ignore */ }
    }
    RUNNING.delete(sessionKey)
    writeState(root, {
      running: false, port, host: bindHost, session_id: proxy.session_id, session_key: sessionKey,
      spool_dir: spoolDir, dir: proxy.dir, flows: proxy.flowCount, stopped_at: nowIso(),
    })
    return proxy.status()
  }

  RUNNING.set(sessionKey, proxy)
  proxy.initialised = true
  writeState(root, {
    running: true, port, host: bindHost, session_id: proxy.session_id, session_key: sessionKey,
    spool_dir: spoolDir, dir: proxy.dir, filter: proxy.filter, started_at: proxy.started_at, pid: process.pid,
  })
  return proxy
}

/** 停一个代理：可传句柄，也可传 `{ root }`（按 state.json 里的 session_key 找活的）。 */
export async function stopMitmProxy(target) {
  if (target && typeof target.stop === 'function') return target.stop()
  const root = target && target.root
  if (root) {
    const state = readProxyState(root)
    const live = state && state.session_key ? RUNNING.get(state.session_key) : null
    if (live) return live.stop()
    writeState(root, Object.assign({}, state, { running: false, stopped_at: nowIso() }))
    return { running: false }
  }
  return { running: false }
}

/** 进程退出/插件 dispose 时收尾所有在跑的代理。 */
export async function stopAllProxies() {
  const proxies = [...RUNNING.values()]
  const results = []
  for (const proxy of proxies) {
    try { results.push(await proxy.stop()) } catch (error) { results.push({ error: String(error && error.message ? error.message : error) }) }
  }
  return results
}

/** 当前进程在跑的代理列表。 */
export function listRunningProxies() {
  return [...RUNNING.values()].map((proxy) => (typeof proxy.status === 'function' ? proxy.status() : { session_key: proxy.session_key }))
}

/** 面板查询：优先返回活句柄状态，否则读 state.json。 */
export function proxyStatus(root) {
  const state = readProxyState(root)
  if (state && state.session_key && RUNNING.has(state.session_key)) return RUNNING.get(state.session_key).status()
  return Object.assign({ running: false }, state)
}

export default {
  startMitmProxy,
  stopMitmProxy,
  stopAllProxies,
  listRunningProxies,
  proxyStatus,
  readProxyState,
  flushNow,
  recordable,
  splitHostPort,
}
