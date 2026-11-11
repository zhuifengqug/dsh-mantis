import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DDL } from '../lib/redteam/schema.js'
import {
  createExploration, addNode, addEdge, addConstraint, listConstraints,
  getExploration, setExplorationStatus, setNodeState, listFrontier,
} from '../lib/redteam/exploration.js'
import {
  DEFAULT_CAP, DEFAULT_STALE_MS, DEFAULT_CRITERIA, WAKE_REASONS, WORKER_TERMINAL_STATES,
  wakeStats, decisionOf, makeWake, bumpRound, plan, claimIntent, recordResult,
  requeueOrphans, staleRunning, readCriteria, proveGoal, prove, step, createEngine,
} from '../lib/redteam/engine.js'

/* ------------------------------------------------------------------ 夹具 */

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)
  return db
}

/** 建一次探索 + 一条 goal + 若干 open intent，返回 { eid, goal, intents }。 */
function seed(db, { target = 'demo', goal = '拿下后台', criteria = null, intents = ['子域枚举'] } = {}) {
  const eid = createExploration(db, { target, goal })
  const goalId = addNode(db, {
    exploration_id: eid, kind: 'goal', title: goal, body: '成功判据',
    ...(criteria ? { payload: { prove: criteria } } : {}),
  })
  const intentIds = intents.map((title, i) => addNode(db, {
    exploration_id: eid, kind: 'intent', title, parent_id: goalId, priority: 10 - i,
  }))
  return { eid, goal: goalId, intents: intentIds }
}

const nodeById = (db, id) => db.prepare('SELECT * FROM exploration_node WHERE id=?').get(Number(id))
const edgesOf = (db, eid, rel) => db.prepare(
  'SELECT * FROM exploration_edge WHERE exploration_id=? AND rel=?',
).all(Number(eid), rel)
const edgesCount = (db, eid, rel) => db.prepare(
  'SELECT COUNT(*) n FROM exploration_edge WHERE exploration_id=? AND rel=?',
).get(Number(eid), rel).n
const digestNodes = (db, eid) => db.prepare(
  "SELECT * FROM exploration_node WHERE exploration_id=? AND kind='digest' AND origin='prove_goal' ORDER BY id",
).all(Number(eid))

/* ------------------------------------------------------------------ planner 大脑 */

test('decisionOf: 设计契约四分支 + cap 边界', () => {
  assert.equal(decisionOf({ frontier_open: 2, running: 0, findings: 0 }), 'dispatch')
  assert.equal(decisionOf({ frontier_open: 0, running: 1, findings: 0 }, 3), 'dispatch')
  assert.equal(decisionOf({ frontier_open: 0, running: 3, findings: 1 }, 3), 'wait')
  assert.equal(decisionOf({ frontier_open: 0, running: 0, findings: 1 }), 'prove')
  assert.equal(decisionOf({ frontier_open: 0, running: 0, findings: 0 }), 'replan')
  // frontier 有货时优先 dispatch，不受 running 是否已满影响
  assert.equal(decisionOf({ frontier_open: 1, running: 5, findings: 0 }, 3), 'dispatch')
  // cap=1 时 running=1 已经满 → wait
  assert.equal(decisionOf({ frontier_open: 0, running: 1, findings: 0 }, 1), 'wait')
  // cap 下限保护：0/负数/NaN 都按 1 处理
  assert.equal(decisionOf({ frontier_open: 0, running: 1, findings: 0 }, 0), 'wait')
  assert.equal(DEFAULT_CAP, 3)
})

test('wakeStats / makeWake: 精确计数与回声结构', () => {
  const db = makeDb()
  const { eid } = seed(db, { intents: ['A', 'B'] })
  const [i1, i2] = listFrontier(db, eid)
  setNodeState(db, i2.id, 'running')
  addNode(db, { exploration_id: eid, kind: 'fact', title: 'f1', parent_id: i1.id })
  addNode(db, { exploration_id: eid, kind: 'finding', title: 'v1', parent_id: i1.id })
  setNodeState(db, i1.id, 'done')
  addNode(db, { exploration_id: eid, kind: 'intent', title: 'C', state: 'blocked' })

  const s = wakeStats(db, eid)
  assert.deepEqual(s, {
    frontier_open: 0, running: 1, findings: 1, facts: 1, done_intents: 1, blocked_intents: 1,
  })

  const w = makeWake(db, eid, 'finding_recorded')
  assert.equal(w.planner, true)
  assert.equal(w.reason, 'finding_recorded')
  assert.equal(w.frontier_open, 0)
  assert.equal(w.running, 1)
  assert.equal(w.findings, 1)
  // 非法 reason 回落 graph_changed；合法枚举全覆盖
  assert.equal(makeWake(db, eid, 'bogus').reason, 'graph_changed')
  for (const r of WAKE_REASONS) assert.equal(makeWake(db, eid, r).reason, r)
  db.close()
})

