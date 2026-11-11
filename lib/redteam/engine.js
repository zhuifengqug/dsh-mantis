/**
 * P2 探索引擎 —— planner / worker / prove_goal 的**被动驱动**实现（纯数据层，零 Cordis 依赖）。
 *
 * 定位（对齐 docs/artex/artex-p2p4-design.md §1.1–1.3、§1.5）：
 *   ARTEX 的引擎是 Go 常驻循环（debounce 唤醒 planner）。拒斧不引入常驻进程：
 *   本文件里**没有任何定时器、轮询、循环推进、线程或 spawn**。每个导出函数都是
 *   「被调用一次 → 做一件事 → 返回（附一段 wake 回声）」的纯函数，闭环由工具/指挥层
 *   在每次工具返回、子会话收尾时显式再调一次来推进。step() 是「一轮被动驱动」的
 *   编排，同样只推进一条 frontier 意图，绝不自造无限循环调度。
 *
 * 依赖边界（任务硬约束）：
 *   · 只用 P1 数据层 ./exploration.js 的既有函数 + DatabaseSync 句柄（即 store.db(id)）。
 *   · createEngine(source, engagementId) 接 RedteamStore 或直接接 db 句柄，属 store API 接线点。
 *   · 不 import tools.js / store-core.js 的类 / settings / Cordis / fs，不改现有关闭/回滚路径。
 *   · CAS、wakeStats、round、孤儿修复、量化验收所需 SQL 全在本文件内自足实现，
 *     不改动 exploration.js（那是 t3 工具层的数据层追加，避免并行覆盖）。
 *
 * 一轮的四段动作（step）：
 *   从 frontier 选意图 → 调 execute 回调执行 → 写回 fact/finding/派生意图 →
 *   按 prove_goal 量化验收决定收官（achieved + 无未闭环意图时自动 prove，可关）。
 *
 * 量化验收模型（prove_goal）：
 *   goal 节点 payload.prove（或调用方 criteria 覆盖）给出结构化成功判据，缺省用
 *   DEFAULT_CRITERIA。proveGoal 对每条判据算 required/actual/met，得 score∈[0,1]，
 *   achieved = 全部 met。收官 prove 另有守卫：还有 open/running 意图、或量化未达成时
 *   拒绝 verdict:'achieved'（除非 force:true + reason）；failed/stopped 放行但要 reason。
 */

import {
  getExploration, setExplorationStatus, addNode, setNodeState, addEdge,
  listFrontier, anchorNode, listConstraints, graphOverview,
} from './exploration.js'

/** 并发上限默认值（与 settings.DEFAULT_MAX_AGENTS 一致；引擎不 import settings，靠调用方注入）。 */
export const DEFAULT_CAP = 3
/** running intent 超时阈值：30 分钟。 */
export const DEFAULT_STALE_MS = 30 * 60 * 1000
/** wake 回声的合法 reason。 */
export const WAKE_REASONS = [
  'frontier_changed', 'intent_state_changed', 'fact_recorded',
  'finding_recorded', 'graph_changed', 'scheduled_due',
]
/** worker 允许的意图终态。 */
export const WORKER_TERMINAL_STATES = ['done', 'blocked', 'exhausted', 'stopped', 'open']

/**
 * 缺省量化判据：至少 1 个 finding、且没有 open/running 意图即算达成；
 * facts / coverage 默认 0 表示不设门槛（met 恒成立），便于最小可验收探索。
 */
export const DEFAULT_CRITERIA = Object.freeze({
  min_findings: 1,
  min_facts: 0,
  min_coverage_pct: 0,
  require_no_open_intents: true,
})

const nowIso = () => new Date().toISOString()
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

/* ------------------------------------------------------------------ payload 小工具 */

/** payload 列可能是 JSON 文本、空、或历史遗留的普通字符串；一律安全解析成对象。 */
function parsePayload(text) {
  if (text == null || text === '') return {}
  if (typeof text === 'object') return text
  try {
    const v = JSON.parse(text)
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : { __raw: v }
  } catch {
    return { __raw: String(text) }
  }
}
const stringifyPayload = (obj) => JSON.stringify(obj || {})
const ownerSessionOf = (text) => parsePayload(text).owner_session ?? null
/** step 只回写计数，不把 recordResult 的 state/wake 混进 written。 */
const pickWritten = (rec) => ({
  facts: rec.facts, findings: rec.findings, intents: rec.intents, edges: rec.edges, anchors: rec.anchors,
})

