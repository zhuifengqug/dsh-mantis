/* ============================================================================
 * ARTEX P2 · 探索图工具集（docs/artex/artex-p2p4-design.md §1.4）
 *
 * 定位：把 RedteamStore.exploration(id) 的绑定 API 暴露成模型可调用的工具。
 * 所有写库都经由 store.exploration(id)（宿主进程内唯一 DatabaseSync 写者），
 * 本文件不直接开库、不碰连接、不引入 Cordis 之外的依赖。工具定义器与错误
 * 收敛统一复用 host-tools.js 的 defineTool / withStructuredErrors / textContent，
 * 由 tools.js 的 apply() 通过 helpers 注入（此处不 import tools.js，避免循环依赖）。
 *
 * 命名：§1.4 的 23 个标准名是前端面板 / 验收的对接契约；任务字面点名的
 * create / add_node / add_edge / list_frontier / overview / constraint 作为同义
 * 别名一并注册，共用同一个 run 实现，不复制逻辑。EXPLORE_TOOL_NAMES 是唯一清单。
 *
 * 事实口径：写 fact / finding / hint 节点时用 provenance 区分——
 *   observed = 工具/命令实际回显、抓到的响应、页面内容等「直接观测」到的一手事实；
 *   inferred = 由已有事实推断出来、尚未被直接观测验证的「结论」。
 * 两者都如实落到 payload.provenance，报告与复测据此判断证据强度。
 * ========================================================================== */

/** 本工具集注册的全部名字（顺序即注册顺序，供数量自检与测试引用）。 */
export const EXPLORE_TOOL_NAMES = Object.freeze([
  /* §1.4 标准 23 个 */
  'redteam_explore_open',
  'redteam_explore_plan',
  'redteam_explore_status',
  'redteam_explore_goal_add',
  'redteam_explore_goal_list',
  'redteam_explore_prove',
  'redteam_explore_intent_add',
  'redteam_explore_intent_claim',
  'redteam_explore_intent_update',
  'redteam_explore_intent_list',
  'redteam_explore_intent_brief',
  'redteam_explore_node_add',
  'redteam_explore_node_list',
  'redteam_explore_edge_add',
  'redteam_explore_anchor',
  'redteam_explore_todolist',
  'redteam_explore_trace_search',
  'redteam_explore_trace_list',
  'redteam_explore_trace_get',
  'redteam_explore_coverage',
  'redteam_explore_constraint_add',
  'redteam_explore_constraint_list',
  'redteam_engine',
  /* 任务字面点名的同义别名 / 补充 */
  'redteam_explore_create',
  'redteam_explore_add_node',
  'redteam_explore_add_edge',
  'redteam_explore_list_frontier',
  'redteam_explore_overview',
  'redteam_explore_constraint',
])

const NODE_ADD_KINDS = ['fact', 'finding', 'hint']
const NODE_LIST_KINDS = ['goal', 'intent', 'fact', 'finding', 'hint', 'digest']
const NODE_STATES = ['open', 'running', 'done', 'blocked', 'exhausted', 'stopped', 'deleted']
const INTENT_UPDATE_STATES = ['done', 'blocked', 'exhausted', 'stopped', 'open']
const EDGE_RELS = ['spawns', 'derived_from', 'yields', 'proves', 'covers']
const CONSTRAINT_KINDS = ['allow', 'deny']
const PROVENANCE = ['observed', 'inferred']
const SEVERITY = ['info', 'low', 'medium', 'high', 'critical']
const PLAN_ACTIONS = ['begin', 'brief']
const VERDICTS = ['achieved', 'failed', 'stopped']
const TODO_ACTIONS = ['get', 'append', 'replace', 'clear']

const ENGAGEMENT_PARAM = { type: 'string', description: '靶标 ID（省略时按会话绑定 / 唯一靶标解析）' }
const EID_PARAM = { type: 'string', description: '探索 ID（省略时取该靶标唯一进行中的探索）' }
const LIMIT_PARAM = { type: 'number', description: '返回条数上限，1..500 的整数' }

/* ---------- 入参校验：错误文本含「非法 / 不能为空 / 不存在」→ bad_input ---------- */