test('bumpRound / plan: begin 自增带 wake，brief 只读不带 wake', () => {
  const db = makeDb()
  const { eid, intents } = seed(db, { intents: ['A', 'B'] })
  claimIntent(db, intents[1], 'worker-1', 'sess-1')
  addConstraint(db, { target: 'demo', kind: 'deny', text: '禁止打生产库' })

  const begun = plan(db, eid, { begin: true, cap: 2 })
  assert.equal(begun.ok, true)
  assert.equal(begun.action, 'begin')
  assert.equal(begun.round_no, 1)
  assert.equal(getExploration(db, eid).round_no, 1)
  assert.equal(begun.wake.planner, true)
  assert.equal(begun.wake.reason, 'graph_changed')
  const b = begun.briefing
  assert.equal(b.round_no, 1)
  assert.equal(b.frontier.length, 1)
  assert.equal(b.frontier[0].id, intents[0])
  assert.equal(b.running_intents.length, 1)
  assert.equal(b.running_intents[0].id, intents[1])
  assert.equal(b.running_intents[0].stale, false)
  assert.equal(b.constraints.length, 1)
  assert.equal(b.constraints[0].kind, 'deny')
  assert.deepEqual(b.todolist, [])
  assert.equal(b.decision, 'dispatch')
  assert.deepEqual(b.stale_running, [])
  assert.equal(b.wake_stats.frontier_open, 1)
  assert.equal(b.wake_stats.running, 1)
  assert.equal(b.overview.findings, 0)

  const brief = plan(db, eid, { begin: false })
  assert.equal(brief.action, 'brief')
  assert.equal(brief.round_no, 1)
  assert.equal(getExploration(db, eid).round_no, 1)
  assert.equal(brief.wake, undefined)
  assert.equal(brief.briefing.decision, 'dispatch')

  assert.equal(bumpRound(db, eid), 2)
  assert.equal(getExploration(db, eid).round_no, 2)
  // 不存在的探索：结构化 bad_input，不抛
  assert.equal(plan(db, 999999).ok, false)
  assert.equal(plan(db, 999999).error_kind, 'bad_input')
  db.close()
})

/* ------------------------------------------------------------------ worker：领取 / 孤儿 / 超时 */

test('claimIntent CAS: 二次领取失败；requeueOrphans 后可再领，且只回自己的', () => {
  const db = makeDb()
  const { eid, intents } = seed(db, { intents: ['A', 'B'] })
  const [i1, i2] = intents

  const first = claimIntent(db, i1, 'worker-1', 'sess-1')
  assert.deepEqual(first, { claimed: true, owner: 'worker-1' })
  assert.equal(nodeById(db, i1).state, 'running')
  assert.equal(JSON.parse(nodeById(db, i1).payload).owner_session, 'sess-1')

  const second = claimIntent(db, i1, 'worker-2', 'sess-1')
  assert.deepEqual(second, { claimed: false, owner: null })
  assert.equal(nodeById(db, i1).owner, 'worker-1') // 没被抢走

  claimIntent(db, i2, 'worker-2', 'sess-2') // 另一个子会话的 running，不该被误伤
  assert.equal(requeueOrphans(db, 'sess-1'), 1)
  assert.equal(nodeById(db, i1).state, 'open')
  assert.equal(nodeById(db, i1).blocked_reason, 'worker-exit-unexpected')
  const p = JSON.parse(nodeById(db, i1).payload)
  assert.equal(p.prev_owner, 'worker-1')
  assert.equal(p.owner_session, 'sess-1')
  assert.equal(nodeById(db, i2).state, 'running') // sess-2 不受影响
  assert.equal(requeueOrphans(db, 'sess-1'), 0) // 已不是 running，不再重复修
  assert.equal(requeueOrphans(db, null), 0) // 空 session 不动任何行

  const again = claimIntent(db, i1, 'worker-3', 'sess-3')
  assert.deepEqual(again, { claimed: true, owner: 'worker-3' })
  // 自定义 reason 透传
  assert.equal(requeueOrphans(db, 'sess-3', 'subagent/end'), 1)
  assert.equal(nodeById(db, i1).blocked_reason, 'subagent/end')

  // 非 intent / 不存在节点一律 claimed:false
  const factId = addNode(db, { exploration_id: eid, kind: 'fact', title: 'f' })
  assert.equal(claimIntent(db, factId, 'w', 's').claimed, false)
  assert.equal(claimIntent(db, 999999, 'w', 's').claimed, false)
  db.close()
})

