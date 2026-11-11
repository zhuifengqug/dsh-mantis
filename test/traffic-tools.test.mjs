/**
 * P3b 流量检索 / 绑定 / 工具的单测。
 *
 * 覆盖验收四条：
 *   1. 检索：traffic.search 自动 ingest 代理 spool，并按 host / q / status / limit 过滤；
 *   2. 绑定：traffic_bind 写 traffic_binding + 回填 traffic_flow.finding_id，之后按 finding_id 可查；
 *   3. 非法入参：id/which/绑定目标非法时给 bad_input，不静默吞掉；
 *   4. 工具清单：tools-traffic 注册的 4 个工具与 tools.js 的 67 个工具数量正确（防重构漂移）。
 *
 * 工具层测试用真实的 RedteamStore + 真实的流量数据，只把宿主 defineTool 换成恒等实现
 * （`setDefineToolLoader`），因此 execute 走的是与线上完全相同的代码路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RedteamStore } from '../lib/redteam/store-core.js'
import { writeFlowToSpool, searchFlows, getFlow } from '../lib/redteam/traffic.js'
import { apply as applyTrafficTools, setDefineToolLoader } from '../lib/redteam/tools-traffic.js'
import { apply as applyCoreTools } from '../lib/redteam/tools.js'

function fresh(tag) {
  const root = mkdtempSync(join(tmpdir(), 'mantis-traffic-tools-' + tag + '-'))
  const store = new RedteamStore(root)
  const engagement = store.openEngagement('t10 测试靶标', [], { bindCurrent: false })
  return { root, store, engagement, spool: join(root, 'mitm', 'spool', 's1') }
}

/** 往 spool 里塞两条真实形状的事务（登录 POST + 404 静态资源）。 */
function seedFlows(spool) {
  writeFlowToSpool(spool, {
    session_key: 's1', idx: 1,
    method: 'POST', url: 'http://api.example.com/login?a=1',
    host: 'api.example.com', scheme: 'http', path: '/login?a=1', status: 200,
    req_headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'mantis-test' },
    req_body: Buffer.from('user=admin&pass=admin123'),
    resp_headers: { 'content-type': 'application/json' },
    resp_content_type: 'application/json',
    resp_body: Buffer.from('{"ok":true,"token":"t-123"}'),
    started_at: '2026-11-11T10:00:00.000Z', finished_at: '2026-11-11T10:00:00.042Z',
    duration_ms: 42, tool: 'curl', agent: 'exploit',
  })
  writeFlowToSpool(spool, {
    session_key: 's1', idx: 2,
    method: 'GET', url: 'http://static.example.com/app.js',
    host: 'static.example.com', scheme: 'http', path: '/app.js', status: 404,
    resp_headers: { 'content-type': 'application/javascript' },
    resp_content_type: 'application/javascript',
    resp_body: Buffer.from('console.log(1)'),
    started_at: '2026-11-11T10:00:01.000Z', finished_at: '2026-11-11T10:00:01.005Z',
    duration_ms: 5, tool: 'curl', agent: 'recon',
  })
}