function needStr(v, label) {
  if (v == null || String(v).trim() === '') throw new Error(label + ' 不能为空')
  return String(v)
}
function needId(v, label) {
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new Error(label + ' 非法: ' + v)
  return n
}
function needEnum(v, allowed, label) {
  const s = String(v ?? '')
  if (!allowed.includes(s)) throw new Error(label + ' 非法: ' + (v ?? '') + '（允许: ' + allowed.join('|') + '）')
  return s
}
function optLimit(v) {
  if (v == null || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error('limit 非法: ' + v + '（应为 1..500 的整数）')
  }
  return n
}
function arr(v) {
  if (Array.isArray(v)) return v
  if (v == null || v === '') return []
  return [v]
}
function parsePayload(text) {
  if (!text) return {}
  try {
    const o = typeof text === 'string' ? JSON.parse(text) : text
    return o && typeof o === 'object' ? o : {}
  } catch { return {} }
}
function normalizeTitle(v) {
  return String(v || '').trim().toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}
/** 解析 exploration_id：显式给就校验存在，否则取唯一进行中的探索。 */
function resolveEid(api, args) {
  if (args.exploration_id != null && String(args.exploration_id).trim() !== '') {
    const n = needId(args.exploration_id, 'exploration_id')
    const row = api.get(n)
    if (!row) throw new Error('探索不存在: ' + n)
    return n
  }
  const active = api.active()
  if (!active) throw new Error('探索不存在：当前靶标没有进行中的探索，请先 redteam_explore_create 新建探索')
  return Number(active.id)
}

/* ---------- 各工具的 run：返回附加到 {ok:true, engagement} 上的字段 ---------- */

const runOpen = (c) => {
  const goal = needStr(c.args.goal, 'goal')
  const eid = c.api.create({ goal })
  if (c.args.note != null && String(c.args.note).trim() !== '') {
    c.api.addNode({ exploration_id: eid, kind: 'begin', title: '开局说明', body: String(c.args.note), state: 'done' })
  }
  const row = c.api.get(eid)
  return { exploration_id: eid, status: row.status, round_no: row.round_no, wake: c.wake('frontier_changed', eid) }
}

const runStatus = (c) => {
  const eid = c.eid()
  return { exploration: c.api.get(eid), overview: c.api.overview(eid), wake_stats: c.api.wakeStats(eid) }
}

const runPlan = (c) => {
  const eid = c.eid()
  const action = needEnum(c.args.action ?? 'brief', PLAN_ACTIONS, 'action')
  const r = c.api.plan(eid, { begin: action === 'begin', cap: c.cap })
  if (r.ok === false) throw new Error(r.hint || 'plan 失败')
  const out = { round_no: r.round_no, engine: c.engineName, briefing: r.briefing }
  if (action === 'begin') out.wake = c.wake('graph_changed', eid)
  return out
}

const runProve = (c) => {
  const eid = c.eid()
  const verdict = needEnum(c.args.verdict, VERDICTS, 'verdict')
  const reason = needStr(c.args.reason, 'reason')
  return c.api.prove(eid, { verdict, reason, force: !!c.args.force })
}

const runGoalAdd = (c) => {
  const eid = c.eid()
  const title = needStr(c.args.title, 'title')
  const nid = c.api.addNode({
    exploration_id: eid, kind: 'goal', title,
    body: c.args.body ?? null, state: 'done',
  })
  return { node_id: nid, wake: c.wake('frontier_changed', eid) }
}

const runGoalList = (c) => {
  const eid = c.eid()
  const items = c.api.nodes(eid, { kind: 'goal', limit: optLimit(c.args.limit) ?? 100 })
    .map((n) => ({ id: n.id, title: n.title, body: n.body, state: n.state, created_at: n.created_at }))
  return { items }
}

