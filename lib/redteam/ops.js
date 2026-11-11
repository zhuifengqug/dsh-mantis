/* ============================================================================
 * ARTEX P4 · 基础能力数据层（docs/artex/artex-p2p4-design.md §3）
 *
 * 定位：报告 / 复测 / 通知 / 归档 / 任务模板 / 调度 的纯数据层。
 * 全部落本机 SQLite（DatabaseSync 句柄）+ 本机文件（报告 md、模板 json、
 * engagement.yaml 归档位）；**不发外网、不引入任何外部依赖、不常驻、不开线程**。
 * 通知渠道本轮严格占位：notifySend 只读配置返回结构化结果，绝不发起任何
 * 网络请求（本文件不 import node:http/https/net，不调用 fetch）。
 *
 * 与既有层的分工：
 *   - goal / 约束 / hint 节点复用 P1 exploration.js 的纯函数；
 *   - 归档位读写自行做「轻量追加/替换三行」，复用 store-core 的 metaPathOf，
 *     不整段重写 engagement.yaml（避免破坏 readMeta/writeMeta 的格式约定）；
 *   - 调度只记录一行 + 被动到期计数 decorateWake，没有调度器、没有自动执行。
 * ========================================================================== */

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  createExploration, getActiveExploration, addNode, addConstraint, setNodeState,
} from './exploration.js'

const nowIso = () => new Date().toISOString()
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const json = (v) => {
  try { return JSON.parse(v) } catch { return {} }
}
const clip = (v, n = 4096) => {
  const s = v == null ? '' : String(v)
  return s.length > n ? s.slice(0, n) + '…(truncated)' : s
}
let fileSeq = 0
const stamp = (now) => String(now || nowIso()).replace(/[^0-9]/g, '').slice(0, 14)

/* 枚举（错误文本带「非法」→ withStructuredErrors 收敛成 bad_input） */

export const REPORT_KINDS = Object.freeze(['score', 'finding', 'coverage', 'final'])
export const CONCLUSIONS = Object.freeze(['reproduced', 'fixed', 'inconclusive'])
export const RETEST_STATUSES = Object.freeze(['pending', 'running', 'done'])
export const SCHEDULE_KINDS = Object.freeze(['retest', 'report', 'notify'])
export const SCHEDULE_STATUSES = Object.freeze(['due', 'done', 'skipped', 'cancelled'])
export const TEMPLATE_NAME_RE = /^[A-Za-z0-9_-]+$/

/* ---------- §3.1 报告：结构化输出 + report_run 一行（不改业务数据） ---------- */

