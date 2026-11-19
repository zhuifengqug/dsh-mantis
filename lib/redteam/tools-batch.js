/* ============================================================================
 * 批量落库 / 范围校验 / 隧道实测 / 数据证明 / 清理台账 —— 5 个工具
 *
 * 定位（v0.16.0 上游 1c75eac 吸收，按本地口径改造）：
 *   1) redteam_scope_check  单个目标是否在靶标 scope 内（域名解析不出 → unresolved）
 *   2) redteam_batch        批量落资产 / 评估 / 漏洞（过 scope，超出进 rejected）
 *   3) redteam_pivot_probe  通过本地 SOCKS5 隧道实测多个内网 host:port 的可达矩阵
 *   4) redteam_data_proof   P1 敏感数据的结构化证明（字段/条数/样本，>=10000 条达标）
 *   5) redteam_cleanup      清理台账（马/临时账号/隧道/文件/计划任务，交付前归零）
 *
 * 约束：全部走本机 SQLite；pivot_probe 只对 args.listen 指定的本地隧道做 CONNECT，
 * 不主动外连；不新增外部依赖。registerBatchTools 由 tools.js 的 apply() 末尾调用，
 * resolveEngagement / agentOf 由 helpers 注入（ESM 循环导入安全，同 tools-ops.js）。
 * ========================================================================== */

import { createConnection } from 'node:net'
import { defineTool, withStructuredErrors, textContent } from './host-tools.js'
import { resolveEngagement, agentOf } from './tools.js'

/** 本工具集注册的全部名字（顺序即注册顺序，供数量自检与测试引用）。 */
export const BATCH_TOOL_NAMES = Object.freeze([
  'redteam_scope_check',
  'redteam_batch',
  'redteam_pivot_probe',
  'redteam_data_proof',
  'redteam_cleanup',
])

const ENGAGEMENT_PARAM = { type: 'string', description: '靶标 ID（省略时按会话绑定 / 唯一靶标解析）' }

/* ---------- scope 判定（IPv4 / CIDR） ---------- */

/* 入参问题归 bad_input 而不是 failed：让模型看到「参数错了、改参数重试」，不是「工具坏了」。 */
function invalidArgument(message) {
  const error = new Error(message)
  error.code = 'INVALID_ARGUMENT'
  return error
}

export function ipv4Int(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim())
  if (m === null) return null
  const n = m.slice(1).map(Number)
  if (n.some((x) => x > 255)) return null
  return ((n[0] * 256 + n[1]) * 256 + n[2]) * 256 + n[3]
}

/** 从 URL / host:port / 任意文本里抠出第一个 IPv4 字面量。 */
export function targetIpv4(target) {
  const m = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/.exec(String(target || ''))
  return m === null ? null : m[1]
}

export function ipInCidr(ip, cidr) {
  const [base, bitsText] = String(cidr || '').split('/')
  const a = ipv4Int(ip)
  const b = ipv4Int(base)
  const bits = Number(bitsText)
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0
  return (a & mask) >>> 0 === (b & mask) >>> 0
}

export function scopeOfEngagement(store, id) {
  const row = (store.listEngagements() || []).find((e) => e.id === id)
  return Array.isArray(row && row.scope) ? row.scope : []
}

/** in / out / unscoped（没填 scope）/ unresolved（解析不出 IPv4，如域名）。 */
export function scopeCheck(store, id, target) {
  const scope = scopeOfEngagement(store, id)
  if (scope.length === 0) return { status: 'unscoped', scope, ip: null }
  const ip = targetIpv4(target)
  if (ip === null) return { status: 'unresolved', scope, ip: null }
  const hit = scope.find((cidr) => ipInCidr(ip, cidr))
  return { status: hit === undefined ? 'out' : 'in', scope, ip, cidr: hit || null }
}
/* ---------- SOCKS5 CONNECT 探测（只走 args.listen 指定的隧道） ---------- */

