import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DDL } from '../lib/redteam/schema.js'
import { importHar, parseHar } from '../lib/redteam/har.js'
import { searchFlows, getFlow, blobPathOf } from '../lib/redteam/traffic.js'

function sampleHar() {
  return JSON.stringify({
    log: {
      version: '1.2',
      entries: [
        {
          startedDateTime: '2026-11-12T10:00:00.000Z',
          time: 12,
          request: {
            method: 'GET',
            url: 'https://api.example.com/v1/user?id=1',
            headers: [{ name: 'Accept', value: 'application/json' }],
          },
          response: {
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: { mimeType: 'application/json', text: '{"id":1}' },
          },
        },
        {
          startedDateTime: '2026-11-12T10:00:01.000Z',
          time: 30,
          request: {
            method: 'POST',
            url: 'https://api.example.com/v1/login',
            headers: [{ name: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
            postData: { params: [{ name: 'user', value: 'admin' }, { name: 'pass', value: 'p@ss' }] },
          },
          response: {
            status: 401,
            headers: [{ name: 'Content-Type', value: 'text/plain' }],
            content: { mimeType: 'text/plain', text: Buffer.from('bad').toString('base64'), encoding: 'base64' },
          },
        },
      ],
    },
  })
}

test('HAR 导入：映射、幂等、隔离、blob 落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mantis-har-'))
  const db = new DatabaseSync(':memory:')
  db.exec(DDL)

  const text = sampleHar()
  assert.equal(parseHar(text).length, 2)

  const first = importHar(db, dir, text, { engagementId: 'engA', target: 'demo' })
  assert.equal(first.ok, true)
  assert.equal(first.parsed, 2)
  assert.equal(first.imported, 2)
  assert.equal(first.dup_skipped, 0)

  // 同一份 HAR 再导一次：全部按 flow_key 去重
  const second = importHar(db, dir, text, { engagementId: 'engA', target: 'demo' })
  assert.equal(second.imported, 0)
  assert.equal(second.dup_skipped, 2)

  // 归属与来源
  const mine = searchFlows(db, { engagement_id: 'engA', limit: 10 })
  assert.equal(mine.total, 2)
  const other = searchFlows(db, { engagement_id: 'engB', limit: 10 })
  assert.equal(other.total, 0)

  const rows = mine.items.map((it) => getFlow(db, it.id))
  assert.ok(rows.every((r) => r.source === 'har' && r.engagement_id === 'engA' && r.target === 'demo'))

  const login = rows.find((r) => r.method === 'POST')
  assert.ok(login.url.endsWith('/v1/login'))
  assert.equal(login.status, 401)
  assert.match(String(login.req_body), /user=admin/)
  assert.match(String(login.req_body), /pass=p%40ss/)
  assert.equal(login.resp_body, 'bad')

  // 响应体落 blob，且能按行里的相对路径读回
  const blob = blobPathOf(dir, login, 'resp')
  assert.ok(blob && existsSync(blob))
  assert.equal(readFileSync(blob, 'utf8'), 'bad')
})

test('HAR 非法输入报错', () => {
  assert.throws(() => parseHar(''), /HAR 内容为空/)
  assert.throws(() => parseHar('not json'), /不是合法 JSON/)
  assert.throws(() => parseHar('{"log":{}}'), /缺少 log.entries/)
})
