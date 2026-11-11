/**
 * ARTEX P2 · 探索图工具集单测（docs/artex/artex-p2p4-design.md §1.4 / §1.6.5）
 *
 * 覆盖：
 *   1. 每个 redteam_explore_* / redteam_engine 工具的成功路径（走真实 RedteamStore）；
 *   2. 每个工具的非法入参 → 结构化 bad_input（不抛给模型）；
 *   3. 工具清单数量自检（既有 64 基线 + EXPLORE_TOOL_NAMES 全登记、无重名）；
 *   4. observed vs inferred 口径、intent dedupe、prove 收官守卫、wake 回声矩阵。
 *
 * 只把宿主 defineTool 换成恒等实现（setDefineToolLoader），execute 与线上同路径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RedteamStore } from '../lib/redteam/store-core.js'
import { setDefineToolLoader } from '../lib/redteam/host-tools.js'
import { apply as applyCoreTools, EXPLORE_TOOL_NAMES } from '../lib/redteam/tools.js'

const L = { limit: -1 } // 通用非法入参（所有非 standalone 工具都会做 optLimit 校验）

function seed(store, id) {
  const api = store.exploration(id)
  const db = store.db(id)
  const eid = api.create({ goal: '证明 10.0.0.0/24 存在可 exploit 的服务' })
  const goal = api.addNode({ exploration_id: eid, kind: 'goal', title: '判据：至少一条 finding', state: 'done' })
  const i1 = api.addNode({ exploration_id: eid, kind: 'intent', title: '探测 80 端口', priority: 5 })
  const i2 = api.addNode({ exploration_id: eid, kind: 'intent', title: '探测 443 端口', priority: 3 })
  const f1 = api.addNode({ exploration_id: eid, kind: 'fact', title: '80 开放', parent_id: i1, payload: { provenance: 'observed' } })
  const f2 = api.addNode({ exploration_id: eid, kind: 'finding', title: '发现管理后台', parent_id: i2, payload: { provenance: 'inferred', severity: 'high' } })
  api.addEdge({ exploration_id: eid, src_id: i1, dst_id: f1, rel: 'yields' })
  api.addConstraint({ kind: 'allow', text: '仅 10.0.0.0/24' })
  api.addConstraint({ kind: 'deny', text: '禁止破坏性操作' })
  const a1 = Number(db.prepare('INSERT INTO asset (segment_cidr, ip, primary_name, test_status) VALUES (?,?,?,?)')
    .run('10.0.0.0/24', '10.0.0.5', 'web', 'untested').lastInsertRowid)
  const a2 = Number(db.prepare('INSERT INTO asset (segment_cidr, ip, primary_name, test_status) VALUES (?,?,?,?)')
    .run('10.0.0.0/24', '10.0.0.6', 'db', 'untested').lastInsertRowid)
  api.anchor({ node_id: f2, asset_id: a1 }) // a2 故意不锚 → coverage 里应出现
  db.prepare('INSERT INTO attack_step (seq, stage, title, detail, agent, tool, result, recorded_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(1, 'recon', '端口扫描', 'nmap -sV 10.0.0.0/24', 'agent-1', 'nmap', '80/open', new Date().toISOString())
  return { eid, goal, i1, i2, f1, f2, a1, a2 }
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'mantis-explore-tools-'))
  const store = new RedteamStore(root)
  const engagement = store.openEngagement('P2 探索靶标', [], { bindCurrent: false })
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
    root, store, tools, byName, exec, s,
    close() {
      setDefineToolLoader(previousLoader)
      try { store.close() } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 每个工具：ok() 构造成功入参（自动注入 engagement），check() 可选，bad() 构造非法入参。 */