export function socks5Probe(listen, target, timeoutMs = 6000) {
  const proxy = String(listen || '').replace(/^socks5:\/\//, '').replace(/^https?:\/\//, '')
  const pi = proxy.lastIndexOf(':')
  const ph = pi > 0 ? proxy.slice(0, pi) : '127.0.0.1'
  const pp = Number(pi > 0 ? proxy.slice(pi + 1) : proxy)
  const ti = String(target || '').lastIndexOf(':')
  const th = ti > 0 ? String(target).slice(0, ti) : String(target || '')
  const tp = Number(ti > 0 ? String(target).slice(ti + 1) : 0)
  if (!Number.isFinite(pp) || pp <= 0 || !Number.isFinite(tp) || tp <= 0) {
    return Promise.resolve({ ok: false, target, error: 'listen/target 端口无法解析' })
  }
  return new Promise((resolve) => {
    const started = Date.now()
    let done = false
    let stage = 'greeting'
    const socket = createConnection({ host: ph, port: pp })
    const finish = (ok, error) => {
      if (done) return
      done = true
      try { socket.destroy() } catch { /* 已断开 */ }
      resolve({ ok, target, listen, latency_ms: Date.now() - started, error: error || undefined })
    }
    socket.setTimeout(Math.min(Math.max(Number(timeoutMs) || 6000, 1000), 20000))
    socket.on('timeout', () => finish(false, 'timeout'))
    socket.on('error', (e) => finish(false, String((e && e.code) || (e && e.message) || e)))
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])))
    socket.on('data', (buf) => {
      if (stage === 'greeting') {
        if (buf.length < 2 || buf[0] !== 5 || buf[1] !== 0) return finish(false, 'SOCKS5 greeting failed')
        stage = 'connect'
        const ip = ipv4Int(th)
        let req
        if (ip !== null) {
          const b = Buffer.alloc(10)
          b[0] = 5; b[1] = 1; b[2] = 0; b[3] = 1
          b.writeUInt32BE(ip >>> 0, 4)
          b.writeUInt16BE(tp, 8)
          req = b
        } else {
          const hb = Buffer.from(th, 'utf8')
          const b = Buffer.alloc(7 + hb.length)
          b[0] = 5; b[1] = 1; b[2] = 0; b[3] = 3; b[4] = hb.length
          hb.copy(b, 5)
          b.writeUInt16BE(tp, 5 + hb.length)
          req = b
        }
        socket.write(req)
        return
      }
      if (buf.length >= 2 && buf[0] === 5 && buf[1] === 0) finish(true)
      else finish(false, 'SOCKS5 connect rejected')
    })
  })
}

/* ---------- 工具注册 ---------- */

