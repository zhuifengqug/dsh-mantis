/**
 * L1 · reporter / retester 独立预设（设计 docs/redteam/L1L2L3-design.md §3）
 *
 * 覆盖：
 *   1. 三份随包预设都能被 readPresetDefinition 解析（宿主注册的前提）；
 *   2. reporter / retester 的 redteam-tools 行带 profile，主预设不带（保持 full）；
 *   3. tools.js apply 的 profile 收口：full=64+探索+ops，reporter/retester 只挂各自子集；
 *   4. installPreset 循环落地三个预设到 $DSH_HOME/.agent-presets/<id>/，幂等不失败。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readPresetDefinition } from '../lib/redteam/preset-composition.js'
import { setDefineToolLoader } from '../lib/redteam/host-tools.js'
import { apply as applyCoreTools, PROFILE_TOOLS, EXPLORE_TOOL_NAMES, OPS_TOOL_NAMES } from '../lib/redteam/tools.js'
import { apply as applyOpsTools } from '../lib/redteam/tools-ops.js'
import { installPreset } from '../lib/redteam/index.js'

const ROOT = process.cwd()
const PRESETS = [
  { id: 'redteam', dir: 'presets/redteam', name: '红队模式', order: 10, profile: null },
  { id: 'redteam-reporter', dir: 'presets/redteam-reporter', name: '红队·报告员', order: 11, profile: 'reporter' },
  { id: 'redteam-retester', dir: 'presets/redteam-retester', name: '红队·复测员', order: 12, profile: 'retester' },
]

/* ---------- 1. 三份预设都能被解析，名称/序号/工具行 profile 正确 ---------- */

test('三份随包预设均可被 readPresetDefinition 解析，名称保留「红队」', () => {
  for (const spec of PRESETS) {
    const def = readPresetDefinition(spec.id, join(ROOT, spec.dir))
    assert.equal(def.id, spec.id)
    assert.equal(def.name, spec.name)
    assert.equal(def.order, spec.order)
    assert.ok(def.name.includes('红队'), `${spec.id} 名称必须含「红队」以命中 isRedteamPresetId`)
    assert.ok(Array.isArray(def.plugins) && def.plugins.length > 0)

    const toolsRow = def.plugins.find((p) => p && p.name === '@zhuifengqug/dsh-mantis/redteam/tools')
    assert.ok(toolsRow, `${spec.id} 必须挂 redteam-tools`)
    if (spec.profile) {
      assert.equal(toolsRow.config && toolsRow.config.profile, spec.profile)
      /* 独立预设把 ops 那 11 个工具拆成单独一行，同样带 profile 收口 */
      const opsRow = def.plugins.find((p) => p && p.name === '@zhuifengqug/dsh-mantis/redteam/tools-ops')
      assert.ok(opsRow, `${spec.id} 必须挂 redteam-tools-ops`)
      assert.equal(opsRow.config && opsRow.config.profile, spec.profile)
    } else {
      assert.equal(toolsRow.config && toolsRow.config.profile, undefined, '主预设不写 profile = full')
      /* 主预设走 tools.js 内联注册 ops，不单独挂 tools-ops 行（否则重复注册） */
      const opsRow = def.plugins.find((p) => p && p.name === '@zhuifengqug/dsh-mantis/redteam/tools-ops')
      assert.equal(opsRow, undefined, '主预设不应单独挂 redteam-tools-ops')
    }
  }
})

test('报告员不挂 subagent/shell；复测员挂 shell 但不挂 subagent', () => {
  const reporter = readPresetDefinition('redteam-reporter', join(ROOT, 'presets/redteam-reporter'))
  const names = reporter.plugins.map((p) => (typeof p === 'string' ? p : p.name))
  assert.ok(!names.includes('@deepseek-ai/dsh-tool-bash') && !names.includes('@deepseek-ai/dsh-tool-pwsh'))
  assert.ok(!names.some((n) => String(n).includes('subagent')), '报告员不给派活工具')
  assert.ok(names.includes('@zhuifengqug/dsh-mantis/redteam/tools-traffic'), '报告员可读流量证据')

  const retester = readPresetDefinition('redteam-retester', join(ROOT, 'presets/redteam-retester'))
  const rnames = retester.plugins.map((p) => (typeof p === 'string' ? p : p.name))
  assert.ok(rnames.includes('@deepseek-ai/dsh-tool-bash') || rnames.includes('@deepseek-ai/dsh-tool-pwsh'), '复测员要能跑 PoC 命令')
  assert.ok(!rnames.some((n) => String(n).includes('subagent')), '复测员不给派活工具')
})

/* ---------- 2. tools.js profile 收口 ---------- */

