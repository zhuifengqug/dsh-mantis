/**
 * Tier-1 兼容吸收（来自 dsh-purge 1.6.95 / 1.6.96，改成对原始 agent.cordis.yml
 * 文本操作，才能作用在我们自愈的那份预设上）。
 *
 * 两处只与 0.2.2-rc.2+ 宿主有关：
 *   1) list_agents：rc.2 把 provider 并入 @deepseek-ai/dsh-tool-subagent-control 主入口，
 *      旧的 `.../list-agents` 子路径失效。只有当子路径确认失效时才摘掉旧行；
 *      无法确认时保留，让宿主报自己的错——最理想是不静默删工具。
 *   2) tool-executor：预设若挂了 @deepseek-ai/dsh-tools 却没有任何
 *      `@deepseek-ai/dsh-tool-executor-*` 行，rc.2 会以 TOOL_EXECUTOR_UNAVAILABLE
 *      整批拒绝；此时同作用域补一个 native 执行器。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const CONTROL = '@deepseek-ai/dsh-tool-subagent-control'
const NATIVE_EXECUTOR = '@deepseek-ai/dsh-tool-executor-native'

/**
 * createRequire 候选根：桌面宿主跑在 resources/app.asar（或 app）下，
 * profile 的 node_modules 未必看得到宿主自带包。这里只做只读定位。
 */
function hostRequireRoots(anchor) {
  const roots = []
  if (anchor) roots.push(anchor)
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  if (resources) {
    for (const rel of [
      ['app.asar', 'dsh', 'node_modules'],
      ['app.asar.unpacked', 'dsh', 'node_modules'],
      ['dsh', 'node_modules'],
      ['app', 'dsh', 'node_modules'],
      ['app', 'node_modules'],
    ]) {
      roots.push(path.join(resources, ...rel))
    }
  }
  return roots
}

function resolveHostRequire(anchor, target, subpath = '') {
  for (const root of hostRequireRoots(anchor)) {
    let req
    try {
      req = createRequire(path.join(root, 'package.json'))
    } catch {
      continue
    }
    try {
      req.resolve(target + subpath)
      return req
    } catch {
      // 下一个根
    }
  }
  return null
}

/**
 * 探测 list_agents 能力。
 * @param {string} [anchor]
 * @returns {'separate'|'merged'|'unknown'}
 *   separate = 旧宿主，`/list-agents` 子路径仍可导出 → 保留旧行
 *   merged   = 子路径没了，但主入口仍注册 list_agents（rc.2+）→ 摘旧行
 *   unknown  = 读不到宿主包树 → 交回调用方按 dshTarget 默认处理
 */
export function detectListAgentsCapability(anchor) {
  if (resolveHostRequire(anchor, CONTROL, '/list-agents')) return 'separate'
  const main = resolveHostRequire(anchor, CONTROL)
  if (!main) return 'unknown'
  let entry
  try {
    entry = main.resolve(CONTROL)
  } catch {
    return 'unknown'
  }
  let source
  try {
    source = fs.readFileSync(entry, 'utf8')
  } catch {
    return 'unknown'
  }
  return /registerListAgents|list_agents/.test(source) ? 'merged' : 'unknown'
}

/** 删除 `- id: tool-subagent-list-agents` 这整个列表项（缩进到下一个列表项为止）。 */
function removeListAgentsRow(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let changed = false
  let skipping = false
  for (const line of lines) {
    if (/^\s*-\s+id:\s*tool-subagent-list-agents\s*$/.test(line)) {
      skipping = true
      changed = true
      continue
    }
    if (skipping) {
      if (/^\s*-\s+(id|group):/.test(line)) skipping = false
      else continue
    }
    out.push(line)
  }
  return { text: out.join('\n'), changed }
}

/**
 * 依据能力处理文本里的旧 list_agents 行。
 * 只有明确 separate 才保留；merged / unknown 都摘掉（我们的 dshTarget 固定 0.2.2-rc.3，
 * 已知子路径已并入包根；unknown 时按已知目标处理，避免预设注册失败）。
 */
export function adaptListAgentsText(text, capability) {
  const src = String(text || '')
  if (capability === 'separate') return { text: src, changed: false }
  return removeListAgentsRow(src)
}

/** 宿主是否随包提供 native 执行器。 */
export function hasNativeExecutor(anchor) {
  return Boolean(resolveHostRequire(anchor, NATIVE_EXECUTOR))
}

/**
 * 预设声明了 @deepseek-ai/dsh-tools 却没有执行器行时，补一个 native 执行器。
 * @param {string} text
 * @param {boolean} available 宿主是否提供 native 执行器
 */
export function ensureToolExecutorText(text, available) {
  const src = String(text || '')
  if (!available) return { text: src, changed: false }
  if (!/name:\s*"?@deepseek-ai\/dsh-tools"?\s*$/m.test(src)) return { text: src, changed: false }
  if (/@deepseek-ai\/dsh-tool-executor-/.test(src)) return { text: src, changed: false }
  const nl = src.includes('\r\n') ? '\r\n' : '\n'
  const m = /^([ \t]*)-[ \t]+id:/m.exec(src)
  const indent = m ? m[1] : '      '
  const row = `${nl}${indent}- id: tool-executor-native${nl}${indent}  name: "${NATIVE_EXECUTOR}"`
  return { text: src.replace(/\s*$/, '') + row + nl, changed: true }
}

/**
 * 良神（liangshen）预设的存在性证据，只看传入的 home，不跨 profile 猜。
 *
 * 补丁表里 #26/#28 这类"预设保留注入"的锚点落在可选第三方预设里，没装时
 * 状态是 na。na 只说明"打不上"，看不出是"没装"还是"装了但锚点漂了"，
 * 所以这里单独给一份 present / absent / unknown 的证据。
 */
export function liangshenRoots(home, reader = fs) {
  const roots = [path.join(home, ".agent-presets", "liangshen")];
  let profiles = [];
  try {
    profiles = reader.readdirSync(path.join(home, "profiles"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const name of profiles) {
    const profile = path.join(home, "profiles", name);
    roots.push(
      path.join(profile, "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen"),
      path.join(profile, ".dsh-module-fallback", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen"),
      path.join(profile, "node_modules", "@linxin666", "dsh-web-all", "node_modules", "@linxin666", "dsh-liangshen", "presets", "liangshen"),
    );
  }
  return roots;
}

export function liangshenPresence(home, reader = fs) {
  const exists = (p) => {
    try { reader.lstatSync(p); return true; }
    catch (e) { if (e.code === "ENOENT") return false; throw e; }
  };
  try {
    /** 目录、包目录、甚至坏掉的软链都算"装过"。 */
    for (const root of liangshenRoots(home, reader)) {
      if (exists(root)) return "present";
      if (root.includes("node_modules") && exists(path.dirname(path.dirname(root)))) return "present";
    }
    let profiles = [];
    try { profiles = reader.readdirSync(path.join(home, "profiles")); }
    catch (e) { if (e.code !== "ENOENT") throw e; }
    for (const name of profiles) {
      let data;
      try { data = JSON.parse(reader.readFileSync(path.join(home, "profiles", name, "package.json"), "utf8")); }
      catch (e) { if (e.code === "ENOENT") continue; throw e; }
      for (const group of ["dependencies", "devDependencies", "optionalDependencies"]) {
        if (Object.hasOwn(data[group] || {}, "@linxin666/dsh-liangshen")) return "present";
      }
    }
    return "absent";
  } catch {
    return "unknown";
  }
}
