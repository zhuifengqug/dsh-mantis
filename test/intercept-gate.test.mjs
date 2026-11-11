/**
 * P3c 审批门（intercept 规则 + 待批队列 + 代理接线）的单测。
 *
 * 覆盖验收三条：
 *   1. 命中规则 → 挂起为待批 → 放行 / 拒绝，谁批、何时、理由都落库；
 *   2. 代理层闭环：403 + x-mantis-intercept 头 + pending id → 面板放行 → 原样重试 200；
 *   3. 非命中流量不被阻塞（照常转发、不产生任何待批记录）。
 *
 * 另外覆盖：deny 规则优先、一次性放行消费后重新排队、ttl 放行过期后重新排队、
 * 智能体自批在 agentDecide=false 时被挡回面板（approval_required）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RedteamStore } from '../lib/redteam/store-core.js'
import { startMitmProxy, stopAllProxies } from '../lib/redteam/proxy.js'
import { writeInterceptConfig } from '../lib/redteam/intercept.js'
import { apply as applyTrafficTools, setDefineToolLoader } from '../lib/redteam/tools-traffic.js'

function fresh(tag) {
  const root = mkdtempSync(join(tmpdir(), 'mantis-intercept-' + tag + '-'))
  mkdirSync(join(root, 'assets', 'demo'), { recursive: true })
  const store = new RedteamStore(root)
  const engagement = store.openEngagement('t11 审批门测试靶标', [], { bindCurrent: false })
  return { root, store, engagement, api: store.intercept(engagement.id) }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** 明文 HTTP 经代理：path 用 absolute-form（真实代理就是这么发的）。 */