const runIntentAdd = (c) => {
  const eid = c.eid()
  const title = needStr(c.args.title, 'title')
  const norm = normalizeTitle(title)
  const existing = c.args.dedupe !== false
    ? c.api.nodes(eid, { kind: 'intent', limit: 500 })
      .find((n) => ['open', 'running', 'done', 'exhausted'].includes(n.state) && normalizeTitle(n.title) === norm)
    : null
  if (existing) return { id: existing.id, deduped: true, wake: c.wake('frontier_changed', eid) }
  const nid = c.api.addNode({
    exploration_id: eid, kind: 'intent', title,
    body: c.args.body ?? null,
    parent_id: c.args.parent_id != null ? needId(c.args.parent_id, 'parent_id') : null,
    priority: Number(c.args.priority) || 0,
    state: 'open',
  })
  for (const a of arr(c.args.anchor_asset_ids)) c.api.anchor({ node_id: nid, asset_id: needId(a, 'anchor_asset_ids') })
  return { id: nid, deduped: false, wake: c.wake('frontier_changed', eid) }
}

const runIntentClaim = (c) => {
  const nid = needId(c.args.id, 'id')
  const row = c.api.node(nid)
  if (!row) throw new Error('意图不存在: ' + nid)
  const r = c.api.claim(nid, c.owner, c.ownerSession)
  if (!r.claimed) return { ok: false, error_kind: 'failed', hint: '已被领取或状态不对', owner: r.owner }
  return { id: nid, owner: r.owner, wake: c.wake('intent_state_changed', row.exploration_id) }
}

const runIntentUpdate = (c) => {
  const nid = needId(c.args.id, 'id')
  const state = needEnum(c.args.state, INTENT_UPDATE_STATES, 'state')
  if (state === 'blocked') needStr(c.args.blocked_reason, 'blocked_reason')
  const row = c.api.node(nid)
  if (!row) throw new Error('意图不存在: ' + nid)
  c.api.setNodeState(nid, state, {
    blocked_reason: c.args.blocked_reason ?? null,
  })
  return { id: nid, state, wake: c.wake('intent_state_changed', row.exploration_id) }
}

const runIntentList = (c) => {
  const eid = c.eid()
  if (c.args.state != null) needEnum(c.args.state, NODE_STATES, 'state')
  return { items: c.api.nodes(eid, { kind: 'intent', state: c.args.state, limit: optLimit(c.args.limit) ?? 100 }) }
}

const runIntentBrief = (c) => {
  const nid = needId(c.args.id, 'id')
  const row = c.api.node(nid)
  if (!row) throw new Error('意图不存在: ' + nid)
  const eid = row.exploration_id
  const exp = c.api.get(eid)
  const constraints = c.api.constraints()
  const todolist = c.api.todolist(eid)
  let assets = []
  try {
    assets = c.db(c.id).prepare('SELECT asset_id FROM exploration_anchor WHERE node_id = ?').all(nid).map((x) => x.asset_id)
  } catch { /* 表缺失时按无锚定处理 */ }
  const allow = constraints.filter((x) => x.kind === 'allow').map((x) => x.text)
  const deny = constraints.filter((x) => x.kind === 'deny').map((x) => x.text)
  const lines = [
    '# 探索任务书 · 意图 #' + nid,
    '',
    '## 探索目标',
    String(exp && exp.goal ? exp.goal : '（未填写）'),
    '',
    '## 本意图',
    String(row.title || '（无标题）'),
    row.body ? String(row.body) : '',
    '',
    '## 约束（必读，越界即停）',
    ...(allow.length ? allow.map((t) => '- [allow] ' + t) : ['- [allow] （无）']),
    ...(deny.length ? deny.map((t) => '- [deny] ' + t) : ['- [deny] （无）']),
    '',
    '## 锚定资产',
    assets.length ? assets.join(', ') : '（无，执行中自行记录并落锚）',
    '',
    '## 当前待办（todolist）',
    ...(todolist.length ? todolist.map((t, i) => (i + 1) + '. ' + t) : ['（空）']),
    '',
    '## 收尾义务（离开前必须做）',
    '1. 观测到的事实写 fact：payload.provenance=observed（直接回显/响应/内容）。',
    '2. 由事实推断的结论写 finding：payload.provenance=inferred，并用 anchor_asset_ids 落锚资产。',
    '3. 用 intent_update 把本意图收到终态：done / blocked / exhausted（blocked 必填 blocked_reason）。',
  ]
  return { brief: lines.join('\n') }
}