/** 只读各表拼装报告章节；表缺失/列缺失时该章节降级为空，绝不回写任何业务行。 */
function reportSections(db, kind, findingId) {
  const count = (sql, ...args) => {
    try { return Number(db.prepare(sql).get(...args).n) || 0 } catch { return 0 }
  }
  const rows = (sql, ...args) => {
    try { return db.prepare(sql).all(...args) } catch { return [] }
  }
  const sections = []
  const overview = {
    title: '1. 概述',
    lines: ['- 报告类型：' + kind, '- 生成时间：' + nowIso()],
  }
  sections.push(overview)

  if (kind === 'score' || kind === 'final') {
    const points = count('SELECT COUNT(*) AS n FROM score_point')
    const hits = count('SELECT COUNT(*) AS n FROM score_hit')
    sections.push({ title: '2. 计分链', lines: ['- 计分点：' + points, '- 命中记录：' + hits] })
  }

  if (kind === 'finding' || kind === 'coverage' || kind === 'final') {
    const where = findingId ? ' AND id = ' + Number(findingId) : ''
    const findings = rows("SELECT id, title, body, state FROM exploration_node WHERE kind = 'finding' AND state != 'deleted'" + where + ' ORDER BY id DESC LIMIT 200')
    overview.lines.push('- finding 节点：' + findings.length)
    sections.push({
      title: sections.length === 2 ? '3. 发现' : '2. 发现',
      lines: findings.length
        ? findings.map((f) => `- #${f.id} [${f.state || '—'}] ${f.title || ''}${f.body ? '：' + clip(f.body, 240) : ''}`)
        : ['（暂无 finding 节点）'],
    })
  }

  if (kind === 'coverage' || kind === 'final') {
    const assets = count('SELECT COUNT(*) AS n FROM asset')
    const anchored = count('SELECT COUNT(DISTINCT asset_id) AS n FROM exploration_anchor')
    const nodes = count("SELECT COUNT(*) AS n FROM exploration_node WHERE state != 'deleted'")
    sections.push({
      title: '覆盖度',
      lines: ['- 资产总数：' + assets, '- 已锚定资产：' + anchored, '- 探索节点：' + nodes],
    })
  }

  if (kind === 'final') {
    const bySeverity = {}
    for (const r of rows('SELECT severity, COUNT(*) AS n FROM vuln GROUP BY severity')) bySeverity[r.severity] = r.n
    sections.push({
      title: '成果漏洞',
      lines: Object.keys(bySeverity).length
        ? Object.entries(bySeverity).map(([k, v]) => `- ${k}: ${v}`)
        : ['（暂无漏洞）'],
    })
    sections.push({ title: '复测', lines: ['- 复测记录：' + count('SELECT COUNT(*) AS n FROM retest'), '- 报告批次：' + count('SELECT COUNT(*) AS n FROM report_run')] })
  }
  return sections
}

/**
 * 生成结构化报告：写本机 md 文件 + report_run 一行（manifest 内含 markdown 全文，
 * 即使不读文件也能从 SQLite 拿到完整结构化输出）。不改任何业务数据。
 * @returns {{id:number, path:string, filename:string, kind:string, sections:string[], created_at:string}}
 */
export function reportBuild(db, { kind, findingId, reportsDir, createdBy, now } = {}) {
  if (!REPORT_KINDS.includes(kind)) throw new Error('kind 非法: ' + kind + '（允许: ' + REPORT_KINDS.join('|') + '）')
  const ts = now || nowIso()
  const sections = reportSections(db, kind, findingId)
  const lines = ['# 红队演练结构化报告 · ' + kind, '']
  for (const s of sections) {
    lines.push('## ' + s.title, '', ...s.lines, '')
  }
  const markdown = lines.join('\n')
  const filename = `${kind}-${stamp(ts)}-${++fileSeq}.md`
  const path = join(String(reportsDir || '.'), filename)
  try {
    mkdirSync(String(reportsDir || '.'), { recursive: true })
    writeFileSync(path, markdown, 'utf8')
  } catch { /* 目录不可写时仍落 SQLite，path 作为展示值 */ }
  const manifest = JSON.stringify({ markdown, kind, finding_id: findingId ?? null, section_count: sections.length, generated_at: ts })
  const result = db.prepare('INSERT INTO report_run(kind, path, sections, manifest, created_by, created_at) VALUES(?,?,?,?,?,?)')
    .run(kind, path, JSON.stringify(sections.map((s) => s.title)), manifest, String(createdBy ?? 'engine'), ts)
  return {
    id: Number(result.lastInsertRowid), path, filename, kind,
    sections: sections.map((s) => s.title), created_at: ts,
  }
}

export function reportList(db, { limit } = {}) {
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 50), 1), 500)
  return db.prepare('SELECT id, kind, path, sections, created_by, created_at FROM report_run ORDER BY id DESC LIMIT ?').all(lim)
}

/* ---------- §3.2 复测：三态闭环，conclude 联动 vuln.status ---------- */