test('staleRunning: 按 updated_at 阈值挑出超时 running 意图', () => {
  const db = makeDb()
  const { eid, intents } = seed(db, { intents: ['A', 'B', 'C'] })
  claimIntent(db, intents[0], 'w', 's1')
  claimIntent(db, intents[1], 'w', 's2')
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  db.prepare('UPDATE exploration_node SET updated_at=? WHERE id=?').run(old, intents[0])
  // 第三条是 open，不该被算进超时
  assert.deepEqual(staleRunning(db, eid, DEFAULT_STALE_MS), [intents[0]])
  assert.deepEqual(staleRunning(db, eid, 24 * 60 * 60 * 1000), []) // 阈值放宽 → 无超时
  assert.equal(plan(db, eid, { begin: false, staleMs: DEFAULT_STALE_MS }).briefing.running_intents[0].stale, true)
  // 终态意图不算 running
  setNodeState(db, intents[1], 'done')
  assert.deepEqual(staleRunning(db, eid, DEFAULT_STALE_MS), [intents[0]])
  db.close()
})

test('recordResult: 写回 fact/finding/派生意图 + spawns/derived_from 边 + 资产锚 + 终态 + wake', () => {
  const db = makeDb()
  const { eid, intents } = seed(db)
  const iid = intents[0]
  claimIntent(db, iid, 'w', 's1')
  const aid = Number(db.prepare(
    "INSERT INTO asset(segment_cidr, ip) VALUES ('10.0.0.0/24','10.0.0.1')",
  ).run().lastInsertRowid)

  const rec = recordResult(db, eid, iid, {
    state: 'done',
    facts: [{ title: '发现 80 端口', provenance: 'observed', evidence: 'nmap -sV' }],
    findings: [{ title: '后台未授权访问', severity: 'high', anchor_asset_ids: [aid] }],
    intents: [{ title: '跟进后台', priority: 4 }],
  })
  assert.deepEqual(
    { facts: rec.facts, findings: rec.findings, intents: rec.intents, edges: rec.edges, anchors: rec.anchors },
    { facts: 1, findings: 1, intents: 1, edges: 2, anchors: 1 },
  )
  assert.equal(rec.state, 'done')
  assert.equal(rec.wake.reason, 'finding_recorded')
  assert.equal(rec.wake.findings, 1)
  assert.equal(nodeById(db, iid).state, 'done')

  const facts = db.prepare("SELECT * FROM exploration_node WHERE exploration_id=? AND kind='fact'").all(eid)
  const findings = db.prepare("SELECT * FROM exploration_node WHERE exploration_id=? AND kind='finding'").all(eid)
  assert.equal(facts.length, 1)
  assert.equal(findings.length, 1)
  const fp = JSON.parse(facts[0].payload)
  assert.equal(fp.provenance, 'observed')
  assert.equal(fp.evidence, 'nmap -sV')
  assert.equal(JSON.parse(findings[0].payload).severity, 'high')
  // parent_id 挂 spawns（goal→intent 1 条 + intent→fact/finding/新intent 3 条 = 4）
  assert.equal(edgesCount(db, eid, 'spawns'), 4)
  assert.equal(edgesCount(db, eid, 'derived_from'), 2)
  assert.equal(edgesOf(db, eid, 'derived_from').every((e) => e.dst_id === iid), true)
  // 资产锚与覆盖率
  const anchors = db.prepare('SELECT * FROM exploration_anchor').all()
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].asset_id, aid)
  assert.equal(anchors[0].node_id, findings[0].id)

  // 同名派生意图 dedupe：再来一次不新建
  const rec2 = recordResult(db, eid, iid, {
    state: 'done', intents: [{ title: '跟进后台', priority: 9 }, { title: '  ', priority: 1 }],
  })
  assert.equal(rec2.intents, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id=? AND kind='intent' AND title='跟进后台'").get(eid).n, 1)
  db.close()
})

