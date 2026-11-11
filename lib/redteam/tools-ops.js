/* ============================================================================
 * ARTEX P4 · 报告/复测/通知/归档/任务模板/调度 工具集（设计 §3 / §4）
 *
 * 定位：把 ops.js 的基础能力暴露成模型可调用的工具。11 个工具全部由
 * tools.js 的 apply() 末尾经 registerOpsTools() 注册，工具定义器与错误收敛
 * **直接复用 host-tools.js**（defineTool / withStructuredErrors / textContent，
 * 不复制一份）；resolveEngagement / bindingKeyOf 由 helpers 注入，避免
 * tools.js ↔ tools-ops.js 循环依赖。
 *
 * 约束（设计 §3 + 任务验收）：
 *   - 全部走本机 SQLite；通知渠道严格占位，绝不发外网、绝不写真实凭据；
 *   - 不新增外部依赖；不对生产/外部系统发起真实写入；
 *   - 归档写保护：写类工具经 archivedGuard 前置检查；读工具、报告生成、
 *     复测结论不受影响（§3.4）。
 * ========================================================================== */

import { defineTool, withStructuredErrors, textContent } from './host-tools.js'
import * as ops from './ops.js'
import { notifyConfigOf, NOTIFY_EVENTS } from './settings.js'

/** 本工具集注册的全部名字（顺序即注册顺序，供数量自检与测试引用）。 */
export const OPS_TOOL_NAMES = Object.freeze([
  'redteam_report_build',
  'redteam_retest_request',
  'redteam_retest_list',
  'redteam_retest_conclude',
  'redteam_notify_send',
  'redteam_notify_test',
  'redteam_template_list',
  'redteam_template_apply',
  'redteam_template_save',
  'redteam_schedule_add',
  'redteam_schedule_list',
])

const ENGAGEMENT_PARAM = { type: 'string', description: '靶标 ID（省略时按会话绑定 / 唯一靶标解析）' }
const LIMIT_PARAM = { type: 'number', description: '返回条数上限，1..500 的整数' }

/* ---------- 入参校验：错误文本含「非法 / 不能为空 / 不存在」→ bad_input ---------- */

function needStr(v, label) {
  if (v == null || String(v).trim() === '') throw new Error(label + ' 不能为空')
  return String(v)
}
function needId(v, label) {
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) throw new Error(label + ' 非法: ' + v)
  return n
}
function needEnum(v, allowed, label) {
  const s = String(v ?? '')
  if (!allowed.includes(s)) throw new Error(label + ' 非法: ' + (v ?? '') + '（允许: ' + allowed.join('|') + '）')
  return s
}
function optLimit(v) {
  if (v == null || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 500) {
    throw new Error('limit 非法: ' + v + '（应为 1..500 的整数）')
  }
  return n
}

/* ---------- 各工具的 run：返回附加到 {ok:true, engagement} 上的字段 ---------- */

const runReportBuild = (c) => {
  const kind = needEnum(c.args.kind, ops.REPORT_KINDS, 'kind')
  const findingId = c.args.finding_id != null && c.args.finding_id !== '' ? needId(c.args.finding_id, 'finding_id') : null
  const r = ops.reportBuild(c.db, { kind, findingId, reportsDir: c.reportsDir, createdBy: c.owner })
  return { path: r.path, sections: r.sections, report_id: r.id, kind }
}

const runRetestRequest = (c) => {
  const reason = needStr(c.args.reason, 'reason')
  const r = ops.retestRequest(c.db, {
    vulnIds: c.args.vuln_ids, all: c.args.all === true,
    reason, requestedBy: c.owner,
  })
  return { retest_ids: r.retest_ids, requested: r.requested }
}

const runRetestList = (c) => {
  const vulnId = c.args.vuln_id != null && c.args.vuln_id !== '' ? needId(c.args.vuln_id, 'vuln_id') : null
  const items = ops.retestList(c.db, { status: c.args.status, vulnId, limit: optLimit(c.args.limit) ?? 100 })
  return { items }
}

const runRetestConclude = (c) => {
  const id = needId(c.args.id, 'id')
  const conclusion = needEnum(c.args.conclusion, ops.CONCLUSIONS, 'conclusion')
  const r = ops.retestConclude(c.db, {
    id, conclusion, evidenceRef: c.args.evidence_ref, note: c.args.note,
  })
  return { retest: r.retest, vuln_status: r.vuln_status }
}