/** all=true 覆盖全部漏洞；否则按 vuln_ids 逐个建 pending 行。 */
export function retestRequest(db, { vulnIds, all, reason, requestedBy, now } = {}) {
  if (!reason || String(reason).trim() === '') throw new Error('reason 不能为空')
  let targets
  if (all === true) {
    targets = db.prepare('SELECT id, target FROM vuln ORDER BY id').all()
  } else {
    const ids = Array.isArray(vulnIds) ? vulnIds : (vulnIds == null ? [] : [vulnIds])
    const nums = ids.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
    if (!nums.length) throw new Error('vuln_ids 不能为空（或用 all:true）')
    targets = nums.map((n) => {
      const row = db.prepare('SELECT id, target FROM vuln WHERE id = ?').get(n)
      if (!row) throw new Error('漏洞不存在: ' + n)
      return row
    })
  }
  const ts = now || nowIso()
  const insert = db.prepare('INSERT INTO retest(vuln_id, target, status, reason, requested_by, requested_at) VALUES(?,?,?,?,?,?)')
  const out = []
  for (const v of targets) out.push(Number(insert.run(v.id, v.target ?? null, 'pending', String(reason), String(requestedBy ?? 'engine'), ts).lastInsertRowid))
  return { retest_ids: out, requested: out.length }
}

export function retestList(db, { status, vulnId, limit } = {}) {
  if (status != null && !RETEST_STATUSES.includes(status)) throw new Error('status 非法: ' + status + '（允许: ' + RETEST_STATUSES.join('|') + '）')
  const where = ['1=1']
  const args = []
  if (status) { where.push('status = ?'); args.push(status) }
  if (vulnId != null) { where.push('vuln_id = ?'); args.push(Number(vulnId)) }
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 100), 1), 500)
  return db.prepare('SELECT * FROM retest WHERE ' + where.join(' AND ') + ' ORDER BY id DESC LIMIT ?').all(...args, lim)
}

/**
 * concluded：fixed→vuln.status='fixed'；reproduced→'open'；inconclusive→不改。
 * 'open' 不在 store-core 的 VULN_STATUSES 白名单里，所以这里直接 SQL，绕开 updateVuln。
 */
export function retestConclude(db, { id, conclusion, evidenceRef, note, now } = {}) {
  const retestId = Number(id)
  if (!Number.isInteger(retestId) || retestId <= 0) throw new Error('id 非法: ' + id)
  if (!CONCLUSIONS.includes(conclusion)) throw new Error('conclusion 非法: ' + conclusion + '（允许: ' + CONCLUSIONS.join('|') + '）')
  const row = db.prepare('SELECT * FROM retest WHERE id = ?').get(retestId)
  if (!row) throw new Error('复测记录不存在: ' + retestId)
  const ts = now || nowIso()
  db.prepare('UPDATE retest SET status = ?, conclusion = ?, evidence_ref = COALESCE(?, evidence_ref), note = COALESCE(?, note), started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?')
    .run('done', conclusion, evidenceRef ?? null, note ?? null, ts, ts, retestId)
  let vulnStatus = null
  if (row.vuln_id != null) {
    if (conclusion === 'fixed') vulnStatus = 'fixed'
    else if (conclusion === 'reproduced') vulnStatus = 'open'
    if (vulnStatus) db.prepare('UPDATE vuln SET status = ? WHERE id = ?').run(vulnStatus, row.vuln_id)
  }
  return { retest: db.prepare('SELECT * FROM retest WHERE id = ?').get(retestId), vuln_status: vulnStatus }
}

/* ---------- §3.3 通知：严格占位，绝不发请求、绝不写真实凭据 ---------- */

const SENSITIVE_KEY = /authorization|cookie|passwd|password|secret|token|api[-_]?key|credential|private[-_]?key/i

/** 递归脱敏 extra 里的凭据类字段；返回全新对象，不改入参。 */
export function redactNotify(value, depth = 0) {
  if (depth > 6) return '[REDACTED:depth]'
  if (Array.isArray(value)) return value.map((x) => redactNotify(x, depth + 1))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redactNotify(v, depth + 1)
    return out
  }
  return value
}

