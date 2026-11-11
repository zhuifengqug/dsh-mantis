/**
 * 探索图（吸收 ARTEX 的 Exploration Graph 设计）——纯数据层，无 Cordis 依赖。
 *
 * 一张图 = 一次任务内的探索状态：目标(goal) 拆成意图(intent)，意图执行产出事实(fact)/
 * 发现(finding)，发现再派生新意图；边记录「谁派生了谁 / 谁证明谁 / 谁覆盖谁」。
 * 与资产图分离：这里只关心"这一次怎么推进"，资产落在 exploration_anchor 上。
 *
 * 所有函数都接一个已打开的 node:sqlite 句柄（DatabaseSync），由 RedteamStore.db(id) 提供，
 * 因此天然按靶标隔离（每个靶标一个库文件）。
 */

const nowIso = () => new Date().toISOString()

const NODE_KINDS = new Set(['begin', 'goal', 'intent', 'fact', 'finding', 'hint', 'digest'])
const NODE_STATES = new Set(['open', 'running', 'done', 'blocked', 'exhausted', 'stopped', 'deleted'])
const EDGE_RELS = new Set(['spawns', 'derived_from', 'yields', 'proves', 'covers'])

function assertEnum(v, set, label) {
  if (!set.has(v)) throw new Error(`${label} 非法: ${v}（允许: ${[...set].join('|')}）`)
}

/** 新建一次探索。返回 exploration id。 */
export function createExploration(db, { target, goal }) {
  if (!target || !goal) throw new Error('createExploration 需要 target 与 goal')
  const ts = nowIso()
  const r = db.prepare(
    'INSERT INTO exploration(target, goal, status, round_no, created_at, updated_at) VALUES (?,?,?,?,?,?)'
  ).run(String(target), String(goal), 'open', 0, ts, ts)
  return Number(r.lastInsertRowid)
}

export function getExploration(db, id) {
  return db.prepare('SELECT * FROM exploration WHERE id = ?').get(Number(id)) || null
}

/** 改探索整体状态（open|achieved|failed|stopped）。 */
export function setExplorationStatus(db, id, status, { roundNo } = {}) {
  const ts = nowIso()
  const r = db.prepare('UPDATE exploration SET status = ?, round_no = COALESCE(?, round_no), updated_at = ? WHERE id = ?')
    .run(status, roundNo == null ? null : Number(roundNo), ts, Number(id))
  return r.changes > 0
}

/**
 * 加一个节点。kind ∈ NODE_KINDS；state 默认 open；payload 传对象会自动 JSON 化。
 * 返回 node id。
 */
