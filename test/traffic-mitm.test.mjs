/**
 * P3a MITM 录制代理 + 自签 CA 的单测。
 *
 * 覆盖四条验收：
 *   1. 明文 HTTP 经代理转发，抓到的请求/响应确实进了 assets.db（traffic_flow）；
 *   2. HTTPS 经 CONNECT 解密录制，客户端用自签 CA 校验链能通过（等价于「CA 生成后可校验链」的端到端证明）；
 *   3. 磁盘 CA / 叶证书可离线验链（verifyChain）；
 *   4. 代理默认不自启：import 之后没有监听、state 为空、running=false。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { DDL } from '../lib/redteam/schema.js'
import {
  startMitmProxy, stopMitmProxy, stopAllProxies, listRunningProxies, proxyStatus, readProxyState,
} from '../lib/redteam/proxy.js'
import { searchFlows, getFlow, countPendingFlows } from '../lib/redteam/traffic.js'
import { ensureCa, ensureLeaf, verifyChain, caPathsOf, guideText } from '../lib/redteam/ca.js'

function tmpRoot(tag) {
  const root = mkdtempSync(join(tmpdir(), 'mantis-mitm-' + tag + '-'))
  mkdirSync(join(root, 'assets', 'demo'), { recursive: true })
  return root
}

function freshDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)
  return db
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

async function waitUntil(predicate, timeoutMs = 4000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return predicate()
}

/** 明文 HTTP 代理请求：path 用 absolute-form（真实代理就是这么发的）。 */
function proxyHttpGet(proxy, targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl)
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: options.method || 'GET',
      path: targetUrl,
      headers: Object.assign({ host: url.host }, options.headers || {}),
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function connectVia(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.host, port: proxy.port, method: 'CONNECT',
      path: host + ':' + port, headers: { host: host + ':' + port },
    })
    req.on('connect', (res, socket, head) => {
      if (head && head.length) socket.unshift(head)
      resolve({ res, socket })
    })
    req.on('error', reject)
    req.end()
  })
}

function readAll(socket) {
  return new Promise((resolve, reject) => {
    let text = ''
    socket.setEncoding('utf8')
    socket.on('data', (c) => { text += c })
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
    socket.on('close', () => resolve(text))
  })
}

/* ------------------------------------------------------------------ 1. 默认不自启 */