/**
 * 占位通知：只读配置，返回结构化结果。**永不发起网络请求**（requests_made 恒为 0）。
 * URL 只来自 settings.notify.urls（面板/人工配置），智能体无法临时指定任意 URL。
 * @param config notifyConfigOf(root) 的结果 {enabled, urls, events}
 */
export function notifySend(config, { event, text, extra } = {}) {
  const cfg = asObject(config)
  const allowed = Array.isArray(cfg.events) && cfg.events.length ? cfg.events : null
  if (!event || String(event).trim() === '') throw new Error('event 不能为空')
  if (allowed && !allowed.includes(event)) throw new Error('event 非法: ' + event + '（允许: ' + allowed.join('|') + '）')
  const urls = cfg.enabled === true && Array.isArray(cfg.urls)
    ? cfg.urls.filter((u) => typeof u === 'string' && u.trim()).map((u) => String(u).trim())
    : []
  const payload = {
    event,
    text: clip(text),
    extra: redactNotify(asObject(extra)),
    requests_made: 0,
  }
  if (!urls.length) {
    return { ok: false, error_kind: 'failed', hint: '通知未配置或发送失败', delivered: [], stub: true, ...payload }
  }
  return {
    ok: true,
    delivered: urls.map((url) => ({ url, status: 'stub', real: false })),
    stub: true,
    ...payload,
  }
}

/* ---------- §3.4 归档：状态位 + 写保护（一处实现，dispatch 与工具层共用） ---------- */

const ARCHIVE_KEYS = ['archived', 'archived_at', 'archive_note']

/** 轻量解析 engagement.yaml 的归档三行；不整段重写、不复用 store-core 私有 readMeta。 */
export function readArchived(metaPath) {
  const out = { archived: false, archived_at: null, archive_note: null }
  let raw
  try { raw = readFileSync(String(metaPath), 'utf8') } catch { return out }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!m || !ARCHIVE_KEYS.includes(m[1])) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    if (m[1] === 'archived') out.archived = v === 'true' || v === true
    else out[m[1]] = v || null
  }
  return out
}

/** 替换/追加归档三行，其余行原样保留。 */
export function writeArchived(metaPath, { archived, note, now } = {}) {
  const ts = now || nowIso()
  let lines = []
  try { lines = readFileSync(String(metaPath), 'utf8').split(/\r?\n/) } catch { lines = [] }
  const kept = lines.filter((line) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*):/.exec(line)
    return !m || !ARCHIVE_KEYS.includes(m[1])
  })
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  kept.push('archived: ' + (archived === true ? 'true' : 'false'))
  kept.push('archived_at: ' + ts)
  if (note != null && String(note).trim() !== '') kept.push('archive_note: ' + String(note).replace(/[\r\n]+/g, ' ').trim())
  writeFileSync(String(metaPath), kept.join('\n') + '\n', 'utf8')
  return readArchived(metaPath)
}

/** 供 dispatch 面板 op `archiveSet` 调用。 */
export function archiveSet(store, id, { archived, note } = {}) {
  if (!id) throw new Error('engagement 不能为空')
  const result = writeArchived(store.metaPathOf(id), { archived: archived === true, note })
  return { ok: true, engagement: id, ...result }
}

/** 该靶标是否已归档。 */
export function isArchived(store, id) {
  if (!id) return false
  try { return readArchived(store.metaPathOf(id)).archived === true } catch { return false }
}

/* 写类 op 判定：用「前缀 + 显式补充」而不是「读类白名单取反」——
   后者会把全局 op（bootstrap / poc* / platformConfig* / openEngagement）和
   未来新增的未知 op 一起误拦。归档只锁该靶标的业务写入。 */
/* activateEngagement 是「切换靶标」的全局 op，不属于该靶标的业务写入，
   因此前缀里不放 activate —— 否则一个已归档的 active 靶标会锁死切换。 */
