/**
 * 插件级设置（零依赖）：目前只有一项 —— **并发执行智能体上限**。
 *
 * 为什么不用环境变量：`REDTEAM_MAX_AGENTS` 只能启动前设，改完得重启 dsh web；
 * 而"同时派几个执行智能体"是使用中最常调的一项，面板上应该能直接改。
 * 所以落一份 JSON 到事实库根目录：`$DSH_HOME/redteam/settings.json`。
 *
 * 生效顺序：settings.json → 环境变量 `REDTEAM_MAX_AGENTS` → 默认 3。
 * 工具侧（redteam_agent_slot 闸门）与面板侧（「智能体」页）读的是同一份，避免两处口径漂移。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from './atomic-write.js'

/** 默认并发上限（用户口径：整个项目默认 3 个执行智能体）。 */
export const DEFAULT_MAX_AGENTS = 3

/** 硬上限：再多也不会更快 —— 同一个 API Key 的并发/速率限制会先到，反而扰动测试。 */
export const MAX_AGENTS_LIMIT = 10

/** 设置文件路径（跟事实库同一个根，随事实库一起备份/迁移）。 */
export function settingsPathOf(root) {
  return join(String(root || '.'), 'settings.json')
}

/** 读全部设置（读不到/坏了都当空对象，绝不抛）。 */
export function readSettings(root) {
  try {
    if (!existsSync(settingsPathOf(root))) return {}
    const parsed = JSON.parse(readFileSync(settingsPathOf(root), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** 合并写入若干项设置，返回写入后的完整设置。 */
export function writeSettings(root, patch) {
  const next = Object.assign({}, readSettings(root), patch)
  mkdirSync(String(root || '.'), { recursive: true })
  atomicWriteFileSync(settingsPathOf(root), JSON.stringify(next, null, 2) + '\n')
  return next
}

/** 把任意输入收敛到 [1, MAX_AGENTS_LIMIT] 的整数。 */
export function clampMaxAgents(value) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_MAX_AGENTS
  return Math.min(Math.max(n, 1), MAX_AGENTS_LIMIT)
}

/**
 * 当前生效的并发上限。
 * @param root - 事实库根目录（`ctx.redteam.root`）。
 * @param env - 环境变量表（便于测试注入）。
 * @returns 生效的整数上限。
 */
export function maxAgentsOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return clampMaxAgents(fromFile)
  const fromEnv = Number(env && env.REDTEAM_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return clampMaxAgents(fromEnv)
  return DEFAULT_MAX_AGENTS
}

/** 保存并发上限，返回实际生效值。 */
export function saveMaxAgents(root, value) {
  const applied = clampMaxAgents(value)
  writeSettings(root, { maxAgents: applied })
  return applied
}

/** 当前设置是从哪来的（面板上要如实说明，避免"我改了没生效"的错觉）。 */
export function maxAgentsSourceOf(root, env = process.env) {
  const fromFile = Number(readSettings(root).maxAgents)
  if (Number.isFinite(fromFile) && fromFile > 0) return 'settings'
  const fromEnv = Number(env && env.REDTEAM_MAX_AGENTS)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return 'env'
  return 'default'
}

/* ─── 探索引擎开关（ARTEX P2，docs/artex/artex-p2p4-design.md §1.6.3）───────
   commander = 指挥者自己编排（默认）；frontier = 由 wake 回声驱动的 frontier 引擎。
   与 maxAgents 共用同一份 settings.json，读不到/坏了都回落默认值，绝不抛。       */

export const DEFAULT_ENGINE = 'commander'
export const ENGINES = ['commander', 'frontier']

/** 当前生效的引擎；settings.redteam_engine 优先，env 次之，非法值回落默认。 */
export function engineOf(root, env = process.env) {
  const fromFile = readSettings(root).redteam_engine
  if (ENGINES.includes(fromFile)) return fromFile
  const fromEnv = env && env.REDTEAM_ENGINE
  if (ENGINES.includes(fromEnv)) return fromEnv
  return DEFAULT_ENGINE
}

/** 保存引擎选择，返回实际写入的值；非 commander|frontier 一律拒绝。 */
export function saveEngine(root, value) {
  if (!ENGINES.includes(value)) {
    throw new Error('引擎取值非法: ' + value + '（允许: ' + ENGINES.join('|') + '）')
  }
  writeSettings(root, { redteam_engine: value })
  return value
}

/** 引擎设置来源（面板/工具如实说明，避免「改了没生效」的错觉）。 */
export function engineSourceOf(root, env = process.env) {
  if (ENGINES.includes(readSettings(root).redteam_engine)) return 'settings'
  if (ENGINES.includes(env && env.REDTEAM_ENGINE)) return 'env'
  return 'default'
}

/* ==== ARTEX P4 · 通知配置（设计 §3.3）====
   只落本机 settings.json；默认 enabled:false 且 urls 为空 —— 未配置即不发任何请求。
   URL 只能由面板/人工写入这里，智能体工具不接受任意 url 入参（封 SSRF 面）。
   这里不保存任何凭据：出站通知的 Authorization/Cookie 之类只能由面板另配，
   工具层一律脱敏，不落进 settings。 */

export const NOTIFY_EVENTS = Object.freeze([
  'score_hit', 'retest_done', 'explore_prove', 'approval_pending', 'report_built',
])

export const DEFAULT_NOTIFY = Object.freeze({
  enabled: false,
  urls: Object.freeze([]),
  events: NOTIFY_EVENTS,
})

/** 读取通知配置，永远返回规整后的对象；文件缺失/损坏一律回落默认值，绝不抛。 */
export function notifyConfigOf(root) {
  const raw = readSettings(root).notify
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const urls = Array.isArray(o.urls) ? o.urls.map((u) => String(u).trim()).filter(Boolean) : []
  const events = Array.isArray(o.events) && o.events.length
    ? o.events.map(String).filter((e) => NOTIFY_EVENTS.includes(e))
    : [...NOTIFY_EVENTS]
  return { enabled: o.enabled === true, urls, events }
}

/** 面板保存通知配置：只收 enabled / urls / events，拒绝写入其他键（不落凭据）。 */
export function saveNotifyConfig(root, patch = {}) {
  const p = patch && typeof patch === 'object' ? patch : {}
  const next = {
    enabled: p.enabled === true,
    urls: Array.isArray(p.urls) ? p.urls.map((u) => String(u).trim()).filter(Boolean) : [],
    events: Array.isArray(p.events) && p.events.length
      ? p.events.map(String).filter((e) => NOTIFY_EVENTS.includes(e))
      : [...NOTIFY_EVENTS],
  }
  writeSettings(root, { notify: next })
  return next
}