export function addNode(db, { exploration_id, kind, title = null, body = null, payload = null,
  priority = 0, origin = null, owner = null, parent_id = null, state = 'open' }) {
  if (!exploration_id) throw new Error('addNode 需要 exploration_id')
  assertEnum(kind, NODE_KINDS, 'kind')
  assertEnum(state, NODE_STATES, 'state')
  const ts = nowIso()
  const payloadText = payload == null ? null : (typeof payload === 'string' ? payload : JSON.stringify(payload))
  const r = db.prepare(
    `INSERT INTO exploration_node(exploration_id, kind, state, title, body, payload, priority, origin, owner, parent_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(Number(exploration_id), kind, state, title, body, payloadText, Number(priority) || 0,
    origin, owner, parent_id == null ? null : Number(parent_id), ts, ts)
  const nodeId = Number(r.lastInsertRowid)
  if (parent_id != null) {
    // 父子天然是一条 spawns 边，省得调用方两处写
    addEdge(db, { exploration_id, src_id: parent_id, dst_id: nodeId, rel: 'spawns' })
  }
  return nodeId
}

/** 改节点状态 / 补阻塞或删除原因。 */
export function setNodeState(db, nodeId, state, { blocked_reason = null, delete_reason = null } = {}) {
  assertEnum(state, NODE_STATES, 'state')
  const r = db.prepare(
    'UPDATE exploration_node SET state = ?, blocked_reason = COALESCE(?, blocked_reason), delete_reason = COALESCE(?, delete_reason), updated_at = ? WHERE id = ?'
  ).run(state, blocked_reason, delete_reason, nowIso(), Number(nodeId))
  return r.changes > 0
}

/** 加一条边（重复自动忽略，靠 UNIQUE 约束）。 */
export function addEdge(db, { exploration_id, src_id, dst_id, rel }) {
  assertEnum(rel, EDGE_RELS, 'rel')
  const r = db.prepare(
    'INSERT OR IGNORE INTO exploration_edge(exploration_id, src_id, dst_id, rel, created_at) VALUES (?,?,?,?,?)'
  ).run(Number(exploration_id), Number(src_id), Number(dst_id), rel, nowIso())
  return r.changes > 0
}

/** 前沿 = 还开着的意图，按优先级/编号排。planner 每轮就从这里领活。 */
export function listFrontier(db, explorationId) {
  return db.prepare(
    "SELECT * FROM exploration_node WHERE exploration_id = ? AND kind = 'intent' AND state = 'open' ORDER BY priority DESC, id ASC"
  ).all(Number(explorationId))
}

/** 把探索节点挂到资产图的具体资产上（覆盖率/资产覆盖图靠它）。 */
export function anchorNode(db, { node_id, asset_id }) {
  const r = db.prepare('INSERT OR IGNORE INTO exploration_anchor(node_id, asset_id, created_at) VALUES (?,?,?)')
    .run(Number(node_id), Number(asset_id), nowIso())
  return r.changes > 0
}

export function addConstraint(db, { target, kind, text, origin = null }) {
  if (kind !== 'allow' && kind !== 'deny') throw new Error("constraint kind 只能是 allow|deny")
  const r = db.prepare('INSERT INTO task_constraint(target, kind, text, origin, created_at) VALUES (?,?,?,?,?)')
    .run(String(target), kind, String(text), origin, nowIso())
  return Number(r.lastInsertRowid)
}

export function listConstraints(db, target) {
  return db.prepare('SELECT * FROM task_constraint WHERE target = ? ORDER BY id').all(String(target))
}

/** 图的概览：按 kind/state 计数 + 覆盖率（被 anchor 的资产数 / 全库资产数）。 */
export function graphOverview(db, explorationId) {
  const id = Number(explorationId)
  const byKind = db.prepare('SELECT kind, COUNT(*) n FROM exploration_node WHERE exploration_id = ? AND state != \'deleted\' GROUP BY kind').all(id)
  const byState = db.prepare('SELECT state, COUNT(*) n FROM exploration_node WHERE exploration_id = ? GROUP BY state').all(id)
  const findings = db.prepare("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id = ? AND kind = 'finding' AND state != 'deleted'").get(id)
  const openIntents = db.prepare("SELECT COUNT(*) n FROM exploration_node WHERE exploration_id = ? AND kind = 'intent' AND state = 'open'").get(id)
  let anchored = 0, totalAssets = 0
  try {
    anchored = db.prepare('SELECT COUNT(DISTINCT a.asset_id) n FROM exploration_anchor a JOIN exploration_node nd ON nd.id = a.node_id WHERE nd.exploration_id = ?').get(id).n
    totalAssets = db.prepare('SELECT COUNT(*) n FROM asset').get().n
  } catch { /* asset 表可能为空/不存在于纯图测试库 */ }
  return {
    exploration_id: id,
    byKind, byState,
    findings: findings.n,
    open_intents: openIntents.n,
    anchored_assets: anchored,
    total_assets: totalAssets,
    coverage_pct: totalAssets > 0 ? Math.round((anchored / totalAssets) * 1000) / 10 : 0,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   P2 工具层所需的数据层查询（docs/artex/artex-p2p4-design.md §1.5）。

   与 ./engine.js 的分工：wakeStats / claimIntent / bumpRound / requeueOrphans /
   staleRunning / plan / prove 由被动引擎实现（单一实现，工具层经
   RedteamStore.exploration(id) 绑定转调，不在这里复制一份）。这里只补引擎
   没有的纯查询：活跃探索、节点列表、todolist、轨迹合并与轨迹上下文。
   ──────────────────────────────────────────────────────────────────────────── */

/** 当前靶标进行中（status='open'）的探索，取最新一条；没有返回 null。 */
export function getActiveExploration(db) {
  return db.prepare(
    "SELECT * FROM exploration WHERE status = 'open' ORDER BY id DESC LIMIT 1",
  ).get() || null
}

/** payload 可能是 JSON 文本 / 裸字符串 / NULL；一律收敛成对象（与 engine.js 同口径）。 */
function parsePayload(text) {
  if (text == null || text === '') return {}
  if (typeof text === 'object') return text
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? v : { __raw: String(v) }
  } catch { return { __raw: String(text) } }
}

/** 列节点：kind/state/q 过滤，limit 默认 100、钳到 500，按 id 倒序（排除已删除）。 */
export function listNodes(db, explorationId, { kind, state, q, limit } = {}) {
  const eid = Number(explorationId)
  if (!Number.isFinite(eid) || eid <= 0) throw new Error('exploration_id 非法')
  const where = ['exploration_id = ?', "state != 'deleted'"]
  const args = [eid]
  if (kind != null && String(kind) !== '') {
    assertEnum(String(kind), NODE_KINDS, 'kind')
    where.push('kind = ?')
    args.push(String(kind))
  }
  if (state != null && String(state) !== '') {
    assertEnum(String(state), NODE_STATES, 'state')
    where.push('state = ?')
    args.push(String(state))
  }
  if (q != null && String(q).trim() !== '') {
    where.push("(COALESCE(title,'') LIKE ? OR COALESCE(body,'') LIKE ?)")
    const like = '%' + String(q).trim() + '%'
    args.push(like, like)
  }
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 100), 1), 500)
  return db.prepare(
    `SELECT * FROM exploration_node WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
  ).all(...args, lim)
}