const runNotifySend = (c) => {
  const event = needStr(c.args.event, 'event')
  const text = needStr(c.args.text, 'text')
  const cfg = notifyConfigOf(c.root)
  /* 未配置 urls 时返回 {ok:false,...} —— 在通用包装里覆盖外层 ok:true（结构化失败）。 */
  return ops.notifySend(cfg, { event, text, extra: c.args.extra })
}

const runNotifyTest = (c) => {
  const cfg = notifyConfigOf(c.root)
  const r = ops.notifySend(cfg, {
    event: 'report_built',
    text: '连通性测试（占位，未发起任何真实请求）',
    extra: { probe: true, authorization: 'should-be-redacted', cookie: 'should-be-redacted' },
  })
  return {
    stub: r.stub, requests_made: r.requests_made, delivered: r.delivered,
    config: { enabled: cfg.enabled, urls: cfg.urls.length, events: cfg.events },
  }
}

const runTemplateList = (c) => {
  const lim = optLimit(c.args.limit) ?? 100
  const items = ops.templateList({ root: c.root }).slice(0, lim)
  return { items }
}

const runTemplateApply = (c) => {
  const name = needStr(c.args.template, 'template')
  const spec = ops.templateResolve({ root: c.root, name })
  return ops.templateApply(c.db, { spec, target: c.id, force: c.args.force === true })
}

const runTemplateSave = (c) => {
  const name = needStr(c.args.name, 'name')
  let spec
  if (c.args.goal_title != null && String(c.args.goal_title).trim() !== '') {
    spec = {
      name, description: c.args.description || '',
      goal: { title: String(c.args.goal_title), body: c.args.goal_body || '' },
      constraints: Array.isArray(c.args.constraints) ? c.args.constraints : [],
      score_hints: Array.isArray(c.args.score_hints) ? c.args.score_hints : [],
      roles: Array.isArray(c.args.roles) ? c.args.roles : [],
    }
  } else {
    spec = ops.templateFromExploration(c.db, { name, description: c.args.description, target: c.id })
  }
  const r = ops.templateSave({ root: c.root, ...spec })
  return { path: r.path, name: r.name }
}

const runScheduleAdd = (c) => {
  const kind = needEnum(c.args.kind, ops.SCHEDULE_KINDS, 'kind')
  const runAt = needStr(c.args.run_at, 'run_at')
  return ops.scheduleAdd(c.db, {
    kind, runAt, params: c.args.params, note: c.args.note, createdBy: c.owner,
  })
}

const runScheduleList = (c) => {
  const items = ops.scheduleList(c.db, { status: c.args.status, limit: optLimit(c.args.limit) ?? 100 })
  return { items }
}

/* ---------- 工具规格（guarded = 归档后写保护；standalone = 不解析 engagement） ---------- */

