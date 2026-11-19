import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ALL_PATCHES,
  deletionStatus,
  filePatchOutcome,
  occurrences,
  patchCrowdForFile,
  patchEnabledByGate,
  patchGroupOf,
  patchStatus,
  patchedTargetStillPatched,
  readPatchGate,
  targetFiles,
} from '../lib/core.js'
import { readTuning, writeTuning, TUNING_DEFAULTS } from '../lib/tuning.js'
import { atomicFiles } from '../lib/atomic-files.js'
import { QUALIFIED_HOST_VERSIONS, compatibility } from '../lib/host-compat.js'

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `mantis-rc5-${tag}-`))
const pkgFile = (aiBase, pkg, rel = 'lib/index.js') => {
  const fp = path.join(aiBase, pkg, ...rel.split('/'))
  fs.mkdirSync(path.dirname(fp), { recursive: true })
  return fp
}
const byId = (id) => ALL_PATCHES.find((p) => p.id === id)

test('occurrences 数得清字符串与正则两种 pattern', () => {
  assert.equal(occurrences('aXbXc', 'X'), 2)
  assert.equal(occurrences('aXbXc', 'Z'), 0)
  assert.equal(occurrences('foo1 foo2', /foo\d/g), 2)
  assert.equal(occurrences('', 'x'), 0)
})

test('rc.5 消失目标包：非 optional 补丁不再有 missing_file', () => {
  // 0.2.2-rc.5 的 338 包里没有 liangshen-agent-cordis，桌面壳入口埋在密封 asar 里；
  // 两条都必须是 optional，否则 selfcheck 把整轮应用判成 broken。
  assert.equal(byId(71).optional, true)
  assert.equal(byId(83).optional, true)
  // hooks-* 整族在 rc.5 已下线，四条老补丁同样只能是 optional。
  for (const id of [30, 31, 64, 65]) assert.equal(byId(id).optional, true, `#${id} 应为 optional`)
})

test('patchedTargetStillPatched：marker 被吃掉时靠计数兜住', () => {
  const aiBase = tmp('still')
  const fp = pkgFile(aiBase, 'dsh-deliverable-file-references')
  const before = 'HEAD\nDo not call present just to list edited source files, or run commands to check whether a diff view will appear. \nTAIL\n'
  fs.writeFileSync(fp, before)
  targetFiles(aiBase)
  // 空内容 / 带 marker / 锚点被消费掉，三种都算「目标仍是补丁态」，不许用官方原文盖掉 bak。
  assert.equal(patchedTargetStillPatched(fp, '', aiBase, before), true)
  assert.equal(patchedTargetStillPatched(fp, 'HEAD [mantis] deliverable prohibition removed TAIL', aiBase, before), true)
  assert.equal(patchedTargetStillPatched(fp, 'HEAD\nTAIL\n', aiBase, before), true)
  // 原文原样在：没有补丁痕迹，可以拿官方原文刷新 bak。
  assert.equal(patchedTargetStillPatched(fp, before, aiBase, before), false)
  // 认不出归属的文件不动 bak。
  assert.equal(patchedTargetStillPatched(path.join(aiBase, 'nowhere.js'), before, aiBase, before), true)
  fs.rmSync(aiBase, { recursive: true, force: true })
})

test('纯删除补丁：重放后逐字节比对才判绿（上游 #255 后半）', () => {
  const aiBase = tmp('del')
  const fp = path.join(aiBase, 'free.js')
  // .mantis.bak 是官方原件，字节比对拿它做基线。
  fs.writeFileSync(fp + '.mantis.bak', 'A\nSECRET LINE\nB\n')
  fs.writeFileSync(fp, 'A\nB\n')
  const patch = { id: 999, name: 'TEST_DELETION', file: 'free', markers: [], replacements: [{ pattern: 'SECRET LINE\n', replace: '' }] }
  // 独占文件 + 有 bak：重放结果与当前内容一致 = 删干净了，且不留 marker。
  assert.equal(filePatchOutcome('A\nB\n', patch, fp), 'applied')
  // 少了别的行（有人手改过）就不再等于重放结果。
  assert.equal(filePatchOutcome('A\nB\nC\n', patch, fp), 'drifted')
  // 该删的还在 = 还没做。
  assert.equal(filePatchOutcome('A\nSECRET LINE\nB\n', patch, fp), 'pending')
  // 没有 bak 就没有可信基线，只能不判绿。
  fs.unlinkSync(fp + '.mantis.bak')
  assert.equal(deletionStatus('A\nB\n', patch, fp), 'skipped')
  fs.rmSync(aiBase, { recursive: true, force: true })
})