const WRITE_PREFIX = /^(add|save|update|delete|import|assess|reset|remove|set)/
const EXTRA_WRITE_OPS = new Set([
  'interceptDecide', 'approvalDecide', 'trafficBind', 'mitmCaExport',
  'shotAdd', 'shotDelete', 'addTunnel', 'updateTunnel', 'addChainStep',
])
const isWriteOp = (op) => WRITE_PREFIX.test(String(op || '')) || EXTRA_WRITE_OPS.has(String(op || ''))

/* 全局 op 不针对某个靶标：即使当前 active 靶标已归档，也不该锁死新建靶标、
   知识库、平台配置、切换靶标。P4 面板 op 在 opsDispatch 里已先返回，不在此列。 */
const GLOBAL_OPS = new Set([
  'bootstrap', 'openEngagement', 'activateEngagement',
  'pocSearch', 'pocList', 'pocGet', 'pocSave', 'pocUpdate', 'pocDelete', 'pocUse', 'pocStats',
  'templateSearch', 'templateStats',
  'platformConfigGet', 'platformConfigSave', 'platformAssignToolkit',
])

/**
 * 归档写保护：归档后所有写类 dispatch op 返回 error_kind:'archived'。
 * 读 op、报告生成（report / scoreReport / reportTargets）、复测结论工具不受影响；
 * archiveSet 本身由 opsDispatch 在守卫之前处理（它是唯一的解除归档入口）。
 */
export function archivedGuard(store, id, op) {
  if (GLOBAL_OPS.has(String(op || ''))) return null
  if (!isWriteOp(op)) return null
  if (!isArchived(store, id)) return null
  return { ok: false, error_kind: 'archived', hint: '在面板解除归档' }
}

/* ---------- §3.5 任务模板：纯数据，不建资产、不注入提示词 ---------- */

/** 随包内置模板（避免改 index.js installPreset —— 它只复制顶层文件，不递归子目录）。 */
export const BUNDLED_TEMPLATES = Object.freeze([
  {
    schema: 1, name: 'default', description: '通用起场：登记探索目标、两条基础约束与计分提示。',
    goal: { title: '梳理靶标攻击面并产出可复现成果', body: '覆盖资产识别 → 服务指纹 → 漏洞验证 → 证据留存，成果须有 observed 证据。' },
    constraints: [
      { kind: 'allow', text: '仅对已登记授权范围内的资产开展测试' },
      { kind: 'deny', text: '不做破坏性操作与生产数据写入' },
    ],
    score_hints: [
      { stage: 'recon', point: '资产测绘', hint: '枚举存活主机与开放端口，逐项落 asset' },
      { stage: 'verify', point: '漏洞验证', hint: '每个候选漏洞附一段可复现请求/响应' },
    ],
    roles: ['planner', 'worker', 'reporter'],
  },
  {
    schema: 1, name: 'web', description: 'Web 应用起场：聚焦接口发现、注入与越权验证。',
    goal: { title: '完成 Web 应用的接口测绘与高危漏洞验证', body: '优先 JS 提取接口、鉴权边界与注入点；结论区分 observed/inferred。' },
    constraints: [
      { kind: 'allow', text: '允许对测试账号下的接口做参数探测' },
      { kind: 'deny', text: '禁止批量撞库与对第三方域名的请求' },
    ],
    score_hints: [
      { stage: 'recon', point: '接口清单', hint: '从 JS 与 sitemap 汇总 endpoint' },
      { stage: 'verify', point: '越权验证', hint: '跨角色替换 token 对比 200/403' },
    ],
    roles: ['planner', 'worker', 'retester'],
  },
])

const templatesDir = (root) => join(String(root || '.'), 'templates')

function readTemplateFile(file) {
  try {
    const spec = json(readFileSync(file, 'utf8'))
    return spec && typeof spec === 'object' && spec.goal ? spec : null
  } catch { return null }
}