test('recordResult: 非法 state 回落 done；blocked/exhausted 记 reason；空结果也收尾', () => {
  const db = makeDb()
  const { eid, intents } = seed(db, { intents: ['A', 'B'] })
  const [i1, i2] = intents
  claimIntent(db, i1, 'w', 's1')
  const r1 = recordResult(db, eid, i1, { state: 'NOT_A_STATE' })
  assert.equal(r1.state, 'done')
  assert.equal(nodeById(db, i1).state, 'done')
  assert.equal(r1.wake.reason, 'intent_state_changed')

  claimIntent(db, i2, 'w', 's1')
  const r2 = recordResult(db, eid, i2, { state: 'exhausted', reason: '字典跑完无结果', facts: [{ title: 'f' }] })
  assert.equal(r2.state, 'exhausted')
  assert.equal(nodeById(db, i2).blocked_reason, '字典跑完无结果')
  assert.equal(r2.facts, 1)
  assert.equal(r2.wake.reason, 'fact_recorded')
  assert.deepEqual(WORKER_TERMINAL_STATES, ['done', 'blocked', 'exhausted', 'stopped', 'open'])
  db.close()
})

/* ------------------------------------------------------------------ prove_goal 量化验收 */

test('readCriteria: override > goal 节点 payload.prove > 缺省三级', () => {
  const db = makeDb()
  const { eid } = seed(db)
  const fallback = readCriteria(db, eid)
  assert.deepEqual(fallback, { ...DEFAULT_CRITERIA })
  assert.notEqual(fallback, DEFAULT_CRITERIA) // 返回副本，不篡改冻结常量
  assert.equal(Object.isFrozen(DEFAULT_CRITERIA), true)

  const fromOverride = readCriteria(db, eid, { min_findings: 7, min_facts: 2 })
  assert.equal(fromOverride.min_findings, 7)
  assert.equal(fromOverride.min_facts, 2)
  assert.equal(fromOverride.min_coverage_pct, 0)
  assert.equal(fromOverride.require_no_open_intents, true)

  const db2 = makeDb()
  const { eid: eid2 } = seed(db2, { criteria: { min_findings: 3, min_coverage_pct: 60, require_no_open_intents: false } })
  const fromGoal = readCriteria(db2, eid2)
  assert.equal(fromGoal.min_findings, 3)
  assert.equal(fromGoal.min_coverage_pct, 60)
  assert.equal(fromGoal.require_no_open_intents, false)
  // override 覆盖 goal
  assert.equal(readCriteria(db2, eid2, { min_findings: 9 }).min_findings, 9)
  // 归一化：负数/越界/非数字收敛
  const norm = readCriteria(db2, eid2, { min_findings: -5, min_coverage_pct: 999, min_facts: 'junk' })
  assert.equal(norm.min_findings, 0)
  assert.equal(norm.min_coverage_pct, 100)
  assert.equal(norm.min_facts, 0)
  db.close()
  db2.close()
})