test('同文件压着多条补丁时不做字节比对（单条重放 != 整份产物）', () => {
  const aiBase = tmp('crowd')
  const webApp = pkgFile(aiBase, 'dsh-web-app')
  const devCtx = pkgFile(aiBase, 'dsh-harness-dev-context')
  fs.writeFileSync(webApp, 'x')
  fs.writeFileSync(devCtx, 'x')
  targetFiles(aiBase)
  assert.equal(patchCrowdForFile(webApp), 2)
  const p32 = byId(32)
  fs.copyFileSync(webApp, webApp + '.mantis.bak')
  assert.equal(deletionStatus('x', p32, webApp) !== 'applied', true)
  fs.rmSync(aiBase, { recursive: true, force: true })
})

test('tuning 组开关：默认全开、未知字段保留、坏文件抛 TUNING_UNREADABLE', () => {
  const home = tmp('tuning')
  assert.equal(TUNING_DEFAULTS.permissionPatches, true)
  assert.equal(TUNING_DEFAULTS.contextManagement, true)
  assert.deepEqual({ ...readTuning(home) }, { ...TUNING_DEFAULTS })
  // 未知字段跨写入保留（降级不丢配置）。
  writeTuning({ boost: false, futureFlag: 42 }, home)
  writeTuning({ rewind: false }, home)
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'mantis', 'tuning.json'), 'utf8'))
  assert.equal(saved.futureFlag, 42)
  assert.equal(saved.rewind, false)
  // 只有真正的 false 才关；字符串 'false' 不算。
  writeTuning({ permissionPatches: 'false' }, home)
  assert.equal(readTuning(home).permissionPatches, true)
  writeTuning({ permissionPatches: false }, home)
  assert.equal(readTuning(home).permissionPatches, false)
  // 坏 JSON 不能静默退回默认（那等于替用户把开关全打开）。
  fs.writeFileSync(path.join(home, 'mantis', 'tuning.json'), '{ oops')
  assert.throws(() => readTuning(home), (error) => error.code === 'TUNING_UNREADABLE')
  fs.rmSync(home, { recursive: true, force: true })
})

test('开关落到补丁状态：关掉的组记 off，不写不改', async () => {
  const home = tmp('gate')
  const aiBase = tmp('gateai')
  writeTuning({ permissionPatches: false, contextManagement: false }, home)
  const gate = readPatchGate(home)
  assert.equal(gate.permissionPatches, false)
  assert.equal(gate.contextManagement, false)
  assert.equal(patchEnabledByGate(byId(5), gate), false)
  assert.equal(patchEnabledByGate(byId(18), gate), false)
  assert.equal(patchEnabledByGate(byId(1), gate), true)
  // 分组按 name 认：本仓 #89/#90 与上游 #93/#94 错位，按 id 抄会关错补丁。
  assert.equal(patchGroupOf(byId(89)), 'permissionPatches')
  assert.equal(patchGroupOf(byId(19)), 'contextManagement')
  assert.equal(patchGroupOf(byId(1)), '')
  const status = await patchStatus(aiBase, ALL_PATCHES, { dshHome: home })
  assert.equal(status[5], 'off')
  assert.equal(status[18], 'off')
  assert.equal(status[19], 'off')
  assert.notEqual(status[1], 'off')
  writeTuning({ permissionPatches: true, contextManagement: true }, home)
  const on = await patchStatus(aiBase, ALL_PATCHES, { dshHome: home })
  assert.notEqual(on[5], 'off')
  assert.notEqual(on[18], 'off')
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(aiBase, { recursive: true, force: true })
})

test('atomic-files：exactMode / directoryMode / durable 都生效', () => {
  const dir = tmp('atomic')
  const file = path.join(dir, 'deep', 'nested', 'state.json')
  atomicFiles(fs).atomicWriteSync(file, '{"a":1}', 'utf8', { exactMode: 0o640, directoryMode: 0o700, durable: true })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
  assert.equal(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')).length, 0)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o640)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('rc.5 进已验证清单，package.json 目标同步', () => {
  assert.equal(QUALIFIED_HOST_VERSIONS.includes('0.2.2-rc.5'), true)
  const aiBase = tmp('compat')
  fs.mkdirSync(path.join(aiBase, 'dsh-agent-instructions', 'lib'), { recursive: true })
  for (const pkg of ['dsh-agent-loop', 'dsh-system-prompt']) {
    const fp = pkgFile(aiBase, pkg, 'package.json')
    fs.writeFileSync(fp, JSON.stringify({ name: '@deepseek-ai/' + pkg, version: '0.2.2-rc.5' }))
  }
  const compat = compatibility(aiBase)
  assert.equal(compat.host_version, '0.2.2-rc.5')
  assert.equal(compat.qualified, true)
  assert.equal(compat.level, 'qualified')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.dshTarget, '0.2.2-rc.5')
  fs.rmSync(aiBase, { recursive: true, force: true })
})