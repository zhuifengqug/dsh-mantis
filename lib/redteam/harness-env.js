/**
 * 录制期的子进程环境注入（方案 A）。
 *
 * 目标：代理一开，子智能体在 bash 里跑的 curl / python / git / node 就自动走本机 MITM、
 * 并且信任插件自签 CA —— 用户不用再手动导出证书、也不用改任何工具配置。
 *
 * 做法：宿主进程的 process.env 是每个子进程的基底（dsh-subprocess 会把它脱敏后复制给
 * 子进程），所以代理启动时把代理与 CA 相关变量写进去，停止时原样还原。只动这几个键，
 * 且 NO_PROXY 永远包含回环地址，避免把本机服务也绕进代理。
 *
 * 边界：
 *   · 只影响代理启动之后新拉起的子进程；已经在跑的子进程不会改。
 *   · 宿主自身的 LLM 出站在进程内，不走这些变量；不受影响。
 *   · 同一台机器上其它应用完全不受影响（不写系统代理、不写信任库）。
 */
import { existsSync } from 'node:fs'

/** 代理变量（大小写两套：curl/git 认小写，部分库只认大写）。 */
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']

/** CA 变量：覆盖 node / curl / python-requests / openssl / git 几条常见链路。 */
const CA_KEYS = ['NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'SSL_CERT_FILE', 'GIT_SSL_CAINFO']

const EXTRA_KEYS = ['NODE_USE_ENV_PROXY', 'NO_PROXY', 'no_proxy']

/** 永远直连的主机：本机回环。 */
const LOOPBACK = ['localhost', '127.0.0.1', '::1']

/** 上一次 apply 前的原值；null = 当前没有注入。 */
let saved = null

/**
 * 把代理与 CA 写进 process.env。
 * @param options - `{ proxyUrl, caPath }`；proxyUrl 形如 `http://127.0.0.1:18081`。
 * @returns `{ proxyUrl, caPath }` 实际写入的值。
 */
export function applyProxyEnv(options = {}) {
  const proxyUrl = String(options.proxyUrl || '').trim()
  if (!proxyUrl) throw new Error('applyProxyEnv 需要 proxyUrl')
  if (saved === null) {
    saved = {}
    for (const key of [...PROXY_KEYS, ...CA_KEYS, ...EXTRA_KEYS]) saved[key] = process.env[key]
  }
  for (const key of PROXY_KEYS) process.env[key] = proxyUrl
  process.env.NODE_USE_ENV_PROXY = '1'

  const caPath = options.caPath && existsSync(String(options.caPath)) ? String(options.caPath) : null
  if (caPath) for (const key of CA_KEYS) process.env[key] = caPath

  const bypass = new Set(
    String(process.env.NO_PROXY || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  for (const host of LOOPBACK) bypass.add(host)
  process.env.NO_PROXY = [...bypass].join(',')
  process.env.no_proxy = process.env.NO_PROXY
  return { proxyUrl, caPath }
}

/**
 * 还原 apply 之前的环境。幂等：没有注入时是空操作。
 * @returns 是否真的还原了。
 */
export function restoreProxyEnv() {
  if (saved === null) return false
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved = null
  return true
}

/** 当前是否处于注入状态（测试/面板提示用）。 */
export function proxyEnvActive() {
  return saved !== null
}

export default { applyProxyEnv, restoreProxyEnv, proxyEnvActive }