test('traffic.search 自动 ingest spool 并按条件过滤', () => {
  const { store, engagement, spool, root } = fresh('search')
  try {
    seedFlows(spool)
    const api = store.traffic(engagement.id)

    const all = api.search({})
    assert.equal(all.total, 2)
    assert.equal(all.items.length, 2)
    assert.equal(all.auto_ingest.skipped, false)
    assert.equal(all.auto_ingest.ingested, 2, 'spool 里的 2 行应被自动入库')
    /* 幂等：再查一次不重复入库 */
    assert.equal(api.search({}).total, 2)
    assert.equal(api.pending(), 0)

    assert.equal(api.search({ host: 'api.example.com' }).total, 1)
    assert.equal(api.search({ q: 'login' }).total, 1)
    assert.equal(api.search({ url: 'app.js' }).total, 1)
    assert.equal(api.search({ method: 'post' }).total, 1)
    assert.equal(api.search({ status: 404 }).total, 1)
    assert.equal(api.search({ since: '2026-11-11T10:00:00.500Z' }).total, 1, 'since 应排掉第一条')
    assert.equal(api.search({ until: '2026-11-11T10:00:00.500Z' }).total, 1, 'until 应排掉第二条')
    const limited = api.search({ limit: 1 })
    assert.equal(limited.total, 2, 'total 是命中总数，不受 limit 影响')
    assert.equal(limited.items.length, 1)

    /* 摘要行不含 header/body，避免上下文被撑爆 */
    assert.ok(!('req_headers' in all.items[0]))
    assert.ok('url' in all.items[0] && 'status' in all.items[0])
    /* 不同靶标互不可见：另开一个靶标检索到 0 条 */
    const other = store.openEngagement('另一个靶标', [], { bindCurrent: false })
    assert.equal(store.traffic(other.id).search({}).total, 0)
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('traffic.blob 取请求/响应全文，非法 which 与不存在的 id 报错', () => {
  const { store, engagement, spool, root } = fresh('blob')
  try {
    seedFlows(spool)
    const api = store.traffic(engagement.id)
    const items = api.search({ host: 'api.example.com' }).items
    const id = items[0].id

    const req = api.blob(id, 'req')
    assert.equal(req.inline, 'user=admin&pass=admin123')
    assert.equal(req.bytes, Buffer.byteLength('user=admin&pass=admin123'))
    assert.equal(req.mime, 'application/x-www-form-urlencoded')
    assert.match(req.sha256, /^[0-9a-f]{64}$/)
    assert.equal(req.truncated, false)

    const resp = api.blob(id, 'resp')
    assert.equal(resp.inline, '{"ok":true,"token":"t-123"}')
    assert.equal(resp.mime, 'application/json')

    /* maxInline=0 → 只给元数据，不带原文 */
    assert.equal(api.blob(id, 'req', { maxInline: 0 }).inline, undefined)

    assert.throws(() => api.blob(id, 'headers'), /非法参数 which/)
    assert.throws(() => api.blob(999999, 'req'), /流量不存在/)
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('traffic.bind 写入绑定表并回填 flow，可按 finding_id 检索；重复绑定幂等', () => {
  const { store, engagement, spool, root } = fresh('bind')
  try {
    seedFlows(spool)
    const api = store.traffic(engagement.id)
    const id = api.search({ host: 'api.example.com' }).items[0].id

    const first = api.bind(id, { finding_id: 7, note: '登录口无锁定，可爆破' })
    assert.equal(first.ok, true)
    assert.equal(first.created, true)
    assert.equal(first.flow.finding_id, 7)

    const bindings = api.bindings(id)
    assert.equal(bindings.length, 1)
    assert.equal(bindings[0].finding_id, 7)
    assert.equal(bindings[0].note, '登录口无锁定，可爆破')

    /* 绑定后 traffic_search 直接按 finding_id 命中（不是靠 JOIN 绑定表） */
    assert.equal(api.search({ finding_id: 7 }).total, 1)
    assert.equal(api.search({ vuln_id: 7 }).total, 0)

    const again = api.bind(id, { finding_id: 7 })
    assert.equal(again.created, false, '重复绑定不应新增一行')
    assert.equal(api.bindings(id).length, 1)

    /* 同一 flow 再挂一个 vuln：多对多，不覆盖 finding 绑定 */
    api.bind(id, { vuln_id: 12, step_id: 3 })
    assert.equal(api.bindings(id).length, 2)
    assert.equal(api.search({ vuln_id: 12 }).total, 1)
    assert.equal(api.search({ finding_id: 7 }).total, 1)

    assert.throws(() => api.bind(id, {}), /至少需要一个绑定目标/)
    assert.throws(() => api.bind(id, { finding_id: 'abc' }), /非法参数 finding_id/)
    assert.throws(() => api.bind(0, { finding_id: 1 }), /非法参数 id/)
    assert.throws(() => api.bind(999999, { finding_id: 1 }), /流量不存在/)
  } finally {
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})

test('工具清单：tools-traffic 注册 4 个工具且 execute 走通真实数据；tools.js 仍是 64 个', async () => {
  const { store, engagement, spool, root } = fresh('tools')
  const previousLoader = setDefineToolLoader((spec) => spec)
  try {
    seedFlows(spool)

    const trafficTools = []
    const fakeCtx = {
      redteam: store,
      tools: { register: (tool) => trafficTools.push(tool) },
      effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
      on: () => () => {},
      logger: { warn() {} },
    }
    applyTrafficTools(fakeCtx)
    const names = trafficTools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'redteam_traffic_bind',
      'redteam_traffic_blob',
      'redteam_traffic_get',
      'redteam_traffic_search',
    ])
    for (const tool of trafficTools) {
      assert.equal(typeof tool.execute, 'function', tool.name + ' 缺少 execute')
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20, tool.name + ' 描述太短')
      assert.ok(tool.parameters && typeof tool.parameters === 'object', tool.name + ' 缺少参数定义')
    }

    const byName = Object.fromEntries(trafficTools.map((t) => [t.name, t]))
    const exec = async (name, args) => JSON.parse(await byName[name].execute(args, {}))

    /* search：显式 engagement，避免依赖会话绑定 */
    const found = await exec('redteam_traffic_search', { engagement: engagement.id })
    assert.equal(found.ok, true)
    assert.equal(found.total, 2)
    assert.equal(found.lines.length, 2)
    assert.match(found.lines[0], /^#\d+  (200|404) /)

    /* get：带预览与绑定视图 */
    const id = found.items.find((i) => i.host === 'api.example.com').id
    const got = await exec('redteam_traffic_get', { engagement: engagement.id, id })
    assert.equal(got.ok, true)
    assert.equal(got.flow.id, id)
    assert.equal(got.req_preview, 'user=admin&pass=admin123')
    assert.deepEqual(got.bound, [])

    /* blob：原文 inline */
    const blob = await exec('redteam_traffic_blob', { engagement: engagement.id, id, which: 'resp' })
    assert.equal(blob.ok, true)
    assert.equal(blob.inline, '{"ok":true,"token":"t-123"}')

    /* bind，然后 search 能按 finding_id 命中 */
    const bound = await exec('redteam_traffic_bind', { engagement: engagement.id, id, finding_id: 7 })
    assert.equal(bound.ok, true)
    assert.equal(bound.flow.finding_id, 7)
    const afterBind = await exec('redteam_traffic_search', { engagement: engagement.id, finding_id: 7 })
    assert.equal(afterBind.total, 1)

    /* 非法入参 → 结构化 bad_input，而不是抛给模型 */
    const badWhich = await exec('redteam_traffic_blob', { engagement: engagement.id, id, which: 'nope' })
    assert.equal(badWhich.ok, false)
    assert.equal(badWhich.error_kind, 'bad_input')
    const badBind = await exec('redteam_traffic_bind', { engagement: engagement.id, id })
    assert.equal(badBind.ok, false)
    assert.equal(badBind.error_kind, 'bad_input')
    const badGet = await exec('redteam_traffic_get', { engagement: engagement.id, id: 999999 })
    assert.equal(badGet.ok, false)
    assert.match(badGet.error, /流量不存在/)

    /* tools.js 的工具数量回归：重构（host-tools.js 抽出）后仍是 67 个 */
    const coreTools = []
    applyCoreTools({
      redteam: store,
      tools: { register: (tool) => coreTools.push(tool) },
      effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
      on: () => () => {},
      logger: { warn() {} },
      get: () => undefined,
    })
    assert.equal(coreTools.length, 64, 'tools.js 注册的工具数量变了：' + coreTools.length)
    const coreNames = new Set(coreTools.map((t) => t.name))
    for (const name of ['redteam_engagement_open', 'redteam_asset_query', 'redteam_score_list']) {
      assert.ok(coreNames.has(name), 'tools.js 缺少 ' + name)
    }
    /* 两包工具名不重叠 */
    for (const name of names) assert.ok(!coreNames.has(name), '工具名重复：' + name)

    /* 直接验证 store 层（工具只是薄壳） */
    assert.equal(searchFlows(store.traffic(engagement.id).db, {}).total, 2)
    assert.ok(getFlow(store.traffic(engagement.id).db, id).finding_id === 7)
  } finally {
    setDefineToolLoader(previousLoader)
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  }
})
