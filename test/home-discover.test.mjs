import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { findDshHome, looksLikeHarnessHome } from '../lib/core.js'

function makeHome(tag, { prompt = false, profiles = false, cordis = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mantis-home-' + tag + '-'))
  if (prompt) writeFileSync(join(dir, 'prompt-inject.md'), 'x')
  if (cordis) writeFileSync(join(dir, 'cordis.patch.yml'), 'x')
  if (profiles) mkdirSync(join(dir, 'profiles'))
  return dir
}

test('findDshHome prefers the registry DSH_HOME when the dir carries harness data', () => {
  const home = makeHome('reg-hit', { prompt: true, profiles: true, cordis: true })
  const calls = []
  const got = findDshHome({
    env: { DSH_HOME: '' },
    registryEnv: (name) => { calls.push(name); return name === 'DSH_HOME' ? home : '' },
  })
  assert.equal(got, home)
  assert.deepEqual(calls, ['DSH_HOME'])
  rmSync(home, { recursive: true, force: true })
})

test('findDshHome ignores a registry path that is not a harness home', () => {
  const bare = mkdtempSync(join(tmpdir(), 'mantis-home-bare-'))
  const got = findDshHome({
    env: { DSH_HOME: '' },
    registryEnv: () => bare,
    shimDir: null,
    prefix: null,
  })
  assert.notEqual(got, bare)
  rmSync(bare, { recursive: true, force: true })
})

test('findDshHome never reads the registry when DSH_HOME is already set', () => {
  const home = makeHome('env-wins', { prompt: true })
  let calls = 0
  const got = findDshHome({
    env: { DSH_HOME: home },
    registryEnv: () => { calls += 1; return '' },
  })
  assert.equal(got, home)
  assert.equal(calls, 0)
  rmSync(home, { recursive: true, force: true })
})

test('findDshHome honours MANTIS_NO_REGISTRY_HOME as an escape hatch', () => {
  const home = makeHome('opt-out', { prompt: true, profiles: true })
  let calls = 0
  const got = findDshHome({
    env: { DSH_HOME: '', MANTIS_NO_REGISTRY_HOME: '1' },
    registryEnv: () => { calls += 1; return home },
  })
  assert.equal(calls, 0)
  assert.notEqual(got, home)
  rmSync(home, { recursive: true, force: true })
})

test('looksLikeHarnessHome accepts any dir name carrying harness data', () => {
  const full = makeHome('full', { prompt: true, profiles: true, cordis: true })
  const onlyProfiles = makeHome('profiles', { profiles: true })
  const onlyPrompt = makeHome('prompt', { prompt: true })
  const empty = makeHome('empty')
  assert.equal(looksLikeHarnessHome(full), true)
  assert.equal(looksLikeHarnessHome(onlyProfiles), true)
  assert.equal(looksLikeHarnessHome(onlyPrompt), true)
  assert.equal(looksLikeHarnessHome(empty), false)
  assert.equal(looksLikeHarnessHome(join(empty, 'nope')), false)
  for (const d of [full, onlyProfiles, onlyPrompt, empty]) rmSync(d, { recursive: true, force: true })
})
