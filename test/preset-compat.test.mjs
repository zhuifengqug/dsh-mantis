import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { adaptListAgentsText, ensureToolExecutorText } from '../lib/preset-compat.js'
import { atomicWriteSync } from '../lib/atomic-files.js'

const SAMPLE = [
  'plugins:',
  '  - id: tool-subagent-control',
  '    name: "@deepseek-ai/dsh-tool-subagent-control"',
  '  - id: tool-subagent-list-agents',
  '    name: "@deepseek-ai/dsh-tool-subagent-control/list-agents"',
  '  - id: tool-subagent',
  '    name: "@deepseek-ai/dsh-tool-subagent"',
  '',
].join('\n')

test('adaptListAgentsText keeps the legacy row when the subpath is still separate', () => {
  const r = adaptListAgentsText(SAMPLE, 'separate')
  assert.equal(r.changed, false)
  assert.ok(r.text.includes('tool-subagent-list-agents'))
})

test('adaptListAgentsText removes the legacy row when merged', () => {
  const r = adaptListAgentsText(SAMPLE, 'merged')
  assert.equal(r.changed, true)
  assert.ok(!r.text.includes('tool-subagent-list-agents'))
  assert.ok(r.text.includes('id: tool-subagent-control'))
  assert.ok(r.text.includes('id: tool-subagent\n'))
})

test('adaptListAgentsText removes the row when capability is unknown (our dshTarget default)', () => {
  const r = adaptListAgentsText(SAMPLE, 'unknown')
  assert.equal(r.changed, true)
  assert.ok(!r.text.includes('tool-subagent-list-agents'))
})

test('ensureToolExecutorText injects native executor for a dsh-tools preset', () => {
  const text = ['plugins:', '  - id: dsh-tools', '    name: "@deepseek-ai/dsh-tools"', ''].join('\n')
  const r = ensureToolExecutorText(text, true)
  assert.equal(r.changed, true)
  assert.ok(r.text.includes('id: tool-executor-native'))
  assert.ok(r.text.includes('@deepseek-ai/dsh-tool-executor-native'))
})

test('ensureToolExecutorText is a no-op without availability, without dsh-tools, or if an executor exists', () => {
  const tools = 'plugins:\n  - id: dsh-tools\n    name: "@deepseek-ai/dsh-tools"\n'
  assert.equal(ensureToolExecutorText(tools, false).changed, false)
  assert.equal(ensureToolExecutorText('plugins:\n  - id: x\n    name: "@deepseek-ai/dsh-x"\n', true).changed, false)
  const withExec = tools + '  - id: e\n    name: "@deepseek-ai/dsh-tool-executor-native"\n'
  assert.equal(ensureToolExecutorText(withExec, true).changed, false)
})

test('atomic write replaces existing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantis-atomic-'))
  try {
    const f = path.join(dir, 'a.txt')
    atomicWriteSync(f, 'one', 'utf8')
    assert.equal(fs.readFileSync(f, 'utf8'), 'one')
    atomicWriteSync(f, 'two', 'utf8')
    assert.equal(fs.readFileSync(f, 'utf8'), 'two')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
