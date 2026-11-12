/**
 * L2 面板「录制」按钮的后端 op 单测。
 *
 * 面板不自己碰 proxy.js，全部经 store-core 的统一分发：
 *   - 同步 `proxyStatus` 走 dispatch（读状态，返回 proxyView 视图）；
 *   - 异步 `proxyStart` / `proxyStop` 走 dispatchAsync（真的 listen 端口、现签 CA）。
 * 这里直接打这两个分发口，验证面板按钮接到的字段（running/port/mode/caPath/flows/lastError）
 * 与失败码（NO_ENGAGEMENT / ALREADY_RECORDING / EADDRINUSE）都对。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RedteamStore, dispatch, dispatchAsync } from '../lib/redteam/store-core.js'
import { stopAllProxies } from '../lib/redteam/proxy.js'

function fresh(tag) {
  const root = mkdtempSync(join(tmpdir(), 'mantis-proxy-panel-' + tag + '-'))
  const store = new RedteamStore(root)
  const a = store.openEngagement('panel-a', [], { bindCurrent: true })
  const b = store.openEngagement('panel-b', [], { bindCurrent: false })
  return { root, store, a, b }
}

test('proxyStatus：未录制时返回 idle 视图（running=false、mode=mitm、有 caPath）', () => {
  const { root, store } = fresh('idle')
  try {
    const st = dispatch(store, { op: 'proxyStatus' })
    assert.equal(st.ok, true)
    assert.equal(st.running, false)
    assert.equal(st.mode, 'mitm')
    assert.ok(typeof st.caPath === 'string' && st.caPath.length > 0, 'caPath 应给出 CA 文件路径')
    assert.equal(st.flows, 0)
    assert.equal(st.port, null)
    assert.equal(st.lastError, null)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('proxyStart 起录制 → proxyStatus 反映真实 running/port → 别的靶标再起被拒 → proxyStop 收尾', async () => {
  const { root, store, a, b } = fresh('lifecycle')
  try {
    const started = await dispatchAsync(store, { op: 'proxyStart', engagement: a.id, port: 18231, portMax: 18249 })
    assert.equal(started.ok, true, JSON.stringify(started))
    assert.equal(started.running, true)
    assert.equal(started.mode, 'mitm')
    assert.ok(started.port >= 18231 && started.port <= 18249, 'port 应落在起始区间：' + started.port)
    assert.ok(started.proxyUrl, '应回可用的代理地址')

    const st = dispatch(store, { op: 'proxyStatus' })
    assert.equal(st.ok, true)
    assert.equal(st.running, true)
    assert.equal(st.port, started.port)
    assert.equal(st.flows, 0)

    /* 单活跃录制：另一个靶标想同时录，必须被挡回，不能把正在录的顶掉 */
    const other = await dispatchAsync(store, { op: 'proxyStart', engagement: b.id, port: 18251, portMax: 18269 })
    assert.equal(other.ok, false)
    assert.equal(other.code, 'ALREADY_RECORDING')

    const stopped = await dispatchAsync(store, { op: 'proxyStop', engagement: a.id })
    assert.equal(stopped.ok, true, JSON.stringify(stopped))
    assert.equal(stopped.running, false)

    const after = dispatch(store, { op: 'proxyStatus' })
    assert.equal(after.running, false)
  } finally {
    await stopAllProxies()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('没有选中靶标时 proxyStart 报 NO_ENGAGEMENT', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mantis-proxy-panel-noeng-'))
  const store = new RedteamStore(root)
  try {
    const res = await dispatchAsync(store, { op: 'proxyStart' })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'NO_ENGAGEMENT')
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('起始端口被占满时 proxyStart 报 EADDRINUSE', async () => {
  const { root, store, a } = fresh('busy')
  const blocker = net.createServer()
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port
  try {
    /* port == portMax：只有这一个候选，必然全占用 */
    const res = await dispatchAsync(store, { op: 'proxyStart', engagement: a.id, port: busyPort, portMax: busyPort })
    assert.equal(res.ok, false, JSON.stringify(res))
    assert.equal(res.code, 'EADDRINUSE')
  } finally {
    await stopAllProxies()
    await new Promise((resolve) => blocker.close(resolve))
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test.after(async () => {
  await stopAllProxies()
})
