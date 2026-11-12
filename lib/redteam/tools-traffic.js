/**
 * MITM 录制流量工具（preset 平面，P3b）
 *
 * 为什么单独一个包而不是继续堆进 tools.js：流量工具与「资产/漏洞/报告」工具的生命周期不同
 * —— 对方是靶标事实的写入者，这边是**原始流量的检索与挂证**，读多写少，且 t11 的审批门
 * （intercept / approval）会继续加在这里。合在一个 apply 里只是让 2000 行的文件更长。
 *
 * 全部落库操作都走 `store.traffic(id)`（RedteamStore 的唯一写者原则，见 store-core.js 注释），
 * 本文件不 import node:sqlite、不自己开连接。
 */
import { defineTool, withStructuredErrors, textContent, setDefineToolLoader } from './host-tools.js'
import { resolveEngagement } from './tools.js'

/** Cordis 插件名。 */
export const name = 'mantis-redteam-tools-traffic'

/** 硬依赖工具注册表；`redteam` 由 host 平面 store 发布。 */
export const inject = ['tools']

/** 测试用：替换 defineTool 的实现（不加载宿主模块）。 */
export { setDefineToolLoader }

const text = textContent

/** 可选数字参数：空值/非法值不进查询条件（宁可少过滤，不要静默按 0 过滤）。 */
function optNum(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function optStr(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** 一条 flow 的紧凑单行（列表渲染用，避免把 header/body 全塞进上下文）。 */
function flowLine(f) {
  const size = (Number(f.req_body_bytes) || 0) + (Number(f.resp_body_bytes) || 0)
  const parts = [
    '#' + f.id,
    String(f.status) + ' ' + f.method,
    f.url,
    size + 'B',
    f.duration_ms === null || f.duration_ms === undefined ? '' : f.duration_ms + 'ms',
  ]
  if (f.finding_id) parts.push('finding:' + f.finding_id)
  if (f.vuln_id) parts.push('vuln:' + f.vuln_id)
  return parts.filter(Boolean).join('  ')
}

export function apply(ctx) {
  let store
  try {
    store = ctx.redteam
  } catch {
    store = undefined
  }
  if (store === undefined && typeof ctx.get === 'function') {
    try { store = ctx.get('redteam') } catch { store = undefined }
  }
  if (!store) return

  const trafficOf = (args, exec) => {
    const id = resolveEngagement(store, exec, optStr(args.engagement))
    return store.traffic(id)
  }

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_traffic_search',
    description: '检索本靶标录到的 HTTP 流量（MITM 代理落库的原始请求/响应）。默认只查当前靶标；all_targets=true 时显式跨靶标检索（返回每条的 engagement_id/target 便于分辨来源）。可按关键字 q（url/host/path/请求头/响应头模糊匹配）、host、url、method、status、vuln_id、finding_id、时间范围（since/until，ISO 时间或日期）过滤。调用前自动把代理 spool 里的新流量入库。只返回摘要行，具体报文用 redteam_traffic_get / redteam_traffic_blob。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
      all_targets: { type: 'boolean', description: '显式跨靶标检索：默认 false 只查当前靶标；true 时不注入靶标过滤，可看到本库中所有来源的流量（含旧库历史串库数据）' },
      q: { type: 'string', description: '关键字（url / host / path / 请求头 / 响应头 模糊匹配）' },
      host: { type: 'string', description: '精确主机名，例如 api.example.com' },
      url: { type: 'string', description: 'URL 子串匹配' },
      method: { type: 'string', description: 'HTTP 方法：GET / POST / PUT / DELETE …' },
      status: { type: 'number', description: '响应状态码，例如 200' },
      vuln_id: { type: 'number', description: '只看绑定到这个漏洞 id 的流量' },
      finding_id: { type: 'number', description: '只看绑定到这个发现 id 的流量' },
      since: { type: 'string', description: '起始时间（含），ISO 时间或 YYYY-MM-DD' },
      until: { type: 'string', description: '结束时间（含），ISO 时间或 YYYY-MM-DD' },
      limit: { type: 'number', description: '最多返回条数，默认 50，上限 5000' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const api = trafficOf(args, exec)
      const cross = args.all_targets === true
      const filters = {
        q: optStr(args.q),
        host: optStr(args.host),
        url: optStr(args.url),
        method: optStr(args.method),
        status: optNum(args.status),
        vuln_id: optNum(args.vuln_id),
        finding_id: optNum(args.finding_id),
        since: optStr(args.since),
        until: optStr(args.until),
        limit: optNum(args.limit),
      }
      if (cross) filters.cross_engagement = true
      const result = api.search(filters)
      return JSON.stringify({
        ok: true,
        cross,
        total: result.total,
        returned: result.items.length,
        auto_ingest: result.auto_ingest,
        items: result.items,
        lines: result.items.map(flowLine),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_traffic_get',
    description: '取一条流量的完整元数据（method/url/头/状态/耗时/来源工具/已有绑定）和请求、响应 body 的预览文本。二进制 body 的预览为 null，原文用 redteam_traffic_blob 取。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
      id: { type: 'number', required: true, description: '流量 id（redteam_traffic_search 返回的 items[].id）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const api = trafficOf(args, exec)
      const id = optNum(args.id)
      if (id === undefined) throw new Error('非法参数 id：需要正整数流量 id')
      const flow = api.get(id)
      if (!flow) throw new Error('流量不存在：' + id)
      return JSON.stringify({
        ok: true,
        flow,
        req_preview: flow.req_body ?? null,
        resp_preview: flow.resp_body ?? null,
        bound: api.bindings(id),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_traffic_blob',
    description: "取一条流量的请求或响应 body 全文。which='req' 取请求体、'resp' 取响应体。返回落盘路径、字节数、sha256、内容类型；body 不超过 maxInline（默认 65536 字节）且为文本时把原文一并带回（inline 字段）。",
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
      id: { type: 'number', required: true, description: '流量 id' },
      which: { type: 'string', required: true, description: "'req' 或 'resp'" },
      maxInline: { type: 'number', description: '原文内联的上限字节数，默认 65536，0 表示不内联' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const api = trafficOf(args, exec)
      const id = optNum(args.id)
      if (id === undefined) throw new Error('非法参数 id：需要正整数流量 id')
      const which = optStr(args.which)
      if (which === undefined) throw new Error("非法参数 which：只能是 'req' 或 'resp'")
      const blob = api.blob(id, which, { maxInline: optNum(args.maxInline) })
      return JSON.stringify(blob, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_traffic_bind',
    description: '把一条流量绑定为某个发现（finding）、漏洞（vuln）、攻击步骤（step）或资产（asset）的证据。至少给一个目标；重复绑定幂等。绑定后 redteam_traffic_search 可直接按 finding_id / vuln_id 过滤，报告里的证据链接也会指向这条原始报文。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
      id: { type: 'number', required: true, description: '流量 id' },
      finding_id: { type: 'number', description: '发现 id' },
      vuln_id: { type: 'number', description: '漏洞 id' },
      step_id: { type: 'number', description: '攻击步骤 id' },
      asset_id: { type: 'number', description: '资产 id' },
      note: { type: 'string', description: '备注：这条流量证明了什么' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const api = trafficOf(args, exec)
      const id = optNum(args.id)
      if (id === undefined) throw new Error('非法参数 id：需要正整数流量 id')
      const targets = {
        finding_id: optNum(args.finding_id),
        vuln_id: optNum(args.vuln_id),
        step_id: optNum(args.step_id),
        asset_id: optNum(args.asset_id),
        note: optStr(args.note),
      }
      const result = api.bind(id, targets)
      return JSON.stringify({ ok: true, ...result }, null, 2)
    },
  })))

  /* ── 审批门（P3c）────────────────────────────────────────────────────── */

  const interceptOf = (args, exec) => store.intercept(resolveEngagement(store, exec, optStr(args.engagement)))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_intercept_check',
    description: '按审批门规则判定一条 HTTP 请求能不能放行（代理在转发前调用同一套逻辑）。命中 require_approval 会把它挂起为待批并返回 pending id；命中 deny 直接拒绝并留痕；未命中则放行，不产生任何队列记录。仅在 intercept 模式为 on 时生效（force=true 可忽略模式只验规则）。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
      method: { type: 'string', required: true, description: 'HTTP 方法，例如 GET / POST' },
      url: { type: 'string', description: '完整 URL（给出它就不必再给 host/path）' },
      host: { type: 'string', description: '主机名（与 url 二选一）' },
      path: { type: 'string', description: '路径+查询串（与 url 二选一）' },
      risk: { type: 'array', items: { type: 'string' }, description: '请求的风险标签（可选）：规则里写了 risk_tags 时才参与交集判断' },
      force: { type: 'boolean', description: '忽略 intercept 模式（仅校验规则本身，不常用于生产路径）' },
      note: { type: 'string', description: '备注：这条请求在做什么（写进待批记录，给审批人看）' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const api = interceptOf(args, exec)
      const method = optStr(args.method)
      if (method === undefined) throw new Error('非法参数 method：需要 HTTP 方法')
      const verdict = api.check({
        method,
        url: optStr(args.url),
        host: optStr(args.host),
        path: optStr(args.path),
        risk: Array.isArray(args.risk) ? args.risk : [],
        requested_by: exec && exec.agent && exec.agent.session ? String(exec.agent.session) : null,
        note: optStr(args.note),
      }, args.force === true ? { force: true } : {})
      return JSON.stringify({
        ok: true,
        action: verdict.action,
        matched: verdict.matched === true,
        effect: verdict.effect || null,
        rule_id: verdict.pending ? verdict.pending.rule_id : null,
        pending_id: verdict.pending ? verdict.pending.id : null,
        state: verdict.pending ? verdict.pending.state : null,
        consumed: verdict.consumed === true,
        reason: verdict.reason || null,
        hint: verdict.action === 'pass'
          ? '放行：未命中规则或已批准'
          : (verdict.effect === 'deny'
            ? ('被规则拒绝：' + (verdict.reason || ''))
            : ('已挂起待人工批准 #' + (verdict.pending ? verdict.pending.id : '?') + '：面板放行后原样重试')),
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_intercept_decide',
    description: '对一条待批请求做放行/拒绝，并记录谁批的、何时、为什么。理由必填。默认（agentDecide=false）智能体不可自批 —— 该工具会返回 approval_required 提示去面板审批；只有 intercept.json 里 agentDecide=true 时才生效。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
      pending_id: { type: 'number', required: true, description: '待批记录 id（redteam_intercept_check 返回的 pending_id）' },
      decision: { type: 'string', required: true, description: "'allow' 放行 或 'deny' 拒绝" },
      reason: { type: 'string', required: true, description: '为什么放行/拒绝（事后复盘唯一能用的那一项）' },
      ttlSeconds: { type: 'number', description: '放行的有效期（秒）；不给 = 仅本次一次性，之后同一请求会重新排队' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const api = interceptOf(args, exec)
      const config = api.config()
      if (config.agentDecide !== true) {
        return JSON.stringify({
          ok: false,
          error_kind: 'approval_required',
          hint: '智能体不可自批：请在面板「待审批」里放行/拒绝（intercept.json 的 agentDecide=true 才允许本工具生效）',
        }, null, 2)
      }
      const decision = optStr(args.decision)
      const pendingId = optNum(args.pending_id)
      if (pendingId === undefined) throw new Error('非法参数 pending_id：需要正整数待批记录 id')
      const reason = optStr(args.reason)
      if (reason === undefined) throw new Error('非法参数 reason：必填，写清为什么放行/拒绝')
      if (decision !== 'allow' && decision !== 'deny' && decision !== 'approve' && decision !== 'reject') {
        throw new Error("非法参数 decision：只能是 'allow' 或 'deny'")
      }
      const mapped = decision === 'approve' ? 'allow' : (decision === 'reject' ? 'deny' : decision)
      const result = api.decide({
        pending_id: pendingId,
        decision: mapped,
        reason,
        ttlSeconds: optNum(args.ttlSeconds),
      }, { decidedBy: exec && exec.agent && exec.agent.session ? 'agent:' + exec.agent.session : 'agent' })
      return JSON.stringify({
        ok: true,
        pending_id: result.pending.id,
        state: result.state,
        decided_by: result.decided_by,
        decided_at: result.decided_at,
        expires_at: result.expires_at,
        note: result.state === 'approved' ? '已放行：原样重试那条请求即可通过' : '已拒绝：同一请求会被继续挡下',
      }, null, 2)
    },
  })))

  ctx.tools.register(withStructuredErrors(defineTool({
    name: 'redteam_intercept_rule',
    description: '管理本靶标的审批门补充规则（全局规则在 <root>/intercept.json，由人和面板编辑）。action=add 加/改一条（同 rule_id 覆盖），list 列出，remove 删除，enable/disable 开关单条。规则按 HTTP 请求的形状匹配：method（或 *）、host glob、path glob、风险标签。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
      action: { type: 'string', required: true, description: 'add | list | remove | enable | disable' },
      id: { type: 'string', description: '规则标识，例如 r-admin-path（add/remove/enable/disable 必填）' },
      method: { type: 'string', description: "匹配的方法；省略或 '*' 表示任意" },
      host: { type: 'string', description: "主机 glob，例如 *.example.com；省略为 '*'" },
      path: { type: 'string', description: "路径 glob，例如 */admin*；省略为 '*'" },
      risk_tags: { type: 'array', items: { type: 'string' }, description: '风险标签（可作匹配交集，也是面板展示标签）' },
      effect: { type: 'string', description: "'require_approval'（进待批）或 'deny'（直接拒）；默认 require_approval" },
      note: { type: 'string', description: '面板上给人看的一句话' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const api = interceptOf(args, exec)
      const action = optStr(args.action)
      if (action === undefined) throw new Error('非法参数 action：需要 add | list | remove | enable | disable')
      if (action === 'list') {
        const composed = api.rules({ all: true })
        return JSON.stringify({
          ok: true,
          mode: composed.config.mode,
          file: composed.config.path,
          rules: composed.rules.map((rule) => ({
            id: rule.id, source: rule.source, effect: rule.effect, enabled: rule.enabled,
            method: rule.method, host: rule.host, path: rule.path, risk_tags: rule.risk_tags, note: rule.note,
          })),
        }, null, 2)
      }
      const ruleId = optStr(args.id)
      if (ruleId === undefined) throw new Error('非法参数 id：需要规则标识')
      if (action === 'remove') {
        const result = api.deleteRule(ruleId)
        return JSON.stringify({ ok: true, deleted: result.deleted, rule_id: ruleId }, null, 2)
      }
      if (action === 'enable' || action === 'disable') {
        const existing = api.rules({ all: true }).rules.find((rule) => rule.id === ruleId && rule.source === 'db')
        if (existing === undefined) throw new Error('库里没有这条规则：' + ruleId + '（全局文件规则请在面板/文件里改）')
        const result = api.saveRule({
          id: ruleId, method: existing.method, host: existing.host, path: existing.path,
          risk_tags: existing.risk_tags, effect: existing.effect, note: existing.note,
          enabled: action === 'enable',
        })
        return JSON.stringify({ ok: true, created: result.created, rule: result.rule }, null, 2)
      }
      if (action !== 'add') throw new Error('非法参数 action：' + action)
      const result = api.saveRule({
        id: ruleId,
        method: optStr(args.method),
        host: optStr(args.host),
        path: optStr(args.path),
        risk_tags: Array.isArray(args.risk_tags) ? args.risk_tags : [],
        effect: optStr(args.effect),
        note: optStr(args.note),
      })
      return JSON.stringify({ ok: true, created: result.created, rule: result.rule }, null, 2)
    },
  })))
}

export default { name, inject, apply, setDefineToolLoader }
