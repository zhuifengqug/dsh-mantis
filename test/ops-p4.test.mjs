/**
 * ARTEX P4 · 报告/复测/通知/归档/任务模板/调度（设计 §3，测试清单 §5.3）
 *
 * 覆盖：
 *   1. 11 个 redteam_* P4 工具：每个成功路径 + 非法入参 bad_input；
 *   2. §5.3 ① archiveSet 后写类 dispatch op 返回 error_kind:'archived'，
 *      读 op / report_build / retest_conclude 正常，解除后恢复；
 *   3. §5.3 ② retest_conclude 三态与 vuln.status 联动（含 reproduced→'open'
 *      这个不在 VULN_STATUSES 白名单里的值，必须直接 SQL 才生效）；
 *   4. §5.3 ③ template_apply 默认不覆盖 / force:true 覆盖 / 用户模板遮蔽随包；
 *   5. §5.3 ④ schedule 到期计数并入 wakeStats 的 scheduled_due，消费后转 done；
 *   6. §5.3 ⑤ notify_send 未配置 urls → ok:false 且 requests_made 恒为 0；
 *   7. 验收硬约束：不发外网、不新增外部依赖、不对外部系统发起真实写入
 *      （静态源码断言 + notify 占位行为 + 报告只落本机临时目录）；
 *   8. 工具清单数量自检（64 基线 + 探索工具集 + 11 个 P4 工具）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DDL } from '../lib/redteam/schema.js'
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'
import { setDefineToolLoader } from '../lib/redteam/host-tools.js'
import { apply as applyCoreTools, EXPLORE_TOOL_NAMES, OPS_TOOL_NAMES } from '../lib/redteam/tools.js'
import * as ops from '../lib/redteam/ops.js'
import { notifyConfigOf, saveNotifyConfig, NOTIFY_EVENTS } from '../lib/redteam/settings.js'

/* ---------- 夹具 ---------- */

function dbFixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)
  return db
}

function seedVuln(db, status = 'confirmed') {
  return Number(db.prepare('INSERT INTO vuln (title, severity, status, target) VALUES (?,?,?,?)')
    .run('示例漏洞', 'high', status, '10.0.0.5').lastInsertRowid)
}