/** 用户目录同名模板遮蔽随包模板；返回 [{name, source, description}]。 */
export function templateList({ root } = {}) {
  const items = new Map()
  for (const spec of BUNDLED_TEMPLATES) items.set(spec.name, { name: spec.name, source: 'bundled', description: spec.description || '' })
  try {
    for (const file of readdirSync(templatesDir(root))) {
      if (!file.endsWith('.json')) continue
      const spec = readTemplateFile(join(templatesDir(root), file))
      if (!spec) continue
      const name = String(spec.name || file.replace(/\.json$/, ''))
      if (!TEMPLATE_NAME_RE.test(name)) continue
      items.set(name, { name, source: 'user', description: spec.description || '' })
    }
  } catch { /* 无用户目录时只列随包模板 */ }
  return [...items.values()]
}

/** 取一份模板（用户优先）；不存在抛「模板不存在」。 */
export function templateResolve({ root, name } = {}) {
  if (!name || !TEMPLATE_NAME_RE.test(String(name))) throw new Error('template 非法: ' + name)
  const user = readTemplateFile(join(templatesDir(root), String(name) + '.json'))
  if (user) return { ...user, name: String(name), source: 'user' }
  const bundled = BUNDLED_TEMPLATES.find((t) => t.name === name)
  if (bundled) return { ...bundled, source: 'bundled' }
  throw new Error('模板不存在: ' + name)
}

/**
 * 把模板落到当前活动探索（无则建），默认不覆盖已有 goal/约束/计分提示。
 * force:true 时旧 goal 标 deleted 再建新的，约束与 score_hints 无条件追加。
 */
export function templateApply(db, { spec, target, force, now } = {}) {
  if (!spec || !spec.goal) throw new Error('模板不存在')
  const s = asObject(spec)
  let exp = getActiveExploration(db)
  let created = false
  if (!exp) {
    const eid = createExploration(db, { target: String(target || 'template'), goal: String(s.goal.title || '模板目标') })
    exp = db.prepare('SELECT * FROM exploration WHERE id = ?').get(eid)
    created = true
  }
  const eid = Number(exp.id)
  const oldGoal = db.prepare("SELECT * FROM exploration_node WHERE exploration_id = ? AND kind = 'goal' AND state != 'deleted' ORDER BY id DESC LIMIT 1").get(eid)
  let goalId
  let reused = false
  if (oldGoal && force !== true) {
    goalId = Number(oldGoal.id)
    reused = true
  } else {
    if (oldGoal) setNodeState(db, Number(oldGoal.id), 'deleted', { delete_reason: 'template-force' })
    goalId = addNode(db, {
      exploration_id: eid, kind: 'goal', title: String(s.goal.title || ''),
      body: s.goal.body == null ? null : String(s.goal.body), state: 'done',
      payload: { template: s.name || null, schema: s.schema ?? 1 },
    })
  }
  let constraintsAdded = 0
  for (const raw of (Array.isArray(s.constraints) ? s.constraints : [])) {
    const c = asObject(raw)
    const kind = c.kind === 'deny' ? 'deny' : 'allow'
    const text = String(c.text || '').trim()
    if (!text) continue
    if (force !== true && db.prepare('SELECT id FROM task_constraint WHERE target = ? AND kind = ? AND text = ?').get(String(target || ''), kind, text)) continue
    addConstraint(db, { target: String(target || ''), kind, text, origin: 'template:' + (s.name || '') })
    constraintsAdded++
  }
  let hintsAdded = 0
  for (const raw of (Array.isArray(s.score_hints) ? s.score_hints : [])) {
    const h = asObject(raw)
    const title = String(h.point || h.stage || '').trim()
    if (!title) continue
    if (force !== true && db.prepare("SELECT id FROM exploration_node WHERE exploration_id = ? AND kind = 'hint' AND origin = 'score_hint' AND title = ? AND state != 'deleted'").get(eid, title)) continue
    addNode(db, {
      exploration_id: eid, kind: 'hint', origin: 'score_hint', title,
      body: h.hint == null ? null : String(h.hint), parent_id: goalId, state: 'done',
      payload: { stage: h.stage || null },
    })
    hintsAdded++
  }
  return {
    goal_id: goalId, exploration_id: eid, created_exploration: created,
    constraints_added: constraintsAdded, score_hints_added: hintsAdded, reused,
  }
}

