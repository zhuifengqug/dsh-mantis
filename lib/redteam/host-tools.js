/**
 * 宿主工具定义器（`@deepseek-ai/dsh-tools` 的加载与封装）—— 全插件唯一一处实现。
 *
 * 为什么单独一个文件：`tools.js` 与 `tools-traffic.js` 都要 `defineTool`，而这个加载器
 * 带着一整套宿主路径探测（源码包不在 profile node_modules 树内时静态 import 会失败）。
 * 复制两份 → 探测逻辑必然漂移；只留一份 → 新增工具包直接复用。
 *
 * 惰性加载：模块 import 本身不再抛错（宿主模块缺席的单元测试也能 import），
 * 真正解析发生在第一次 `defineTool(...)`（即插件 apply 时）；失败信息与原先一致。
 */
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

function addCandidate(list, pkg) {
  if (!pkg) return
  const norm = String(pkg).replace(/\\/g, '/')
  if (!list.includes(norm)) list.push(norm)
}

function considerBin(list, bin) {
  if (!bin) return
  let text = String(bin).replace(/\\/g, '/')
  try { text = realpathSync(bin).replace(/\\/g, '/') } catch { /* 解析不了就用原路径 */ }
  const needle = '/node_modules/@deepseek-ai/dsh/'
  const at = text.lastIndexOf(needle)
  if (at >= 0) addCandidate(list, text.slice(0, at + needle.length - 1) + '/package.json')
  const nm = text.lastIndexOf('/node_modules/')
  if (nm >= 0) addCandidate(list, join(text.slice(0, nm), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dir = dirname(text)
  /* npm 全局的 argv 常常是 …/bin/dsh，真正的包在旁边的 lib/node_modules。 */
  addCandidate(list, join(dir, '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  addCandidate(list, join(dir, '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
}

/**
 * 从宿主里找 `@deepseek-ai/dsh-tools` 并取出 `defineTool`。
 * 找不到就抛错——调用方（插件 apply）会把它变成预设行启动失败，**不要静默降级**：
 * 降级会让红队预设里「一个工具都没有」却看起来正常。
 */
export function loadDefineTool() {
  const candidates = []
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-tools')
    const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
    if (typeof fn === 'function') return fn
  } catch { /* 插件自己的 node_modules 里没有，再扫宿主 */ }
  try { considerBin(candidates, process.argv[1]) } catch { /* ignore */ }
  try { considerBin(candidates, process.execPath) } catch { /* ignore */ }
  const homes = [process.env.DSH_HOME, join(homedir(), '.dsh')].filter(Boolean)
  for (const home of homes) {
    addCandidate(candidates, join(home, 'package.json'))
    for (const profile of ['web', 'desktop', 'default']) {
      addCandidate(candidates, join(home, 'profiles', profile, 'package.json'))
      addCandidate(candidates, join(home, 'profiles', profile, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    }
  }
  const resources = process.resourcesPath || ''
  const exeDir = process.execPath ? dirname(process.execPath) : ''
  const desktopRoots = [resources, exeDir ? join(exeDir, 'resources') : '', exeDir].filter(Boolean)
  for (const root of desktopRoots) {
    addCandidate(candidates, join(root, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
    addCandidate(candidates, join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  }
  addCandidate(candidates, join(process.cwd(), 'package.json'))
  addCandidate(candidates, join('D:', 'DeepSeek Harness', 'npm-global', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  for (const pkg of candidates) {
    try {
      if (!pkg || !existsSync(pkg)) continue
      const mod = createRequire(pkg)('@deepseek-ai/dsh-tools')
      const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
      if (typeof fn === 'function') return fn
    } catch { /* try next */ }
  }
  throw new Error('@zhuifengqug/dsh-mantis/redteam: cannot resolve @deepseek-ai/dsh-tools from host')
}

/** 0.2.1：任何 type=object 都必须显式 additionalProperties，否则整份红队预设加载失败。 */
export function sealObjectSchemas(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) {
    for (const item of node) sealObjectSchemas(item)
    return node
  }
  if (node.type === 'object' && node.additionalProperties === undefined) {
    node.additionalProperties = node.properties ? false : true
  }
  if (node.properties) {
    for (const key of Object.keys(node.properties)) sealObjectSchemas(node.properties[key])
  }
  if (node.items) sealObjectSchemas(node.items)
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    sealObjectSchemas(node.additionalProperties)
  }
  return node
}

let loaderOverride = null
let rawCached = null

/** 测试用：直接换成假的 defineTool 实现（不加载宿主模块）。传 null 恢复真实加载。 */
export function setDefineToolLoader(impl) {
  loaderOverride = typeof impl === 'function' ? impl : null
  rawCached = null
}

function rawDefineTool() {
  if (loaderOverride) return loaderOverride
  if (rawCached === null) rawCached = loadDefineTool()
  return rawCached
}

/** 包一层：把 parameters/inputSchema/schema 里的 object 都补上 additionalProperties。 */
export function defineTool(spec) {
  const raw = rawDefineTool()
  // parameters 有两种形态：完整 JSON Schema（type/properties）或「参数名 → 值 schema」映射。
  // 宿主 parameterSchemaSpecToJsonSchema 会在 defineTool 内部立刻编译并校验，
  // 所以必须在调用 raw 之前把映射里每个 type=object 的值 schema 封好，晚了就来不及。
  if (spec && spec.parameters) {
    const p = spec.parameters
    if (p.type || p.properties) {
      sealObjectSchemas(p)
    } else {
      for (const key of Object.keys(p)) sealObjectSchemas(p[key])
    }
  }
  if (spec && spec.params && typeof spec.params === 'object') {
    for (const key of Object.keys(spec.params)) sealObjectSchemas(spec.params[key])
  }
  const tool = raw(spec)
  if (tool && tool.parameters) sealObjectSchemas(tool.parameters)
  if (tool && tool.inputSchema) sealObjectSchemas(tool.inputSchema)
  if (tool && tool.schema) sealObjectSchemas(tool.schema)
  return tool
}

/**
 * 把 store 层抛出的异常统一收敛成结构化的失败返回。
 *
 * 参数类错误（非法值/缺必填）与"找不到对象"分开提示，模型据此决定重试还是放弃；
 * 原始错误文本一律保留在 error 字段里，不吞信息。
 */
export function withStructuredErrors(tool) {
  const inner = tool.execute
  if (typeof inner !== 'function') return tool
  return Object.assign({}, tool, {
    async execute(args, exec) {
      try {
        return await inner(args, exec)
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        // 0.2.2-rc.2 起宿主工具失败带显式错误类型/错误码（error.code）。
        // 有 code 时优先按 code 归类；没有 code 的旧错误仍按原文关键字判。
        const code = (error && (error.code || error.name)) || ''
        const kind = /INVALID_ARGUMENT|INVALID|REQUIRED|BAD_INPUT|NOT_FOUND/i.test(code)
          ? 'bad_input'
          : /UNAVAILABLE|DRAINING|PERSISTENCE|CONTINUATION/i.test(code)
            ? 'unavailable'
            : /非法|invalid|required|不能为空|not found|不存在/i.test(message) ? 'bad_input' : 'failed'
        const hint = kind === 'bad_input'
          ? '这是参数或对象标识的问题：核对参数名与取值（可用对应的 *_list / *_query 工具先看实际 id），修正后重试。'
          : kind === 'unavailable'
            ? '宿主编排层当前不可用或正在交接（错误码见 error_code）：先按原文说明卡点，必要时稍后重试，不要改成别的路径硬绕。'
            : '工具执行失败，错误原文见 error 字段；不要静默跳过，先向用户或指挥者说明卡点。'
        return JSON.stringify({
          ok: false,
          error: message,
          error_kind: kind,
          error_code: code || undefined,
          hint,
        }, null, 2)
      }
    },
  })
}

/** 工具返回值统一渲染成一条 text 块。 */
export const textContent = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export default { loadDefineTool, sealObjectSchemas, defineTool, withStructuredErrors, textContent, setDefineToolLoader }