/** todolist 复用一张 kind='digest' + origin='todolist' 的节点，读最新一份。 */
export function getTodolist(db, explorationId) {
  const row = db.prepare(
    "SELECT payload FROM exploration_node WHERE exploration_id=? AND kind='digest' AND origin='todolist' AND state!='deleted' ORDER BY id DESC LIMIT 1",
  ).get(Number(explorationId))
  if (!row) return []
  const p = parsePayload(row.payload)
  return Array.isArray(p.items) ? p.items.map(String) : []
}

/** 写 todolist：已存在就地更新，全程只有一份节点（重复调用幂等）。 */
export function setTodolist(db, explorationId, items) {
  const list = Array.isArray(items) ? items.map((x) => String(x)) : []
  const eid = Number(explorationId)
  const row = db.prepare(
    "SELECT id FROM exploration_node WHERE exploration_id=? AND kind='digest' AND origin='todolist' AND state!='deleted' ORDER BY id DESC LIMIT 1",
  ).get(eid)
  const payload = JSON.stringify({ items: list })
  if (row) {
    db.prepare('UPDATE exploration_node SET payload=?, updated_at=? WHERE id=?')
      .run(payload, nowIso(), row.id)
    /* 老数据可能留下多份：收敛成一份，避免 get 取到旧清单 */
    db.prepare(
      "UPDATE exploration_node SET state='deleted', delete_reason='todolist-dedup', updated_at=? WHERE exploration_id=? AND kind='digest' AND origin='todolist' AND id != ? AND state!='deleted'",
    ).run(nowIso(), eid, row.id)
  } else {
    addNode(db, {
      exploration_id: eid, kind: 'digest', origin: 'todolist',
      title: '待办清单（todolist）', payload: { items: list }, state: 'done',
    })
  }
  return list
}