test('proveGoal: 逐条 required/actual/met + score + achieved + blockers + 覆盖率判据', () => {
  const db = makeDb()
  const { eid, intents } = seed(db, { intents: ['A', 'B'] })
  // 初始：0 finding、2 open intent → 4 条判据里 findings 与 no_open_intents 不达标
  const g0 = proveGoal(db, eid)
  assert.equal(g0.achieved, false)
  assert.equal(g0.score, 0.5)
  assert.deepEqual(g0.checks.map((c) => c.key), ['findings', 'facts', 'coverage_pct', 'no_open_intents'])
  assert.deepEqual(g0.checks.map((c) => c.met), [false, true, true, false])
  assert.equal(g0.checks[0].required, 1)
  assert.equal(g0.checks[0].actual, 0)
  assert.equal(g0.blockers.length, 2)
  assert.deepEqual(g0.blockers.map((b) => b.id), intents)

  // 把两条意图都收尾并补一个 finding → 默认判据全达标
  setNodeState(db, intents[0], 'done')
  setNodeState(db, intents[1], 'done')
  const f1 = addNode(db, { exploration_id: eid, kind: 'finding', title: 'v1' })
  const g1 = proveGoal(db, eid)
  assert.equal(g1.achieved, true)
  assert.equal(g1.score, 1)
  assert.deepEqual(g1.checks.map((c) => c.met), [true, true, true, true])
  assert.deepEqual(g1.blockers, [])

  // 覆盖率判据：插 2 个资产只锚 1 个 → coverage=50
  db.prepare("INSERT INTO asset(segment_cidr, ip) VALUES ('10.0.0.0/24','10.0.0.1')").run()
  db.prepare("INSERT INTO asset(segment_cidr, ip) VALUES ('10.0.0.0/24','10.0.0.2')").run()
  db.prepare('INSERT INTO exploration_anchor(node_id, asset_id) VALUES (?,1)').run(f1)
  const g2 = proveGoal(db, eid, { min_findings: 1, min_facts: 0, min_coverage_pct: 50, require_no_open_intents: true })
  assert.equal(g2.checks[2].actual, 50)
  assert.equal(g2.checks[2].met, true)
  assert.equal(g2.achieved, true)
  const g3 = proveGoal(db, eid, { min_findings: 1, min_facts: 0, min_coverage_pct: 60, require_no_open_intents: true })
  assert.equal(g3.checks[2].met, false)
  assert.equal(g3.achieved, false)
  assert.equal(g3.score, 0.75)
  // require_no_open_intents:false 时该项恒 met，required 记 null
  const g4 = proveGoal(db, eid, { require_no_open_intents: false, min_findings: 1 })
  assert.equal(g4.checks[3].required, null)
  assert.equal(g4.checks[3].met, true)
  db.close()
})

test('prove: 收官守卫（open intent 拒绝 / force 放行 / 量化未达成 / failed|stopped / 审计节点）', () => {
  const db = makeDb()
  const { eid, intents } = seed(db)
  const denied = prove(db, eid, { verdict: 'achieved', reason: '看着差不多了' })
  assert.equal(denied.ok, false)
  assert.equal(denied.error_kind, 'bad_input')
  assert.equal(denied.blocked_intents.length, 1)
  assert.equal(denied.blocked_intents[0].id, intents[0])
  assert.equal(denied.blocked_intents[0].state, 'open')
  assert.match(denied.hint, /force:true/)
  assert.equal(getExploration(db, eid).status, 'open') // 没写库
  assert.equal(digestNodes(db, eid).length, 0)

  // 收尾 intent 但没有任何 finding → 量化未达成，仍拒绝
  setNodeState(db, intents[0], 'done')
  const notProven = prove(db, eid, { verdict: 'achieved', reason: '收尾了' })
  assert.equal(notProven.ok, false)
  assert.match(notProven.hint, /量化验收未达成/)
  assert.equal(notProven.prove.score, 0.75)

  // 校验参数
  assert.equal(prove(db, eid, { verdict: 'achieved' }).error_kind, 'bad_input') // 缺 reason
  assert.equal(prove(db, eid, { verdict: 'bogus', reason: 'x' }).error_kind, 'bad_input')
  assert.equal(prove(db, 999999, { verdict: 'failed', reason: 'x' }).ok, false)

  // failed / stopped 放行但要 reason，且不受量化/守卫限制
  const failed = prove(db, eid, { verdict: 'failed', reason: '靶标下线' })
  assert.equal(failed.ok, true)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.round_no, 1)
  assert.equal(getExploration(db, eid).status, 'failed')
  assert.equal(failed.wake.planner, true)
  assert.equal(failed.prove.achieved, false) // 量化报告仍如实带回
  assert.equal(digestNodes(db, eid).length, 1)

  setExplorationStatus(db, eid, 'open')
  const stopped = prove(db, eid, { verdict: 'stopped', reason: 'G 叫停' })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.round_no, 2)
  assert.equal(digestNodes(db, eid).length, 2)

  // force:true + reason 绕过全部守卫
  setExplorationStatus(db, eid, 'open')
  setNodeState(db, intents[0], 'open')
  const forced = prove(db, eid, { verdict: 'achieved', reason: '人工判定已达成', force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.status, 'achieved')
  const last = digestNodes(db, eid).at(-1)
  const pl = JSON.parse(last.payload)
  assert.equal(pl.verdict, 'achieved')
  assert.equal(pl.forced, true)
  assert.equal(pl.reason, '人工判定已达成')
  assert.equal(pl.score, 0.5)
  assert.equal(pl.checks.length, 4)
  assert.deepEqual(pl.criteria, { ...DEFAULT_CRITERIA })

  // 量化达成且无 live 意图时正常收官（非 force）
  const db2 = makeDb()
  const { eid: e2, intents: i2 } = seed(db2)
  setNodeState(db2, i2[0], 'done')
  addNode(db2, { exploration_id: e2, kind: 'finding', title: 'v1' })
  const clean = prove(db2, e2, { verdict: 'achieved', reason: '量化验收达成' })
  assert.equal(clean.ok, true)
  assert.equal(clean.prove.achieved, true)
  assert.equal(clean.prove.score, 1)
  assert.equal(getExploration(db2, e2).status, 'achieved')
  assert.equal(clean.round_no, 1)
  db.close()
  db2.close()
})