const SPECS = [
  { name: 'redteam_report_build', description: '生成结构化漏洞报告（score | finding | coverage | final），只写本机报告文件与 report_run 一行，不改任何业务数据。', params: { kind: { type: 'string', description: 'score | finding | coverage | final（必填）' }, finding_id: { type: 'number', description: 'finding 节点 ID（kind=finding 时可选）' } }, run: runReportBuild },
  { name: 'redteam_retest_request', description: '为漏洞登记复测（vuln_ids 或 all:true），只建 pending 复测行，不新建漏洞、不改计分。', params: { vuln_ids: { type: 'array', description: '漏洞 ID 数组' }, all: { type: 'boolean', description: '为全部漏洞登记复测' }, reason: { type: 'string', description: '复测原因（必填）' } }, run: runRetestRequest, guarded: true },
  { name: 'redteam_retest_list', description: '列出复测记录，可按 status / vuln_id 过滤。', params: { status: { type: 'string', description: 'pending | running | done' }, vuln_id: { type: 'number', description: '漏洞 ID' } }, run: runRetestList },
  { name: 'redteam_retest_conclude', description: '复测结论三态：fixed → vuln.status=fixed；reproduced → open；inconclusive → 不改状态。不产生新分数。', params: { id: { type: 'number', description: '复测记录 ID（必填）' }, conclusion: { type: 'string', description: 'reproduced | fixed | inconclusive（必填）' }, evidence_ref: { type: 'string', description: '证据引用' }, note: { type: 'string', description: '备注' } }, run: runRetestConclude },
  { name: 'redteam_notify_send', description: '占位通知：只读 settings.notify 配置，URL 由面板/人工配置，智能体不能临时指定；脱敏凭据字段、正文截断 4KB，绝不发起真实网络请求。', params: { event: { type: 'string', description: '事件名（须在 notify.events 内，必填）' }, text: { type: 'string', description: '通知正文（必填，超出 4KB 截断）' }, extra: { type: 'object', description: '附加字段（凭据类键自动脱敏）' } }, run: runNotifySend },
  { name: 'redteam_notify_test', description: '通知连通性自检（占位）：返回配置摘要与脱敏探针，requests_made 恒为 0，不发送任何请求。', params: {}, run: runNotifyTest, standalone: true },
  { name: 'redteam_template_list', description: '列出任务模板；同名时用户目录 <root>/templates/ 遮蔽随包内置模板。', params: {}, run: runTemplateList, standalone: true },
  { name: 'redteam_template_apply', description: '把模板的 goal / 约束 / 计分提示落到当前探索；纯数据、不建资产、不注入提示词；force:false 默认不覆盖已有 goal/约束。', params: { template: { type: 'string', description: '模板名（必填）' }, force: { type: 'boolean', description: '覆盖已有 goal 并无条件追加约束/提示' } }, run: runTemplateApply, guarded: true },
  { name: 'redteam_template_save', description: '存一份用户模板到 <root>/templates/<name>.json；不带 goal_title 时把当前探索的 goal/约束固化下来。', params: { name: { type: 'string', description: '模板名（必填，字母数字下划线连字符）' }, description: { type: 'string', description: '模板说明' }, goal_title: { type: 'string', description: '目标标题（给了则显式构造模板）' }, goal_body: { type: 'string', description: '目标正文' }, constraints: { type: 'array', description: '约束数组 [{kind,text}]' }, score_hints: { type: 'array', description: '计分提示数组 [{stage,point,hint}]' }, roles: { type: 'array', description: '角色数组' } }, run: runTemplateSave, guarded: true },
  { name: 'redteam_schedule_add', description: '登记一行「到点提醒」（只记录，不自动执行）；到期条数并入 wake 的 scheduled_due。', params: { kind: { type: 'string', description: 'retest | report | notify（必填）' }, run_at: { type: 'string', description: '到期时间 ISO（必填）' }, params: { type: 'object', description: '执行参数（纯数据）' }, note: { type: 'string', description: '备注' } }, run: runScheduleAdd, guarded: true },
  { name: 'redteam_schedule_list', description: '列出调度记录，可按 status 过滤。', params: { status: { type: 'string', description: 'due | done | skipped | cancelled' } }, run: runScheduleList },
]

if (SPECS.length !== OPS_TOOL_NAMES.length || SPECS.some((s, i) => s.name !== OPS_TOOL_NAMES[i])) {
  throw new Error('tools-ops.js: OPS_TOOL_NAMES 与 SPECS 不一致')
}

/**
 * 把 P4 工具注册到 ctx.tools。由 tools.js 的 apply() 末尾调用。
 *
 * @param {object} ctx     Cordis 上下文（需 ctx.tools.register）
 * @param {object} store   RedteamStore 实例
 * @param {object} helpers { resolveEngagement, bindingKeyOf, db, root,
 *   reportsDir, archivedGuard }
 */
export function registerOpsTools(ctx, store, helpers) {
  const { resolveEngagement, bindingKeyOf, db, root, reportsDir, archivedGuard } = helpers

  for (const spec of SPECS) {
    const parameters = { limit: LIMIT_PARAM, ...spec.params }
    if (!spec.standalone) parameters.engagement = ENGAGEMENT_PARAM

    const execute = async (args, exec) => {
      args = args || {}
      optLimit(args.limit) // 统一的可触发 bad_input 的入参校验
      let id = null
      const c = {
        args, exec, root: store && store.root,
        owner: 'engine', ownerSession: null, db: null, reportsDir: null,
      }
      if (!spec.standalone) {
        id = resolveEngagement(store, exec, args.engagement)
        c.id = id
        c.db = db(id)
        c.reportsDir = reportsDir(id)
        if (spec.guarded && typeof archivedGuard === 'function') {
          const guard = archivedGuard(id)
          if (guard) return JSON.stringify(guard, null, 2)
        }
        const binding = (typeof bindingKeyOf === 'function' ? bindingKeyOf(exec) : {}) || {}
        c.owner = binding.rootId ?? binding.sessionId ?? 'engine'
        c.ownerSession = binding.sessionId ?? null
      }
      const data = await spec.run(c)
      return JSON.stringify({ ok: true, ...(id ? { engagement: id } : {}), ...data }, null, 2)
    }

    ctx.tools.register(withStructuredErrors(defineTool({
      name: spec.name,
      description: spec.description,
      parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
      execute,
    })))
  }
  return OPS_TOOL_NAMES.length
}