function runApply(config) {
  const tools = []
  const ctx = {
    redteam: null,
    tools: { register: (t) => tools.push(t) },
    effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
    on: () => () => {},
    logger: { warn() {}, info() {} },
    get: () => undefined,
  }
  /* 不连真实库：store 解析失败会走 stub，工具仍注册（只测数量与名单） */
  const prevLoader = setDefineToolLoader((spec) => spec)
  try {
    applyCoreTools(ctx, config)
  } finally {
    setDefineToolLoader(prevLoader)
  }
  return tools.map((t) => t.name)
}

/* tools-ops 独立插件：真实宿主里 store 一定存在；这里给一个最小 stub，注册期不触碰。 */
function runOps(config) {
  const tools = []
  const stub = { root: '/tmp/redteam-test', dirOf: () => '/tmp/redteam-test', db: () => null }
  const ctx = {
    redteam: stub,
    tools: { register: (t) => tools.push(t) },
    logger: { warn() {}, info() {} },
    get: () => undefined,
  }
  const prevLoader = setDefineToolLoader((spec) => spec)
  try {
    applyOpsTools(ctx, config)
  } finally {
    setDefineToolLoader(prevLoader)
  }
  return tools.map((t) => t.name)
}

/* 独立预设的真实工具集 = tools.js(非 full) ∪ tools-ops(同 profile) */
function presetTools(profile) {
  return [...runApply({ profile }), ...runOps({ profile })]
}

test('profile 收口：full 注册全部，reporter/retester 只挂子集', () => {
  const full = runApply(undefined)
  assert.equal(full.length, 64 + EXPLORE_TOOL_NAMES.length + OPS_TOOL_NAMES.length)
  assert.equal(new Set(full).size, full.length, '不得有重名工具')

  /* tools-ops 单挂 full = 11 个 ops */
  const opsOnly = runOps(undefined)
  assert.equal(opsOnly.length, OPS_TOOL_NAMES.length)
  assert.deepEqual(opsOnly, [...OPS_TOOL_NAMES])

  const reporter = presetTools('reporter')
  const retester = presetTools('retester')
  assert.equal(new Set(reporter).size, reporter.length, '报告员不得有重名工具')
  assert.equal(new Set(retester).size, retester.length, '复测员不得有重名工具')
  assert.equal(reporter.length, PROFILE_TOOLS.reporter.length)
  assert.equal(retester.length, PROFILE_TOOLS.retester.length)
  assert.ok(reporter.length < full.length && retester.length < full.length)

  /* 报告员：有报告产出与模板，无执行/写入/复测类 */
  assert.ok(reporter.includes('redteam_report_build'))
  assert.ok(reporter.includes('redteam_template_list'))
  assert.ok(!reporter.includes('redteam_vuln_add'))
  assert.ok(!reporter.includes('redteam_retest_conclude'))
  assert.ok(!reporter.includes('redteam_notify_send'))

  /* 复测员：有复测三件套与回写，无报告产出、无模板 */
  assert.ok(retester.includes('redteam_retest_request'))
  assert.ok(retester.includes('redteam_retest_list'))
  assert.ok(retester.includes('redteam_retest_conclude'))
  assert.ok(retester.includes('redteam_vuln_update'))
  assert.ok(!retester.includes('redteam_report_build'))
  assert.ok(!retester.includes('redteam_template_apply'))
})

/* ---------- 3. installPreset 循环落地三个预设，幂等 ---------- */

test('installPreset 把三个预设装进 $DSH_HOME/.agent-presets 且幂等', () => {
  const home = mkdtempSync(join(tmpdir(), 'mantis-l1-presets-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const first = installPreset({ log: () => {} })
    assert.equal(first.presets.length, 3)
    for (const spec of PRESETS) {
      const agentFile = join(home, '.agent-presets', spec.id, 'agent.cordis.yml')
      assert.ok(existsSync(agentFile), `${spec.id} 未落地`)
      assert.ok(existsSync(join(home, '.agent-presets', spec.id, 'preset.yml')))
      /* 占位符必须已被真实路径替换 */
      const text = readFileSync(agentFile, 'utf8')
      assert.ok(!text.includes('{{REDTEAM_SKILLS_DIR}}'), `${spec.id} 仍留占位符`)
    }
    /* 回读安装后的报告员/复测员元数据 */
    const rep = readPresetDefinition('redteam-reporter', join(home, '.agent-presets', 'redteam-reporter'))
    assert.equal(rep.name, '红队·报告员')
    assert.equal(rep.order, 11)
    const ret = readPresetDefinition('redteam-retester', join(home, '.agent-presets', 'redteam-retester'))
    assert.equal(ret.name, '红队·复测员')
    assert.equal(ret.order, 12)

    /* 幂等：再跑一次不新增、不失败、仍是三个 */
    const second = installPreset({ log: () => {} })
    assert.equal(second.presets.length, 3)
    assert.ok(second.presets.every((p) => p.action !== 'failed'))
  } finally {
    if (prevHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})