/* ------------------------------------------------------------------ step：一轮被动驱动 */

test('step: frontier 选一条 → execute 回调 → 写回 fact/finding → 量化达成自动收官', () => {
  const db = makeDb()
  const { eid, intents } = seed(db, { intents: ['子域枚举'] })
  const seen = []
  const out = step(db, eid, {
    owner: 'worker-1', ownerSession: 'sess-1',
    execute: (intent, ctx) => {
      seen.push({ intent, ctx })
      return {
        state: 'done',
        facts: [{ title: '发现 admin.demo', provenance: 'observed' }],
        findings: [{ title: '后台未授权访问', severity: 'high' }],
      }
    },
  })

  assert.equal(out.ok, true)
  assert.equal(out.intent.id, intents[0])
  assert.equal(seen.length, 1)
  assert.equal(seen[0].ctx.explorationId, eid)
  assert.equal(seen[0].ctx.roundNo, 0)
  assert.equal(seen[0].ctx.owner, 'worker-1')
  assert.equal(seen[0].ctx.ownerSession, 'sess-1')
  assert.deepEqual(seen[0].ctx.overdue, [])
  assert.deepEqual(seen[0].ctx.constraints, [])
  assert.equal(out.claimed, true)
  assert.equal(out.executed, true)
  assert.equal(out.worker_error, null)
  assert.deepEqual(out.written, { facts: 1, findings: 1, intents: 0, edges: 2, anchors: 0 })
  assert.equal(nodeById(db, intents[0]).state, 'done')
  assert.equal(out.prove.achieved, true)
  assert.equal(out.prove.score, 1)
  assert.equal(out.decision, 'prove')
  assert.equal(out.closed, true)
  assert.equal(out.status, 'achieved')
  assert.equal(out.close.ok, true)
  assert.equal(out.close.status, 'achieved')
  assert.equal(out.round_no, 1) // prove 里 bumpRound
  assert.equal(getExploration(db, eid).status, 'achieved')
  assert.equal(digestNodes(db, eid).length, 1)
  assert.equal(out.wake.planner, true)
  assert.equal(out.wake.reason, 'finding_recorded')
  assert.deepEqual(out.stale_running, [])

  // 被动：收官后再调一次，frontier 空、无回调可派，不产生任何新动作
  const again = step(db, eid, { execute: () => ({ state: 'done' }) })
  assert.equal(again.claimed, false)
  assert.equal(again.executed, false)
  assert.equal(again.decision, 'prove') // 量化仍达成 → 建议 prove
  assert.equal(again.closed, false) // 已收官的探索重入不重复写库
  assert.equal(again.round_no, 1) // round_no 不自增
  assert.equal(digestNodes(db, eid).length, 1) // 审计节点不重复追加
  db.close()
})

