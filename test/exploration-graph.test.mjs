import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { DDL } from '../lib/redteam/schema.js'
import {
  createExploration, addNode, addEdge, listFrontier, setNodeState,
  setExplorationStatus, graphOverview, addConstraint, listConstraints, anchorNode,
} from '../lib/redteam/exploration.js'

test('exploration graph: goal→intent→fact 基本流转', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)

  const eid = createExploration(db, { target: 'demo', goal: '拿下后台' })
  const goal = addNode(db, { exploration_id: eid, kind: 'goal', title: '拿下后台' })
  const i1 = addNode(db, { exploration_id: eid, kind: 'intent', title: '子域枚举', parent_id: goal, priority: 5 })
  const i2 = addNode(db, { exploration_id: eid, kind: 'intent', title: '指纹识别', parent_id: goal, priority: 1 })

  // 两条意图都 open → 前沿 2 条，按 priority DESC 排，第一条是 i1
  let front = listFrontier(db, eid)
  assert.equal(front.length, 2)
  assert.equal(front[0].id, i1)

  // 一条转 running，就不再在前沿里
  assert.equal(setNodeState(db, i2, 'running'), true)
  front = listFrontier(db, eid)
  assert.equal(front.length, 1)
  assert.equal(front[0].id, i1)

  // 意图产出事实；事实反手挂一条 derived_from 边
  const fact = addNode(db, { exploration_id: eid, kind: 'fact', title: '发现 80 端口', parent_id: i1 })
  assert.equal(addEdge(db, { exploration_id: eid, src_id: fact, dst_id: i1, rel: 'derived_from' }), true)
  // 重复边被 UNIQUE 忽略
  assert.equal(addEdge(db, { exploration_id: eid, src_id: fact, dst_id: i1, rel: 'derived_from' }), false)

  // parent_id 自动生成一条 spawns 边（goal→i1、goal→i2、i1→fact）
  const spawns = db.prepare("SELECT COUNT(*) n FROM exploration_edge WHERE exploration_id=? AND rel='spawns'").get(eid).n
  assert.equal(spawns, 3)

  // 约束
  addConstraint(db, { target: 'demo', kind: 'deny', text: '禁止打生产库' })
  assert.equal(listConstraints(db, 'demo').length, 1)

  // 概览
  const ov = graphOverview(db, eid)
  assert.equal(ov.open_intents, 1)
  assert.equal(ov.byKind.find((k) => k.kind === 'intent').n, 2)
  assert.equal(ov.byKind.find((k) => k.kind === 'fact').n, 1)

  // 收官
  assert.equal(setExplorationStatus(db, eid, 'achieved', { roundNo: 3 }), true)
  const row = db.prepare('SELECT status, round_no FROM exploration WHERE id=?').get(eid)
  assert.equal(row.status, 'achieved')
  assert.equal(row.round_no, 3)

  db.close()
})

test('exploration graph: 非法 kind / state / rel 抛错', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)
  const eid = createExploration(db, { target: 'demo2', goal: 'g' })
  assert.throws(() => addNode(db, { exploration_id: eid, kind: 'bogus' }), /kind 非法/)
  const n = addNode(db, { exploration_id: eid, kind: 'intent' })
  assert.throws(() => setNodeState(db, n, 'weird'), /state 非法/)
  assert.throws(() => addEdge(db, { exploration_id: eid, src_id: n, dst_id: n, rel: 'bogus' }), /rel 非法/)
  db.close()
})