function normalizeCriteria(c) {
  const src = c && typeof c === 'object' ? c : {}
  return {
    min_findings: Math.max(0, num(src.min_findings, DEFAULT_CRITERIA.min_findings)),
    min_facts: Math.max(0, num(src.min_facts, DEFAULT_CRITERIA.min_facts)),
    min_coverage_pct: Math.min(100, Math.max(0, num(src.min_coverage_pct, DEFAULT_CRITERIA.min_coverage_pct))),
    require_no_open_intents: src.require_no_open_intents === undefined
      ? DEFAULT_CRITERIA.require_no_open_intents : Boolean(src.require_no_open_intents),
  }
}

/* ------------------------------------------------------------------ planner 大脑：统计 / 决策 / 回声 */

/** frontier 统计：{frontier_open, running, findings, facts, done_intents, blocked_intents}。 */
export function wakeStats(db, explorationId) {
  const eid = Number(explorationId)
  const q = (sql) => db.prepare(sql).get(eid).n
  return {
    frontier_open: q("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state='open'"),
    running: q("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state='running'"),
    findings: q("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id=? AND kind='finding' AND state!='deleted'"),
    facts: q("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id=? AND kind='fact' AND state!='deleted'"),
    done_intents: q("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state='done'"),
    blocked_intents: q("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state IN ('blocked','exhausted')"),
  }
}

/**
 * 服务端确定性决策（设计 §1.2 四分支，不是模型拍脑袋）。cap = 并发上限。
 *   frontier 有货 / running 未满 → dispatch；running 满 → wait；
 *   无活但有 findings → prove；否则 → replan。
 */
export function decisionOf(stats, cap = DEFAULT_CAP) {
  const c = Math.max(1, num(cap, DEFAULT_CAP))
  if (num(stats.frontier_open) > 0) return 'dispatch'
  if (num(stats.running) > 0 && num(stats.running) < c) return 'dispatch'
  if (num(stats.running) > 0) return 'wait'
  if (num(stats.findings) > 0) return 'prove'
  return 'replan'
}

/** 构造一段 wake 回声（写类动作返回，指挥看到 planner:true 就再跑一轮 plan）。 */
export function makeWake(db, explorationId, reason = 'graph_changed') {
  const s = wakeStats(db, explorationId)
  return {
    planner: true,
    reason: WAKE_REASONS.includes(reason) ? reason : 'graph_changed',
    frontier_open: s.frontier_open,
    running: s.running,
    findings: s.findings,
  }
}

/** round_no 自增，返回新值。 */
export function bumpRound(db, explorationId) {
  db.prepare('UPDATE exploration SET round_no = round_no + 1, updated_at = ? WHERE id = ?')
    .run(nowIso(), Number(explorationId))
  const row = db.prepare('SELECT round_no FROM exploration WHERE id = ?').get(Number(explorationId))
  return row ? row.round_no : 0
}

/** todolist：读 origin='todolist' 的最新 digest 节点（设计 §1.2 复用 digest 节点，不加表）。 */
function readTodolist(db, explorationId) {
  const row = db.prepare(
    "SELECT payload FROM exploration_node WHERE exploration_id=? AND kind='digest' AND origin='todolist' AND state!='deleted' ORDER BY id DESC LIMIT 1",
  ).get(Number(explorationId))
  if (!row) return []
  const p = parsePayload(row.payload)
  return Array.isArray(p.items) ? p.items : []
}

/**
 * 一轮 planner：只读快照（begin=false / brief）或开一轮（begin=true，round_no+1 且带 wake）。
 * 返回 briefing：overview + frontier + running_intents(带 stale) + constraints + todolist
 *              + decision + stale_running + wake_stats。
 */