const runNodeAdd = (c) => {
  const eid = c.eid()
  const kind = needEnum(c.args.kind, NODE_ADD_KINDS, 'kind')
  const provenance = c.args.provenance != null ? needEnum(c.args.provenance, PROVENANCE, 'provenance') : null
  const severity = c.args.severity != null ? needEnum(c.args.severity, SEVERITY, 'severity') : null
  const payload = {}
  if (provenance) payload.provenance = provenance
  if (c.args.evidence != null) payload.evidence = c.args.evidence
  if (severity) payload.severity = severity
  const nid = c.api.addNode({
    exploration_id: eid, kind,
    title: c.args.title ?? null,
    body: c.args.body ?? null,
    payload: Object.keys(payload).length ? payload : null,
    parent_id: c.args.parent_id != null ? needId(c.args.parent_id, 'parent_id') : null,
    origin: c.args.origin ?? null,
    state: 'done',
  })
  for (const a of arr(c.args.anchor_asset_ids)) c.api.anchor({ node_id: nid, asset_id: needId(a, 'anchor_asset_ids') })
  const reason = kind === 'finding' ? 'finding_recorded' : kind === 'fact' ? 'fact_recorded' : 'graph_changed'
  return { node_id: nid, wake: c.wake(reason, eid) }
}

const runNodeList = (c) => {
  const eid = c.eid()
  if (c.args.kind != null) needEnum(c.args.kind, NODE_LIST_KINDS, 'kind')
  if (c.args.state != null) needEnum(c.args.state, NODE_STATES, 'state')
  return { items: c.api.nodes(eid, {
    kind: c.args.kind, state: c.args.state, q: c.args.q, limit: optLimit(c.args.limit) ?? 100,
  }) }
}

const runEdgeAdd = (c) => {
  const eid = c.eid()
  const src = needId(c.args.src_id, 'src_id')
  const dst = needId(c.args.dst_id, 'dst_id')
  const rel = needEnum(c.args.rel, EDGE_RELS, 'rel')
  return { created: c.api.addEdge({ exploration_id: eid, src_id: src, dst_id: dst, rel }) }
}

const runAnchor = (c) => {
  const nid = needId(c.args.node_id, 'node_id')
  const aid = needId(c.args.asset_id, 'asset_id')
  const row = c.api.node(nid)
  if (!row) throw new Error('节点不存在: ' + nid)
  const created = c.api.anchor({ node_id: nid, asset_id: aid })
  return { created, wake: c.wake('graph_changed', row.exploration_id) }
}

const runListFrontier = (c) => ({ items: c.api.frontier(c.eid()) })

const runTodolist = (c) => {
  const eid = c.eid()
  const action = needEnum(c.args.action ?? 'get', TODO_ACTIONS, 'action')
  let items
  if (action === 'get') items = c.api.todolist(eid)
  else if (action === 'append') items = c.api.setTodolist(eid, [...c.api.todolist(eid), ...arr(c.args.items).map(String)])
  else if (action === 'replace') items = c.api.setTodolist(eid, arr(c.args.items).map(String))
  else items = c.api.setTodolist(eid, [])
  const out = { items }
  if (action === 'append' || action === 'replace') out.wake = c.wake('graph_changed', eid)
  return out
}

const runTraceSearch = (c) => ({ items: c.api.traces({
  q: c.args.q, agent: c.args.agent, since: c.args.since, limit: optLimit(c.args.limit) ?? 50,
}) })
const runTraceList = (c) => ({ items: c.api.traces({ since: c.args.since, limit: optLimit(c.args.limit) ?? 50 }) })
const runTraceGet = (c) => {
  const ref = needStr(c.args.ref, 'ref')
  return c.api.trace(ref) // { trace, linked }；格式/存在性由 getTrace 抛 bad_input
}

const runCoverage = (c) => {
  const eid = c.eid()
  const findings_by_severity = {}
  for (const n of c.api.nodes(eid, { kind: 'finding', limit: 500 })) {
    const sev = String(parsePayload(n.payload).severity || 'unspecified')
    findings_by_severity[sev] = (findings_by_severity[sev] || 0) + 1
  }
  return {
    overview: c.api.overview(eid),
    unanchored_assets: c.api.unanchoredAssets(eid),
    open_intents: c.api.nodes(eid, { kind: 'intent', state: 'open', limit: 500 }),
    blocked_intents: c.api.nodes(eid, { kind: 'intent', state: 'blocked', limit: 500 }),
    findings_by_severity,
  }
}

