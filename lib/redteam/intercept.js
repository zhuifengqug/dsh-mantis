/**
 * 审批门（P3c）：intercept 规则 + 待批队列。
 *
 * 两个规则源，合并匹配：
 *   1. `<root>/intercept.json` —— 全局文件，人和面板编辑（mode / agentDecide / defaultTtlSeconds / rules）；
 *   2. `intercept_rule` 表 —— 靶标内补充规则（工具与面板加的），随靶标库走。
 *
 * 三类判定的优先级（命中即返回，deny 先于 require_approval）：
 *   - `effect:'deny'`            → 直接拒，落一行 state='rejected'（谁批的记 'rule:<id>'，理由=规则 note）
 *   - `effect:'require_approval'`→ upsert 一行 state='pending'，请求被挡下；人放行后**原样重试**才通过
 *   - 未命中                     → 透传。非命中流量零开销，不进任何队列（验收硬要求）
 *
 * 为什么不做「挂起等批」的长连接：代理是单进程网络服务，把 socket 吊在等人点按钮上
 * 等于用一个未定义的超时换一堆僵尸连接。这里沿用设计文档 §2.4 的做法 —— 立即失败返回
 * pending id，人批完原样重试，`pending_key` 保证重试命中同一行。
 *
 * 零外部依赖，纯 node:crypto + node:fs。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 全局规则文件名（与 settings.json 同层）。 */
export const INTERCEPT_FILE = 'intercept.json'

/** 出厂：关闭（面板一键打开；关闭时全部流量透传）。 */
export const INTERCEPT_DEFAULTS = {
  mode: 'off',
  agentDecide: false,
  defaultTtlSeconds: 3600,
  rules: [],
}

/**
 * 出厂规则（mode 打开后生效）。都是「人类看到会想点一下」的形状，不是地毯式拦截 ——
 * 地毯式规则等于把审批门关掉，因为人会一路点放行。
 */
export const DEFAULT_RULES = [
  { id: 'r-admin-path', path: '*admin*', effect: 'require_approval', note: '访问后台管理路径' },
  { id: 'r-php-upload', method: 'POST', path: '*.php*', effect: 'require_approval', note: '向 PHP 端点提交（疑似上传）' },
  { id: 'r-delete', method: 'DELETE', effect: 'require_approval', note: 'DELETE 请求（疑似删数据）' },
]

/** 待批状态机。`approved` / `rejected` 是终态，`pending` 只进不出。 */
export const INTERCEPT_STATES = ['pending', 'approved', 'rejected']

export const EFFECTS = ['require_approval', 'deny']

/* --------------------------------------------------------------- 配置读写 */

function emptyConfig() {
  return {
    mode: INTERCEPT_DEFAULTS.mode,
    agentDecide: INTERCEPT_DEFAULTS.agentDecide,
    defaultTtlSeconds: INTERCEPT_DEFAULTS.defaultTtlSeconds,
    rules: [],
  }
}

/** 规范化一条规则（文件里的和表里的走同一套）。 */
export function normalizeRule(input = {}) {
  const ruleId = String(input.id || input.rule_id || '').trim()
  const effect = input.effect === 'deny' ? 'deny' : 'require_approval'
  const tags = Array.isArray(input.risk_tags)
    ? input.risk_tags.map((tag) => String(tag).trim()).filter(Boolean)
    : (typeof input.risk_tags === 'string' && input.risk_tags.trim() !== ''
      ? input.risk_tags.split(',').map((tag) => tag.trim()).filter(Boolean)
      : [])
  const rule = {
    id: ruleId,
    method: typeof input.method === 'string' && input.method.trim() !== '' ? input.method.trim().toUpperCase() : '*',
    host: typeof input.host === 'string' && input.host.trim() !== '' ? input.host.trim().toLowerCase() : '*',
    path: typeof input.path === 'string' && input.path.trim() !== '' ? input.path.trim() : '*',
    risk_tags: tags,
    effect,
    note: typeof input.note === 'string' ? input.note : '',
    enabled: input.enabled === false || input.enabled === 0 ? false : true,
  }
  return rule
}

/**
 * 读 `<root>/intercept.json`。文件缺失/坏掉都退回出厂配置（mode off）——
 * 审批门是「坏了自己消失」比「坏了拦死全网」安全得多的那种部件。
 */