export function plan(db, explorationId, { cap = DEFAULT_CAP, staleMs = DEFAULT_STALE_MS, begin = true } = {}) {
  const eid = Number(explorationId)
  const exp = getExploration(db, eid)
  if (!exp) return { ok: false, error_kind: 'bad_input', hint: '探索不存在' }
  const roundNo = begin ? bumpRound(db, eid) : exp.round_no
  const stats = wakeStats(db, eid)
  const running = db.prepare(
    "SELECT * FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state='running' ORDER BY id",
  ).all(eid)
  const stale = staleRunning(db, eid, staleMs)
  const staleSet = new Set(stale)
  const briefing = {
    round_no: roundNo,
    overview: graphOverview(db, eid),
    frontier: listFrontier(db, eid),
    running_intents: running.map((r) => ({ ...r, stale: staleSet.has(r.id) })),
    constraints: listConstraints(db, exp.target),
    todolist: readTodolist(db, eid),
    decision: decisionOf(stats, cap),
    stale_running: stale,
    wake_stats: stats,
  }
  const out = { ok: true, round_no: roundNo, action: begin ? 'begin' : 'brief', briefing }
  if (begin) out.wake = makeWake(db, eid, 'graph_changed')
  return out
}

/* ------------------------------------------------------------------ worker：领取 / 写回 / 孤儿 / 超时 */

/** intent 领取 CAS：state='open' 才成功，写 owner + payload.owner_session。返回 {claimed, owner}。 */
export function claimIntent(db, intentId, owner, ownerSession) {
  const id = Number(intentId)
  const row = db.prepare('SELECT payload FROM exploration_node WHERE id = ?').get(id)
  const merged = Object.assign({}, parsePayload(row?.payload), { owner_session: ownerSession ?? null })
  const r = db.prepare(
    "UPDATE exploration_node SET state='running', owner=?, payload=?, updated_at=? WHERE id=? AND kind='intent' AND state='open'",
  ).run(String(owner), stringifyPayload(merged), nowIso(), id)
  return { claimed: r.changes > 0, owner: r.changes > 0 ? String(owner) : null }
}

/**
 * 写回 worker 结果。result 形如：
 * {
 *   state: 'done'|'blocked'|'exhausted'|'stopped'|'open',  // 收尾终态，缺省 done
 *   reason?: string,                                       // blocked/exhausted 原因
 *   facts?:    [{ title, body?, payload?, provenance?, evidence?, parent_id? }],
 *   findings?: [{ title, body?, payload?, severity?, provenance?, evidence?, anchor_asset_ids?, parent_id? }],
 *   intents?:  [{ title, body?, payload?, priority?, parent_id? }],  // 派生新意图（同名去重）
 * }
 * fact/finding 用 parent_id=intent_id 自动挂 spawns 边，并补 derived_from 边；
 * finding 可锚定资产。最后把意图置终态。返回写入计数 + wake。
 */
export function recordResult(db, explorationId, intentId, result = {}) {
  const eid = Number(explorationId)
  const iid = Number(intentId)
  const written = { facts: 0, findings: 0, intents: 0, edges: 0, anchors: 0 }

  const mkPayload = (spec) => {
    const base = spec.payload && typeof spec.payload === 'object' ? { ...spec.payload } : {}
    if (spec.provenance && !base.provenance) base.provenance = spec.provenance
    if (spec.evidence && !base.evidence) base.evidence = spec.evidence
    if (spec.severity && !base.severity) base.severity = spec.severity
    return Object.keys(base).length ? base : null
  }

  for (const spec of Array.isArray(result.facts) ? result.facts : []) {
    const nodeId = addNode(db, {
      exploration_id: eid, kind: 'fact', title: spec.title ?? null, body: spec.body ?? null,
      payload: mkPayload(spec), parent_id: spec.parent_id ?? iid, origin: spec.origin ?? 'engine:worker',
    })
    written.facts++
    if (addEdge(db, { exploration_id: eid, src_id: nodeId, dst_id: iid, rel: 'derived_from' })) written.edges++
  }

  for (const spec of Array.isArray(result.findings) ? result.findings : []) {
    const nodeId = addNode(db, {
      exploration_id: eid, kind: 'finding', title: spec.title ?? null, body: spec.body ?? null,
      payload: mkPayload(spec), parent_id: spec.parent_id ?? iid, origin: spec.origin ?? 'engine:worker',
    })
    written.findings++
    if (addEdge(db, { exploration_id: eid, src_id: nodeId, dst_id: iid, rel: 'derived_from' })) written.edges++
    for (const assetId of Array.isArray(spec.anchor_asset_ids) ? spec.anchor_asset_ids : []) {
      if (anchorNode(db, { node_id: nodeId, asset_id: Number(assetId) })) written.anchors++
    }
  }

  for (const spec of Array.isArray(result.intents) ? result.intents : []) {
    const title = String(spec.title ?? '').trim()
    if (!title) continue
    const dup = db.prepare(
      "SELECT id FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state IN ('open','running') AND lower(trim(COALESCE(title,'')))=lower(?)",
    ).get(eid, title)
    if (dup) continue // 同名派生意图去重（设计 §1.4 dedupe）
    addNode(db, {
      exploration_id: eid, kind: 'intent', title, body: spec.body ?? null,
      payload: spec.payload ?? null, priority: num(spec.priority, 0),
      parent_id: spec.parent_id ?? iid, origin: spec.origin ?? 'engine:planner',
    })
    written.intents++
  }

  const state = WORKER_TERMINAL_STATES.includes(result.state) ? result.state : 'done'
  setNodeState(db, iid, state, {
    blocked_reason: ['blocked', 'exhausted'].includes(state) ? (result.reason ?? null) : null,
  })
  const reason = written.findings > 0 ? 'finding_recorded'
    : written.facts > 0 ? 'fact_recorded' : 'intent_state_changed'
  return { ...written, state, wake: makeWake(db, eid, reason) }
}