function proxyHttp(proxy, targetUrl, options = {}) {
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
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch { /* 非 JSON 响应（放行到靶标时） */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/* ────────────────────────────── 1. 规则判定 ────────────────────────────── */

test('规则匹配：命中挂起、deny 优先、非命中放行、一次性与 ttl 语义', () => {
  const { root, store, api } = fresh('rules')
  try {
    writeInterceptConfig(root, { mode: 'on', rules: [] })
    api.saveRule({ id: 'r-admin', path: '*/admin*', note: '后台操作' })
    api.saveRule({ id: 'r-del', method: 'DELETE', effect: 'deny', note: '禁止删除' })

    /* 命中 require_approval → 挂起 */
    const first = api.check({ method: 'GET', url: 'http://a.test/admin/users' })
    assert.equal(first.action, 'block')
    assert.equal(first.matched, true)
    assert.equal(first.effect, 'require_approval')
    assert.equal(first.pending.state, 'pending')
    assert.equal(first.pending.rule_id, 'r-admin')
    assert.equal(api.pending(), 1)

    /* 同一「规则 + 方法 + URL」重试：复用同一行，不重复排队 */
    const again = api.check({ method: 'GET', url: 'http://a.test/admin/users' })
    assert.equal(again.pending.id, first.pending.id)
    assert.equal(api.pending(), 1)

    /* 非命中：放行，且不产生任何待批记录 */
    const clean = api.check({ method: 'GET', url: 'http://a.test/public/index.html' })
    assert.equal(clean.action, 'pass')
    assert.equal(clean.matched, false)
    assert.equal(api.pending(), 1, '非命中流量不该进队列')

    /* deny 规则：直接拒，留痕 decided_by=rule:<id> */
    const denied = api.check({ method: 'DELETE', url: 'http://a.test/api/item/3' })
    assert.equal(denied.action, 'block')
    assert.equal(denied.effect, 'deny')
    assert.equal(denied.pending.state, 'rejected')
    assert.equal(denied.pending.decided_by, 'rule:r-del')
    assert.equal(denied.pending.decision_reason, '禁止删除')

    /* deny 优先：DELETE /admin/x 同时命中 r-admin(require) 与 r-del(deny) → deny 胜 */
    const both = api.check({ method: 'DELETE', url: 'http://a.test/admin/x' })
    assert.equal(both.effect, 'deny')

    /* 放行（一次性）：重试通过一次，第二次重新排队 */
    const allowed = api.decide({ pending_id: first.pending.id, decision: 'allow', reason: '客户书面授权' }, { decidedBy: 'panel' })
    assert.equal(allowed.state, 'approved')
    assert.equal(allowed.scope, 'once')
    assert.equal(allowed.expires_at, null)
    assert.equal(allowed.decided_by, 'panel')
    assert.match(allowed.decided_at, /^\d{4}-\d{2}-\d{2}T/)

    const consumed = api.check({ method: 'GET', url: 'http://a.test/admin/users' })
    assert.equal(consumed.action, 'pass')
    assert.equal(consumed.consumed, true)
    assert.equal(api.get(first.pending.id).decision_count, 1)
    assert.match(String(api.get(first.pending.id).consumed_at), /^\d{4}-/)

    const requeued = api.check({ method: 'GET', url: 'http://a.test/admin/users' })
    assert.equal(requeued.action, 'block')
    assert.equal(requeued.pending.state, 'pending')
    assert.notEqual(requeued.pending.id, first.pending.id, '一次性放行消费后应重新排队')
    assert.match(requeued.pending.note, /一次性/)

    /* 拒绝后重试：挡下并带出拒绝理由 */
    const p2 = api.check({ method: 'POST', url: 'http://a.test/admin/export' })
    api.decide({ pending_id: p2.pending.id, decision: 'deny', reason: '不在授权范围' }, { decidedBy: 'panel' })
    const afterDeny = api.check({ method: 'POST', url: 'http://a.test/admin/export' })
    assert.equal(afterDeny.action, 'block')
    assert.match(afterDeny.reason, /已被拒绝：不在授权范围/)

    /* ttl 放行：有效期内反复通过，过期后重新排队 */
    writeInterceptConfig(root, { mode: 'on', rules: [] })
    const t = api.check({ method: 'GET', url: 'http://a.test/admin/ttl' })
    const ttlOk = api.decide({ pending_id: t.pending.id, decision: 'allow', reason: '限时排障', ttlSeconds: 60 })
    assert.equal(ttlOk.scope, 'ttl')
    assert.match(ttlOk.expires_at, /^\d{4}-/)
    assert.equal(api.check({ method: 'GET', url: 'http://a.test/admin/ttl' }, { now: Date.now() + 1000 }).action, 'pass')
    assert.equal(api.check({ method: 'GET', url: 'http://a.test/admin/ttl' }, { now: Date.now() + 1000 }).action, 'pass', 'ttl 内可反复放行')
    const expired = api.check({ method: 'GET', url: 'http://a.test/admin/ttl' }, { now: Date.now() + 120000 })
    assert.equal(expired.action, 'block')
    assert.match(expired.pending.note, /过期/)

    /* 非法决策一律抛错，不静默 */
    assert.throws(() => api.decide({ pending_id: t.pending.id, decision: 'allow', reason: 'x' }), /已经处理过/)
    assert.throws(() => api.decide({ pending_id: 999999, decision: 'allow', reason: 'x' }), /不存在/)
    assert.throws(() => api.decide({ pending_id: t.pending.id, decision: 'maybe', reason: 'x' }), /decision/)
    assert.throws(() => api.decide({ pending_id: t.pending.id, decision: 'allow', reason: '   ' }), /reason 必填/)

    /* mode=off：不拦任何东西（审批门坏了自己消失，别拦死全网） */
    writeInterceptConfig(root, { mode: 'off' })
    assert.equal(api.check({ method: 'GET', url: 'http://a.test/admin/users' }).action, 'pass')
    /* force=true 可忽略 mode 只验规则 */
    assert.equal(api.check({ method: 'GET', url: 'http://a.test/admin/users' }, { force: true }).action, 'block')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/* ────────────────────────────── 2. 代理闭环 ────────────────────────────── */

test('代理闭环：403 挂起 → 放行后原样重试 200 → 拒绝继续挡 → 非命中直通', async () => {
  const { root, store, engagement, api } = fresh('proxy')
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('target:' + req.url)
  })
  let proxy = null
  try {
    const targetPort = await listen(target)
    const base = 'http://127.0.0.1:' + targetPort

    writeInterceptConfig(root, { mode: 'on', rules: [] })
    api.saveRule({ id: 'r-admin', path: '*/admin*', note: '后台操作' })

    proxy = await startMitmProxy({
      root, dir: store.dirOf(engagement.id), db: api.db,
      port: 18081, portMax: 18099, caDir: join(root, 'ca'),
      gate: api.gate({ ttlMs: 0 }),
    })

    /* 命中 → 403，头里带 pending id */
    const blocked = await proxyHttp(proxy, base + '/admin/list')
    assert.equal(blocked.status, 403)
    assert.equal(blocked.headers['x-mantis-intercept'], 'pending')
    assert.equal(blocked.json.error_kind, 'approval_required')
    assert.equal(blocked.json.rule_id, 'r-admin')
    assert.ok(Number(blocked.json.intercept_pending_id) > 0)

    const queue = api.list({})
    assert.equal(queue.total, 1)
    assert.equal(queue.items[0].state, 'pending')
    assert.equal(queue.items[0].method, 'GET')
    assert.equal(queue.items[0].path, '/admin/list')

    /* 面板放行 → 原样重试 200 */
    api.decide({ pending_id: queue.items[0].id, decision: 'allow', reason: '已获客户授权' }, { decidedBy: 'panel' })
    const passed = await proxyHttp(proxy, base + '/admin/list')
    assert.equal(passed.status, 200)
    assert.equal(passed.body, 'target:/admin/list')
    assert.equal(passed.headers['x-mantis-intercept'], undefined)
    const row = api.get(queue.items[0].id)
    assert.equal(row.state, 'approved')
    assert.equal(row.decided_by, 'panel')
    assert.equal(row.decision_reason, '已获客户授权')
    assert.match(String(row.consumed_at), /^\d{4}-/)

    /* 拒绝 → 重试仍 403，并带出拒绝理由 */
    const block2 = await proxyHttp(proxy, base + '/admin/export')
    assert.equal(block2.status, 403)
    api.decide({ pending_id: block2.json.intercept_pending_id, decision: 'deny', reason: '不允许导数据' }, { decidedBy: 'panel' })
    const denied = await proxyHttp(proxy, base + '/admin/export')
    assert.equal(denied.status, 403)
    assert.equal(denied.headers['x-mantis-intercept'], 'pending')
    assert.match(String(denied.json.hint), /已被拒绝：不允许导数据/)

    /* deny 规则 → 403 intercept_denied */
    api.saveRule({ id: 'r-del', method: 'DELETE', effect: 'deny', note: '禁止删除' })
    const del = await proxyHttp(proxy, base + '/api/item/9', { method: 'DELETE' })
    assert.equal(del.status, 403)
    assert.equal(del.headers['x-mantis-intercept'], 'denied')
    assert.equal(del.json.error_kind, 'intercept_denied')
    assert.match(String(del.json.hint), /禁止删除/)

    /* 非命中：照常转发，队列不增加 */
    const pendingBefore = api.pending()
    const pub = await proxyHttp(proxy, base + '/public/index.html')
    assert.equal(pub.status, 200)
    assert.equal(pub.body, 'target:/public/index.html')
    assert.equal(api.pending(), pendingBefore, '非命中流量不该产生待批记录')

    /* 拦下的与被放行的都应该在流量库里留痕（status 分别为 403 / 200） */
    await proxy.flush()
    const flows = store.traffic(engagement.id).search({ q: '/public/index.html' })
    assert.equal(flows.total, 1)
    assert.equal(flows.items[0].status, 200)
    const blockedFlows = store.traffic(engagement.id).search({ q: '/admin/list' })
    assert.equal(blockedFlows.total, 2, '一次被拦 + 一次放行通过，各一条')
    assert.deepEqual(blockedFlows.items.map((i) => i.status).sort(), [200, 403])
  } finally {
    if (proxy) await proxy.stop()
    stopAllProxies()
    await new Promise((resolve) => target.close(resolve))
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/* ────────────────────────────── 3. 工具层 ────────────────────────────── */

test('工具层：rule/check/decide 走真实 store，agentDecide=false 时自批被挡回面板', async () => {
  const previousLoader = setDefineToolLoader((spec) => spec)
  const { root, store, engagement, api } = fresh('tools')
  try {
    writeInterceptConfig(root, { mode: 'on', rules: [], agentDecide: false })

    const tools = []
    applyTrafficTools({
      redteam: store,
      tools: { register: (tool) => tools.push(tool) },
      effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
      on: () => () => {},
      logger: { warn() {} },
    })
    const byName = new Map(tools.map((t) => [t.name, t]))
    const exec = async (name, args) => JSON.parse(await byName.get(name).execute(args, { agent: { session: 'sess-test' } }))

    /* rule add / list */
    const added = await exec('redteam_intercept_rule', {
      engagement: engagement.id, action: 'add', id: 'r-admin', path: '*/admin*', note: '后台操作',
    })
    assert.equal(added.ok, true)
    assert.equal(added.rule.id, 'r-admin')
    const listed = await exec('redteam_intercept_rule', { engagement: engagement.id, action: 'list' })
    assert.equal(listed.mode, 'on')
    assert.equal(listed.rules.filter((r) => r.source === 'db').length, 1)

    /* check → 挂起 */
    const checked = await exec('redteam_intercept_check', {
      engagement: engagement.id, method: 'GET', url: 'http://a.test/admin/users',
    })
    assert.equal(checked.ok, true)
    assert.equal(checked.action, 'block')
    assert.equal(checked.effect, 'require_approval')
    assert.equal(checked.state, 'pending')
    assert.ok(checked.pending_id > 0)

    /* agentDecide=false → 自批被挡，返回 approval_required（不是抛错） */
    const blocked = await exec('redteam_intercept_decide', {
      engagement: engagement.id, pending_id: checked.pending_id, decision: 'allow', reason: '图快',
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error_kind, 'approval_required')
    assert.match(String(blocked.hint), /面板/)
    assert.equal(api.get(checked.pending_id).state, 'pending', '被挡回时不得改状态')

    /* 人把 agentDecide 打开（面板/文件）→ 工具才生效 */
    writeInterceptConfig(root, { agentDecide: true })
    const decided = await exec('redteam_intercept_decide', {
      engagement: engagement.id, pending_id: checked.pending_id, decision: 'approve', reason: '客户授权',
    })
    assert.equal(decided.ok, true)
    assert.equal(decided.state, 'approved')
    assert.equal(decided.decided_by, 'agent:sess-test')

    /* 放行后 check 同一请求 → pass */
    const afterApprove = await exec('redteam_intercept_check', {
      engagement: engagement.id, method: 'GET', url: 'http://a.test/admin/users',
    })
    assert.equal(afterApprove.action, 'pass')
    assert.equal(afterApprove.consumed, true)

    /* disable → 规则不再命中；enable 后再命中 */
    const disabled = await exec('redteam_intercept_rule', { engagement: engagement.id, action: 'disable', id: 'r-admin' })
    assert.equal(disabled.ok, true)
    const passNoRule = await exec('redteam_intercept_check', {
      engagement: engagement.id, method: 'POST', url: 'http://a.test/admin/other',
    })
    assert.equal(passNoRule.action, 'pass')
    await exec('redteam_intercept_rule', { engagement: engagement.id, action: 'enable', id: 'r-admin' })
    const hitAgain = await exec('redteam_intercept_check', {
      engagement: engagement.id, method: 'POST', url: 'http://a.test/admin/other',
    })
    assert.equal(hitAgain.action, 'block')

    /* remove → 队列里的待批仍在，但规则没了不再新增 */
    const removed = await exec('redteam_intercept_rule', { engagement: engagement.id, action: 'remove', id: 'r-admin' })
    assert.equal(removed.deleted, true)
    assert.equal((await exec('redteam_intercept_rule', { engagement: engagement.id, action: 'list' })).rules.filter((r) => r.source === 'db').length, 0)

    /* 非法入参 → 结构化 bad_input */
    const bad = await exec('redteam_intercept_check', { engagement: engagement.id, url: 'http://a.test/x' })
    assert.equal(bad.ok, false)
    assert.equal(bad.error_kind, 'bad_input')
    const badDecide = await exec('redteam_intercept_decide', { engagement: engagement.id, pending_id: checked.pending_id, decision: 'allow', reason: '' })
    assert.equal(badDecide.ok, false)
    assert.equal(badDecide.error_kind, 'bad_input')
  } finally {
    setDefineToolLoader(previousLoader)
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