const runConstraintAdd = (c) => {
  const kind = needEnum(c.args.kind, CONSTRAINT_KINDS, 'kind')
  const text = needStr(c.args.text, 'text')
  const id = c.api.addConstraint({ kind, text, origin: c.args.origin ?? null })
  return { id }
}
const runConstraintList = (c) => ({ items: c.api.constraints() })

/* ---------- 工具规格表 ---------- */

const GOAL_P = { goal: { type: 'string', description: '探索目标（必填）：这一轮要证明 / 达成的结论' }, note: { type: 'string', description: '开局说明（可选）' } }
const NODE_P = {
  kind: { type: 'string', description: '节点种类：fact=直接观测到的事实 | finding=发现/结论 | hint=线索' },
  title: { type: 'string', description: '标题' },
  body: { type: 'string', description: '正文' },
  parent_id: { type: 'number', description: '父意图 / 父节点 ID（自动挂 spawns 边）' },
  provenance: { type: 'string', description: '证据口径：observed=工具回显/响应/页面内容等直接观测的一手事实；inferred=由事实推断、尚未直接观测验证的结论' },
  evidence: { type: 'string', description: '证据引用（命令输出 / 证据 ref / 流量 id）' },
  severity: { type: 'string', description: '严重度：info | low | medium | high | critical' },
  anchor_asset_ids: { type: 'array', description: '关联的资产 ID 列表（finding 建议落锚）' },
  origin: { type: 'string', description: '来源标记' },
}