/** 孤儿修复（设计 §1.3.4）：某子会话拥有的 running 意图全部回 open，记 prev_owner + blocked_reason。 */
export function requeueOrphans(db, ownerSessionId, reason = 'worker-exit-unexpected') {
  if (ownerSessionId == null) return 0
  const rows = db.prepare(
    "SELECT id, owner, payload FROM exploration_node WHERE kind='intent' AND state='running'",
  ).all()
  let n = 0
  const upd = db.prepare(
    "UPDATE exploration_node SET state='open', blocked_reason=?, payload=?, updated_at=? WHERE id=? AND state='running'",
  )
  for (const row of rows) {
    if (ownerSessionOf(row.payload) !== String(ownerSessionId)) continue
    const merged = Object.assign({}, parsePayload(row.payload), { prev_owner: row.owner ?? null })
    n += upd.run(reason, stringifyPayload(merged), nowIso(), row.id).changes
  }
  return n
}

/** 超时巡检：running 且 updated_at 早于 now-staleMs 的意图 id 数组。 */
export function staleRunning(db, explorationId, staleMs = DEFAULT_STALE_MS) {
  const cutoff = new Date(Date.now() - num(staleMs, DEFAULT_STALE_MS)).toISOString()
  return db.prepare(
    "SELECT id FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state='running' AND updated_at < ? ORDER BY id",
  ).all(Number(explorationId), cutoff).map((r) => r.id)
}

/* ------------------------------------------------------------------ prove_goal 量化验收 + 收官 */

/** 读生效判据：override > goal 节点 payload.prove（id 升序首个含 prove 的）> 缺省。 */
export function readCriteria(db, explorationId, override) {
  if (override && typeof override === 'object') return normalizeCriteria(override)
  const rows = db.prepare(
    "SELECT payload FROM exploration_node WHERE exploration_id=? AND kind='goal' AND state!='deleted' ORDER BY id",
  ).all(Number(explorationId))
  for (const row of rows) {
    const p = parsePayload(row.payload)
    if (p.prove && typeof p.prove === 'object') return normalizeCriteria(p.prove)
  }
  return { ...DEFAULT_CRITERIA }
}

/**
 * 量化验收（不写库）：逐条判据算 required/actual/met，得 score 与 achieved。
 * 返回 { achieved, score, checks[], blockers[], criteria, stats }。
 */
export function proveGoal(db, explorationId, criteria) {
  const eid = Number(explorationId)
  const c = readCriteria(db, eid, criteria)
  const stats = wakeStats(db, eid)
  const coverage = graphOverview(db, eid).coverage_pct
  const live = stats.frontier_open + stats.running
  const checks = [
    { key: 'findings', required: c.min_findings, actual: stats.findings, met: stats.findings >= c.min_findings },
    { key: 'facts', required: c.min_facts, actual: stats.facts, met: stats.facts >= c.min_facts },
    { key: 'coverage_pct', required: c.min_coverage_pct, actual: coverage, met: coverage >= c.min_coverage_pct },
    {
      key: 'no_open_intents', required: c.require_no_open_intents ? 0 : null, actual: live,
      met: c.require_no_open_intents ? live === 0 : true,
    },
  ]
  const metCount = checks.filter((x) => x.met).length
  const score = checks.length ? Math.round((metCount / checks.length) * 1000) / 1000 : 0
  const blockers = db.prepare(
    "SELECT id, title, state FROM exploration_node WHERE exploration_id=? AND kind='intent' AND state IN ('open','running') ORDER BY id",
  ).all(eid)
  return { achieved: metCount === checks.length, score, checks, blockers, criteria: c, stats }
}