function seed(store, id) {
  const db = store.db(id)
  const vulnId = seedVuln(db)
  const retestId = Number(db.prepare('INSERT INTO retest (vuln_id, status, reason, requested_at) VALUES (?,?,?,?)')
    .run(vulnId, 'pending', '初始复测', new Date().toISOString()).lastInsertRowid)
  return { vulnId, retestId }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'mantis-ops-p4-'))
  const store = new RedteamStore(root)
  const engagement = store.openEngagement('P4 基础能力靶标', [], { bindCurrent: false })
  const previousLoader = setDefineToolLoader((spec) => spec)
  const tools = []
  applyCoreTools({
    redteam: store,
    tools: { register: (tool) => tools.push(tool) },
    effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
    on: () => () => {},
    logger: { warn() {} },
    get: () => undefined,
  })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  const exec = async (name, args) => JSON.parse(await byName[name].execute(args || {}, {}))
  const s = { ...seed(store, engagement.id), engagement: engagement.id }
  return {
    root, store, tools, byName, exec, s, engagement,
    close() {
      setDefineToolLoader(previousLoader)
      try { store.close() } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const L = { limit: -1 } // 通用非法入参（optLimit 统一校验）

/* ---------- 1. 11 个工具：成功路径 + 非法入参 ---------- */

const CASES = [
  {
    name: 'redteam_report_build',
    ok: () => ({ kind: 'final' }),
    check: (r) => {
      assert.equal(r.kind, 'final')
      assert.ok(r.report_id > 0)
      assert.ok(Array.isArray(r.sections) && r.sections.length >= 2)
      assert.ok(r.path.endsWith('.md'))
    },
    bad: () => ({ kind: 'nope' }),
  },
  {
    name: 'redteam_retest_request',
    ok: (s) => ({ vuln_ids: [s.vulnId], reason: '复核漏洞是否修复' }),
    check: (r) => { assert.ok(r.retest_ids.length === 1); assert.equal(r.requested, 1) },
    bad: () => ({}),
  },
  {
    name: 'redteam_retest_list',
    ok: () => ({}),
    check: (r) => { assert.ok(Array.isArray(r.items)); assert.ok(r.items.length >= 1) },
    bad: () => ({ status: 'nope' }),
  },
  {
    name: 'redteam_retest_conclude',
    ok: (s) => ({ id: s.retestId, conclusion: 'fixed', note: '已修复' }),
    check: (r) => { assert.equal(r.retest.status, 'done'); assert.equal(r.retest.conclusion, 'fixed'); assert.equal(r.vuln_status, 'fixed') },
    bad: () => ({ id: 999999, conclusion: 'fixed' }),
  },
  {
    name: 'redteam_notify_send',
    ok: () => ({ event: 'report_built', text: '报告已生成', extra: { authorization: 'Bearer x', cookie: 'sid=1' } }),
    expectOk: false, // 未配置 urls：结构化失败（§5.3 ⑤）
    check: (r) => {
      assert.equal(r.error_kind, 'failed')
      assert.equal(r.stub, true)
      assert.equal(r.requests_made, 0)
      assert.deepEqual(r.delivered, [])
      assert.equal(r.extra.authorization, '[REDACTED]')
      assert.equal(r.extra.cookie, '[REDACTED]')
    },
    bad: () => ({ event: 'nope', text: 'x' }),
  },
  {
    name: 'redteam_notify_test',
    ok: () => ({}),
    check: (r) => {
      assert.equal(r.stub, true)
      assert.equal(r.requests_made, 0)
      assert.equal(r.config.enabled, false)
      assert.equal(r.config.urls, 0)
    },
    bad: () => L,
  },
  {
    name: 'redteam_template_list',
    ok: () => ({}),
    check: (r) => {
      assert.ok(r.items.length >= 2)
      assert.ok(r.items.some((t) => t.name === 'default' && t.source === 'bundled'))
      assert.ok(r.items.some((t) => t.name === 'web'))
    },
    bad: () => L,
  },
  {
    name: 'redteam_template_apply',
    ok: () => ({ template: 'default' }),
    check: (r) => {
      assert.ok(r.goal_id > 0)
      assert.equal(r.constraints_added, 2)
      assert.equal(r.score_hints_added, 2)
    },
    bad: () => ({ template: 'nope' }),
  },
  {
    name: 'redteam_template_save',
    ok: () => ({ name: 'tpl1', goal_title: '起场目标', goal_body: '正文' }),
    check: (r) => {
      assert.equal(r.name, 'tpl1')
      assert.ok(existsSync(r.path))
      assert.equal(JSON.parse(readFileSync(r.path, 'utf8')).goal.title, '起场目标')
    },
    bad: () => ({ name: 'bad name!', goal_title: 'x' }),
  },
  {
    name: 'redteam_schedule_add',
    ok: () => ({ kind: 'retest', run_at: '2020-01-01T00:00:00.000Z', params: { vuln_id: 1 } }),
    check: (r) => { assert.ok(r.id > 0) },
    bad: () => ({ kind: 'nope', run_at: '2020-01-01' }),
  },
  {
    name: 'redteam_schedule_list',
    ok: () => ({}),
    check: (r) => { assert.ok(Array.isArray(r.items)) },
    bad: () => ({ status: 'nope' }),
  },
]

assert.equal(CASES.length, OPS_TOOL_NAMES.length, 'CASES 必须覆盖每个 P4 工具')

for (const c of CASES) {
  test('工具 ' + c.name + '：成功路径 + 非法入参 bad_input', async () => {
    const h = harness()
    try {
      const okRes = await h.exec(c.name, { engagement: h.s.engagement, ...c.ok(h.s) })
      if (c.expectOk === false) {
        assert.equal(okRes.ok, false, c.name + ' 应返回结构化失败：' + JSON.stringify(okRes))
      } else {
        assert.equal(okRes.ok, true, c.name + ' 成功路径返回：' + JSON.stringify(okRes))
      }
      if (c.check) await c.check(okRes, h.s, h.exec)

      const badRes = await h.exec(c.name, { engagement: h.s.engagement, ...c.bad(h.s) })
      assert.equal(badRes.ok, false, c.name + ' 非法入参未被拒绝：' + JSON.stringify(badRes))
      assert.equal(badRes.error_kind, 'bad_input', c.name + ' 错误种类：' + JSON.stringify(badRes))
    } finally {
      h.close()
    }
  })
}

/* ---------- 2. §5.3 ① 归档写保护 ---------- */

test('§5.3 ① archiveSet 后写类 dispatch op 返回 archived；读 op / report_build / 复测结论正常', async () => {
  const h = harness()
  try {
    const id = h.s.engagement
    /* 未归档：写类 op 不被拦 */
    assert.notEqual(dispatch(h.store, { op: 'addVuln', engagement: id, title: '归档前' }).error_kind, 'archived')

    const set = dispatch(h.store, { op: 'archiveSet', engagement: id, archived: true, note: '演练收口' })
    assert.equal(set.ok, true)
    assert.equal(set.archived, true)
    assert.equal(set.archive_note, '演练收口')
    assert.ok(set.archived_at)

    /* 归档位：只追加/替换三行，engagement.yaml 其余行原样保留 */
    const raw = readFileSync(h.store.metaPathOf(id), 'utf8')
    assert.match(raw, /target_name: P4 基础能力靶标/)
    assert.match(raw, /status: active/)
    assert.equal((raw.match(/^archived:/gm) || []).length, 1, '归档位不得重复追加')
    assert.equal(h.store.listEngagements().find((e) => e.id === id).archived, true)

    /* 写类 op 被拦 */
    const blocked = dispatch(h.store, { op: 'addVuln', engagement: id, title: '归档后' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error_kind, 'archived')
    assert.match(blocked.hint, /解除归档/)
    for (const op of ['updateVuln', 'saveScorePoint', 'addScoreHit', 'resetPrompts', 'trafficBind']) {
      assert.equal(dispatch(h.store, { op, engagement: id }).error_kind, 'archived', op + ' 应被归档拦截')
    }

    /* 读 op / 报告生成 / 复测结论不受影响 */
    assert.equal(dispatch(h.store, { op: 'assets', engagement: id }).ok, true)
    assert.equal(dispatch(h.store, { op: 'report', engagement: id }).ok, true)
    assert.equal(dispatch(h.store, { op: 'scoreReport', engagement: id }).ok, true)
    const rb = await h.exec('redteam_report_build', { engagement: id, kind: 'final' })
    assert.equal(rb.ok, true, '报告生成不受归档影响：' + JSON.stringify(rb))
    const rc = await h.exec('redteam_retest_conclude', { engagement: id, id: h.s.retestId, conclusion: 'inconclusive' })
    assert.equal(rc.ok, true, '复测结论不受归档影响：' + JSON.stringify(rc))

    /* 写类工具（guarded）经同一守卫被拦 */
    const rq = await h.exec('redteam_retest_request', { engagement: id, all: true, reason: '归档后复测' })
    assert.equal(rq.error_kind, 'archived')
    const ta = await h.exec('redteam_template_apply', { engagement: id, template: 'default' })
    assert.equal(ta.error_kind, 'archived')
    const sa = await h.exec('redteam_schedule_add', { engagement: id, kind: 'notify', run_at: '2020-01-01' })
    assert.equal(sa.error_kind, 'archived')

    /* 全局 op 不锁死：bootstrap / openEngagement / activateEngagement / 知识库 / 平台配置 */
    for (const op of ['bootstrap', 'openEngagement', 'activateEngagement', 'pocSave', 'platformConfigSave', 'assets', 'snapshot', 'report']) {
      assert.equal(ops.archivedGuard(h.store, id, op), null, op + ' 不该被归档守卫拦')
    }
    assert.equal(ops.archivedGuard(h.store, id, 'addVuln').error_kind, 'archived')
    assert.equal(ops.archivedGuard(h.store, id, '重置prompts'), null, '未知 op 不该被误拦')

    /* 解除归档后写类 op 恢复 */
    const unset = dispatch(h.store, { op: 'archiveSet', engagement: id, archived: false })
    assert.equal(unset.archived, false)
    assert.equal(h.store.listEngagements().find((e) => e.id === id).archived, false)
    assert.notEqual(dispatch(h.store, { op: 'addVuln', engagement: id, title: '解除后' }).error_kind, 'archived')
  } finally {
    h.close()
  }
})

/* ---------- 3. §5.3 ② retest_conclude 三态联动 ---------- */

test('§5.3 ② retest_conclude 三态联动 vuln.status（fixed / reproduced→open / inconclusive）', () => {
  const db = dbFixture()
  try {
    const v = seedVuln(db)
    const req = () => ops.retestRequest(db, { vulnIds: [v], reason: '复核' }).retest_ids[0]
    const statusOf = () => db.prepare('SELECT status FROM vuln WHERE id = ?').get(v).status

    const r1 = req()
    const fixed = ops.retestConclude(db, { id: r1, conclusion: 'fixed', evidenceRef: 'http-evidence:1' })
    assert.equal(fixed.vuln_status, 'fixed')
    assert.equal(statusOf(), 'fixed')
    assert.equal(fixed.retest.status, 'done')
    assert.equal(fixed.retest.evidence_ref, 'http-evidence:1')
    assert.ok(fixed.retest.finished_at)

    const r2 = req()
    const repro = ops.retestConclude(db, { id: r2, conclusion: 'reproduced' })
    assert.equal(repro.vuln_status, 'open')
    /* 'open' 不在 store-core 的 VULN_STATUSES 白名单里，updateVuln 会吞掉它；
       这里必须直接 SQL 生效，否则复现漏洞无法回到待处理态。 */
    assert.equal(statusOf(), 'open')
    assert.ok(!['candidate', 'confirmed', 'false-positive', 'exploited', 'fixed'].includes('open'))

    const r3 = req()
    const inc = ops.retestConclude(db, { id: r3, conclusion: 'inconclusive' })
    assert.equal(inc.vuln_status, null)
    assert.equal(statusOf(), 'open', 'inconclusive 不改状态')
    assert.equal(inc.retest.conclusion, 'inconclusive')

    assert.equal(ops.retestList(db, { status: 'done' }).length, 3)
    assert.equal(ops.retestList(db, { vulnId: v }).length, 3)
    assert.equal(ops.retestRequest(db, { all: true, reason: '全量复核' }).requested, 1)
    assert.throws(() => ops.retestConclude(db, { id: 999999, conclusion: 'fixed' }), /复测记录不存在/)
    assert.throws(() => ops.retestConclude(db, { id: r1, conclusion: 'nope' }), /conclusion 非法/)
    assert.throws(() => ops.retestRequest(db, { vulnIds: [], reason: 'x' }), /vuln_ids 不能为空/)
    assert.throws(() => ops.retestRequest(db, { vulnIds: [999999], reason: 'x' }), /漏洞不存在/)
    assert.throws(() => ops.retestList(db, { status: 'nope' }), /status 非法/)
  } finally {
    db.close()
  }
})

/* ---------- 4. §5.3 ③ template_apply 覆盖语义 + 用户模板遮蔽 ---------- */

test('§5.3 ③ template_apply 默认不覆盖、force 覆盖、用户模板遮蔽随包', () => {
  const db = dbFixture()
  const root = mkdtempSync(join(tmpdir(), 'mantis-ops-p4-tpl-'))
  try {
    const spec = ops.templateResolve({ root: '/nonexistent-tpl-root', name: 'default' })
    assert.equal(spec.source, 'bundled')

    const a = ops.templateApply(db, { spec, target: 'eng-1' })
    assert.equal(a.created_exploration, true)
    assert.equal(a.constraints_added, 2)
    assert.equal(a.score_hints_added, 2)
    assert.equal(a.reused, false)

    /* 默认 force:false：复用已有 goal，约束/hint 按内容去重不重复追加 */
    const b = ops.templateApply(db, { spec, target: 'eng-1' })
    assert.equal(b.reused, true)
    assert.equal(b.goal_id, a.goal_id)
    assert.equal(b.constraints_added, 0)
    assert.equal(b.score_hints_added, 0)

    /* force:true：旧 goal 标 deleted 再建新 goal；约束/hint 无条件追加 */
    const c = ops.templateApply(db, { spec, target: 'eng-1', force: true })
    assert.equal(c.reused, false)
    assert.notEqual(c.goal_id, a.goal_id)
    assert.equal(c.constraints_added, 2)
    assert.equal(c.score_hints_added, 2)
    assert.equal(db.prepare('SELECT state FROM exploration_node WHERE id = ?').get(a.goal_id).state, 'deleted')

    /* 以 goal 为父的 hint 节点、约束、探索状态都没被破坏 */
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM exploration_node WHERE kind = 'hint' AND origin = 'score_hint'").get().n >= 2)
    assert.ok(db.prepare("SELECT COUNT(*) AS n FROM exploration_node WHERE kind = 'goal' AND state != 'deleted'").get().n === 1)

    /* 用户目录同名模板遮蔽随包 */
    const saved = ops.templateSave({
      root, name: 'default', description: '用户覆盖模板',
      goal: { title: '用户覆盖目标', body: '用户正文' },
      constraints: [{ kind: 'deny', text: '用户专属约束' }],
      score_hints: [{ stage: 'recon', point: '用户提示', hint: '做点什么' }],
    })
    assert.ok(existsSync(saved.path))
    assert.equal(ops.templateList({ root }).find((t) => t.name === 'default').source, 'user')
    const resolved = ops.templateResolve({ root, name: 'default' })
    assert.equal(resolved.source, 'user')
    assert.equal(resolved.goal.title, '用户覆盖目标')

    const db2 = dbFixture()
    try {
      const d = ops.templateApply(db2, { spec: resolved, target: 'eng-2' })
      assert.equal(db2.prepare('SELECT title FROM exploration_node WHERE id = ?').get(d.goal_id).title, '用户覆盖目标')
      const snap = ops.templateFromExploration(db2, { name: 'snap', target: 'eng-2' })
      assert.equal(snap.goal.title, '用户覆盖目标')
      assert.equal(snap.constraints.length, 1)
      assert.equal(snap.constraints[0].text, '用户专属约束')
      assert.equal(snap.score_hints.length, 1)
    } finally {
      db2.close()
    }

    assert.throws(() => ops.templateResolve({ root, name: 'bad name!' }), /template 非法/)
    assert.throws(() => ops.templateResolve({ root, name: 'not-exist' }), /模板不存在/)
    assert.throws(() => ops.templateSave({ root, name: 'ok', goal: { title: '' } }), /goal.title 不能为空/)
    assert.throws(() => ops.templateFromExploration(dbFixture(), { name: 'x' }), /探索不存在/)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

/* ---------- 5. §5.3 ④ schedule 到期计数进 wakeStats ---------- */

test('§5.3 ④ schedule 到期计数并入 wakeStats.scheduled_due；消费后行转 done', async () => {
  const db = dbFixture()
  try {
    const past = '2020-01-01T00:00:00.000Z'
    const future = '2999-01-01T00:00:00.000Z'
    const s1 = ops.scheduleAdd(db, { kind: 'retest', runAt: past, params: { vuln_id: 1 } }).id
    const s2 = ops.scheduleAdd(db, { kind: 'report', runAt: future }).id
    assert.equal(ops.scheduledDue(db), 1)
    assert.equal(ops.scheduleList(db, { status: 'due' }).length, 2, '两条都是 due 状态')
    assert.equal(ops.scheduleList(db, { status: 'done' }).length, 0)
    assert.equal(ops.decorateWake(db, { planner: true, reason: 'graph_changed' }).scheduled_due, 1)

    assert.equal(ops.consumeSchedule(db, s1), true)
    assert.equal(ops.scheduledDue(db), 0)
    assert.equal(ops.consumeSchedule(db, s1), false, '重复消费返回 false')
    assert.equal(ops.scheduleList(db, { status: 'done' }).length, 1)
    assert.ok(ops.scheduleList(db, { status: 'done' })[0].consumed_at)
    assert.equal(ops.scheduleList(db, { status: 'due' })[0].id, s2)

    assert.throws(() => ops.scheduleAdd(db, { kind: 'nope', runAt: past }), /kind 非法/)
    assert.throws(() => ops.scheduleAdd(db, { kind: 'notify', runAt: '' }), /run_at 不能为空/)
    assert.throws(() => ops.scheduleList(db, { status: 'nope' }), /status 非法/)
    assert.throws(() => ops.consumeSchedule(db, -1), /id 非法/)
  } finally {
    db.close()
  }

  /* store-core 的 exploration(id) 绑定已挂 decorateWake，decisionOf 四分支不受影响 */
  const h = harness()
  try {
    const db = h.store.db(h.s.engagement)
    ops.scheduleAdd(db, { kind: 'notify', runAt: '2020-01-01T00:00:00.000Z' })
    const api = h.store.exploration(h.s.engagement)
    const eid = api.active() ? Number(api.active().id) : 1
    const ws = api.wakeStats(eid)
    assert.equal(ws.scheduled_due, 1)
    assert.equal(api.wake(eid, 'graph_changed').scheduled_due, 1)
    assert.equal(api.decisionOf(ws, 3), 'replan', '追加字段不得改变 decisionOf 四分支')
    assert.equal(dispatch(h.store, { op: 'scheduledDue', engagement: h.s.engagement }).scheduled_due, 1)
    assert.equal(dispatch(h.store, { op: 'exploreDue', engagement: h.s.engagement }).scheduled_due, 1)
    assert.equal(dispatch(h.store, { op: 'scheduleList', engagement: h.s.engagement }).items.length, 1)
    assert.equal(dispatch(h.store, { op: 'reportList', engagement: h.s.engagement }).items.length, 0)
    assert.ok(dispatch(h.store, { op: 'templateList' }).items.length >= 2)
  } finally {
    h.close()
  }
})

/* ---------- 6. §5.3 ⑤ 通知严格占位 + 脱敏 + 截断 ---------- */

test('§5.3 ⑤ notify_send 未配置 urls → ok:false；配置后仍是 stub，requests_made 恒为 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mantis-ops-p4-notify-'))
  try {
    const cfg = notifyConfigOf(root)
    assert.equal(cfg.enabled, false)
    assert.deepEqual(cfg.urls, [])
    assert.deepEqual(cfg.events, [...NOTIFY_EVENTS])

    const r = ops.notifySend(cfg, {
      event: 'report_built', text: '报告已生成',
      extra: { authorization: 'Bearer secret', cookie: 'sid=1', nested: { password: 'p', api_key: 'k', safe: 'ok' } },
    })
    assert.equal(r.ok, false)
    assert.equal(r.error_kind, 'failed')
    assert.equal(r.stub, true)
    assert.equal(r.requests_made, 0)
    assert.deepEqual(r.delivered, [])
    assert.equal(r.extra.authorization, '[REDACTED]')
    assert.equal(r.extra.cookie, '[REDACTED]')
    assert.equal(r.extra.nested.password, '[REDACTED]')
    assert.equal(r.extra.nested.api_key, '[REDACTED]')
    assert.equal(r.extra.nested.safe, 'ok')
    /* 脱敏返回新对象，不改入参 */
    const input = { token: 't' }
    assert.equal(ops.redactNotify(input).token, '[REDACTED]')
    assert.equal(input.token, 't')

    /* 正文截断 4KB */
    const clipped = ops.notifySend(cfg, { event: 'report_built', text: 'x'.repeat(9000) })
    assert.ok(clipped.text.length < 4200)
    assert.match(clipped.text, /truncated/)

    assert.throws(() => ops.notifySend(cfg, { event: '', text: 'x' }), /event 不能为空/)
    assert.throws(() => ops.notifySend(cfg, { event: 'nope', text: 'x' }), /event 非法/)

    /* 面板配置 urls 后仍绝不发真实请求：delivered 全是 stub / real:false */
    const saved = saveNotifyConfig(root, { enabled: true, urls: ['http://127.0.0.1:9/hook'], events: ['report_built'] })
    assert.equal(saved.enabled, true)
    assert.equal(saved.urls.length, 1)
    assert.equal(notifyConfigOf(root).urls[0], 'http://127.0.0.1:9/hook')
    const r2 = ops.notifySend(notifyConfigOf(root), { event: 'report_built', text: 'x' })
    assert.equal(r2.ok, true)
    assert.equal(r2.stub, true)
    assert.equal(r2.requests_made, 0)
    assert.equal(r2.delivered.length, 1)
    assert.equal(r2.delivered[0].status, 'stub')
    assert.equal(r2.delivered[0].real, false)
    assert.throws(() => ops.notifySend(notifyConfigOf(root), { event: 'score_hit', text: 'x' }), /event 非法/)

    /* 配置只收白名单键，不落任何凭据字段 */
    saveNotifyConfig(root, { enabled: true, urls: ['http://127.0.0.1:9/h'], authorization: 'MUST-NOT-PERSIST', password: 'MUST-NOT-PERSIST' })
    const onDisk = readFileSync(join(root, 'settings.json'), 'utf8')
    assert.ok(!onDisk.includes('MUST-NOT-PERSIST'))
    assert.ok(!onDisk.includes('authorization'))
    assert.ok(!onDisk.includes('password'))
    assert.equal(dispatch(new RedteamStore(root), { op: 'notifyConfigGet' }).notify.enabled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  /* 工具层同样严格占位 */
  const h = harness()
  try {
    const send = await h.exec('redteam_notify_send', { engagement: h.s.engagement, event: 'retest_done', text: '复测完成' })
    assert.equal(send.ok, false)
    assert.equal(send.requests_made, 0)
    assert.equal(send.stub, true)
    const probe = await h.exec('redteam_notify_test', {})
    assert.equal(probe.ok, true)
    assert.equal(probe.requests_made, 0)
    assert.equal(probe.config.enabled, false)
  } finally {
    h.close()
  }
})

/* ---------- 7. 报告：只写本机文件 + report_run 一行，不改业务数据 ---------- */

test('report_build 四种 kind 都落本机 md + report_run 一行；业务数据零改动', () => {
  const reportsDir = mkdtempSync(join(tmpdir(), 'mantis-ops-p4-reports-'))
  const db = dbFixture()
  try {
    seedVuln(db)
    const before = {
      vuln: db.prepare('SELECT COUNT(*) AS n FROM vuln').get().n,
      nodes: db.prepare('SELECT COUNT(*) AS n FROM exploration_node').get().n,
      assets: db.prepare('SELECT COUNT(*) AS n FROM asset').get().n,
    }
    const kinds = []
    for (const kind of ops.REPORT_KINDS) {
      const r = ops.reportBuild(db, { kind, reportsDir, createdBy: 'tester' })
      kinds.push(r)
      assert.ok(r.id > 0)
      assert.equal(r.kind, kind)
      assert.ok(r.sections.length >= 2)
      assert.ok(r.path.startsWith(reportsDir), '报告必须落在本机报告目录')
      assert.ok(existsSync(r.path), '报告文件真实存在')
      const run = db.prepare('SELECT * FROM report_run WHERE id = ?').get(r.id)
      assert.equal(run.kind, kind)
      assert.equal(run.created_by, 'tester')
      const manifest = JSON.parse(run.manifest)
      assert.match(manifest.markdown, /红队演练结构化报告/)
      assert.equal(readFileSync(r.path, 'utf8'), manifest.markdown, 'SQLite 里的结构化输出与文件一致')
    }
    assert.equal(new Set(kinds.map((k) => k.filename)).size, 4, '文件名不冲突')
    assert.equal(ops.reportList(db, {}).length, 4)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vuln').get().n, before.vuln)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exploration_node').get().n, before.nodes)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM asset').get().n, before.assets)
    assert.throws(() => ops.reportBuild(db, { kind: 'nope', reportsDir }), /kind 非法/)
    /* 目录不存在时自动创建 */
    const nested = join(reportsDir, 'a', 'b')
    const r = ops.reportBuild(db, { kind: 'score', reportsDir: nested, findingId: 1 })
    assert.equal(ops.reportFileExists(r.path), true)
    mkdirSync(nested, { recursive: true })
  } finally {
    db.close()
    rmSync(reportsDir, { recursive: true, force: true })
  }
})

/* ---------- 8. 归档位读写：不破坏 engagement.yaml 其它行 ---------- */

test('readArchived / writeArchived 保留非归档行，重复写不叠加，解除后归档位为 false', () => {
  const root = mkdtempSync(join(tmpdir(), 'mantis-ops-p4-meta-'))
  try {
    const meta = join(root, 'engagement.yaml')
    writeFileSync(meta, 'target_name: 靶标A\nscope_cidrs: [10.0.0.0/24]\nstatus: active\ncreated_at: 2026-01-01\n', 'utf8')
    assert.equal(ops.readArchived(meta).archived, false)

    ops.writeArchived(meta, { archived: true, note: '演练收口', now: '2026-11-11T00:00:00.000Z' })
    let raw = readFileSync(meta, 'utf8')
    assert.match(raw, /target_name: 靶标A/)
    assert.match(raw, /scope_cidrs: \[10\.0\.0\.0\/24\]/)
    assert.match(raw, /status: active/)
    assert.match(raw, /created_at: 2026-01-01/)
    assert.equal((raw.match(/^archived:/gm) || []).length, 1)
    assert.equal(ops.readArchived(meta).archived, true)
    assert.equal(ops.readArchived(meta).archive_note, '演练收口')

    ops.writeArchived(meta, { archived: true, note: '再来一次', now: '2026-11-12T00:00:00.000Z' })
    raw = readFileSync(meta, 'utf8')
    assert.equal((raw.match(/^archived:/gm) || []).length, 1, '重复写不得叠加归档位')
    assert.equal((raw.match(/^archived_at:/gm) || []).length, 1)
    assert.equal(ops.readArchived(meta).archive_note, '再来一次')

    ops.writeArchived(meta, { archived: false, now: '2026-11-13T00:00:00.000Z' })
    assert.equal(ops.readArchived(meta).archived, false)
    assert.equal(ops.readArchived('/nonexistent/engagement.yaml').archived, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ---------- 9. 验收硬约束：不发外网 / 不新增依赖 / 不真实写外部系统 ---------- */

test('验收：ops.js / tools-ops.js 零网络出站能力、零外部依赖、通知恒占位', () => {
  const opsSrc = readFileSync(new URL('../lib/redteam/ops.js', import.meta.url), 'utf8')
  const toolSrc = readFileSync(new URL('../lib/redteam/tools-ops.js', import.meta.url), 'utf8')
  const networkImport = /^\s*import[^;]*from\s*['"](?:node:)?(?:http|https|net|tls|dgram|dns|undici|node-fetch|axios|got|ws)['"]/m
  const forbiddenCalls = ['fetch(', 'XMLHttpRequest', 'WebSocket(', 'https.request(', 'http.request(', 'net.connect(', 'tls.connect(', 'createConnection(']
  for (const [label, src] of [['ops.js', opsSrc], ['tools-ops.js', toolSrc]]) {
    assert.ok(!networkImport.test(src), label + ' 引入了网络/HTTP 模块')
    for (const bad of forbiddenCalls) {
      assert.ok(!src.includes(bad), label + ' 出现网络出站调用：' + bad)
    }
    assert.ok(!/node:child_process/.test(src), label + ' 起了子进程')
  }
  /* ops.js 只依赖 node:fs / node:path / 本地 exploration.js */
  const imports = [...opsSrc.matchAll(/^import\s[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(imports.sort(), ['./exploration.js', 'node:fs', 'node:path'])

  /* package.json 不新增外部依赖 */
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies || {}).sort(), ['yaml'], '外部依赖不得新增')

  /* notifyConfigOf 在无/坏配置下绝不抛，且默认不发 */
  const root = mkdtempSync(join(tmpdir(), 'mantis-ops-p4-cfg-'))
  try {
    writeFileSync(join(root, 'settings.json'), '{ broken json', 'utf8')
    assert.equal(notifyConfigOf(root).enabled, false)
    assert.deepEqual(notifyConfigOf(root).urls, [])
    assert.equal(ops.notifySend(notifyConfigOf(root), { event: 'report_built', text: 'x' }).requests_made, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ---------- 10. 工具清单数量自检 ---------- */

test('工具清单数量自检：64 基线 + 探索工具集 + P4 工具集，全登记且无重名', () => {
  const h = harness()
  try {
    assert.equal(h.tools.length, 64 + EXPLORE_TOOL_NAMES.length + OPS_TOOL_NAMES.length,
      'tools.js 注册总数变了：' + h.tools.length)
    const names = h.tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, '存在重复注册的工具名')
    const set = new Set(names)
    for (const name of EXPLORE_TOOL_NAMES) assert.ok(set.has(name), '缺少探索工具 ' + name)
    for (const name of OPS_TOOL_NAMES) assert.ok(set.has(name), '缺少 P4 工具 ' + name)
    for (const t of h.tools) {
      assert.equal(typeof t.execute, 'function', t.name + ' 缺 execute')
      assert.match(t.description, /[\u4e00-\u9fa5]/, t.name + ' 描述非中文')
      assert.ok(t.parameters && typeof t.parameters === 'object', t.name + ' 缺参数定义')
    }
    /* 两批新增工具互不重名、也不撞既有工具名 */
    assert.equal(new Set([...EXPLORE_TOOL_NAMES, ...OPS_TOOL_NAMES]).size,
      EXPLORE_TOOL_NAMES.length + OPS_TOOL_NAMES.length)
    for (const name of ['redteam_engagement_open', 'redteam_asset_query', 'redteam_unknown_list']) {
      assert.ok(!new Set(OPS_TOOL_NAMES).has(name), 'P4 工具名撞上既有工具：' + name)
    }
  } finally {
    h.close()
  }
})