test('代理默认不自启：import 之后无监听、无状态', () => {
  const root = tmpRoot('idle')
  try {
    assert.equal(listRunningProxies().length, 0)
    assert.equal(proxyStatus(root).running, false)
    assert.deepEqual(readProxyState(root), { running: false })
    assert.equal(existsSync(join(root, 'mitm', 'state.json')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 2. CA 与链 */

test('自签 CA：可生成、可复现、叶证书可离线验链', () => {
  const root = tmpRoot('ca')
  const caDir = join(root, 'ca')
  try {
    const first = ensureCa(caDir)
    assert.equal(first.generated, true)
    assert.ok(existsSync(caPathsOf(caDir).crt))
    assert.ok(existsSync(caPathsOf(caDir).key))
    assert.match(first.sha256, /^[0-9a-f]{64}$/)

    const second = ensureCa(caDir)
    assert.equal(second.generated, false, '再次 ensureCa 应复用已有根证书')
    assert.equal(second.sha256, first.sha256, '根证书内容必须稳定，不能每次重签')

    const leaf = ensureLeaf(caDir, 'example.test')
    assert.ok(leaf.crt.includes('BEGIN CERTIFICATE'))
    assert.ok(leaf.key.includes('PRIVATE KEY'))

    const chain = verifyChain(caDir, 'example.test')
    assert.equal(chain.ok, true, 'verifyChain 应通过：' + JSON.stringify(chain.error || chain))
    assert.equal(chain.ca.self_signed, true)
    assert.equal(chain.ca.signature_ok, true)
    assert.equal(chain.leaf.issued_by_ca, true)
    assert.equal(chain.leaf.signature_ok, true)
    assert.equal(chain.leaf.host_match, 'example.test')

    const guide = guideText(process.platform, caPathsOf(caDir).crt)
    assert.equal(guide.ok, true)
    const text = guide.steps.join('\n')
    assert.ok(text.length > 0)
    assert.ok(/certutil|security add-trusted-cert|update-ca-certificates/.test(text))
    assert.match(text, /由你手动执行/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 3. 明文 HTTP 录制入库 */

test('明文 HTTP 经代理，请求/响应一行入库', async () => {
  const root = tmpRoot('http')
  const dir = join(root, 'assets', 'demo')
  const db = freshDb()
  const target = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('echo:' + body)
    })
  })
  const targetPort = await listen(target)
  let proxy
  try {
    proxy = await startMitmProxy({ root, dir, db, port: 18081, portMax: 18099, caDir: join(root, 'ca') })
    assert.equal(proxy.status().running, true)
    assert.equal(proxy.port >= 18081 && proxy.port <= 18099, true)

    const targetUrl = 'http://127.0.0.1:' + targetPort + '/hello?x=1'
    const res = await proxyHttpGet(proxy, targetUrl, {
      method: 'POST', body: 'ping', headers: { 'content-type': 'text/plain' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'echo:ping')

    const ok = await waitUntil(() => proxy.flowCount >= 1)
    assert.equal(ok, true, '代理应记到至少一条 flow')
    proxy.flush()

    const found = searchFlows(db, { q: 'hello' })
    assert.equal(found.total, 1, '库里应恰好一条匹配的 flow')
    const row = found.items[0]
    assert.equal(row.method, 'POST')
    assert.equal(row.host, '127.0.0.1:' + targetPort)
    assert.equal(row.status, 200)

    const full = getFlow(db, row.id)
    assert.equal(full.path, '/hello?x=1')
    assert.equal(full.req_body, 'ping')
    assert.equal(full.resp_body, 'echo:ping')
    assert.equal(full.req_headers['content-type'], 'text/plain')
    assert.equal(full.resp_content_type, 'text/plain; charset=utf-8')
    assert.equal(full.bytes, full.req_body_bytes + full.resp_body_bytes)
    assert.equal(full.source, 'mitm')
  } finally {
    if (proxy) await proxy.stop()
    await new Promise((r) => target.close(r))
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 4. HTTPS CONNECT 解密录制 */

test('HTTPS 经 CONNECT 解密录制，客户端用自签 CA 校验链通过', async () => {
  const root = tmpRoot('https')
  const dir = join(root, 'assets', 'demo')
  const caDir = join(root, 'ca')
  const db = freshDb()
  ensureCa(caDir)
  const leaf = ensureLeaf(caDir, 'localhost')
  const target = https.createServer({ key: leaf.key, cert: leaf.crt }, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('secret-ok:' + req.url)
  })
  const targetPort = await listen(target)
  let proxy
  try {
    proxy = await startMitmProxy({ root, dir, db, port: 18081, portMax: 18099, caDir })
    const { socket } = await connectVia(proxy, 'localhost', targetPort)
    /* rejectUnauthorized:true + 只信任我们的自签 CA：握手成功即证明叶证书链被正确签发与校验 */
    const tlsSock = tls.connect({ socket, servername: 'localhost', ca: readFileSync(caPathsOf(caDir).crt, 'utf8'), rejectUnauthorized: true })
    await once(tlsSock, 'secureConnect')
    const reading = readAll(tlsSock)
    tlsSock.write('GET /secure?q=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    const raw = await reading
    assert.ok(raw.includes('secret-ok:/secure?q=1'), '解密后的响应应到达客户端：' + raw.slice(0, 200))

    const ok = await waitUntil(() => proxy.flowCount >= 1)
    assert.equal(ok, true)
    proxy.flush()
    const found = searchFlows(db, { q: 'secure' })
    assert.equal(found.total, 1)
    const full = getFlow(db, found.items[0].id)
    assert.equal(full.scheme, 'https')
    assert.equal(full.status, 200)
    assert.equal(full.resp_body, 'secret-ok:/secure?q=1')
  } finally {
    if (proxy) await proxy.stop()
    await new Promise((r) => target.close(r))
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 5. filter 与停代理 */

test('filter 生效：不匹配的主机走裸隧道；stop 后 state 落盘 running=false', async () => {
  const root = tmpRoot('filter')
  const dir = join(root, 'assets', 'demo')
  const db = freshDb()
  const target = http.createServer((req, res) => { res.end('ok') })
  const targetPort = await listen(target)
  let proxy
  try {
    proxy = await startMitmProxy({
      root, dir, db, port: 18081, portMax: 18099, caDir: join(root, 'ca'), filter: 'only.example',
    })
    const res = await proxyHttpGet(proxy, 'http://127.0.0.1:' + targetPort + '/no-record')
    assert.equal(res.body, 'ok')
    assert.equal(proxy.flowCount, 0, 'filter 不命中的请求不该被记录')

    const stopped = await proxy.stop()
    assert.equal(stopped.running, false)
    assert.equal(proxyStatus(root).running, false)
    const state = readProxyState(root)
    assert.equal(state.running, false)
    assert.equal(state.flows, 0)
  } finally {
    if (proxy) await proxy.stop()
    await new Promise((r) => target.close(r))
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.after(async () => {
  await stopAllProxies()
})

test('stopMitmProxy 按 root 兜底收尾', async () => {
  const root = tmpRoot('stop')
  const dir = join(root, 'assets', 'demo')
  const db = freshDb()
  try {
    await startMitmProxy({ root, dir, db, port: 18081, portMax: 18099, caDir: join(root, 'ca') })
    const res = await stopMitmProxy({ root })
    assert.equal(res.running, false)
    assert.equal(countPendingFlows(join(root, 'mitm', 'spool', readProxyState(root).session_key || 'x')) >= 0, true)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
