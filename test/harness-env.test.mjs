import test from 'node:test'
import assert from 'node:assert/strict'
import { applyProxyEnv, restoreProxyEnv, proxyEnvActive } from '../lib/redteam/harness-env.js'

test('applyProxyEnv 写入代理与 CA 变量并合并回环 NO_PROXY，restore 原样还原', () => {
  assert.equal(proxyEnvActive(), false)
  delete process.env.HTTP_PROXY
  delete process.env.http_proxy

  const out = applyProxyEnv({ proxyUrl: 'http://127.0.0.1:18081', caPath: '/no/such/ca.crt' })
  assert.equal(out.proxyUrl, 'http://127.0.0.1:18081')
  assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:18081')
  assert.equal(process.env.HTTPS_PROXY, 'http://127.0.0.1:18081')
  assert.equal(process.env.ALL_PROXY, 'http://127.0.0.1:18081')
  assert.equal(process.env.NODE_USE_ENV_PROXY, '1')
  assert.ok(String(process.env.NO_PROXY).split(',').includes('127.0.0.1'))
  assert.ok(String(process.env.NO_PROXY).split(',').includes('localhost'))
  assert.equal(proxyEnvActive(), true)

  assert.equal(restoreProxyEnv(), true)
  assert.equal(proxyEnvActive(), false)
  assert.equal(process.env.HTTP_PROXY, undefined)
})

test('restoreProxyEnv 无注入时是空操作', () => {
  assert.equal(restoreProxyEnv(), false)
})