const SPECS = [
  { name: 'redteam_explore_open', description: '新建一次探索（目标 → 意图 → 事实/发现），返回 exploration_id。', params: GOAL_P, run: runOpen },
  { name: 'redteam_explore_plan', description: 'planner 编排：begin 推进一轮并带 wake 回声，brief 只读当前简报。', params: { action: { type: 'string', description: 'begin=推进一轮 | brief=只读简报' } }, run: runPlan },
  { name: 'redteam_explore_status', description: '查看探索状态、图概览与 wake 统计（只读）。', params: {}, run: runStatus },
  { name: 'redteam_explore_goal_add', description: '登记一个成功判据（goal 节点，body 写清可验收的判据）。', params: { title: { type: 'string', description: '判据标题（必填）' }, body: { type: 'string', description: '成功判据正文' } }, run: runGoalAdd },
  { name: 'redteam_explore_goal_list', description: '列出该靶标的成功判据（goal 节点）。', params: {}, run: runGoalList },
  { name: 'redteam_explore_prove', description: '收官：按 prove_goal 量化验收决定 achieved/failed/stopped；有 open 意图或量化未达成时拒绝 achieved，除非 force+reason。', params: { verdict: { type: 'string', description: 'achieved | failed | stopped' }, reason: { type: 'string', description: '收官理由（必填）' }, force: { type: 'boolean', description: '强制收官（跳过守卫，需 reason）' } }, run: runProve },
  { name: 'redteam_explore_intent_add', description: '新增待办意图；同名（归一化后）且未删除的意图默认去重不重复建。', params: { parent_id: { type: 'number', description: '父意图 ID' }, title: { type: 'string', description: '意图标题（必填）' }, body: { type: 'string', description: '意图正文' }, priority: { type: 'number', description: '优先级（越大越先）' }, anchor_asset_ids: { type: 'array', description: '关联资产 ID' }, dedupe: { type: 'boolean', description: '同名去重，默认 true' } }, run: runIntentAdd },
  { name: 'redteam_explore_intent_claim', description: 'worker 领取一条 open 意图（CAS，重复领取返回结构化失败）。', params: { id: { type: 'number', description: '意图 ID（必填）' } }, run: runIntentClaim },
  { name: 'redteam_explore_intent_update', description: '把意图收到终态；state=blocked 时必填 blocked_reason。', params: { id: { type: 'number', description: '意图 ID（必填）' }, state: { type: 'string', description: 'done | blocked | exhausted | stopped | open' }, blocked_reason: { type: 'string', description: 'blocked 时的原因（必填）' }, note: { type: 'string', description: '备注' } }, run: runIntentUpdate },
  { name: 'redteam_explore_intent_list', description: '列出意图，可按 state 过滤。', params: { state: { type: 'string', description: 'open | running | done | blocked | exhausted | stopped' } }, run: runIntentList },
  { name: 'redteam_explore_intent_brief', description: '生成可直接粘进子会话 prompt 的任务书（目标/约束/正文/锚定资产/待办/收尾义务）。', params: { id: { type: 'number', description: '意图 ID（必填）' } }, run: runIntentBrief },
  { name: 'redteam_explore_node_add', description: '写入事实/发现/线索节点。provenance 必须区分 observed（直接观测）与 inferred（推断结论）；finding 用 anchor_asset_ids 落锚。', params: NODE_P, run: runNodeAdd },
  { name: 'redteam_explore_node_list', description: '按 kind / state / 关键字检索探索节点。', params: { kind: { type: 'string', description: 'goal | intent | fact | finding | hint | digest' }, state: { type: 'string', description: '节点状态' }, q: { type: 'string', description: '标题/正文关键字' } }, run: runNodeList },
  { name: 'redteam_explore_edge_add', description: '补一条图边（已存在则 created=false，幂等）。', params: { src_id: { type: 'number', description: '源节点 ID（必填）' }, dst_id: { type: 'number', description: '目标节点 ID（必填）' }, rel: { type: 'string', description: 'spawns | derived_from | yields | proves | covers' } }, run: runEdgeAdd },
  { name: 'redteam_explore_anchor', description: '把节点锚定到资产（幂等，created 表示是否新建）。', params: { node_id: { type: 'number', description: '节点 ID（必填）' }, asset_id: { type: 'number', description: '资产 ID（必填）' } }, run: runAnchor },
  { name: 'redteam_explore_todolist', description: '待办清单：get / append / replace / clear；append 与 replace 带 wake 回声。', params: { action: { type: 'string', description: 'get | append | replace | clear' }, items: { type: 'array', description: '待办文本数组' } }, run: runTodolist },
  { name: 'redteam_explore_trace_search', description: '按关键字/执行者/时间检索执行轨迹（攻击步骤 ∪ 探索节点）。', params: { q: { type: 'string', description: '关键字' }, agent: { type: 'string', description: '执行者' }, since: { type: 'string', description: '起始时间（ISO）' } }, run: runTraceSearch },
  { name: 'redteam_explore_trace_list', description: '按时间倒序列出执行轨迹。', params: { since: { type: 'string', description: '起始时间（ISO）' } }, run: runTraceList },
  { name: 'redteam_explore_trace_get', description: '取一条轨迹详情及其关联节点/边/证据：ref=step:<id> 或 node:<id>。', params: { ref: { type: 'string', description: 'step:<id> | node:<id>（必填）' } }, run: runTraceGet },
  { name: 'redteam_explore_coverage', description: '覆盖率与未锚定资产、open/blocked 意图、发现按严重度汇总（只读）。', params: {}, run: runCoverage },
  { name: 'redteam_explore_constraint_add', description: '登记 allow / deny 约束（作用域为当前靶标）。', params: { kind: { type: 'string', description: 'allow | deny（必填）' }, text: { type: 'string', description: '约束正文（必填）' }, origin: { type: 'string', description: '来源' } }, run: runConstraintAdd },
  { name: 'redteam_explore_constraint_list', description: '列出当前靶标的 allow / deny 约束。', params: {}, run: runConstraintList },
  { name: 'redteam_engine', description: '查看或切换探索引擎：commander（默认，指挥者编排）| frontier（wake 回声驱动）。不传 set=只读。', params: { set: { type: 'string', description: 'commander | frontier' } }, standalone: true },
  /* --- 任务字面别名 / 补充（共用同一 run，不复制逻辑） --- */
  { name: 'redteam_explore_create', description: '新建探索（redteam_explore_open 的同义名）。', params: GOAL_P, run: runOpen },
  { name: 'redteam_explore_add_node', description: '写入事实/发现/线索节点（redteam_explore_node_add 的同义名）；provenance 区分 observed 直接观测与 inferred 推断结论。', params: NODE_P, run: runNodeAdd },
  { name: 'redteam_explore_add_edge', description: '补一条图边（redteam_explore_edge_add 的同义名，幂等）。', params: { src_id: { type: 'number', description: '源节点 ID（必填）' }, dst_id: { type: 'number', description: '目标节点 ID（必填）' }, rel: { type: 'string', description: 'spawns | derived_from | yields | proves | covers' } }, run: runEdgeAdd },
  { name: 'redteam_explore_list_frontier', description: '列出 frontier（open 意图，按优先级/ID 排序，只读）。', params: {}, run: runListFrontier },
  { name: 'redteam_explore_overview', description: '查看探索状态与图概览（redteam_explore_status 的同义名，只读）。', params: {}, run: runStatus },
  { name: 'redteam_explore_constraint', description: '登记 allow / deny 约束（redteam_explore_constraint_add 的同义名）。', params: { kind: { type: 'string', description: 'allow | deny（必填）' }, text: { type: 'string', description: '约束正文（必填）' }, origin: { type: 'string', description: '来源' } }, run: runConstraintAdd },
]

