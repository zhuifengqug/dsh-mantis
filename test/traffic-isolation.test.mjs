/**
 * P3 隔离（L3）：traffic_flow 按靶标隔离。
 *
 * 覆盖四条验收：
 *   1. spool 按 owner.json 隔离：两个靶标各写各的 spool，互不串库；
 *   2. 无 owner 的老 spool 由第一个打开的靶标认领，另一个靶标看不到；
 *   3. 跨靶标必须显式：默认搜索隐藏他靶标行，cross_engagement:true 才可见；
 *      get / blob / bind 默认拒绝碰非本靶标的 flow（opts.cross=true 才放行）；
 *   4. 旧库迁移：缺 engagement_id/target 列的老库打开后补列并回填，查询正常；
 *      代理路径：startMitmProxy 按 engagementId 写 owner.json，record 盖 engagement_id/target。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { RedteamStore } from '../lib/redteam/store-core.js'
import {
  writeFlowToSpool, writeSpoolOwner, readSpoolOwner, searchFlows, insertFlowRow,
} from '../lib/redteam/traffic.js'
import { startMitmProxy, stopAllProxies } from '../lib/redteam/proxy.js'

function fresh(tag) {
  const root = mkdtempSync(join(tmpdir(), 'mantis-traffic-iso-' + tag + '-'))
  return { root, store: new RedteamStore(root) }
}

/** 一条最小 flow（host 用于区分靶标）。 */
function flow(host, idx = 1) {
  return {
    session_key: 'sess-' + host, idx,
    method: 'GET', url: 'http://' + host + '/p' + idx, host,
    scheme: 'http', path: '/p' + idx, status: 200,
    resp_headers: { 'content-type': 'text/plain' }, resp_content_type: 'text/plain',
    resp_body: Buffer.from('ok-' + host),
    started_at: '2026-11-12T10:00:00.000Z', finished_at: '2026-11-12T10:00:00.010Z',
    duration_ms: 10,
  }
}

function spoolDir(root, name) {
  const dir = join(root, 'mitm', 'spool', name)
  mkdirSync(dir, { recursive: true })
  return dir
}

/* ------------------------------------------------------------------ 1. owner.json 隔离 */

