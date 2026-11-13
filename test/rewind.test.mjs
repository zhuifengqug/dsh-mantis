import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planRewind,
  cutSurfaceNodes,
  isRewindDerivedMessage,
  wrapSessionDeriveMessages,
  applyRewind,
} from '../lib/rewind.js'

/** 造一个最小会话：事件日志 + surface 节点 + deriveMessages。 */
function makeSession() {
  const events = []
  const bySeq = new Map()
  const surface = { nodes: [] }
  let seq = 0
  const add = (type, data, options) => {
    const event = { type, seq, data }
    if (options?.surfaceOp) event.surfaceOp = options.surfaceOp
    if (options?.sourceEventSeqs) event.sourceEventSeqs = options.sourceEventSeqs
    events.push(event)
    bySeq.set(seq, event)
    // 宿主的 surface 只收表面事件类型，turn/start、turn/end 不进节点表。
    const surfaceEligible = /^(system|user|assistant|developer)\/message$/.test(type) || type === 'tool/result'
    if (surfaceEligible) {
      const op = options?.surfaceOp
      if (op === undefined || op === 'append') surface.nodes.push(seq)
      else if (op && op.op === 'replace') {
        const kept = surface.nodes.filter((n) => n < op.startSeq || n > op.endSeq)
        surface.nodes.length = 0
        surface.nodes.push(...kept, seq)
      }
    }
    seq += 1
    return event
  }
  add('system/message', { content: 'sys' })
  add('turn/start', { turn: 1 })
  add('user/message', { id: 'm1', content: '第一句', source: { kind: 'user' } })
  add('assistant/message', { id: 'a1', content: '回应一' })
  add('turn/end', { turn: 1 })
  add('turn/start', { turn: 2 })
  add('user/message', { id: 'm2', content: '第二句', source: { kind: 'user' } })
  add('assistant/message', { id: 'a2', content: '回应二' })
  add('turn/end', { turn: 2 })

  const session = {
    surface,
    header: { id: 's1' },
    append(type, data, options) {
      return add(type, data, options)
    },
    eventAt: (n) => bySeq.get(n),
    snapshotEvents: () => events.slice(),
    deriveMessages() {
      return surface.nodes
        .map((n) => bySeq.get(n))
        .filter(Boolean)
        .map((event) => {
          const content = event.data?.content
          const text = Array.isArray(content) ? content.map((b) => b?.text ?? '').join('') : String(content ?? '')
          const role = event.type.startsWith('assistant') ? 'assistant'
            : event.type.startsWith('system') ? 'system'
            : 'user'
          return { id: event.data?.id || ('i' + event.seq), role, content: text }
        })
        .filter((message) => message.content !== '')
    },
  }
  return { session, events, surface, bySeq }
}

function makeCtx(session) {
  return {
    get(name) {
      if (name === 'sessions') return { get: (id) => (id === 's1' ? session : undefined) }
      return undefined
    },
  }
}

test('planRewind 取最近一轮里发出去的那句，范围含整轮', () => {
  const { events } = makeSession()
  const plan = planRewind(events)
  assert.equal(plan.ok, true)
  assert.equal(plan.text, '第二句')
  assert.equal(plan.fromSeq, 5)
  assert.equal(plan.promptSeq, 6)
})

test('cutSurfaceNodes 只切本轮之后的节点，系统提示留在节点 0', () => {
  const { session, events } = makeSession()
  const eventAt = (n) => session.eventAt(n)
  const nodes = session.surface.nodes.slice()
  const cut = cutSurfaceNodes(nodes, 5, eventAt)
  assert.deepEqual(cut, [6, 7])
  assert.deepEqual(cutSurfaceNodes([0, 2, 3], 5, eventAt), [])
  assert.deepEqual(cutSurfaceNodes(nodes, 0, eventAt), [2, 3, 6, 7])
})

test('rewind 标记不进下一轮模型请求', () => {
  assert.equal(isRewindDerivedMessage({ id: 'rewind-abc-3' }), true)
  assert.equal(isRewindDerivedMessage({ id: 'm2' }), false)
})

test('wrapSessionDeriveMessages 过滤掉 rewind 派生消息', () => {
  const session = {
    deriveMessages: () => [{ id: 'm1', role: 'user', content: 'a' }, { id: 'rewind-1-2', role: 'user', content: '' }],
  }
  wrapSessionDeriveMessages(session)
  const kept = session.deriveMessages()
  assert.deepEqual(kept.map((m) => m.id), ['m1'])
})

test('applyRewind 留在同一会话：切掉已发送内容并写回标记', async () => {
  const { session, surface, events } = makeSession()
  const ctx = makeCtx(session)
  const result = await applyRewind(ctx, 's1', 'once')
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 's1')
  assert.equal(result.cleared, true)
  assert.equal(result.text, '第二句')

  const marker = events.at(-1)
  assert.equal(marker.type, 'user/message')
  assert.ok(String(marker.data.id).startsWith('rewind-'))
  assert.deepEqual(marker.surfaceOp, { op: 'replace', startSeq: 6, endSeq: 7 })
  assert.deepEqual(marker.sourceEventSeqs, [6, 7])

  assert.deepEqual(surface.nodes, [0, 2, 3, marker.seq])
  const derived = session.deriveMessages()
  assert.equal(derived.some((m) => m.content === '第二句'), false)
  assert.equal(derived.some((m) => m.content.includes('第二句')), false)
  assert.equal(derived.some((m) => isRewindDerivedMessage(m)), false)
})

test('applyRewind 拿不到 surface 时返回失败，不动会话', async () => {
  const { session } = makeSession()
  delete session.surface
  const result = await applyRewind(makeCtx(session), 's1', 'once')
  assert.equal(result.ok, false)
  assert.ok(result.error)
})
