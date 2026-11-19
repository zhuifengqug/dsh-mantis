/**
 * v0.16.0 吸收（上游 1c75eac / f203605）· 批量落库 / 范围校验 / 隧道实测 / 数据证明 / 清理台账 五工具单测
 *
 * 覆盖：
 *   1. 纯函数：ipv4Int / targetIpv4 / ipInCidr / scopeCheck 的边界（越界、无 scope、域名解析不出）；
 *   2. 五个工具的成功路径（走真实 RedteamStore）与非法入参 → 结构化 bad_input；
 *   3. 账号类得分门禁（assertAccountAccess）：access_id 缺失 / 不存在 / 无 username / webshell 会话 / host 不一致 全部拒绝；
 *   4. 12 个方法类技能能被技能库判定（checkSkill 均 available、无 content-missing / file-missing）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RedteamStore } from '../lib/redteam/store-core.js'
import { setDefineToolLoader } from '../lib/redteam/host-tools.js'
import { apply as applyCoreTools, BATCH_TOOL_NAMES } from '../lib/redteam/tools.js'
import { ipv4Int, targetIpv4, ipInCidr, scopeCheck } from '../lib/redteam/tools-batch.js'
import { checkSkill } from '../lib/redteam/skill-availability.js'
import { SKILL_FIXES, fixesForIssue } from '../lib/redteam/skill-fixes.js'

/* 临时目录：优先系统 tmp；个别沙箱里 os.tmpdir() 返回 undefined，退回工作区目录。 */
const RAW_TMP = (() => {
  try {
    const d = tmpdir()
    return typeof d === 'string' && d.trim() !== '' && d !== 'undefined' ? d : null
  } catch { return null }
})()
const TMP = RAW_TMP || fileURLToPath(new URL('../.tmp-test/', import.meta.url))
const SKILLS = fileURLToPath(new URL('../skills/redteam/', import.meta.url))

function tmpRoot(tag) {
  mkdirSync(TMP, { recursive: true })
  return mkdtempSync(join(TMP, tag + '-'))
}