export function registerBatchTools(ctx, store, helpers = {}) {
  const resolve = helpers.resolveEngagement || resolveEngagement
  const whoOf = helpers.agentOf || agentOf
  const register = (def) => ctx.tools.register(def)

  register(withStructuredErrors(defineTool({
    name: 'redteam_scope_check',
    description: '检查一个 IP/URL/域名是否在当前靶标的授权 scope 内（scope 来自 redteam_engagement_open）。'
      + '域名无法解析成 IPv4 时返回 unresolved；scope 为空时返回 unscoped（不阻断，但提示用户补范围）。'
      + 'ok=true 表示可以继续（in/unscoped/unresolved）；status=out 才是越界，必须停止对该目标的探测、不落库、不计分。',
    parameters: {
      engagement: ENGAGEMENT_PARAM,
      target: { type: 'string', required: true, description: '要检查的目标：URL / ip:port / 主机名 / IP' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
    async execute(args, exec) {
      const id = resolve(store, exec, args.engagement)
      const check = scopeCheck(store, id, args.target)
      const ok = check.status === 'in' || check.status === 'unscoped' || check.status === 'unresolved'
      return JSON.stringify({ ok, engagement: id, target: args.target, ...check }, null, 2)
    },
  })))

  register(withStructuredErrors(defineTool({
    name: 'redteam_batch',
    description: '批量落库，减少逐条调用：kind=assets 批量资产（最多 500，复用 asset_add 的字段与去重）；'
      + 'kind=assess 批量评估（最多 200）；kind=vulns 批量漏洞（最多 200，带 request/response 自动存 HTTP 证据）。'
      + '超出 scope 的条目会跳过并在 rejected 里说明。',
    parameters: {
      engagement: ENGAGEMENT_PARAM,
      kind: { type: 'string', required: true, enum: ['assets', 'assess', 'vulns'], description: 'assets 资产 / assess 评估 / vulns 漏洞' },
      items: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: true },
        description: 'assets: [{ip, provenance, tool, state, primary_name, names, ports, discovered_at}]；'
          + 'assess: [{asset_id|ip, priority, potential, reason}]；'
          + 'vulns: [{title, severity, asset_id, cve, target, evidence, status, gained, request, response, method}]',
      },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
    async execute(args, exec) {
      const id = resolve(store, exec, args.engagement)
      const kind = String(args.kind || '')
      const items = Array.isArray(args.items) ? args.items : []
      const limit = kind === 'assets' ? 500 : 200
      if (items.length === 0 || items.length > limit) {
        throw invalidArgument('redteam_batch: items 数量必须在 1..' + limit)
      }
      const rejected = []
      const results = []
      if (kind === 'assets') {
        const accepted = []
        for (const it of items) {
          const check = scopeCheck(store, id, it && it.ip)
          if (check.status === 'out') {
            rejected.push({ ip: it && it.ip, reason: 'out_of_scope', scope: check.scope })
            continue
          }
          if (!it || typeof it.ip !== 'string' || it.ip.trim() === '') {
            rejected.push({ item: it, reason: 'ip required' })
            continue
          }
          accepted.push(it)
        }
        const out = accepted.length > 0
          ? store.importBundle(id, { scan: { tool: 'redteam_batch', argv: ['assets'] }, assets: accepted })
          : { counts: { assets: 0 } }
        return JSON.stringify({
          ok: true,
          engagement: id,
          kind,
          accepted: accepted.length,
          rejected: rejected.length,
          counts: out.counts,
          rejected,
        }, null, 2)
      }
      if (kind === 'assess') {
        for (const it of items) {
          try {
            results.push(store.assessAsset(id, it || {}))
          } catch (error) {
            rejected.push({ item: it, reason: error && error.message ? error.message : String(error) })
          }
        }
        return JSON.stringify({
          ok: true,
          engagement: id,
          kind,
          assessed: results.length,
          rejected: rejected.length,
          results,
          rejected,
        }, null, 2)
      }
      if (kind === 'vulns') {
        for (const it of items) {
          const check = scopeCheck(store, id, it && it.target)
          if (check.status === 'out') {
            rejected.push({ target: it && it.target, reason: 'out_of_scope', scope: check.scope })
            continue
          }
          try {
            const v = store.addVuln(id, {
              ...it,
              engagement: undefined,
              agent: whoOf(args),
              found_by_agent: it.found_by_agent || it.agent || 'vuln-scan',
            })
            let httpEvidenceId = null
            const request = typeof it.request === 'string' ? it.request.trim() : ''
            if (request !== '') {
              try {
                const ev = store.addHttpEvidence(id, {
                  vuln_id: v.id,
                  asset_id: it.asset_id,
                  label: it.title,
                  method: it.method || 'GET',
                  url: it.target,
                  request,
                  response: it.response,
                  captured_by: whoOf(args),
                })
                httpEvidenceId = ev.id
              } catch { /* 证据存不下不阻断漏洞落库 */ }
            }
            results.push({ id: v.id, updated: v.updated === true, http_evidence_id: httpEvidenceId })
          } catch (error) {
            rejected.push({ item: it, reason: error && error.message ? error.message : String(error) })
          }
        }
        return JSON.stringify({
          ok: true,
          engagement: id,
          kind,
          inserted: results.length,
          rejected: rejected.length,
          results,
          rejected,
        }, null, 2)
      }
      throw invalidArgument('redteam_batch.kind 只接受 assets / assess / vulns')
    },
  })))
  register(withStructuredErrors(defineTool({
    name: 'redteam_pivot_probe',
    description: '通过一个本地 SOCKS5 隧道实测多个内网目标（host:port），返回可达矩阵。'
      + '用于判断"隧道进程活着"是否真的能到内网：reachable>0 才算隧道真的通，'
      + '也是记边界突破（boundary-logical/strong/physical）时"实际访问到的内网资产"那一问的证据来源。',
    parameters: {
      engagement: ENGAGEMENT_PARAM,
      listen: { type: 'string', required: true, description: '本地 SOCKS5 监听地址：127.0.0.1:1080 / socks5://127.0.0.1:7890' },
      targets: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '内网目标 host:port 列表（最多 50 个，写 IPv4 或域名）',
      },
      timeoutMs: { type: 'number', description: '单个探测超时毫秒（1000..20000，默认 6000）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
    async execute(args, exec) {
      const id = resolve(store, exec, args.engagement)
      const targets = (Array.isArray(args.targets) ? args.targets : [])
        .filter((x) => typeof x === 'string' && x.trim() !== '')
        .slice(0, 50)
      if (targets.length === 0) throw invalidArgument('redteam_pivot_probe.targets required')
      const probes = []
      for (const target of targets) probes.push(await socks5Probe(args.listen, target, args.timeoutMs))
      return JSON.stringify({
        ok: true,
        engagement: id,
        listen: args.listen,
        reachable: probes.filter((x) => x.ok).length,
        total: probes.length,
        probes,
      }, null, 2)
    },
  })))

  register(withStructuredErrors(defineTool({
    name: 'redteam_data_proof',
    description: 'P1 敏感数据的结构化证明：op=add 记录字段/条数/样本/来源（row_count>=10000 标 meets_threshold）；'
      + 'op=list 查询。比自由文本 evidence 更可核对，报告/复核用它。'
      + '只记证明所需样本，不要拖全库；fields 必填（写清泄露了哪些字段）。',
    parameters: {
      engagement: ENGAGEMENT_PARAM,
      op: { type: 'string', required: true, enum: ['add', 'list'], description: 'add 记录 / list 查询' },
      target: { type: 'string', description: '数据所在目标（URL / ip:port / 库表）' },
      source: { type: 'string', description: '数据来源：api / db / file / backup' },
      interface: { type: 'string', description: '具体接口或库表名，例如 /api/v1/users、user_db.t_user' },
      fields: { type: 'array', items: { type: 'string' }, description: '【add 必填】泄露字段，如 ["姓名","身份证号","手机号"]' },
      row_count: { type: 'number', description: '【add 必填】实际可获取条数（>=10000 记为达标 P1）' },
      sample: { type: 'string', description: '少量脱敏样本（不要贴完整明文，遮几位）' },
      query: { type: 'string', description: '取数语句或请求原文' },
      evidence_ref: { type: 'string', description: '截图/文件路径或 redteam_evidence_record 的 ref' },
      pii_type: { type: 'string', description: '敏感数据类型，默认 pii（如 身份证/手机号/银行卡/病历）' },
      asset_id: { type: 'number' },
      vuln_id: { type: 'number' },
      note: { type: 'string' },
      limit: { type: 'number', description: 'list 返回条数上限（1..500，默认 100）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
    async execute(args, exec) {
      const id = resolve(store, exec, args.engagement)
      if (args.op === 'list') {
        return JSON.stringify({ ok: true, engagement: id, ...store.listDataProofs(id, args) }, null, 2)
      }
      return JSON.stringify({
        ok: true,
        engagement: id,
        proof: store.addDataProof(id, { ...args, created_by: whoOf(args) }),
      }, null, 2)
    },
  })))

  register(withStructuredErrors(defineTool({
    name: 'redteam_cleanup',
    description: '清理台账：op=add 记录上传的马/临时账号/隧道/文件/计划任务；op=list 查未清理项；op=update 标记 done。'
      + '交付前用它确认没有遗留入口 —— list status=open 归零才算收尾干净。',
    parameters: {
      engagement: ENGAGEMENT_PARAM,
      op: { type: 'string', required: true, enum: ['add', 'list', 'update'], description: 'add 记录 / list 查询 / update 改状态' },
      id: { type: 'number', description: 'update 时的台账项 id' },
      kind: { type: 'string', enum: ['webshell', 'account', 'tunnel', 'file', 'task', 'other'], description: '【add 必填】遗留物类型' },
      target: { type: 'string', description: '所在目标（URL / ip:port / 主机名）' },
      location: { type: 'string', description: '具体位置：路径 / 账号 / 监听端口 / 任务名' },
      detail: { type: 'string', description: '补充说明（清理方法、风险）' },
      status: { type: 'string', enum: ['open', 'done', 'kept'], description: '状态：open 未清理 / done 已清理 / kept 有意保留（需说明）' },
      limit: { type: 'number', description: 'list 返回条数上限（1..500，默认 200）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
    async execute(args, exec) {
      const id = resolve(store, exec, args.engagement)
      if (args.op === 'list') {
        return JSON.stringify({ ok: true, engagement: id, ...store.listCleanup(id, args) }, null, 2)
      }
      if (args.op === 'update') {
        return JSON.stringify({ ok: true, engagement: id, item: store.updateCleanup(id, args) }, null, 2)
      }
      return JSON.stringify({ ok: true, engagement: id, item: store.addCleanup(id, { ...args, created_by: whoOf(args) }) }, null, 2)
    },
  })))

  return BATCH_TOOL_NAMES.length
}

/* 独立挂载入口（供只挂这一片工具的 agent 复用；profile 由宿主配置决定）。 */
export const name = 'mantis-redteam-tools-batch'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  let store
  try { store = ctx.redteam } catch { store = undefined }
  if (!store && typeof ctx.get === 'function') {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) {
    ctx.logger?.warn?.('redteam-tools-batch: host ctx.redteam unavailable — tools will report store_missing')
    store = { root: '', dirOf: () => '', db: () => null, listEngagements: () => [] }
  }
  return registerBatchTools(ctx, store, { resolveEngagement, agentOf })
}

export default { name, inject, apply }