export function readInterceptConfig(root) {
  const path = join(String(root), INTERCEPT_FILE)
  if (!existsSync(path)) {
    return Object.assign(emptyConfig(), { path, exists: false, rules: DEFAULT_RULES.map(normalizeRule) })
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const config = {
      mode: raw.mode === 'on' ? 'on' : 'off',
      agentDecide: raw.agentDecide === true,
      defaultTtlSeconds: Number.isFinite(Number(raw.defaultTtlSeconds)) ? Math.max(0, Number(raw.defaultTtlSeconds)) : INTERCEPT_DEFAULTS.defaultTtlSeconds,
      rules: Array.isArray(raw.rules) ? raw.rules.map(normalizeRule).filter((rule) => rule.id !== '') : [],
    }
    return Object.assign(config, { path, exists: true })
  } catch (error) {
    return Object.assign(emptyConfig(), { path, exists: true, error: error && error.message ? error.message : String(error) })
  }
}

/** 写回 `<root>/intercept.json`（先写 .tmp 再 rename，避免半截文件）。 */
export function writeInterceptConfig(root, patch = {}) {
  const current = readInterceptConfig(root)
  const next = {
    mode: patch.mode === undefined ? current.mode : (patch.mode === 'on' ? 'on' : 'off'),
    agentDecide: patch.agentDecide === undefined ? current.agentDecide : patch.agentDecide === true,
    defaultTtlSeconds: patch.defaultTtlSeconds === undefined ? current.defaultTtlSeconds : Math.max(0, Number(patch.defaultTtlSeconds) || 0),
    rules: Array.isArray(patch.rules) ? patch.rules : (patch.rules === undefined ? current.rules : []),
  }
  const path = join(String(root), INTERCEPT_FILE)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
  return Object.assign(next, { path })
}

/* --------------------------------------------------------------- 规则匹配 */

const GLOB_CACHE = new Map()