function harness(scope = ['10.0.0.0/24']) {
  const root = tmpRoot('mantis-batch-tools')
  const store = new RedteamStore(root)
  const engagement = store.openEngagement('T0 直接归属靶标', scope, { bindCurrent: false })
  const previousLoader = setDefineToolLoader((spec) => spec)
  const tools = []
  applyCoreTools({
    redteam: store,
    tools: { register: (tool) => tools.push(tool) },
    effect: (fn) => { try { fn() } catch { /* ignore */ } return () => {} },
    on: () => () => {},
    logger: { warn() {} },
    get: () => undefined,
  })
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  const exec = async (name, args) => JSON.parse(await byName[name].execute(args || {}, {}))
  const db = store.db(engagement.id)
  const assetId = Number(db.prepare('INSERT INTO asset (segment_cidr, ip, primary_name, test_status) VALUES (?,?,?,?)')
    .run('10.0.0.0/24', '10.0.0.9', 'web01', 'untested').lastInsertRowid)
  return {
    root, store, tools, byName, exec,
    engagement: engagement.id,
    assetId,
    close() {
      setDefineToolLoader(previousLoader)
      try { store.close() } catch { /* ignore */ }
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('纯函数：ipv4Int / targetIpv4 / ipInCidr', () => {
  assert.equal(ipv4Int('10.0.0.1'), 167772161)
  assert.equal(ipv4Int('10.0.0.256'), null)
  assert.equal(ipv4Int('10.0.0'), null)
  assert.equal(targetIpv4('https://10.0.0.5:8443/admin?x=1'), '10.0.0.5')
  assert.equal(targetIpv4('web01.example.com'), null)
  assert.equal(ipInCidr('10.0.0.5', '10.0.0.0/24'), true)
  assert.equal(ipInCidr('10.0.1.5', '10.0.0.0/24'), false)
  assert.equal(ipInCidr('10.0.1.5', '0.0.0.0/0'), true)
  assert.equal(ipInCidr('10.0.1.5', '10.0.0.0/33'), false)
})

test('scopeCheck：in / out / unscoped / unresolved 四种判定', () => {
  const h = harness()
  const clean = harness([])
  try {
    assert.equal(scopeCheck(h.store, h.engagement, '10.0.0.5').status, 'in')
    const out = scopeCheck(h.store, h.engagement, 'http://192.168.1.7/')
    assert.equal(out.status, 'out')
    assert.equal(out.ip, '192.168.1.7')
    assert.equal(scopeCheck(h.store, h.engagement, 'intranet.example.com').status, 'unresolved')
    assert.equal(scopeCheck(clean.store, clean.engagement, '10.0.0.5').status, 'unscoped')
  } finally {
    h.close()
    clean.close()
  }
})

test('redteam_scope_check：in/unscoped 放行，out 阻断', async () => {
  const h = harness()
  try {
    const inside = await h.exec('redteam_scope_check', { engagement: h.engagement, target: '10.0.0.5:22' })
    assert.equal(inside.ok, true)
    assert.equal(inside.status, 'in')
    const outside = await h.exec('redteam_scope_check', { engagement: h.engagement, target: '192.168.1.7' })
    assert.equal(outside.ok, false)
    assert.equal(outside.status, 'out')
    /* 没传 target 时解析不出 IPv4 → unresolved，不阻断（要用户补范围/给可解析目标） */
    const noTarget = await h.exec('redteam_scope_check', { engagement: h.engagement })
    assert.equal(noTarget.ok, true)
    assert.equal(noTarget.status, 'unresolved')
  } finally {
    h.close()
  }
})

test('redteam_batch：assets 越界进 rejected，assess / vulns 落库', async () => {
  const h = harness()
  try {
    const assets = await h.exec('redteam_batch', {
      engagement: h.engagement,
      kind: 'assets',
      items: [
        { ip: '10.0.0.11', primary_name: 'web11', provenance: 'active', tool: 'nmap' },
        { ip: '192.168.9.9', primary_name: 'out-of-scope' },
        { primary_name: 'no-ip' },
      ],
    })
    assert.equal(assets.ok, true)
    assert.equal(assets.accepted, 1)
    assert.equal(assets.rejected.length, 2)
    assert.ok(assets.rejected.some((r) => r.reason === 'out_of_scope'))
    assert.ok(assets.rejected.some((r) => r.reason === 'ip required'))

    const assess = await h.exec('redteam_batch', {
      engagement: h.engagement,
      kind: 'assess',
      items: [{ asset_id: h.assetId, priority: 'high', potential: '管理后台弱口令', reason: '暴露公网 + 老版本' }],
    })
    assert.equal(assess.ok, true)
    assert.equal(assess.assessed, 1)

    const vulns = await h.exec('redteam_batch', {
      engagement: h.engagement,
      kind: 'vulns',
      items: [
        { title: '后台未授权', severity: 'high', asset_id: h.assetId, target: 'http://10.0.0.9/admin', request: 'GET /admin HTTP/1.1\r\nHost: 10.0.0.9\r\n\r\n', method: 'GET' },
        { title: '越界目标', severity: 'low', target: 'http://192.168.9.9/x' },
      ],
    })
    assert.equal(vulns.ok, true)
    assert.equal(vulns.inserted, 1)
    assert.equal(vulns.rejected.length, 1)
    assert.ok(vulns.results[0].http_evidence_id > 0, '带 request 应自动落 HTTP 证据')
    assert.ok(vulns.rejected.some((r) => r.reason === 'out_of_scope'))

    const emptyItems = await h.exec('redteam_batch', { engagement: h.engagement, kind: 'assets', items: [] })
    assert.equal(emptyItems.ok, false)
    assert.equal(emptyItems.error_kind, 'bad_input')
    const badKind = await h.exec('redteam_batch', { engagement: h.engagement, kind: 'nope', items: [{ ip: '10.0.0.1' }] })
    assert.equal(badKind.ok, false)
  } finally {
    h.close()
  }
})

test('redteam_pivot_probe：返回可达矩阵，targets 为空即拒绝', async () => {
  const h = harness()
  try {
    const res = await h.exec('redteam_pivot_probe', {
      engagement: h.engagement,
      listen: '127.0.0.1:1',
      targets: ['10.0.0.5:443', '  ', '10.0.0.6:22'],
      timeoutMs: 1000,
    })
    assert.equal(res.ok, true)
    assert.equal(res.total, 2, '空串应被过滤')
    assert.equal(res.reachable, 0)
    assert.ok(res.probes.every((p) => typeof p.ok === 'boolean'))
    const bad = await h.exec('redteam_pivot_probe', { engagement: h.engagement, listen: '127.0.0.1:1080', targets: [] })
    assert.equal(bad.ok, false)
    assert.equal(bad.error_kind, 'bad_input')
  } finally {
    h.close()
  }
})

test('redteam_data_proof：add 记字段/条数，list 可查，缺 fields 即拒绝', async () => {
  const h = harness()
  try {
    const add = await h.exec('redteam_data_proof', {
      engagement: h.engagement,
      op: 'add',
      target: 'http://10.0.0.9/api/v1/users',
      source: 'api',
      interface: '/api/v1/users',
      fields: ['姓名', '身份证号', '手机号'],
      row_count: 12000,
      sample: '张*，110***********1234，138****0000',
      query: 'GET /api/v1/users?page=1&size=20',
      pii_type: '身份证/手机号',
      asset_id: h.assetId,
      note: '未授权接口直接返回全量',
    })
    assert.equal(add.ok, true)
    assert.equal(add.proof.meets_threshold, true)
    assert.equal(add.proof.row_count, 12000)
    const list = await h.exec('redteam_data_proof', { engagement: h.engagement, op: 'list', target: '10.0.0.9' })
    assert.equal(list.ok, true)
    assert.ok(list.total >= 1)
    assert.deepEqual(list.items[0].fields, ['姓名', '身份证号', '手机号'])
    const bad = await h.exec('redteam_data_proof', { engagement: h.engagement, op: 'add', target: 'x', row_count: 1 })
    assert.equal(bad.ok, false)
    assert.equal(bad.error_kind, 'bad_input')
  } finally {
    h.close()
  }
})

test('redteam_cleanup：add/list/update 走通，update 不存在的 id 即拒绝', async () => {
  const h = harness()
  try {
    const add = await h.exec('redteam_cleanup', {
      engagement: h.engagement,
      op: 'add',
      kind: 'webshell',
      target: 'http://10.0.0.9/upload',
      location: '/upload/shell.php',
      detail: '交付前删除',
    })
    assert.equal(add.ok, true)
    assert.equal(add.item.status, 'open')
    const list = await h.exec('redteam_cleanup', { engagement: h.engagement, op: 'list', status: 'open' })
    assert.equal(list.ok, true)
    assert.ok(list.total >= 1)
    const upd = await h.exec('redteam_cleanup', { engagement: h.engagement, op: 'update', id: add.item.id, status: 'done' })
    assert.equal(upd.ok, true)
    assert.equal(upd.item.status, 'done')
    const missing = await h.exec('redteam_cleanup', { engagement: h.engagement, op: 'update', id: 999999, status: 'done' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error_kind, 'bad_input')
    const badKind = await h.exec('redteam_cleanup', { engagement: h.engagement, op: 'add', target: 'x' })
    assert.equal(badKind.ok, false)
    assert.equal(badKind.error_kind, 'bad_input')
  } finally {
    h.close()
  }
})

test('账号类得分门禁：access_id 四道门禁全拒绝，真实登录才放行', async () => {
  const h = harness()
  try {
    const base = {
      engagement: h.engagement,
      code: 'web-app',
      point_name: '获取 Web 应用后台权限',
      target: 'http://10.0.0.9/admin',
      evidence: '后台截图 + 登录请求',
    }
    const noAccess = await h.exec('redteam_score_hit', base)
    assert.equal(noAccess.ok, false, '缺 access_id 必须拒绝')
    assert.equal(noAccess.error_kind, 'bad_input')

    const ghost = await h.exec('redteam_score_hit', { ...base, access_id: 4321 })
    assert.equal(ghost.ok, false, 'access_id 不存在必须拒绝')

    const shell = await h.store.addAccess(h.engagement, { host: '10.0.0.9', username: 'admin', method: 'webshell' })
    const shellHit = await h.exec('redteam_score_hit', { ...base, access_id: shell.id })
    assert.equal(shellHit.ok, false, 'webshell 会话不算账号登录')

    const noUser = await h.store.addAccess(h.engagement, { host: '10.0.0.9', method: 'web' })
    const noUserHit = await h.exec('redteam_score_hit', { ...base, access_id: noUser.id })
    assert.equal(noUserHit.ok, false, '没有 username 必须拒绝')

    const otherHost = await h.store.addAccess(h.engagement, { host: '10.0.0.77', username: 'admin', method: 'web' })
    const hostHit = await h.exec('redteam_score_hit', { ...base, access_id: otherHost.id })
    assert.equal(hostHit.ok, false, 'host 与 target 不一致必须拒绝')

    const real = await h.store.addAccess(h.engagement, { host: '10.0.0.9', username: 'admin', method: 'web', privilege: 'admin' })
    const okHit = await h.exec('redteam_score_hit', { ...base, access_id: real.id })
    assert.equal(okHit.ok, true, '真实登录应放行：' + JSON.stringify(okHit))

    const selfCreated = await h.exec('redteam_score_hit', { ...base, self_created: true })
    assert.equal(selfCreated.ok, true, 'self_created 只留痕，不校验 access_id')
  } finally {
    h.close()
  }
})

test('12 个方法类技能可被技能库判定：全部 available、无 content-missing', () => {
  const names = [
    'icp-query', 'oob-verify', 'asset-deep-scan', 'host-post-exploit', 'network-device',
    'cloud-k8s', 'ad-attack', 'c2-infra', 'opsec-hygiene', 'score-coverage',
    'campaign-planning', 'specialist-paths',
  ]
  for (const name of names) {
    const path = join(SKILLS, name + '.md')
    assert.ok(existsSync(path), '缺少技能文件 ' + path)
    const content = readFileSync(path, 'utf8')
    assert.match(content, /^---[\s\S]*?name: /, name + ' 缺 frontmatter')
    const verdict = checkSkill({ name, content, path }, { env: {} })
    assert.equal(verdict.status, 'available', name + ' 判定为 ' + verdict.status + '：' + JSON.stringify(verdict.issues))
    const fatal = verdict.issues.filter((x) => x.kind === 'content-missing' || x.kind === 'file-missing')
    assert.equal(fatal.length, 0, name + ' 判定异常：' + JSON.stringify(fatal))
  }
})

test('BATCH_TOOL_NAMES 全登记且不与既有工具重名', () => {
  const h = harness()
  try {
    const names = h.tools.map((t) => t.name)
    const set = new Set(names)
    assert.equal(set.size, names.length, '存在重名工具')
    for (const name of BATCH_TOOL_NAMES) assert.ok(set.has(name), '缺少批量工具 ' + name)
    for (const t of h.tools.filter((x) => BATCH_TOOL_NAMES.includes(x.name))) {
      assert.equal(typeof t.execute, 'function', t.name + ' 缺 execute')
      assert.match(t.description, /[\u4e00-\u9fa5]/, t.name + ' 描述非中文')
      assert.ok(t.parameters && typeof t.parameters === 'object', t.name + ' 缺参数定义')
    }
  } finally {
    h.close()
  }
})

test('skill-fixes 覆盖会缺外部依赖的 8 个新技能，纯方法类不硬加占位条目', () => {
  /* 键 = 技能名；值 = 修复文案里必须出现的锚点（缺什么 + 去哪里填 + 怎么复验之一） */
  const deps = {
    'icp-query': ['icpquery', 'MCP', 'ICP_PROXY_TUNNEL'],
    'oob-verify': ['interactsh', '回调'],
    'asset-deep-scan': ['pd-httpx', 'nuclei', 'setup.sh'],
    'host-post-exploit': ['proxychains4', 'pivot_probe', 'REDTEAM_VPS_HOST'],
    'network-device': ['snmpwalk', 'netdev'],
    'cloud-k8s': ['kubectl', 'KUBECONFIG'],
    'ad-attack': ['impacket', 'certipy'],
    'c2-infra': ['REDTEAM_VPS_HOST', 'pivot_probe'],
  }
  for (const [name, anchors] of Object.entries(deps)) {
    assert.ok(Object.prototype.hasOwnProperty.call(SKILL_FIXES, name), name + ' 缺 skill-fixes 条目')
    const text = fixesForIssue({ kind: 'needs-user', skill: name })
    assert.ok(text.length > 0, name + ' 的修复文案为空')
    assert.match(text, /[\u4e00-\u9fa5]/, name + ' 的修复文案不是中文')
    for (const a of anchors) assert.ok(text.includes(a), name + ' 的修复文案没提到 ' + a + '：' + text)
  }
  /* 纯方法类：已有的三条保持“不依赖外部工具”口径，opsec-hygiene 不硬加条目 */
  for (const name of ['score-coverage', 'campaign-planning', 'specialist-paths']) {
    assert.match(SKILL_FIXES[name], /不依赖外部工具|不依赖任何外部工具/, name + ' 口径不对')
  }
  assert.equal(Object.prototype.hasOwnProperty.call(SKILL_FIXES, 'opsec-hygiene'), false, 'opsec-hygiene 不需要占位条目')
})

test('模拟缺环境：12 个新技能报出的缺口都带可执行修复文案', () => {
  const names = [
    'icp-query', 'oob-verify', 'asset-deep-scan', 'host-post-exploit', 'network-device',
    'cloud-k8s', 'ad-attack', 'c2-infra', 'opsec-hygiene', 'score-coverage',
    'campaign-planning', 'specialist-paths',
  ]
  /* 注入一段缺口声明：一个 shell 必需变量 + 一个本机不存在的工具路径，模拟“这台机器没配”。 */
  const gaps = [
    '',
    '故障模拟（测试注入，不属于技能正文）：',
    '`${DSH_SIM_MISSING_TOKEN:?}`',
    '`$DSH_HOME/redteam/toolkit/dshsim/dsh-sim-missing-tool`',
    '',
  ].join('\n')
  for (const name of names) {
    const content = readFileSync(join(SKILLS, name + '.md'), 'utf8') + gaps
    const verdict = checkSkill({ name, content, path: join(SKILLS, name + '.md') }, { env: {} })
    const envIssue = verdict.issues.find((x) => x.kind === 'env-missing')
    const pathIssue = verdict.issues.find((x) => x.kind === 'path-missing')
    assert.ok(envIssue, name + ' 没报出 env-missing：' + JSON.stringify(verdict.issues))
    assert.ok(pathIssue, name + ' 没报出 path-missing：' + JSON.stringify(verdict.issues))
    for (const issue of verdict.issues) {
      assert.equal(typeof issue.fix, 'string', name + ' 的 ' + issue.kind + ' 缺口没有修复文案')
      assert.ok(issue.fix.trim().length > 0, name + ' 的 ' + issue.kind + ' 缺口修复文案为空')
      assert.ok(issue.fix.includes('`'), name + ' 的 ' + issue.kind + ' 缺口文案没给命令')
    }
    /* 缺变量 → 说清写进哪里、什么时候生效 */
    assert.ok(envIssue.fix.includes('DSH_SIM_MISSING_TOKEN'), name + ' 的环境变量文案没点名缺哪一个')
    assert.ok(envIssue.fix.includes('.env') && envIssue.fix.includes('dsh web'), name + ' 没说清填哪个文件/何时生效')
    /* 缺工具 → 给统一的补齐入口，而不是只说“不可用” */
    assert.ok(pathIssue.fix.includes('setup.sh'), name + ' 的工具路径文案没给补齐入口')
  }
})

test('ICP_PROXY_TUNNEL / KUBECONFIG 的缺变量提示指向真实填法', () => {
  const icp = fixesForIssue({ kind: 'env-missing', skill: 'icp-query', env: 'ICP_PROXY_TUNNEL' })
  assert.ok(icp.includes('代理出口'), '没说明 ICP_PROXY_TUNNEL 是代理出口：' + icp)
  assert.ok(icp.includes('重启 `dsh web`'), '没说明改完要重启：' + icp)
  const k8s = fixesForIssue({ kind: 'env-missing', skill: 'cloud-k8s', env: 'KUBECONFIG' })
  assert.ok(k8s.includes('kubeconfig'), '没说明 KUBECONFIG 填什么：' + k8s)
})