/**
 * 收官（写库）：verdict ∈ achieved|failed|stopped。
 *   achieved 守卫（force 可绕过）：还有 open/running 意图 → 拒（返回 blocked_intents）；
 *                                  prove_goal 量化未达成 → 拒；
 *   failed/stopped 放行但要 reason。所有 verdict 都必填 reason。
 * 成功：round_no+1、setExplorationStatus、落一条 digest 审计节点（含量化报告）、返回 wake。
 */
export function prove(db, explorationId, { verdict, reason, force = false, criteria } = {}) {
  const eid = Number(explorationId)
  const exp = getExploration(db, eid)
  if (!exp) return { ok: false, error_kind: 'bad_input', hint: '探索不存在' }
  const assessment = proveGoal(db, eid, criteria)
  if (!['achieved', 'failed', 'stopped'].includes(verdict)) {
    return { ok: false, error_kind: 'bad_input', hint: 'verdict 只能是 achieved|failed|stopped', prove: assessment }
  }
  if (!reason || !String(reason).trim()) {
    return { ok: false, error_kind: 'bad_input', hint: 'reason 必填', prove: assessment }
  }
  if (verdict === 'achieved' && !force) {
    const stats = assessment.stats
    if (stats.frontier_open > 0 || stats.running > 0) {
      return {
        ok: false, error_kind: 'bad_input', blocked_intents: assessment.blockers,
        hint: '仍有 open/running 意图，收官需 force:true + reason', prove: assessment,
      }
    }
    if (!assessment.achieved) {
      return {
        ok: false, error_kind: 'bad_input',
        hint: 'prove_goal 量化验收未达成，收官需 force:true + reason', prove: assessment,
      }
    }
  }
  const roundNo = bumpRound(db, eid)
  setExplorationStatus(db, eid, verdict, { roundNo })
  addNode(db, {
    exploration_id: eid, kind: 'digest', origin: 'prove_goal',
    title: `prove_goal 收官: ${verdict}`,
    payload: {
      verdict, reason: String(reason), forced: Boolean(force) && verdict === 'achieved',
      score: assessment.score, checks: assessment.checks, criteria: assessment.criteria,
    },
  })
  const wake = makeWake(db, eid, verdict === 'achieved' ? 'graph_changed' : 'intent_state_changed')
  return { ok: true, status: verdict, round_no: roundNo, prove: assessment, wake }
}

/* ------------------------------------------------------------------ 一轮被动驱动（step） */

/**
 * 一轮被动驱动：从 frontier 选一条意图 → CAS 领取 → 调 execute 回调 →
 * recordResult 写回 → proveGoal 量化 → 达成且无未闭环意图时自动 prove 收官（autoClose 可关）。
 *
 * 关键：**只推进一条意图，一次调用一次返回**，没有循环/定时器/线程，符合「零常驻进程」。
 * execute 是同步回调 (intent, ctx) => result；异步子会话的编排归工具层（await 回来再调本函数）。
 * execute 抛错时把意图置 blocked（带 worker-error reason），绝不留 running 孤儿。
 */