test('两个靶标的 spool 各带 owner，检索互不串库', () => {
  const { root, store } = fresh('owner')
  try {
    const a = store.openEngagement('targetA', [], { bindCurrent: false })
    const b = store.openEngagement('targetB', [], { bindCurrent: false })
    const sA = spoolDir(root, 'sA')
    const sB = spoolDir(root, 'sB')
    writeFlowToSpool(sA, flow('a.example.com'))
    writeFlowToSpool(sB, flow('b.example.com'))
    writeSpoolOwner(sA, { engagement_id: a.id, target: 'targetA' })
    writeSpoolOwner(sB, { engagement_id: b.id, target: 'targetB' })

    const ra = store.traffic(a.id).search({})
    const rb = store.traffic(b.id).search({})
    assert.equal(ra.total, 1, 'A 只应看到自己那一条')
    assert.equal(rb.total, 1, 'B 只应看到自己那一条')
    assert.equal(ra.items[0].host, 'a.example.com')
    assert.equal(rb.items[0].host, 'b.example.com')
    assert.equal(ra.items[0].engagement_id, String(a.id))
    assert.equal(ra.items[0].target, 'targetA')
    assert.equal(rb.items[0].engagement_id, String(b.id))
    /* 幂等：再查不重复入库 */
    assert.equal(store.traffic(a.id).search({}).total, 1)
    assert.equal(store.traffic(b.id).search({}).total, 1)
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 2. 老 spool 认领 */

test('无 owner 的老 spool 由第一个靶标认领，另一个靶标看不到', () => {
  const { root, store } = fresh('legacy')
  try {
    const a = store.openEngagement('targetA', [], { bindCurrent: false })
    const b = store.openEngagement('targetB', [], { bindCurrent: false })
    const sLegacy = spoolDir(root, 'sLegacy')
    writeFlowToSpool(sLegacy, flow('legacy.example.com'))
    assert.equal(readSpoolOwner(sLegacy), null, '写 spool 时没有 owner')

    assert.equal(store.traffic(a.id).search({}).total, 1, 'A 认领并入库')
    assert.equal(readSpoolOwner(sLegacy).engagement_id, String(a.id), 'A 认领后 owner 指向 A')
    assert.equal(store.traffic(b.id).search({}).total, 0, 'B 看不到 A 认领的 spool')
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 3. 显式跨靶标 + 归属校验 */

test('默认只查本靶标；cross_engagement 才见他靶标行；get/blob/bind 归属校验', () => {
  const { root, store } = fresh('cross')
  try {
    const a = store.openEngagement('targetA', [], { bindCurrent: false })
    const sA = spoolDir(root, 'sA')
    writeFlowToSpool(sA, flow('a.example.com'))
    writeSpoolOwner(sA, { engagement_id: a.id, target: 'targetA' })
    store.traffic(a.id).search({}) // 触发入库本靶标那条

    /* 模拟老库历史串库：往 A 的库里直接塞一条属于 other 的行 */
    const foreign = insertFlowRow(store.traffic(a.id).db, {
      flow_key: 'foreign-1', method: 'GET', url: 'http://other.example.com/x',
      host: 'other.example.com', scheme: 'http', path: '/x', status: 200,
      engagement_id: 'other', target: 'otherTarget',
      started_at: '2026-11-12T10:00:00.000Z', finished_at: '2026-11-12T10:00:00.010Z',
      duration_ms: 10, source: 'mitm',
    })
    assert.equal(foreign, true)
    const foreignRow = store.traffic(a.id).db.prepare("SELECT id FROM traffic_flow WHERE flow_key='foreign-1'").get()

    assert.equal(store.traffic(a.id).search({}).total, 1, '默认隐藏他靶标行')
    assert.equal(store.traffic(a.id).search({ cross_engagement: true }).total, 2, '显式跨靶标才可见')

    assert.throws(() => store.traffic(a.id).get(foreignRow.id), /不属于当前靶标/)
    assert.equal(store.traffic(a.id).get(foreignRow.id, { cross: true }).id, foreignRow.id)
    assert.throws(() => store.traffic(a.id).blob(foreignRow.id, 'resp'), /不属于当前靶标/)
    assert.throws(() => store.traffic(a.id).bind(foreignRow.id, { finding_id: 1 }), /不属于当前靶标/)
    /* 本靶标的 flow 正常可用 */
    const ownId = store.traffic(a.id).search({}).items[0].id
    assert.equal(store.traffic(a.id).get(ownId).id, ownId)
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 4. 旧库迁移 */

const OLD_TRAFFIC_FLOW_DDL = `
CREATE TABLE traffic_flow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_key TEXT NOT NULL UNIQUE,
  session_id INTEGER,
  method TEXT NOT NULL, url TEXT NOT NULL, host TEXT, scheme TEXT, path TEXT,
  status INTEGER,
  req_headers TEXT,
  req_body TEXT, req_body_file TEXT, req_body_bytes INTEGER DEFAULT 0,
  req_body_sha256 TEXT, req_body_truncated INTEGER DEFAULT 0,
  resp_headers TEXT,
  resp_body TEXT, resp_body_file TEXT, resp_body_bytes INTEGER DEFAULT 0,
  resp_body_sha256 TEXT, resp_body_truncated INTEGER DEFAULT 0,
  resp_content_type TEXT,
  bytes INTEGER DEFAULT 0,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  tool TEXT, agent TEXT,
  asset_id INTEGER, vuln_id INTEGER, finding_id INTEGER, step_id INTEGER,
  source TEXT DEFAULT 'mitm', note TEXT, created_at TEXT
);
CREATE UNIQUE INDEX ux_traffic_flow_key ON traffic_flow(flow_key);
CREATE INDEX ix_traffic_host ON traffic_flow(host, started_at);
`

test('旧库（缺 engagement_id/target）打开后补列并回填，查询正常', () => {
  const { root, store } = fresh('migrate')
  const a = store.openEngagement('legacyTarget', [], { bindCurrent: false })
  const dbPath = store.dbPathOf(a.id)
  store.close()

  /* 用旧 schema 重建这个库文件，塞一条历史行 */
  rmSync(dbPath, { force: true })
  const old = new DatabaseSync(dbPath)
  old.exec(OLD_TRAFFIC_FLOW_DDL)
  old.prepare(
    'INSERT INTO traffic_flow (flow_key, method, url, host, scheme, path, status, resp_body, started_at, finished_at, duration_ms, source)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run('legacy-1', 'GET', 'http://old.example.com/a', 'old.example.com', 'http', '/a', 200, 'old-body',
    '2026-11-12T09:00:00.000Z', '2026-11-12T09:00:00.010Z', 10, 'mitm')
  const colsBefore = old.prepare('PRAGMA table_info(traffic_flow)').all().map((r) => r.name)
  assert.ok(!colsBefore.includes('engagement_id'), '旧库确实没有 engagement_id 列')
  old.close()

  /* 重新打开：DDL 跳过已存在的表，migrate 补列，store 打开时回填 */
  const reopened = new RedteamStore(root)
  try {
    const api = reopened.traffic(a.id)
    const cols = api.db.prepare('PRAGMA table_info(traffic_flow)').all().map((r) => r.name)
    assert.ok(cols.includes('engagement_id'), '迁移后应有 engagement_id 列')
    assert.ok(cols.includes('target'), '迁移后应有 target 列')

    const found = api.search({})
    assert.equal(found.total, 1, '迁移后历史行仍可查询')
    assert.equal(found.items[0].host, 'old.example.com')
    assert.equal(found.items[0].engagement_id, String(a.id), '历史行回填为当前 id')
    assert.equal(found.items[0].target, 'legacyTarget')
    /* 直接 searchFlows 也能读到回填列 */
    assert.equal(searchFlows(api.db, {}).items[0].engagement_id, String(a.id))
  } finally {
    try { reopened.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ 5. 代理路径盖章 */

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function proxyHttpGet(proxy, targetUrl) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl)
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'GET', path: targetUrl, headers: { host: url.host } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode, body: text }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitUntil(pred, timeoutMs = 4000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (pred()) return true; await new Promise((r) => setTimeout(r, stepMs)) }
  return pred()
}

test('代理按 engagementId 写 owner.json，record 给每行盖上 engagement_id/target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mantis-traffic-iso-proxy-'))
  const dir = join(root, 'assets', 'demo')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(':memory:')
  const { DDL } = await import('../lib/redteam/schema.js')
  db.exec(DDL)
  const target = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') })
  const tport = await listen(target)
  let proxy
  try {
    proxy = await startMitmProxy({ root, dir, db, port: 18101, portMax: 18119, caDir: join(root, 'ca'), engagementId: 'engZ', targetName: 'targetZ' })
    assert.ok(existsSync(join(proxy.spool_dir, 'owner.json')), '代理应在 spool 目录写 owner.json')
    assert.equal(readSpoolOwner(proxy.spool_dir).engagement_id, 'engZ')
    assert.equal(readSpoolOwner(proxy.spool_dir).target, 'targetZ')

    await proxyHttpGet(proxy, 'http://127.0.0.1:' + tport + '/z?x=1')
    assert.equal(await waitUntil(() => proxy.flowCount >= 1), true)
    proxy.flush()

    const found = searchFlows(db, { q: '/z' })
    assert.equal(found.total, 1)
    const row = searchFlows(db, { q: '/z' }).items[0]
    assert.equal(row.engagement_id, 'engZ')
    assert.equal(row.target, 'targetZ')
    const full = db.prepare('SELECT engagement_id, target FROM traffic_flow WHERE id=?').get(row.id)
    assert.equal(full.engagement_id, 'engZ')
    assert.equal(full.target, 'targetZ')
  } finally {
    if (proxy) await proxy.stop()
    await new Promise((r) => target.close(r))
    await stopAllProxies()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.after(async () => { await stopAllProxies() })