const CASES = [
  {
    name: 'redteam_explore_open',
    ok: () => ({ goal: '证明边界可达', note: '开局说明' }),
    check: (r) => { assert.ok(r.exploration_id > 0); assert.equal(r.status, 'open'); assert.equal(r.round_no, 0); assert.equal(r.wake.planner, true) },
    bad: () => ({}),
  },
  {
    name: 'redteam_explore_create',
    ok: () => ({ goal: 'create 别名新建' }),
    check: (r) => { assert.ok(r.exploration_id > 0); assert.equal(r.status, 'open') },
    bad: () => ({}),
  },
  {
    name: 'redteam_explore_status',
    ok: (s) => ({ exploration_id: s.eid }),
    check: (r, s) => { assert.equal(r.exploration.id, s.eid); assert.ok(r.overview.byKind); assert.ok(r.wake_stats) },
    bad: () => ({ exploration_id: 999999 }),
  },
  {
    name: 'redteam_explore_overview',
    ok: (s) => ({ exploration_id: s.eid }),
    check: (r) => { assert.ok(r.overview.byKind); assert.ok(r.wake_stats) },
    bad: () => ({ exploration_id: 999999 }),
  },
  {
    name: 'redteam_explore_goal_add',
    ok: (s) => ({ exploration_id: s.eid, title: '判据2', body: '至少两条 finding' }),
    check: (r) => { assert.ok(r.node_id > 0); assert.equal(r.wake.planner, true) },
    bad: () => ({}),
  },
  {
    name: 'redteam_explore_goal_list',
    ok: (s) => ({ exploration_id: s.eid }),
    check: (r, s) => { assert.ok(r.items.some((x) => x.id === s.goal)) },
    bad: () => L,
  },
  {
    name: 'redteam_explore_plan',
    ok: (s) => ({ exploration_id: s.eid, action: 'brief' }),
    check: (r) => { assert.ok(['commander', 'frontier'].includes(r.engine)); assert.ok(r.briefing.decision); assert.equal(r.wake, undefined) },
    bad: () => ({ action: 'nope' }),
  },
  {
    name: 'redteam_explore_prove',
    ok: (s) => ({ exploration_id: s.eid, verdict: 'achieved', reason: '判据满足', force: true }),
    check: (r) => { assert.equal(r.status, 'achieved'); assert.ok(r.round_no >= 1); assert.equal(typeof r.prove.score, 'number') },
    bad: () => ({ verdict: 'nope', reason: 'x' }),
  },
  {
    name: 'redteam_explore_intent_add',
    ok: (s) => ({ exploration_id: s.eid, title: '探测 8080', priority: 7, parent_id: s.i1 }),
    check: (r) => { assert.ok(r.id > 0); assert.equal(r.deduped, false); assert.equal(r.wake.planner, true) },
    bad: () => ({}),
  },
  {
    name: 'redteam_explore_intent_claim',
    ok: (s) => ({ id: s.i1 }),
    check: async (r, s, exec) => {
      assert.equal(r.ok, true); assert.ok(r.owner); assert.equal(r.wake.reason, 'intent_state_changed')
      const again = await exec('redteam_explore_intent_claim', { engagement: s.engagement, id: s.i1 })
      assert.equal(again.ok, false)
      assert.equal(again.error_kind, 'failed')
    },
    bad: () => ({}),
  },
  {
    name: 'redteam_explore_intent_update',
    ok: (s) => ({ id: s.i2, state: 'done' }),
    check: (r) => { assert.equal(r.state, 'done'); assert.equal(r.wake.planner, true) },
    bad: (s) => ({ id: s.i2, state: 'nope' }),
  },
  {
    name: 'redteam_explore_intent_list',
    ok: (s) => ({ exploration_id: s.eid, state: 'open' }),
    check: (r, s) => { assert.ok(r.items.some((x) => x.id === s.i1)) },
    bad: (s) => ({ exploration_id: s.eid, state: 'nope' }),
  },
  {
    name: 'redteam_explore_intent_brief',
    ok: (s) => ({ id: s.i1 }),
    check: (r) => { assert.match(r.brief, /收尾义务/); assert.match(r.brief, /\[allow\]/); assert.match(r.brief, /\[deny\]/) },
    bad: () => ({}),
  },
  {
    name: 'redteam_explore_node_add',
    ok: (s) => ({ exploration_id: s.eid, kind: 'fact', title: '443 开放', provenance: 'observed', parent_id: s.i1, evidence: 'nmap 回显' }),
    check: async (r, s, exec) => {
      assert.ok(r.node_id > 0)
      assert.equal(r.wake.reason, 'fact_recorded')
      const finding = await exec('redteam_explore_node_add', {
        engagement: s.engagement, exploration_id: s.eid, kind: 'finding', title: '后台弱口令',
        provenance: 'inferred', severity: 'critical', anchor_asset_ids: [s.a2],
      })
      assert.equal(finding.wake.reason, 'finding_recorded')
    },
    bad: () => ({ kind: 'nope' }),
  },
  {
    name: 'redteam_explore_add_node',
    ok: (s) => ({ exploration_id: s.eid, kind: 'finding', title: '推断：存在管理口', provenance: 'inferred', parent_id: s.i2, anchor_asset_ids: [s.a1] }),
    check: (r) => { assert.ok(r.node_id > 0); assert.equal(r.wake.reason, 'finding_recorded') },
    bad: () => ({ kind: 'nope' }),
  },
  {
    name: 'redteam_explore_node_list',
    ok: (s) => ({ exploration_id: s.eid, kind: 'fact' }),
    check: (r, s) => { assert.ok(r.items.some((x) => x.id === s.f1)) },
    bad: (s) => ({ exploration_id: s.eid, kind: 'nope' }),
  },
  {
    name: 'redteam_explore_edge_add',
    ok: (s) => ({ exploration_id: s.eid, src_id: s.i1, dst_id: s.f2, rel: 'derived_from' }),
    check: (r) => { assert.equal(r.created, true) },
    bad: (s) => ({ exploration_id: s.eid, src_id: s.i1, dst_id: s.f1, rel: 'nope' }),
  },
  {
    name: 'redteam_explore_add_edge',
    ok: (s) => ({ exploration_id: s.eid, src_id: s.i2, dst_id: s.f1, rel: 'proves' }),
    check: (r) => { assert.equal(r.created, true) },
    bad: (s) => ({ exploration_id: s.eid, src_id: s.i1, dst_id: s.f1, rel: 'nope' }),
  },
  {
    name: 'redteam_explore_anchor',
    ok: (s) => ({ node_id: s.f1, asset_id: s.a2 }),
    check: (r) => { assert.equal(r.created, true); assert.equal(r.wake.planner, true) },
    bad: () => ({}),
  },
  {
    name: 'redteam_explore_list_frontier',
    ok: (s) => ({ exploration_id: s.eid }),
    check: (r, s) => { assert.ok(r.items.some((x) => x.id === s.i1)) },
    bad: () => L,
  },
  {
    name: 'redteam_explore_coverage',
    ok: (s) => ({ exploration_id: s.eid }),
    check: (r, s) => {
      assert.ok(r.overview.byKind)
      assert.ok(r.unanchored_assets.some((x) => x.id === s.a2), '未锚定资产应出现')
      assert.ok(r.findings_by_severity.high >= 1)
    },
    bad: () => ({ exploration_id: 999999 }),
  },
  {
    name: 'redteam_explore_todolist',
    ok: (s) => ({ exploration_id: s.eid, action: 'replace', items: ['复核 80', '复核 443'] }),
    check: async (r, s, exec) => {
      assert.deepEqual(r.items, ['复核 80', '复核 443'])
      assert.equal(r.wake.planner, true)
      const got = await exec('redteam_explore_todolist', { engagement: s.engagement, exploration_id: s.eid, action: 'get' })
      assert.deepEqual(got.items, ['复核 80', '复核 443'])
    },
    bad: () => ({ action: 'nope' }),
  },
  {
    name: 'redteam_explore_trace_search',
    ok: () => ({ q: '端口' }),
    check: (r) => { assert.ok(Array.isArray(r.items)); assert.ok(r.items.length >= 1) },
    bad: () => L,
  },
  {
    name: 'redteam_explore_trace_list',
    ok: () => ({}),
    check: (r) => { assert.ok(Array.isArray(r.items)) },
    bad: () => L,
  },
  {
    name: 'redteam_explore_trace_get',
    ok: (s) => ({ ref: 'node:' + s.f1 }),
    check: (r, s) => { assert.equal(r.trace.ref, 'node:' + s.f1); assert.ok(r.linked.nodes.some((n) => n.id === s.f1)) },
    bad: () => ({ ref: 'bad' }),
  },
  {
    name: 'redteam_explore_constraint_add',
    ok: () => ({ kind: 'allow', text: '仅工作日 09:00-18:00' }),
    check: (r) => { assert.ok(r.id > 0) },
    bad: () => ({ kind: 'nope', text: 'x' }),
  },
  {
    name: 'redteam_explore_constraint',
    ok: () => ({ kind: 'deny', text: '禁止扫描 443' }),
    check: (r) => { assert.ok(r.id > 0) },
    bad: () => ({ kind: 'nope', text: 'x' }),
  },
  {
    name: 'redteam_explore_constraint_list',
    ok: () => ({}),
    check: (r) => { assert.ok(r.items.length >= 2); assert.ok(r.items.some((x) => x.kind === 'deny')) },
    bad: () => L,
  },
  {
    name: 'redteam_engine',
    ok: () => ({}),
    check: async (r, s, exec) => {
      assert.equal(r.engine, 'commander')
      assert.equal(r.source, 'default')
      const set = await exec('redteam_engine', { set: 'frontier' })
      assert.equal(set.engine, 'frontier')
      const read = await exec('redteam_engine', {})
      assert.equal(read.engine, 'frontier')
      assert.equal(read.source, 'settings')
    },
    bad: () => ({ set: 'nope' }),
  },
]

