/**
 * tools-traffic profile 收口（L1 补丁）
 *
 * 契约：主预设（无 config = full）7 个流量/审批工具全挂；报告员（profile=reporter）
 * 只挂 3 个只读流量工具，不得拿到 redteam_traffic_bind（写）与 redteam_intercept_*（审批）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { setDefineToolLoader } from '../lib/redteam/host-tools.js'
import { apply as applyTraffic, TRAFFIC_PROFILE_TOOLS } from '../lib/redteam/tools-traffic.js'

const ALL = [
  'redteam_traffic_search', 'redteam_traffic_get', 'redteam_traffic_blob', 'redteam_traffic_bind',
  'redteam_intercept_check', 'redteam_intercept_decide', 'redteam_intercept_rule',
]

function run(config) {
  const tools = []
  const stub = { root: '/tmp/redteam-test', dirOf: () => '/tmp/redteam-test', db: () => null, traffic: () => ({}) }
  const ctx = {
    redteam: stub,
    tools: { register: (t) => tools.push(t) },
    logger: { warn() {}, info() {} },
    get: () => undefined,
  }
  const prev = setDefineToolLoader((spec) => spec)
  try {
    applyTraffic(ctx, config)
  } finally {
    setDefineToolLoader(prev)
  }
  return tools.map((t) => t.name)
}

test('tools-traffic：full 注册 7 个（含 bind / intercept），report 只注册 3 个只读', () => {
  const full = run(undefined)
  assert.deepEqual([...full].sort(), [...ALL].sort())

  const reporter = run({ profile: 'reporter' })
  assert.deepEqual([...reporter].sort(), [...TRAFFIC_PROFILE_TOOLS.reporter].sort())
  assert.ok(!reporter.includes('redteam_traffic_bind'), '报告员不得有绑定写工具')
  assert.ok(!reporter.some((n) => n.startsWith('redteam_intercept_')), '报告员不得有审批门工具')
})