/** 轨迹 = attack_step ∪ 探索图节点，按时间倒序合并（没有独立 activity 表）。 */
export function searchTraces(db, { q, agent, since, limit } = {}) {
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 500)
  const like = q != null && String(q).trim() !== '' ? '%' + String(q).trim() + '%' : null
  const ag = agent != null && String(agent).trim() !== '' ? String(agent).trim() : null
  const from = since != null && String(since).trim() !== '' ? String(since).trim() : null
  const out = []

  const stepWhere = []
  const stepArgs = []
  if (from) { stepWhere.push('recorded_at >= ?'); stepArgs.push(from) }
  if (ag) { stepWhere.push('agent = ?'); stepArgs.push(ag) }
  if (like) {
    stepWhere.push("(COALESCE(title,'') LIKE ? OR COALESCE(detail,'') LIKE ? OR COALESCE(result,'') LIKE ?)")
    stepArgs.push(like, like, like)
  }
  const stepSql = 'SELECT * FROM attack_step'
    + (stepWhere.length ? ' WHERE ' + stepWhere.join(' AND ') : '')
    + ' ORDER BY recorded_at DESC, id DESC LIMIT ?'
  for (const s of db.prepare(stepSql).all(...stepArgs, lim)) {
    out.push({
      ref: 'step:' + s.id, at: s.recorded_at || null,
      agent: s.agent || null, tool: s.tool || null,
      kind: 'step', title: s.title || s.stage || ('步骤 #' + s.id),
      snippet: String(s.detail || s.result || '').slice(0, 300),
    })
  }

  const nodeWhere = ["state != 'deleted'"]
  const nodeArgs = []
  if (from) { nodeWhere.push('created_at >= ?'); nodeArgs.push(from) }
  if (ag) { nodeWhere.push('owner = ?'); nodeArgs.push(ag) }
  if (like) {
    nodeWhere.push("(COALESCE(title,'') LIKE ? OR COALESCE(body,'') LIKE ?)")
    nodeArgs.push(like, like)
  }
  for (const n of db.prepare(
    'SELECT * FROM exploration_node WHERE ' + nodeWhere.join(' AND ')
    + ' ORDER BY created_at DESC, id DESC LIMIT ?',
  ).all(...nodeArgs, lim)) {
    out.push({
      ref: 'node:' + n.id, at: n.updated_at || n.created_at || null,
      agent: n.owner || null, tool: n.origin || null,
      kind: n.kind, title: n.title || ('节点 #' + n.id),
      snippet: String(n.body || '').slice(0, 300),
    })
  }

  out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
  return out.slice(0, lim)
}

/** 取一条轨迹的完整上下文：ref = step:<id> 或 node:<id>。 */
export function getTrace(db, ref) {
  const s = String(ref || '')
  const m = /^(step|node):(\d+)$/.exec(s)
  if (!m) throw new Error('trace ref 非法: ' + s + '（应为 step:<id> 或 node:<id>）')
  const kind = m[1]
  const id = Number(m[2])

  if (kind === 'step') {
    const step = db.prepare('SELECT * FROM attack_step WHERE id = ?').get(id)
    if (!step) throw new Error('攻击步骤不存在: ' + s)
    const linked = { nodes: [], edges: [], attack_step: step }
    const er = step.evidence_ref
    if (er != null && String(er) !== '') {
      linked.http_evidence = db.prepare(
        'SELECT * FROM http_evidence WHERE CAST(id AS TEXT) = ? OR label = ? LIMIT 1',
      ).get(String(er), String(er)) || null
      linked.nodes = db.prepare(
        "SELECT * FROM exploration_node WHERE state!='deleted' AND (body LIKE ? OR title LIKE ?) ORDER BY id LIMIT 50",
      ).all('%' + String(er) + '%', '%' + String(er) + '%')
    }
    return { trace: { ref: s, kind: 'step', at: step.recorded_at || null, ...step }, linked }
  }

  const node = db.prepare('SELECT * FROM exploration_node WHERE id = ?').get(id)
  if (!node) throw new Error('探索节点不存在: ' + s)
  const edges = db.prepare(
    'SELECT * FROM exploration_edge WHERE exploration_id = ? AND (src_id = ? OR dst_id = ?) ORDER BY id',
  ).all(node.exploration_id, id, id)
  const ids = new Set([id])
  for (const e of edges) { ids.add(e.src_id); ids.add(e.dst_id) }
  const nodes = db.prepare(
    `SELECT * FROM exploration_node WHERE id IN (${[...ids].map(() => '?').join(',')}) ORDER BY id`,
  ).all(...ids)
  return {
    trace: { ref: s, kind: 'node', at: node.updated_at || node.created_at || null, ...node },
    linked: { nodes, edges },
  }
}