for (const c of CASES) {
  test('工具 ' + c.name + '：成功路径 + 非法入参 bad_input', async () => {
    const h = harness()
    try {
      const okArgs = { engagement: h.s.engagement, ...c.ok(h.s) }
      const okRes = await h.exec(c.name, okArgs)
      assert.equal(okRes.ok, true, c.name + ' 成功路径返回：' + JSON.stringify(okRes))
      if (c.check) await c.check(okRes, h.s, h.exec)

      const badArgs = { engagement: h.s.engagement, ...c.bad(h.s) }
      const badRes = await h.exec(c.name, badArgs)
      assert.equal(badRes.ok, false, c.name + ' 非法入参未被拒绝：' + JSON.stringify(badRes))
      assert.equal(badRes.error_kind, 'bad_input', c.name + ' 错误种类：' + JSON.stringify(badRes))
    } finally {
      h.close()
    }
  })
}

test('工具清单数量自检：64 基线 + EXPLORE_TOOL_NAMES，全登记且无重名', () => {
  const h = harness()
  try {
    assert.equal(h.tools.length, 64 + EXPLORE_TOOL_NAMES.length,
      'tools.js 注册总数变了：' + h.tools.length)
    const names = h.tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, '存在重复注册的工具名')
    const set = new Set(names)
    for (const name of EXPLORE_TOOL_NAMES) assert.ok(set.has(name), '缺少探索工具 ' + name)
    for (const t of h.tools) {
      assert.equal(typeof t.execute, 'function', t.name + ' 缺 execute')
      assert.match(t.description, /[\u4e00-\u9fa5]/, t.name + ' 描述非中文')
      assert.ok(t.parameters && typeof t.parameters === 'object', t.name + ' 缺参数定义')
    }
    /* observed/inferred 口径必须写进 node_add / add_node 的参数描述 */
    for (const name of ['redteam_explore_node_add', 'redteam_explore_add_node']) {
      const p = h.byName[name].parameters.provenance.description
      assert.match(p, /observed/)
      assert.match(p, /inferred/)
    }
  } finally {
    h.close()
  }
})