test('step: autoClose=false / 派生新意图 / execute 抛错 / 空 frontier / 无 execute', () => {
  // autoClose=false：量化达成也不写库
  {
    const db = makeDb()
    const { eid } = seed(db)
    const out = step(db, eid, {
      autoClose: false,
      execute: () => ({ state: 'done', findings: [{ title: 'v1' }] }),
    })
    assert.equal(out.prove.achieved, true)
    assert.equal(out.decision, 'prove')
    assert.equal(out.closed, false)
    assert.equal(out.close, null)
    assert.equal(out.status, 'open')
    assert.equal(getExploration(db, eid).status, 'open')
    assert.equal(digestNodes(db, eid).length, 0)
    db.close()
  }

  // 派生新意图 → frontier 仍有货 → decision=dispatch，不收官
  {
    const db = makeDb()
    const { eid } = seed(db, { intents: ['A', 'B'] })
    const out = step(db, eid, {
      execute: () => ({
        state: 'done', findings: [{ title: 'v1' }],
        intents: [{ title: '顺着 v1 深挖', priority: 8 }],
      }),
    })
    assert.equal(out.intent.title, 'A') // 按 priority DESC 取第一条
    assert.equal(out.written.intents, 1)
    assert.equal(out.prove.achieved, false) // no_open_intents 不满足
    assert.equal(out.decision, 'dispatch')
    assert.equal(out.closed, false)
    assert.equal(listFrontier(db, eid).length, 2) // 原 B + 新派生
    assert.equal(nodeById(db, out.intent.id).state, 'done')
    db.close()
  }

  // execute 抛错 → 意图置 blocked，绝不留 running 孤儿
  {
    const db = makeDb()
    const { eid, intents } = seed(db)
    const out = step(db, eid, { execute: () => { throw new Error('boom') } })
    assert.equal(out.claimed, true)
    assert.equal(out.executed, false)
    assert.match(out.worker_error, /worker-error: boom/)
    assert.equal(nodeById(db, intents[0]).state, 'blocked')
    assert.match(nodeById(db, intents[0]).blocked_reason, /worker-error: boom/)
    assert.equal(wakeStats(db, eid).running, 0)
    assert.equal(out.closed, false)
    db.close()
  }

  // 空 frontier：不派活，decision=replan
  {
    const db = makeDb()
    const { eid, intents } = seed(db)
    setNodeState(db, intents[0], 'done')
    const out = step(db, eid, { execute: () => ({ state: 'done' }) })
    assert.equal(out.claimed, false)
    assert.equal(out.executed, false)
    assert.equal(out.intent, null)
    assert.equal(out.decision, 'replan')
    assert.equal(out.closed, false)
    db.close()
  }

  // 无 execute：只做快照，不领取、不改状态
  {
    const db = makeDb()
    const { eid, intents } = seed(db)
    const out = step(db, eid)
    assert.equal(out.claimed, false)
    assert.equal(out.intent, null)
    assert.equal(nodeById(db, intents[0]).state, 'open')
    assert.equal(out.decision, 'dispatch')
    db.close()
  }

  // 不存在的探索：结构化 bad_input
  {
    const db = makeDb()
    assert.equal(step(db, 999999).ok, false)
    assert.equal(step(db, 999999).error_kind, 'bad_input')
    db.close()
  }
})

test('step: 自定义量化判据（goal payload.prove / 调用方 criteria）决定收官', () => {
  // goal 节点写 min_findings:2，只回写 1 个 finding → 不收官
  {
    const db = makeDb()
    const { eid } = seed(db, { criteria: { min_findings: 2 } })
    const out = step(db, eid, { execute: () => ({ state: 'done', findings: [{ title: 'v1' }] }) })
    assert.deepEqual(out.prove.criteria.min_findings, 2)
    assert.equal(out.prove.checks[0].met, false)
    assert.equal(out.prove.achieved, false)
    assert.equal(out.closed, false)
    // 有 1 条 finding → decisionOf 走 'prove' 分支（复核 findings），但量化未达成故不写库收官
    assert.equal(out.decision, 'prove')
    assert.equal(getExploration(db, eid).status, 'open')
    db.close()
  }
  // 调用方 criteria 覆盖 goal 判据为 min_findings:1 → 收官
  {
    const db = makeDb()
    const { eid } = seed(db, { criteria: { min_findings: 2 } })
    const out = step(db, eid, {
      criteria: { min_findings: 1 },
      execute: () => ({ state: 'done', findings: [{ title: 'v1' }] }),
    })
    assert.equal(out.prove.criteria.min_findings, 1)
    assert.equal(out.prove.achieved, true)
    assert.equal(out.closed, true)
    db.close()
  }
})

