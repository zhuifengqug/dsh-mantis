import test from 'node:test'
import assert from 'node:assert/strict'
import { aiBaseScore, pickPreferredAiBase } from '../lib/core.js'

test('aiBaseScore prefers a version-matched desktop tree over an npx cache', () => {
  const desktop = 'D:\\deepseek HARNESS\\resources\\app\\dsh\\node_modules\\@deepseek-ai'
  const npx = 'D:\\DSHData\\npm-cache\\_npx\\abc\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai'
  const d = aiBaseScore(desktop, { version: '0.2.2-rc.3', targets: ['0.2.2-rc.3'] })
  const n = aiBaseScore(npx, { version: '0.1.5-rc.1', targets: ['0.2.2-rc.3'] })
  assert.ok(d > n)
})

test('aiBaseScore still penalizes npx even when its version matches', () => {
  const npx = 'C:/Users/x/npm-cache/_npx/abc/node_modules/@deepseek-ai'
  const local = 'C:/tools/dsh/node_modules/@deepseek-ai'
  assert.ok(aiBaseScore(local, { version: '0.2.2-rc.3' }) > aiBaseScore(npx, { version: '0.2.2-rc.3' }))
})

test('pickPreferredAiBase returns the highest score and keeps order on ties', () => {
  const npx = 'C:/npm-cache/_npx/x/node_modules/@deepseek-ai'
  const desk = 'D:/deepseek HARNESS/resources/app/dsh/node_modules/@deepseek-ai'
  assert.equal(pickPreferredAiBase([npx, desk], { version: '0.2.2-rc.3' }), desk)
  assert.equal(pickPreferredAiBase([null, undefined]), null)
})