/**
 * 把当前活动探索的 goal 节点 / 靶标约束 / score_hint 提示读成模板 spec。
 * 供 redteam_template_save 在不带 goal 参数时「把这场固化下来」。
 */
export function templateFromExploration(db, { name, description, target } = {}) {
  const exp = getActiveExploration(db)
  if (!exp) throw new Error('探索不存在：当前靶标没有进行中的探索，无法固化模板')
  const eid = Number(exp.id)
  const goal = db.prepare("SELECT title, body FROM exploration_node WHERE exploration_id = ? AND kind = 'goal' AND state != 'deleted' ORDER BY id DESC LIMIT 1").get(eid)
  const constraints = db.prepare('SELECT kind, text FROM task_constraint WHERE target = ? ORDER BY id').all(String(target || ''))
  const hints = db.prepare("SELECT title, body, payload FROM exploration_node WHERE exploration_id = ? AND kind = 'hint' AND origin = 'score_hint' AND state != 'deleted' ORDER BY id").all(eid)
    .map((h) => {
      const p = asObject(json(h.payload))
      return { stage: p.stage || '', point: h.title || '', hint: h.body || '' }
    })
  return {
    schema: 1,
    name: String(name || ''),
    description: String(description || ''),
    goal: { title: (goal && goal.title) || String(exp.goal || ''), body: (goal && goal.body) || '' },
    constraints,
    score_hints: hints,
    roles: [],
  }
}

/** 存一份用户模板到 <root>/templates/<name>.json。不写任何凭据字段。 */
export function templateSave({ root, name, description, goal, constraints, score_hints, roles } = {}) {
  if (!name || !TEMPLATE_NAME_RE.test(String(name))) throw new Error('name 非法: ' + name)
  if (!goal || !String(goal.title || '').trim()) throw new Error('goal.title 不能为空')
  const dir = templatesDir(root)
  mkdirSync(dir, { recursive: true })
  const spec = {
    schema: 1, name: String(name), description: String(description || ''),
    goal: { title: String(goal.title), body: String(goal.body || '') },
    constraints: (Array.isArray(constraints) ? constraints : []).map((c) => ({ kind: c && c.kind === 'deny' ? 'deny' : 'allow', text: String((c && c.text) || '') })).filter((c) => c.text),
    score_hints: (Array.isArray(score_hints) ? score_hints : []).map((h) => ({ stage: String((h && h.stage) || ''), point: String((h && h.point) || ''), hint: String((h && h.hint) || '') })).filter((h) => h.point || h.hint),
    roles: Array.isArray(roles) ? roles.map(String) : [],
  }
  const path = join(dir, String(name) + '.json')
  writeFileSync(path, JSON.stringify(spec, null, 2) + '\n', 'utf8')
  return { path, name: String(name) }
}

/* ---------- §3.6 调度：只记录一行 + 被动到期计数，没有调度器 ---------- */

export function scheduleAdd(db, { kind, runAt, params, note, createdBy, now } = {}) {
  if (!SCHEDULE_KINDS.includes(kind)) throw new Error('kind 非法: ' + kind + '（允许: ' + SCHEDULE_KINDS.join('|') + '）')
  if (!runAt || String(runAt).trim() === '') throw new Error('run_at 不能为空')
  const ts = now || nowIso()
  const r = db.prepare('INSERT INTO schedule(kind, run_at, params, status, created_by, created_at, note) VALUES(?,?,?,?,?,?,?)')
    .run(kind, String(runAt), JSON.stringify(asObject(params)), 'due', String(createdBy ?? 'engine'), ts, note == null ? null : String(note))
  return { id: Number(r.lastInsertRowid) }
}