if (SPECS.length !== EXPLORE_TOOL_NAMES.length || SPECS.some((s, i) => s.name !== EXPLORE_TOOL_NAMES[i])) {
  throw new Error('tools-exploration.js: EXPLORE_TOOL_NAMES 与 SPECS 不一致')
}

/**
 * 把探索工具注册到 ctx.tools。由 tools.js 的 apply() 末尾调用。
 *
 * @param {object} ctx   Cordis 上下文（需 ctx.tools.register）
 * @param {object} store RedteamStore 实例
 * @param {object} helpers { defineTool, withStructuredErrors, textContent,
 *   resolveEngagement, bindingKeyOf, engineOf, saveEngine, engineSourceOf,
 *   ENGINES, maxAgentsOf, db: (engagementId)=>DatabaseSync }
 */
export function registerExplorationTools(ctx, store, helpers) {
  const {
    defineTool, withStructuredErrors, textContent: text,
    resolveEngagement, bindingKeyOf, engineOf, saveEngine, engineSourceOf,
    ENGINES, maxAgentsOf, db,
  } = helpers

  for (const spec of SPECS) {
    const parameters = spec.standalone
      ? { ...spec.params }
      : { engagement: ENGAGEMENT_PARAM, exploration_id: EID_PARAM, limit: LIMIT_PARAM, ...spec.params }

    const execute = spec.standalone
      ? async (args) => {
        args = args || {}
        const root = store && store.root
        let engine
        if (args.set != null && String(args.set).trim() !== '') {
          engine = saveEngine(root, needEnum(args.set, ENGINES, 'set'))
        } else {
          engine = engineOf(root)
        }
        const source = engineSourceOf(root)
        return JSON.stringify({ ok: true, engine, source }, null, 2)
      }
      : async (args, exec) => {
        args = args || {}
        optLimit(args.limit) // 统一的可触发 bad_input 的入参校验
        const id = resolveEngagement(store, exec, args.engagement)
        const api = store.exploration(id)
        const binding = (typeof bindingKeyOf === 'function' ? bindingKeyOf(exec) : {}) || {}
        let cachedEid
        const eid = () => {
          if (cachedEid == null) cachedEid = resolveEid(api, args)
          return cachedEid
        }
        const c = {
          id, api, args, exec,
          root: store && store.root,
          owner: binding.rootId ?? binding.sessionId ?? 'engine',
          ownerSession: binding.sessionId ?? null,
          engineName: engineOf(store && store.root),
          cap: maxAgentsOf(store && store.root, process.env),
          db,
          eid,
          wake: (reason, eidOverride) => api.wake(eidOverride ?? eid(), reason),
        }
        const data = await spec.run(c)
        return JSON.stringify({ ok: true, engagement: id, ...data }, null, 2)
      }

    ctx.tools.register(withStructuredErrors(defineTool({
      name: spec.name,
      description: spec.description,
      parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
      execute,
    })))
  }
  return EXPLORE_TOOL_NAMES.length
}
