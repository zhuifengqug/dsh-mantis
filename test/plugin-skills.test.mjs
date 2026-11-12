import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPluginSkillEntries } from '../lib/redteam/ui.js'

test('listPluginSkillEntries enumerates flat .md and folder-style SKILL.md', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mantis-skills-'))
  writeFileSync(join(dir, 'alpha.md'), '# alpha\n')
  mkdirSync(join(dir, 'beta'))
  writeFileSync(join(dir, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: b\n---\n# beta\n')
  mkdirSync(join(dir, 'gamma'))
  writeFileSync(join(dir, 'gamma', 'README.md'), 'not a skill\n')

  const entries = listPluginSkillEntries(dir)
  const names = entries.map((e) => e.name).sort()
  assert.deepEqual(names, ['alpha', 'beta'])

  const alpha = entries.find((e) => e.name === 'alpha')
  assert.equal(alpha.dir, dir)
  assert.equal(alpha.path, join(dir, 'alpha.md'))

  const beta = entries.find((e) => e.name === 'beta')
  assert.equal(beta.dir, join(dir, 'beta'))
  assert.equal(beta.path, join(dir, 'beta', 'SKILL.md'))
})
