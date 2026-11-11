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