export function scheduleList(db, { status, limit } = {}) {
  if (status != null && !SCHEDULE_STATUSES.includes(status)) throw new Error('status 非法: ' + status + '（允许: ' + SCHEDULE_STATUSES.join('|') + '）')
  const where = status ? 'WHERE status = ?' : ''
  const args = status ? [status] : []
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 100), 1), 500)
  return db.prepare('SELECT * FROM schedule ' + where + ' ORDER BY id DESC LIMIT ?').all(...args, lim)
}

/** 到期未消费条数：status='due' 且 run_at <= now。 */
export function scheduledDue(db, now) {
  try { return Number(db.prepare("SELECT COUNT(*) AS n FROM schedule WHERE status = 'due' AND run_at <= ?").get(String(now || nowIso())).n) || 0 } catch { return 0 }
}

/** 把一行置 done；返回是否真的消费（重复消费返回 false）。 */
export function consumeSchedule(db, id, now) {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new Error('id 非法: ' + id)
  const r = db.prepare("UPDATE schedule SET status = 'done', consumed_at = ? WHERE id = ? AND status = 'due'").run(String(now || nowIso()), n)
  return r.changes > 0
}

/** 被动到期提示：给 planner 的 wake 回声追加 scheduled_due（不改 engine.js）。 */
export function decorateWake(db, wake, now) {
  return { ...asObject(wake), scheduled_due: scheduledDue(db, now) }
}

/* ---------- 面板只读 op 转发（dispatch 集成点，返回 null = 交回原 dispatch） ---------- */

/**
 * 处理 P4 面板 op：reportList / retestList / templateList / scheduleList /
 * notifyConfigGet / notifyConfigSave / archiveSet / exploreDue / scheduledDue。
 * 读配置走 settings.js 的 notifyConfigOf/saveNotifyConfig（由 helpers 注入）。
 */
const P4_OPS = new Set([
  'archiveSet', 'reportList', 'retestList', 'templateList', 'scheduleList',
  'notifyConfigGet', 'notifyConfigSave', 'scheduledDue', 'exploreDue',
])

export function opsDispatch(store, req, id, helpers = {}) {
  const op = req && typeof req.op === 'string' ? req.op.trim() : ''
  /* 非 P4 op 立即交回原 dispatch：绝不为 snapshot / assets / report 等既有 op
     额外开一次库句柄，也不改它们的行为。 */
  if (!P4_OPS.has(op)) return null
  const { notifyConfigOf, saveNotifyConfig } = helpers
  const root = store && store.root
  const getDb = () => (id ? store.db(id) : null)
  switch (op) {
    case 'archiveSet':
      return archiveSet(store, id, { archived: req.archived === true, note: req.note })
    case 'reportList':
      return { ok: true, items: getDb() ? reportList(getDb(), { limit: req.limit }) : [] }
    case 'retestList':
      return { ok: true, items: getDb() ? retestList(getDb(), { status: req.status, vuln_id: req.vuln_id, limit: req.limit }) : [] }
    case 'templateList':
      return { ok: true, items: templateList({ root }) }
    case 'scheduleList':
      return { ok: true, items: getDb() ? scheduleList(getDb(), { status: req.status, limit: req.limit }) : [] }
    case 'notifyConfigGet':
      return { ok: true, notify: typeof notifyConfigOf === 'function' ? notifyConfigOf(root) : null }
    case 'notifyConfigSave':
      return { ok: true, notify: typeof saveNotifyConfig === 'function' ? saveNotifyConfig(root, req.notify || {}) : null }
    case 'scheduledDue':
    case 'exploreDue':
      return { ok: true, scheduled_due: getDb() ? scheduledDue(getDb()) : 0 }
    default:
      return null
  }
}

/** existsSync 再导出一份，供工具层判断报告目录（不强制依赖）。 */
export const reportFileExists = (path) => { try { return existsSync(String(path)) } catch { return false } }
