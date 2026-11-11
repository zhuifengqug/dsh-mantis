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
    description: '检索本靶标录到的 HTTP 流量（MITM 代理落库的原始请求/响应）。可按关键字 q（url/host/path/请求头/响应头模糊匹配）、host、url、method、status、vuln_id、finding_id、时间范围（since/until，ISO 时间或日期）过滤。调用前自动把代理 spool 里的新流量入库。只返回摘要行，具体报文用 redteam_traffic_get / redteam_traffic_blob。',
    parameters: {
      engagement: { type: 'string', description: '靶标 id 或单位名称；省略则用本会话已绑定的靶标' },
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
      const result = api.search(filters)
      return JSON.stringify({
        ok: true,
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
}

export default { name, inject, apply, setDefineToolLoader }