/** glob → RegExp（只支持 `*` 与 `?`，足够写规则，且不会像正则那样手滑写出灾难回溯）。 */
export function globToRegExp(pattern) {
  const key = String(pattern)
  const cached = GLOB_CACHE.get(key)
  if (cached !== undefined) return cached
  let out = '^'
  for (const ch of key) {
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  out += '$'
  const regexp = new RegExp(out, 'i')
  GLOB_CACHE.set(key, regexp)
  return regexp
}

/** 一条请求的形状（代理侧构造；工具侧可以只给 url，由 url 推 host/path）。 */
export function normalizeRequest(input = {}) {
  const method = String(input.method || 'GET').toUpperCase()
  const url = typeof input.url === 'string' ? input.url : ''
  let host = typeof input.host === 'string' ? input.host : ''
  let path = typeof input.path === 'string' ? input.path : ''
  if ((host === '' || path === '') && url !== '') {
    try {
      const parsed = new URL(url)
      if (host === '') host = parsed.host
      if (path === '') path = parsed.pathname + parsed.search
    } catch { /* url 不是绝对地址时沿用传入值 */ }
  }
  if (host === '' && typeof input.authority === 'string') host = input.authority
  if (path === '') path = '/'
  const risk = Array.isArray(input.risk) ? input.risk.map((tag) => String(tag)) : []
  return { method, url, host: host.toLowerCase(), path, risk }
}

/** 单条规则是否命中。`*` 通配；risk_tags 只在请求带了 risk 标签时才参与交集判断。 */
export function ruleMatches(rule, request) {
  if (rule.enabled === false) return false
  const req = request.method !== undefined ? request : normalizeRequest(request)
  if (rule.method !== '*' && String(rule.method).toUpperCase() !== req.method) return false
  if (rule.host !== '*' && !globToRegExp(rule.host).test(req.host)) return false
  if (rule.path !== '*' && !globToRegExp(rule.path).test(req.path)) return false
  if (Array.isArray(rule.risk_tags) && rule.risk_tags.length > 0 && req.risk.length > 0) {
    const hit = rule.risk_tags.some((tag) => req.risk.includes(tag))
    if (!hit) return false
  }
  return true
}

/** 选出命中的规则：deny 优先（同样优先级下按规则顺序）。 */
export function pickRule(rules, request) {
  const hits = rules.filter((rule) => ruleMatches(rule, request))
  if (hits.length === 0) return null
  return hits.find((rule) => rule.effect === 'deny') || hits[0]
}

/* --------------------------------------------------------------- 规则存储 */

function rowToRule(row) {
  return normalizeRule({
    id: row.rule_id,
    method: row.method,
    host: row.host,
    path: row.path,
    risk_tags: row.risk_tags,
    effect: row.effect,
    note: row.note,
    enabled: Number(row.enabled) !== 0,
  })
}

/** 读靶标库里的规则（只列启用的可用 enabled:false 关掉单条）。 */
export function listDbRules(db, options = {}) {
  const where = options.all === true ? '' : ' WHERE enabled = 1'
  const rows = db.prepare('SELECT * FROM intercept_rule' + where + ' ORDER BY id').all()
  return rows.map((row) => Object.assign(rowToRule(row), { source: 'db', db_id: row.id }))
}

/** 合并两个规则源：文件规则 + 库规则（库规则后置，deny 优先级由 pickRule 统一处理）。 */
export function composeRules(root, db, options = {}) {
  const config = readInterceptConfig(root)
  const fromFile = config.rules.map((rule) => Object.assign({}, rule, { source: 'file' }))
  const fromDb = db ? listDbRules(db, options) : []
  return { config, rules: fromFile.concat(fromDb) }
}

/** 加/改一条库规则（同 rule_id 覆盖）。 */
export function saveDbRule(db, input = {}) {
  const rule = normalizeRule(input)
  if (rule.id === '') throw new Error('规则需要 id（例如 r-admin-path）')
  const existing = db.prepare('SELECT id FROM intercept_rule WHERE rule_id = ?').get(rule.id)
  const riskTags = rule.risk_tags.length > 0 ? JSON.stringify(rule.risk_tags) : null
  if (existing) {
    db.prepare(
      'UPDATE intercept_rule SET method = ?, host = ?, path = ?, risk_tags = ?, effect = ?, note = ?, enabled = ? WHERE rule_id = ?',
    ).run(rule.method, rule.host, rule.path, riskTags, rule.effect, rule.note, rule.enabled ? 1 : 0, rule.id)
    return { created: false, rule }
  }
  db.prepare(
    'INSERT INTO intercept_rule (rule_id, method, host, path, risk_tags, effect, note, enabled, created_at)'
    + " VALUES (?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(rule.id, rule.method, rule.host, rule.path, riskTags, rule.effect, rule.note, rule.enabled ? 1 : 0)
  return { created: true, rule }
}

/** 删一条库规则。 */
export function deleteDbRule(db, ruleId) {
  const result = db.prepare('DELETE FROM intercept_rule WHERE rule_id = ?').run(String(ruleId))
  return { ok: true, deleted: Number(result && result.changes) > 0, rule_id: String(ruleId) }
}

/* --------------------------------------------------------------- 待批队列 */

/** 同一「规则 + 方法 + URL」的重试必须命中同一行，否则人批一次、模型重试一次就再进一次队。 */
export function pendingKeyOf(ruleId, request) {
  const req = request.method !== undefined ? request : normalizeRequest(request)
  return createHash('sha256').update(String(ruleId) + '\n' + req.method + '\n' + req.url).digest('hex')
}

function nowIso(now) {
  return new Date(now === undefined ? Date.now() : now).toISOString()
}

function rowToPending(row) {
  if (!row) return null
  return {
    id: row.id,
    pending_key: row.pending_key,
    rule_id: row.rule_id,
    method: row.method,
    url: row.url,
    host: row.host,
    path: row.path,
    state: row.state,
    requested_by: row.requested_by,
    requested_at: row.requested_at,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    decision_reason: row.decision_reason,
    scope: row.scope || 'once',
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    decision_count: Number(row.decision_count) || 0,
    flow_id: row.flow_id === null ? null : Number(row.flow_id),
    session_id: row.session_id,
    risk_tags: row.risk_tags ? safeParse(row.risk_tags) : [],
    note: row.note,
  }
}

function safeParse(text) {
  try { return JSON.parse(text) } catch { return [] }
}

/**
 * 审批门核心：判定一条请求能不能过。
 *
 * @returns {{action:'pass', matched:false}}
 *        | {{action:'pass', matched:true, effect:'require_approval', pending, consumed:true}}
 *        | {{action:'block', matched:true, effect:'deny'|'require_approval', pending, reason}}
 */
export function checkRequest(db, input = {}, options = {}) {
  const request = normalizeRequest(input)
  const config = options.config || readInterceptConfig(options.root)
  const rules = options.rules || composeRules(options.root, db, { all: false }).rules
  const now = options.now === undefined ? Date.now() : options.now

  if (config.mode !== 'on' && options.force !== true) {
    return { action: 'pass', matched: false, reason: 'intercept mode is off' }
  }

  const rule = pickRule(rules, request)
  if (!rule) return { action: 'pass', matched: false }

  const pendingKey = pendingKeyOf(rule.id, request)
  const existing = rowToPending(db.prepare('SELECT * FROM intercept_pending WHERE pending_key = ? ORDER BY id DESC LIMIT 1').get(pendingKey))
  const requestedBy = typeof input.requested_by === 'string' ? input.requested_by : null
  const sessionId = typeof input.session_id === 'string' ? input.session_id : null
  const flowId = Number.isFinite(Number(input.flow_id)) ? Number(input.flow_id) : null

  /* deny：直接拒，并留痕（谁=规则，何时=now，理由=规则 note） */
  if (rule.effect === 'deny') {
    const reason = rule.note || '命中 deny 规则：' + rule.id
    if (existing === null) {
      const info = db.prepare(
        'INSERT INTO intercept_pending (pending_key, rule_id, method, url, host, path, state, requested_by, requested_at,'
        + ' decided_by, decided_at, decision_reason, flow_id, session_id, risk_tags)'
        + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        pendingKey, rule.id, request.method, request.url, request.host, request.path, 'rejected',
        requestedBy, nowIso(now), 'rule:' + rule.id, nowIso(now), reason, flowId, sessionId,
        rule.risk_tags.length > 0 ? JSON.stringify(rule.risk_tags) : null,
      )
      return { action: 'block', matched: true, effect: 'deny', reason, pending: getPending(db, Number(info.lastInsertRowid)) }
    }
    return { action: 'block', matched: true, effect: 'deny', reason: existing.decision_reason || reason, pending: existing }
  }

  /* require_approval */
  if (existing !== null) {
    const expired = existing.expires_at !== null && existing.expires_at !== '' && Date.parse(existing.expires_at) <= now
    const onceUsed = existing.scope !== 'ttl' && existing.consumed_at !== null && existing.consumed_at !== ''
    if (existing.state === 'approved' && !expired && !onceUsed) {
      db.prepare(
        "UPDATE intercept_pending SET consumed_at = ?, decision_count = decision_count + 1 WHERE id = ?",
      ).run(nowIso(now), existing.id)
      return { action: 'pass', matched: true, effect: 'require_approval', consumed: true, pending: getPending(db, existing.id) }
    }
    /* 拒绝：原样挡下。过期的放行 / 已消费的一次性放行：都不复活旧行，重新排队（人再看一眼） */
    if (existing.state === 'rejected') {
      return {
        action: 'block', matched: true, effect: 'require_approval',
        reason: '已被拒绝：' + (existing.decision_reason || '（未写理由）'), pending: existing,
      }
    }
    if (existing.state === 'pending') {
      /* pending：复用同一行，不重复建 —— 模型反复重试也只产生一条待批 */
      return { action: 'block', matched: true, effect: 'require_approval', reason: '待人工批准', pending: existing }
    }
    const why = expired
      ? '上一次放行已过期（' + existing.expires_at + '），重新排队'
      : '上一次放行是一次性（已消费），重新排队'
    const requeueKey = pendingKey + '#r' + (existing.id + 1) + '-' + now.toString(36)
    const info = db.prepare(
      'INSERT INTO intercept_pending (pending_key, rule_id, method, url, host, path, state, requested_by, requested_at,'
      + ' flow_id, session_id, risk_tags, note)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      requeueKey, rule.id, request.method, request.url, request.host, request.path, 'pending',
      requestedBy, nowIso(now), flowId, sessionId,
      rule.risk_tags.length > 0 ? JSON.stringify(rule.risk_tags) : null, why,
    )
    return { action: 'block', matched: true, effect: 'require_approval', reason: '待人工批准', pending: getPending(db, Number(info.lastInsertRowid)) }
  }

  const info = db.prepare(
    'INSERT INTO intercept_pending (pending_key, rule_id, method, url, host, path, state, requested_by, requested_at,'
    + ' flow_id, session_id, risk_tags)'
    + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    pendingKey, rule.id, request.method, request.url, request.host, request.path, 'pending',
    requestedBy, nowIso(now), flowId, sessionId,
    rule.risk_tags.length > 0 ? JSON.stringify(rule.risk_tags) : null,
  )
  return { action: 'block', matched: true, effect: 'require_approval', reason: '待人工批准', pending: getPending(db, Number(info.lastInsertRowid)) }
}

/** 取一行待批。 */
export function getPending(db, id) {
  return rowToPending(db.prepare('SELECT * FROM intercept_pending WHERE id = ?').get(Number(id)))
}

/** 列表（默认 pending；`state:'all'` 全列）。 */
export function listPending(db, filters = {}) {
  const where = []
  const args = []
  const state = typeof filters.state === 'string' ? filters.state.trim() : 'pending'
  if (state !== '' && state !== 'all') { where.push('state = ?'); args.push(state) }
  if (typeof filters.rule_id === 'string' && filters.rule_id !== '') { where.push('rule_id = ?'); args.push(filters.rule_id) }
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 1000)
  const sql = 'SELECT * FROM intercept_pending' + (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY id DESC LIMIT ' + limit
  const rows = db.prepare(sql).all(...args)
  const total = Number(db.prepare('SELECT COUNT(*) AS n FROM intercept_pending' + (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '')).get(...args).n) || 0
  return { total, items: rows.map(rowToPending) }
}

export function countPending(db) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM intercept_pending WHERE state = 'pending'").get()
  return Number(row && row.n) || 0
}

/**
 * 放行 / 拒绝。理由必填 —— 「谁、何时、为什么」里最容易被跳过的是为什么，
 * 而它恰好是事后复盘唯一能用的那一项。
 */
export function decidePending(db, input = {}, options = {}) {
  const id = Number(input.pending_id !== undefined ? input.pending_id : input.id)
  if (!Number.isInteger(id) || id <= 0) throw new Error('非法参数 pending_id：需要正整数')
  const decision = String(input.decision || '').trim().toLowerCase()
  if (decision !== 'allow' && decision !== 'deny') throw new Error("非法参数 decision：只能是 'allow' 或 'deny'")
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason === '') throw new Error('decision_reason 必填：写清为什么放行/拒绝')

  const row = getPending(db, id)
  if (row === null) throw new Error('待批记录不存在：' + id)
  if (row.state !== 'pending') throw new Error('这条已经处理过了（当前状态 ' + row.state + '）')

  const now = options.now === undefined ? Date.now() : options.now
  const decidedBy = typeof options.decidedBy === 'string' && options.decidedBy !== '' ? options.decidedBy : 'panel'
  const ttlSeconds = Number.isFinite(Number(input.ttlSeconds)) ? Math.max(0, Number(input.ttlSeconds)) : 0
  const state = decision === 'allow' ? 'approved' : 'rejected'
  const expiresAt = decision === 'allow' && ttlSeconds > 0 ? new Date(now + ttlSeconds * 1000).toISOString() : null
  const scope = decision === 'allow' && ttlSeconds > 0 ? 'ttl' : 'once'
  db.prepare(
    'UPDATE intercept_pending SET state = ?, decided_by = ?, decided_at = ?, decision_reason = ?, scope = ?, expires_at = ? WHERE id = ?',
  ).run(state, decidedBy, nowIso(now), reason, scope, expiresAt, id)
  return { ok: true, state, scope, decided_by: decidedBy, decided_at: nowIso(now), expires_at: expiresAt, pending: getPending(db, id) }
}

/**
 * 给代理用的门：带 1 秒配置缓存（面板改规则后最多 1 秒生效，而每条请求不必读盘）。
 * 任何异常都判 pass —— 审批门自身故障不该让用户断网。
 */
export function makeGate(options = {}) {
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Math.max(0, Number(options.ttlMs)) : 1000
  let cached = null
  let cachedAt = 0
  const load = () => {
    const now = Date.now()
    if (cached !== null && now - cachedAt < ttlMs) return cached
    try {
      cached = composeRules(options.root, options.db, { all: false })
    } catch {
      cached = { config: { mode: 'off' }, rules: [] }
    }
    cachedAt = now
    return cached
  }
  return function gate(request) {
    try {
      const { config, rules } = load()
      if (config.mode !== 'on') return { action: 'pass', matched: false }
      return checkRequest(options.db, request, { config, rules })
    } catch {
      return { action: 'pass', matched: false }
    }
  }
}