test('探索工具集与既有工具、traffic 工具均不重名；wake 矩阵抽查', () => {
  const h = harness()
  try {
    const exploreSet = new Set(EXPLORE_TOOL_NAMES)
    assert.equal(exploreSet.size, EXPLORE_TOOL_NAMES.length)
    assert.ok(exploreSet.has('redteam_explore_create'))
    assert.ok(exploreSet.has('redteam_explore_add_node'))
    assert.ok(exploreSet.has('redteam_explore_add_edge'))
    assert.ok(exploreSet.has('redteam_explore_list_frontier'))
    assert.ok(exploreSet.has('redteam_explore_overview'))
    assert.ok(exploreSet.has('redteam_explore_constraint'))
    for (const name of ['redteam_engagement_open', 'redteam_asset_query', 'redteam_unknown_list']) {
      assert.ok(!exploreSet.has(name), '探索工具名撞上既有工具：' + name)
    }
    /* 既有 64 个工具一个不少 */
    const nonExplore = h.tools.filter((t) => !exploreSet.has(t.name))
    assert.equal(nonExplore.length, 64)
  } finally {
    h.close()
  }
})

test('intent_add 同名 dedupe：第二次 deduped=true 且不新建；prove 收官守卫', async () => {
  const h = harness()
  try {
    const first = await h.exec('redteam_explore_intent_add', {
      engagement: h.s.engagement, exploration_id: h.s.eid, title: '  探测 9090 ！ ',
    })
    assert.equal(first.deduped, false)
    const second = await h.exec('redteam_explore_intent_add', {
      engagement: h.s.engagement, exploration_id: h.s.eid, title: '探测9090',
    })
    assert.equal(second.deduped, true)
    assert.equal(second.id, first.id)

    /* 有 open/running 意图时，achieved 无 force 被拒并返回 blocked_intents */
    const blocked = await h.exec('redteam_explore_prove', {
      engagement: h.s.engagement, exploration_id: h.s.eid, verdict: 'achieved', reason: '收官',
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error_kind, 'bad_input')
    assert.ok(Array.isArray(blocked.blocked_intents) && blocked.blocked_intents.length >= 1)

    /* failed / stopped 直接放行但要 reason */
    const failed = await h.exec('redteam_explore_prove', {
      engagement: h.s.engagement, exploration_id: h.s.eid, verdict: 'failed', reason: '范围变更',
    })
    assert.equal(failed.ok, true)
    assert.equal(failed.status, 'failed')
    const noReason = await h.exec('redteam_explore_prove', {
      engagement: h.s.engagement, exploration_id: h.s.eid, verdict: 'failed',
    })
    assert.equal(noReason.ok, false)
    assert.equal(noReason.error_kind, 'bad_input')
  } finally {
    h.close()
  }
})

test('写回实证：observed/inferred 真落 payload、anchor 真落锚、edge 幂等、blocked 缺 reason 被拒', async () => {
  const h = harness()
  try {
    const obs = await h.exec('redteam_explore_node_add', {
      engagement: h.s.engagement, exploration_id: h.s.eid, kind: 'fact',
      title: '直接观测 8080', provenance: 'observed', evidence: 'curl 回显 200',
    })
    const inf = await h.exec('redteam_explore_add_node', {
      engagement: h.s.engagement, exploration_id: h.s.eid, kind: 'finding',
      title: '推断存在后台', provenance: 'inferred', severity: 'high', anchor_asset_ids: [h.s.a2],
    })
    const db = h.store.db(h.s.engagement)
    const rowOf = (nid) => db.prepare('SELECT * FROM exploration_node WHERE id = ?').get(nid)
    const obsPayload = JSON.parse(rowOf(obs.node_id).payload)
    const infPayload = JSON.parse(rowOf(inf.node_id).payload)
    assert.equal(obsPayload.provenance, 'observed', 'observed 未落库')
    assert.equal(obsPayload.evidence, 'curl 回显 200')
    assert.equal(infPayload.provenance, 'inferred', 'inferred 未落库')
    assert.equal(infPayload.severity, 'high')
    assert.equal(rowOf(obs.node_id).kind, 'fact')
    assert.equal(rowOf(inf.node_id).kind, 'finding')
    const anchored = db.prepare('SELECT COUNT(*) AS n FROM exploration_anchor WHERE node_id = ? AND asset_id = ?')
      .get(inf.node_id, h.s.a2).n
    assert.equal(anchored, 1, 'anchor_asset_ids 未落锚')

    /* addEdge 重复 → created=false（INSERT OR IGNORE） */
    const e1 = await h.exec('redteam_explore_edge_add', {
      engagement: h.s.engagement, exploration_id: h.s.eid, src_id: obs.node_id, dst_id: inf.node_id, rel: 'yields',
    })
    const e2 = await h.exec('redteam_explore_add_edge', {
      engagement: h.s.engagement, exploration_id: h.s.eid, src_id: obs.node_id, dst_id: inf.node_id, rel: 'yields',
    })
    assert.equal(e1.created, true)
    assert.equal(e2.created, false, '重复边应幂等')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exploration_edge WHERE src_id = ? AND dst_id = ? AND rel = ?')
      .get(obs.node_id, inf.node_id, 'yields').n, 1)

    /* state=blocked 必填 blocked_reason */
    const blocked = await h.exec('redteam_explore_intent_update', {
      engagement: h.s.engagement, id: h.s.i2, state: 'blocked',
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error_kind, 'bad_input')
    assert.equal(rowOf(h.s.i2).state, 'open', '被拒后不应改动意图状态')
  } finally {
    h.close()
  }
})

test('plan(begin) 带 wake 且推进 round_no；brief 不带 wake 不推进', async () => {
  const h = harness()
  try {
    const before = await h.exec('redteam_explore_status', { engagement: h.s.engagement, exploration_id: h.s.eid })
    const brief = await h.exec('redteam_explore_plan', { engagement: h.s.engagement, exploration_id: h.s.eid, action: 'brief' })
    assert.equal(brief.wake, undefined)
    assert.equal(brief.round_no, before.exploration.round_no)
    const begin = await h.exec('redteam_explore_plan', { engagement: h.s.engagement, exploration_id: h.s.eid, action: 'begin' })
    assert.equal(begin.wake.planner, true)
    assert.equal(begin.round_no, before.exploration.round_no + 1)
    assert.equal(typeof begin.briefing.decision, 'string')
  } finally {
    h.close()
  }
})
