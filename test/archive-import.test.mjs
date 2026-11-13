import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { safeArchiveName, extractZipBuffer } from '../lib/zip-extract.js'
import { extractSkillTar } from '../lib/tar-import.js'
import { importArchive, importFromPath } from '../lib/skills.js'

function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.body ?? '', 'utf8')
    const method = entry.method ?? 0
    const data = method === 8 ? zlib.deflateRawSync(raw) : raw
    const crc = zlib.crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

function tarHeader(name, size, type = '0') {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write('0000644\0', 100, 'ascii')
  header.write('0000000\0', 108, 'ascii')
  header.write('0000000\0', 116, 'ascii')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii')
  header.write('00000000000\0', 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write(type, 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii')
  return header
}

function tar(entries) {
  const chunks = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '', 'utf8')
    chunks.push(tarHeader(entry.name, body.length, entry.type ?? '0'), body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

test('safeArchiveName 拦穿越、盘符、控制字符与 Windows 保留名', () => {
  assert.equal(safeArchiveName('./a/b.md'), 'a/b.md')
  assert.equal(safeArchiveName('a\\b.md'), 'a/b.md')
  assert.equal(safeArchiveName('dir/'), 'dir')
  for (const bad of ['../x', 'a/../../x', '/abs/x', 'C:/x', 'a/\u0001x', 'a/name.', 'CON', 'aux.md', 'lpt1/x']) {
    assert.throws(() => safeArchiveName(bad), /Invalid archive path/, bad)
  }
})

test('extractZipBuffer 按目录逐条落盘，并拒绝重复路径与链接条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mantis-zip-'))
  const body = zip([
    { name: 'skill/', body: '' },
    { name: 'skill/SKILL.md', body: '# hi\n' },
    { name: 'skill/deep/x.txt', body: 'x'.repeat(200), method: 8 },
  ])
  extractZipBuffer(body, join(dir, 'out'))
  assert.equal(readFileSync(join(dir, 'out', 'skill', 'SKILL.md'), 'utf8'), '# hi\n')
  assert.equal(readFileSync(join(dir, 'out', 'skill', 'deep', 'x.txt'), 'utf8'), 'x'.repeat(200))

  assert.throws(() => extractZipBuffer(zip([
    { name: 'a.txt', body: '1' },
    { name: 'a.txt', body: '2' },
  ]), join(dir, 'dup')), /duplicate/)

  assert.throws(() => extractZipBuffer(zip([
    { name: 'link', body: '/etc/passwd', mode: 0o120777 },
  ]), join(dir, 'link')), /link entries/)

  assert.throws(() => extractZipBuffer(zip([
    { name: 'big.txt', body: 'y'.repeat(4096), method: 8 },
  ]), join(dir, 'big'), { maxBytes: 1000 }), /size limit/)
})

test('extractZipBuffer verifyCrc 会发现被改过的字节', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mantis-zipcrc-'))
  const body = zip([{ name: 'a.txt', body: 'hello' }])
  body[30 + 5] = body[30 + 5] ^ 0xff
  assert.throws(() => extractZipBuffer(body, join(dir, 'out'), { verifyCrc: true }))
})

test('extractSkillTar 解出目录与文件，拒绝链接与越界条目', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mantis-tar-'))
  extractSkillTar(tar([
    { name: 'skill/', type: '5' },
    { name: 'skill/SKILL.md', body: '---\nname: taro\ndescription: d\n---\n' },
  ]), join(dir, 'out'), { maxBytes: 1 << 20, maxEntries: 10 })
  assert.equal(readFileSync(join(dir, 'out', 'skill', 'SKILL.md'), 'utf8').includes('taro'), true)

  assert.throws(() => extractSkillTar(tar([
    { name: 'evil', type: '2' },
  ]), join(dir, 'link'), { maxBytes: 1 << 20, maxEntries: 10 }), /only supports regular files/)

  assert.throws(() => extractSkillTar(tar([
    { name: '../escape.md', body: 'x' },
  ]), join(dir, 'escape'), { maxBytes: 1 << 20, maxEntries: 10 }), /Invalid archive path/)

  assert.throws(() => extractSkillTar(tar([
    { name: 'a.md', body: 'x' },
    { name: 'b.md', body: 'y' },
  ]), join(dir, 'many'), { maxBytes: 1 << 20, maxEntries: 1 }), /too many entries/)
})

test('importArchive 装 zip 与 tar.gz 里的技能，并拒绝从 skills 自身导入', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mantis-home-'))
  const skill = '---\nname: zipped\ndescription: zip import\n---\n# zipped\n'
  const zipped = await importArchive(home, zip([{ name: 'zipped/SKILL.md', body: skill }]), 'zipped.zip')
  assert.equal(zipped.imported.length, 1)
  assert.equal(zipped.imported[0].id, 'zipped')
  assert.equal(existsSync(join(home, 'skills', 'zipped', 'SKILL.md')), true)

  const tarball = zlib.gzipSync(tar([{ name: 'taro/SKILL.md', body: skill.replace('zipped', 'taro') }]))
  const unpacked = await importArchive(home, tarball, 'taro.tar.gz')
  assert.equal(unpacked.imported[0].id, 'taro')
  assert.equal(existsSync(join(home, 'skills', 'taro', 'SKILL.md')), true)

  const inside = join(home, 'skills', 'taro')
  await assert.rejects(importFromPath(home, inside), /Cannot import from \$DSH_HOME\/skills itself/)
})