/* ------------------------------------------------------------------ store API 接线 */

test('createEngine: 绑 db 句柄与 store.db(id) 形态，缺省探索 id 自动解析', () => {
  const db = makeDb()
  const { eid, intents } = seed(db, { target: 'demo' })

  const eng = createEngine(db, 'demo')
  assert.equal(eng.db, db)
  assert.equal(eng.activeExplorationId(), eid)
  assert.deepEqual(eng.wakeStats(), { frontier_open: 1, running: 0, findings: 0, facts: 0, done_intents: 0, blocked_intents: 0 })
  assert.equal(eng.decisionOf({ frontier_open: 1, running: 0, findings: 0 }), 'dispatch')
  assert.equal(eng.frontier().length, 1)
  assert.equal(eng.overview().open_intents, 1)
  assert.equal(eng.exploration().status, 'open')
  assert.equal(eng.constraints('demo').length, 0)
  assert.equal(eng.makeWake(null, 'fact_recorded').reason, 'fact_recorded')
  assert.equal(eng.bumpRound(), 1)
  assert.equal(eng.plan({ begin: false }).briefing.frontier.length, 1)
  assert.equal(eng.readCriteria(null).min_findings, 1)
  assert.equal(eng.proveGoal(null).achieved, false)
  assert.equal(eng.staleRunning(null).length, 0)

  const out = eng.step({ execute: () => ({ state: 'done', findings: [{ title: 'v1' }] }) })
  assert.equal(out.closed, true)
  assert.equal(eng.exploration(eid).status, 'achieved')
  // 探索已收官 → activeExplorationId 为空；仍可显式传 eid 继续读
  assert.equal(eng.activeExplorationId(), null)
  assert.equal(eng.wakeStats(eid).findings, 1)

  // 显式传 explorationId 覆盖缺省
  const db2 = makeDb()
  const { eid: e2 } = seed(db2, { target: 'demo2' })
  const eng2 = createEngine({ db: (id) => { assert.equal(id, 'demo2'); return db2 } }, 'demo2')
  assert.equal(eng2.activeExplorationId(), e2)
  assert.equal(eng2.prove({ explorationId: e2, verdict: 'stopped', reason: '收工' }).ok, true)
  assert.equal(getExploration(db2, e2).status, 'stopped')

  // claimIntent / recordResult / requeueOrphans 走绑定形态
  const db3 = makeDb()
  const { eid: e3, intents: i3 } = seed(db3)
  const eng3 = createEngine(db3, 'demo3')
  assert.equal(eng3.claimIntent(i3[0], 'w', 'sess-x').claimed, true)
  eng3.recordResult(e3, i3[0], { state: 'blocked', reason: 'x' })
  assert.equal(nodeById(db3, i3[0]).state, 'blocked')
  assert.equal(eng3.requeueOrphans('sess-x'), 0) // 已非 running

  // 非法 source 直接抛
  assert.throws(() => createEngine({}, 'x'), /需要 DatabaseSync 句柄或 RedteamStore/)
  db.close()
  db2.close()
  db3.close()
})

/* ------------------------------------------------------------------ 静态约束：零常驻 / 不碰关闭回滚路径 */

test('引擎源码: 零定时器/零线程/零调度循环，且只依赖 P1 数据层', () => {
  const src = readFileSync(new URL('../lib/redteam/engine.js', import.meta.url), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bset(?:Interval|Timeout|Immediate)\s*\(/)
  assert.doesNotMatch(code, /\bnew\s+Worker\s*\(|\bchild_process\b|\bworker_threads\b|\bspawn\s*\(|\bfork\s*\(/)
  assert.doesNotMatch(code, /\bwhile\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/)
  // 唯一 import 就是 P1 数据层 exploration.js；不触碰 store-core / tools / settings / Cordis
  const imports = [...src.matchAll(/^import\s[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['./exploration.js'])
  // 不修改现有关闭/回滚路径：引擎不引入关闭、回滚、备份恢复语义
  assert.doesNotMatch(code, /\brollback\b|\brestore(?:Backup|-backup)?\b|\.close\s*\(/)
})