export function step(db, explorationId, options = {}) {
  const {
    execute, owner = 'engine', ownerSession = null, cap = DEFAULT_CAP,
    staleMs = DEFAULT_STALE_MS, criteria, autoClose = true,
    closeReason = 'prove_goal 量化验收达成',
  } = options
  const eid = Number(explorationId)
  const exp = getExploration(db, eid)
  if (!exp) return { ok: false, error_kind: 'bad_input', hint: '探索不存在' }

  const frontier = listFrontier(db, eid)
  let intent = null
  let claimed = false
  let executed = false
  let result = null
  let workerError = null
  let written = { facts: 0, findings: 0, intents: 0, edges: 0, anchors: 0 }

  if (frontier.length > 0 && typeof execute === 'function') {
    intent = frontier[0]
    claimed = claimIntent(db, intent.id, owner, ownerSession).claimed
    if (claimed) {
      try {
        result = execute(intent, {
          explorationId: eid, roundNo: exp.round_no, owner, ownerSession,
          overdue: staleRunning(db, eid, staleMs),
          constraints: listConstraints(db, exp.target),
        }) || {}
        written = pickWritten(recordResult(db, eid, intent.id, result))
        executed = true
      } catch (err) {
        workerError = `worker-error: ${err?.message ?? String(err)}`
        result = { state: 'blocked', reason: workerError }
        written = pickWritten(recordResult(db, eid, intent.id, result))
      }
    }
  }

  const stats = wakeStats(db, eid)
  const assessment = proveGoal(db, eid, criteria)
  let decision = decisionOf(stats, cap)
  let status = exp.status
  let closed = false
  let close = null

  if (assessment.achieved && stats.frontier_open === 0 && stats.running === 0) {
    decision = 'prove'
    // 已收官的探索不重复收官：step 是被动重入的，第二次醒来不能再追加一条审计节点 /
    // 再自增一次 round_no。closed 由本轮是否真正写入决定。
    if (autoClose && exp.status === 'open') {
      close = prove(db, eid, { verdict: 'achieved', reason: closeReason, criteria })
      if (close.ok) { status = close.status; closed = true }
    }
  }

  const roundNo = (getExploration(db, eid) || {}).round_no ?? exp.round_no
  const wakeReason = written.findings > 0 ? 'finding_recorded'
    : written.facts > 0 ? 'fact_recorded'
      : closed ? 'graph_changed' : 'intent_state_changed'
  return {
    ok: true, round_no: roundNo, decision, status, closed,
    intent, claimed, executed, worker_error: workerError,
    result, written, prove: assessment, close,
    stale_running: staleRunning(db, eid, staleMs),
    wake: makeWake(db, eid, wakeReason),
  }
}

/* ------------------------------------------------------------------ store API 接线点 */

function resolveDb(source, engagementId) {
  if (source && typeof source.prepare === 'function') return source // 直接是 DatabaseSync 句柄
  if (source && typeof source.db === 'function') return source.db(engagementId) // RedteamStore
  throw new Error('createEngine 需要 DatabaseSync 句柄或 RedteamStore')
}

function activeExplorationId(db) {
  const row = db.prepare("SELECT id FROM exploration WHERE status='open' ORDER BY id DESC LIMIT 1").get()
  return row ? row.id : null
}

/**
 * 把引擎绑定到某个靶标库（store.db(engagementId)）。工具层用它免去每次传 db / explorationId：
 * explorationId 缺省时自动取该靶标唯一 open 探索。返回对象里 decisionOf 是纯函数（不含 db）。
 */
export function createEngine(source, engagementId) {
  const db = resolveDb(source, engagementId)
  const eidOf = (explicit) => explicit ?? activeExplorationId(db)
  return {
    db,
    activeExplorationId: () => activeExplorationId(db),
    wakeStats: (eid) => wakeStats(db, eidOf(eid)),
    makeWake: (eid, reason) => makeWake(db, eidOf(eid), reason),
    bumpRound: (eid) => bumpRound(db, eidOf(eid)),
    plan: (opts = {}) => plan(db, eidOf(opts.explorationId), opts),
    claimIntent: (intentId, owner, ownerSession) => claimIntent(db, intentId, owner, ownerSession),
    recordResult: (eid, intentId, result) => recordResult(db, eidOf(eid), intentId, result),
    requeueOrphans: (session, reason) => requeueOrphans(db, session, reason),
    staleRunning: (eid, ms) => staleRunning(db, eidOf(eid), ms),
    readCriteria: (eid, override) => readCriteria(db, eidOf(eid), override),
    proveGoal: (eid, criteria) => proveGoal(db, eidOf(eid), criteria),
    prove: (opts = {}) => prove(db, eidOf(opts.explorationId), opts),
    step: (opts = {}) => step(db, eidOf(opts.explorationId), opts),
    decisionOf,
    frontier: (eid) => listFrontier(db, eidOf(eid)),
    overview: (eid) => graphOverview(db, eidOf(eid)),
    exploration: (eid) => getExploration(db, eidOf(eid)),
    constraints: (target) => listConstraints(db, target),
  }
}
