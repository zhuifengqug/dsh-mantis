/**
 * 自签 CA（P3a）—— MITM 录制代理的证书源。
 *
 * 边界（写死，不得偏离）：
 *   · 只在事实库侧生成根证书与叶证书，证书落 `<toolkit>/ca/`（默认 `$DSH_HOME/redteam/toolkit/ca`）；
 *   · **绝不自动写入系统/浏览器信任库**：`guideText()` 只返回文本，不 spawn 任何安装命令；
 *     `exportCa()` 只把 ca.crt 拷到用户指定路径。装不装、怎么装，由用户自己执行。
 *
 * 双路径：
 *   1) 系统有 `openssl` → 走 openssl（与平台工具链一致，用户拿到的文件别人也认）；
 *   2) 没有 openssl（Windows 上常见）→ 纯 `node:crypto` + 本文件内的极简 DER 编码器现签。
 * 两条路径产出同参数的证书，都可以被 `X509Certificate` 解析与验签。
 *
 * 零外部依赖：只用 node: 内置模块。
 */
import {
  createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate,
} from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { loadPlatformConfig, toolkitDirOf } from './platform-config.js'

/** 根证书默认有效期（天）。 */
export const CA_DAYS = 3650
/** 叶证书默认有效期（天）：短一些，泄露影响小。 */
export const LEAF_DAYS = 825
/** 根证书主体 CN。 */
export const CA_COMMON_NAME = 'ChongPo MITM CA'

/* ------------------------------------------------------------------ DER 编码 */

const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8: 0x0c,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
  /* 上下文标签：显式 [0]/[3]，隐式 dNSName [2] / iPAddress [7] */
  CTX0: 0xa0,
  CTX3: 0xa3,
  CTX_DNS: 0x82,
  CTX_IP: 0x87,
}

const OID = {
  CN: '2.5.4.3',
  O: '2.5.4.10',
  OU: '2.5.4.11',
  sha256WithRSA: '1.2.840.113549.1.1.11',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  extendedKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
}

function derLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function seqOf(parts) {
  return tlv(TAG.SEQUENCE, Buffer.concat(parts))
}

function setOf(parts) {
  return tlv(TAG.SET, Buffer.concat(parts))
}

function integerOf(buffer) {
  return tlv(TAG.INTEGER, buffer)
}

function oidOf(dotted) {
  const parts = String(dotted).split('.').map((x) => Number(x))
  if (parts.length < 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error('非法 OID： ' + dotted)
  }
  const out = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    const stack = []
    let value = part
    do {
      stack.unshift(value & 0x7f)
      value = Math.floor(value / 128)
    } while (value > 0)
    for (let i = 0; i < stack.length - 1; i += 1) stack[i] |= 0x80
    out.push(...stack)
  }
  return tlv(TAG.OID, Buffer.from(out))
}

function utf8Of(text) {
  return tlv(TAG.UTF8, Buffer.from(String(text), 'utf8'))
}

/** 时间：1950–2049 用 UTCTime，之外用 GeneralizedTime（RFC 5280）。 */
function timeOf(date) {
  const year = date.getUTCFullYear()
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const rest = pad(date.getUTCMonth() + 1) + pad(date.getUTCDate())
    + pad(date.getUTCHours()) + pad(date.getUTCMinutes()) + pad(date.getUTCSeconds()) + 'Z'
  if (year >= 1950 && year < 2050) return tlv(TAG.UTC_TIME, Buffer.from(pad(year % 100) + rest, 'ascii'))
  return tlv(TAG.GENERALIZED_TIME, Buffer.from(String(year) + rest, 'ascii'))
}

/** Name ::= RDNSequence，这里只用单值 RDN：CN 与 O。 */
function nameOf(commonName, organization) {
  const rdns = [setOf([seqOf([oidOf(OID.CN), utf8Of(commonName)])])]
  if (organization) rdns.push(setOf([seqOf([oidOf(OID.O), utf8Of(organization)])]))
  return seqOf(rdns)
}

function algorithmOf() {
  return seqOf([oidOf(OID.sha256WithRSA), tlv(TAG.NULL, Buffer.alloc(0))])
}

function extensionOf(oid, value, critical = false) {
  const parts = [oidOf(oid)]
  if (critical) parts.push(tlv(TAG.BOOLEAN, Buffer.from([0xff])))
  parts.push(tlv(TAG.OCTET_STRING, value))
  return seqOf(parts)
}

/** keyUsage 位串：bit0=digitalSignature … bit5=keyCertSign、bit6=cRLSign。 */
function keyUsageOf(bits) {
  let used = 0
  for (const bit of bits) used = Math.max(used, bit + 1)
  const octets = Math.ceil(used / 8)
  const buf = Buffer.alloc(octets)
  for (const bit of bits) buf[Math.floor(bit / 8)] |= 0x80 >> (bit % 8)
  return tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([octets * 8 - used]), buf]))
}

function sanOf(host) {
  const value = String(host || '').trim()
  if (value === '') throw new Error('签发叶证书需要 host')
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(value)
  if (isIp) {
    const octets = value.split('.').map((x) => Number(x))
    if (octets.some((n) => n > 255)) throw new Error('非法 IPv4： ' + value)
    return seqOf([tlv(TAG.CTX_IP, Buffer.from(octets))])
  }
  return seqOf([tlv(TAG.CTX_DNS, Buffer.from(value, 'ascii'))])
}

/** 从 PKCS#8 PEM 里取出私钥对象（Node 的 createPrivateKey 走 crypto 内部解码）。 */
function pemEncode(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').trim()
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`
}

/**
 * 组一张 X.509 v3 证书并签名。
 * @returns {{ pem:string, der:Buffer, serial:string, not_before:string, not_after:string }}
 */
function buildCertificate(options) {
  const {
    subjectCn, subjectO, issuerCn, issuerO, spkiDer, privateKey,
    days, isCa, san, notBefore,
  } = options
  const from = notBefore instanceof Date ? notBefore : new Date()
  const to = new Date(from.getTime() + Math.round(days * 86400000))

  /* 序列号：16 字节随机，最高位清零保证正整数 */
  const serialBuf = randomBytes(16)
  serialBuf[0] &= 0x7f
  if (serialBuf[0] === 0) serialBuf[0] = 0x01

  const extensions = []
  if (isCa) {
    extensions.push(extensionOf(OID.basicConstraints, seqOf([tlv(TAG.BOOLEAN, Buffer.from([0xff]))]), true))
    extensions.push(extensionOf(OID.keyUsage, keyUsageOf([5, 6]), true))
  } else {
    extensions.push(extensionOf(OID.basicConstraints, seqOf([]), true))
    /* digitalSignature(0) + keyEncipherment(2)：TLS 服务端证书的常规组合 */
    extensions.push(extensionOf(OID.keyUsage, keyUsageOf([0, 2]), true))
    extensions.push(extensionOf(OID.extendedKeyUsage, seqOf([oidOf(OID.serverAuth)]), false))
    if (san) extensions.push(extensionOf(OID.subjectAltName, san, false))
  }

  const tbs = seqOf([
    tlv(TAG.CTX0, integerOf(Buffer.from([2]))),          // version v3
    integerOf(serialBuf),
    algorithmOf(),                                       // signature
    nameOf(issuerCn, issuerO),
    seqOf([timeOf(from), timeOf(to)]),                   // validity
    nameOf(subjectCn, subjectO),
    spkiDer,                                             // subjectPublicKeyInfo
    tlv(TAG.CTX3, seqOf(extensions)),
  ])

  const signature = sign('sha256', tbs, privateKey)
  const der = seqOf([tbs, algorithmOf(), tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0]), signature]))])
  return {
    pem: pemEncode('CERTIFICATE', der),
    der,
    serial: serialBuf.toString('hex'),
    not_before: from.toISOString(),
    not_after: to.toISOString(),
  }
}

/* ------------------------------------------------------------------ 路径与状态 */

/** CA 目录：`<toolkit>/ca`，默认 `$DSH_HOME/redteam/toolkit/ca`。 */
export function caDirOf(root, cfg) {
  const config = cfg || loadPlatformConfig(root)
  return join(toolkitDirOf(config, root), 'ca')
}

export const CA_FILES = Object.freeze({
  key: 'ca.key',
  crt: 'ca.crt',
  srl: 'ca.srl',
})

export function caPathsOf(dir) {
  return {
    key: join(dir, CA_FILES.key),
    crt: join(dir, CA_FILES.crt),
    srl: join(dir, CA_FILES.srl),
    leafs: join(dir, 'leafs'),
  }
}

/** 证书摘要：sha256 按 PEM 字节算，跟面板/审计里记的值同一个口径。 */
export function certDigest(pemOrPath) {
  const text = existsSync(pemOrPath) ? readFileSync(pemOrPath, 'utf8') : String(pemOrPath)
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function parseCert(pem) {
  try { return new X509Certificate(pem) } catch { return null }
}

function certInfo(pem, digestSource) {
  const cert = parseCert(pem)
  if (!cert) return null
  const notAfter = Date.parse(cert.validTo)
  return {
    subject: cert.subject,
    issuer: cert.issuer,
    not_before: cert.validFrom,
    not_after: cert.validTo,
    expired: Number.isFinite(notAfter) ? notAfter <= Date.now() : false,
    sha256: certDigest(digestSource || pem),
  }
}

/* ------------------------------------------------------------------ 根证书 */

function hasOpenssl() {
  try {
    const out = spawnSync('openssl', ['version'], { stdio: 'ignore', timeout: 5000 })
    return out && out.status === 0
  } catch { return false }
}

function generateCaByOpenssl(paths) {
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', CA_FILES.key, '-out', CA_FILES.crt,
    '-days', String(CA_DAYS),
    '-subj', '/CN=' + CA_COMMON_NAME + '/O=ChongPo',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]
  const out = spawnSync('openssl', args, { cwd: paths.dir, stdio: 'ignore', timeout: 60000 })
  if (!out || out.status !== 0) return null
  if (!existsSync(paths.key) || !existsSync(paths.crt)) return null
  const info = certInfo(readFileSync(paths.crt, 'utf8'), paths.crt)
  if (!info || info.expired) return null
  writeFileSync(paths.srl, '01\n', 'utf8')
  return info
}

function generateCaByCrypto(paths) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const built = buildCertificate({
    subjectCn: CA_COMMON_NAME,
    subjectO: 'ChongPo',
    issuerCn: CA_COMMON_NAME,
    issuerO: 'ChongPo',
    spkiDer: spki,
    privateKey,
    days: CA_DAYS,
    isCa: true,
  })
  writeFileSync(paths.key, keyPem, { encoding: 'utf8', mode: 0o600 })
  writeFileSync(paths.crt, built.pem, 'utf8')
  writeFileSync(paths.srl, '01\n', 'utf8')
  const info = certInfo(built.pem, paths.crt)
  if (!info) throw new Error('生成的根证书无法被 X509Certificate 解析')
  return info
}

/**
 * 确保根证书存在且未过期。
 * @param dir - CA 目录（见 {@link caDirOf}）。
 * @param options - `{ openssl?: boolean, force?: boolean }`；`openssl:false` 强制走纯 JS 路径（测试用）。
 * @returns `{ dir, path, key_path, srl_path, sha256, subject, not_after, generated, source }`
 */
export function ensureCa(dir, options = {}) {
  const base = String(dir || '').trim()
  if (base === '') throw new Error('ensureCa 需要 CA 目录')
  const paths = Object.assign({ dir: base }, caPathsOf(base))
  mkdirSync(paths.leafs, { recursive: true })

  if (options.force !== true && existsSync(paths.crt) && existsSync(paths.key)) {
    const info = certInfo(readFileSync(paths.crt, 'utf8'), paths.crt)
    if (info && !info.expired) {
      return {
        dir: base,
        path: paths.crt,
        key_path: paths.key,
        srl_path: paths.srl,
        leafs_dir: paths.leafs,
        sha256: info.sha256,
        subject: info.subject,
        not_before: info.not_before,
        not_after: info.not_after,
        generated: false,
        source: 'existing',
      }
    }
  }

  const wantOpenssl = options.openssl !== false
  let info = null
  let source = 'builtin'
  if (wantOpenssl && hasOpenssl()) {
    info = generateCaByOpenssl(paths)
    if (info) source = 'openssl'
  }
  if (!info) {
    info = generateCaByCrypto(paths)
    source = 'builtin'
  }
  return {
    dir: base,
    path: paths.crt,
    key_path: paths.key,
    srl_path: paths.srl,
    leafs_dir: paths.leafs,
    sha256: info.sha256,
    subject: info.subject,
    not_before: info.not_before,
    not_after: info.not_after,
    generated: true,
    source,
  }
}

/* ------------------------------------------------------------------ 叶证书 */

const leafCache = new Map()

function leafBaseName(host) {
  return String(host).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^\.+|\.+$/g, '') || 'leaf'
}

/**
 * 按 host 现签（或复用缓存）叶证书。SAN 只有这一个 host；到期前 1 天就重签。
 * @returns `{ host, crt, key, crt_path, key_path, not_after, cached, sha256 }`
 */
export function ensureLeaf(dir, host, options = {}) {
  const ca = ensureCa(dir, options)
  const wanted = String(host || '').trim().toLowerCase()
  if (wanted === '') throw new Error('ensureLeaf 需要 host')
  const base = String(dir)
  const stamp = statSync(ca.path).mtimeMs
  const cacheKey = base + '::' + wanted
  const hit = leafCache.get(cacheKey)
  if (options.force !== true && hit && hit.stamp === stamp && Date.parse(hit.not_after) - Date.now() > 86400000) {
    return Object.assign({}, hit, { cached: true })
  }

  const paths = Object.assign({ dir: base }, caPathsOf(base))
  mkdirSync(paths.leafs, { recursive: true })
  const name = leafBaseName(wanted)
  const crtPath = join(paths.leafs, name + '.crt')
  const keyPath = join(paths.leafs, name + '.key')

  /* 磁盘上已有可用叶证书（同 CA 签发、未过期、SAN 覆盖该 host）时直接复用 */
  if (options.force !== true && existsSync(crtPath) && existsSync(keyPath)) {
    const crtPem = readFileSync(crtPath, 'utf8')
    const leafCert = parseCert(crtPem)
    const caCert = parseCert(readFileSync(ca.path, 'utf8'))
    if (leafCert && caCert) {
      const matches = /^\d{1,3}(\.\d{1,3}){3}$/.test(wanted)
        ? leafCert.checkIP(wanted)
        : leafCert.checkHost(wanted)
      if (matches && Date.parse(leafCert.validTo) - Date.now() > 86400000 && leafCert.checkIssued(caCert)) {
        const out = {
          host: wanted,
          crt: crtPem,
          key: readFileSync(keyPath, 'utf8'),
          crt_path: crtPath,
          key_path: keyPath,
          not_after: leafCert.validTo,
          sha256: certDigest(crtPath),
          cached: true,
          stamp,
        }
        leafCache.set(cacheKey, out)
        return out
      }
    }
  }

  const caKey = createPrivateKey(readFileSync(ca.key_path, 'utf8'))
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const caCert = parseCert(readFileSync(ca.path, 'utf8'))
  const issuer = caCert ? caCert.subject : ('CN=' + CA_COMMON_NAME)
  const built = buildCertificate({
    subjectCn: wanted.length > 64 ? wanted.slice(0, 64) : wanted,
    issuerCn: CA_COMMON_NAME,
    issuerO: 'ChongPo',
    spkiDer: publicKey.export({ type: 'spki', format: 'der' }),
    privateKey: caKey,
    days: LEAF_DAYS,
    isCa: false,
    san: sanOf(wanted),
  })
  /* 叶证书必须由 CA 私钥签：上面用 caKey 签名，subject 公钥用新生成的这对 */
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(crtPath, built.pem, 'utf8')
  writeFileSync(keyPath, keyPem, { encoding: 'utf8', mode: 0o600 })
  const out = {
    host: wanted,
    crt: built.pem,
    key: keyPem,
    crt_path: crtPath,
    key_path: keyPath,
    not_after: built.not_after,
    sha256: certDigest(crtPath),
    cached: false,
    stamp,
    issuer,
  }
  leafCache.set(cacheKey, out)
  return out
}

/* ------------------------------------------------------------------ 导出与安装指引 */

function within(base, target) {
  const root = resolve(base).replace(/[\\/]+$/, '')
  const full = resolve(target)
  return full === root || full.startsWith(root + sep) || full.startsWith(root + '/')
}

/**
 * 把 ca.crt 拷到用户指定位置（面板「导出证书」用）。
 * 目标必须在数据根或用户目录内：避免被写成任意路径的覆盖。
 */
export function exportCa(dir, to, options = {}) {
  const ca = ensureCa(dir, options)
  const target = String(to || '').trim()
  if (target === '') throw new Error('exportCa 需要目标路径')
  const abs = isAbsolute(target) ? target : resolve(target)
  const home = homedir()
  const root = options.root || join(home, '.dsh', 'redteam')
  if (!within(root, abs) && !within(home, abs)) {
    throw new Error('导出路径必须在本机数据目录或用户目录内： ' + abs)
  }
  mkdirSync(dirname(abs), { recursive: true })
  copyFileSync(ca.path, abs)
  return { ok: true, path: abs, sha256: certDigest(abs) }
}

/**
 * 安装/移除指引 —— **只出文本，不执行任何命令**。
 * 系统信任库属于系统级改动，必须由用户手动做（或明确授权后由用户自己跑）。
 */
export function guideText(platform, caPath) {
  const want = String(platform || 'auto').toLowerCase()
  const resolved = want === 'auto' || want === '' || want === 'undefined'
    ? (osPlatform() === 'win32' ? 'windows' : osPlatform() === 'darwin' ? 'macos' : 'linux')
    : want
  const path = String(caPath || join(caDirOf(), CA_FILES.crt))
  const quote = (p) => '"' + p + '"'
  const isWindows = resolved === 'windows'
  const isMac = resolved === 'macos'
  let steps
  if (isWindows) {
    steps = [
      '1) 确认要装的是这一份：' + path + '（打开看一眼 CN 是 ' + CA_COMMON_NAME + '）。',
      '2) 当前用户装进「受信任的根证书颁发机构」（无需管理员，只影响你这个账户）：',
      '   certutil -addstore -user Root ' + quote(path),
      '3) 管理员装进本机存储（影响所有用户，需要提权的命令行）：',
      '   certutil -addstore Root ' + quote(path),
      '4) 验证：certutil -store -user Root "' + CA_COMMON_NAME + '" 应当能列出证书。',
      '5) 用完移除（逆操作）：certutil -delstore -user Root "' + CA_COMMON_NAME + '"',
      '以上命令由你手动执行；插件不会替你改系统信任库。',
    ]
  } else if (isMac) {
    steps = [
      '1) 确认要装的是这一份：' + path + '。',
      '2) 装进登录钥匙串并标为信任根：',
      '   security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ' + quote(path),
      '3) 验证：security find-certificate -c "' + CA_COMMON_NAME + '" -a ~/Library/Keychains/login.keychain-db',
      '4) 用完移除（逆操作）：security delete-certificate -c "' + CA_COMMON_NAME + '" ~/Library/Keychains/login.keychain-db',
      '以上命令由你手动执行；插件不会替你改系统信任库。',
    ]
  } else {
    steps = [
      '1) 确认要装的是这一份：' + path + '。',
      '2) Debian/Ubuntu 系拷进系统证书目录并刷新：',
      '   sudo cp ' + quote(path) + ' /usr/local/share/ca-certificates/chongpo-mitm.crt && sudo update-ca-certificates',
      '3) RHEL/Fedora 系：sudo cp ' + quote(path) + ' /etc/pki/ca-trust/source/anchors/chongpo-mitm.crt && sudo update-ca-trust',
      '4) 验证：curl -v https://<被录制的主机>/ 不再报 self signed certificate 即已生效。',
      '5) 用完移除（逆操作）：sudo rm /usr/local/share/ca-certificates/chongpo-mitm.crt && sudo update-ca-certificates --fresh',
      '浏览器（Firefox/Chromium 系）另有自己的证书库，需要在设置里单独导入这一份 .crt。',
      '以上命令由你手动执行；插件不会替你改系统信任库。',
    ]
  }
  return { ok: true, platform: resolved, ca_path: path, steps }
}

/* ------------------------------------------------------------------ 验链 */

/**
 * 校验 CA 与（可选）某 host 叶证书的签名链。
 * 用 `X509Certificate.checkIssued/verify` 做真验签，不只看文件存在。
 */
export function verifyChain(dir, host) {
  const paths = caPathsOf(String(dir))
  if (!existsSync(paths.crt)) return { ok: false, error: '根证书不存在： ' + paths.crt }
  const caPem = readFileSync(paths.crt, 'utf8')
  const ca = parseCert(caPem)
  if (!ca) return { ok: false, error: '根证书无法解析' }
  const caIssuedBySelf = ca.checkIssued(ca)
  const caSignatureOk = ca.verify(ca.publicKey)
  const result = {
    ok: !!(caIssuedBySelf && caSignatureOk && Date.parse(ca.validTo) > Date.now()),
    ca: {
      subject: ca.subject,
      not_after: ca.validTo,
      self_signed: caIssuedBySelf,
      signature_ok: caSignatureOk,
      sha256: certDigest(paths.crt),
    },
  }
  if (host) {
    const wanted = String(host).toLowerCase()
    const name = leafBaseName(wanted)
    const leafPath = join(paths.leafs, name + '.crt')
    if (!existsSync(leafPath)) return Object.assign(result, { ok: false, error: '叶证书不存在： ' + leafPath })
    const leaf = parseCert(readFileSync(leafPath, 'utf8'))
    if (!leaf) return Object.assign(result, { ok: false, error: '叶证书无法解析' })
    const issued = leaf.checkIssued(ca)
    const signatureOk = leaf.verify(ca.publicKey)
    const matched = leaf.checkHost(wanted) || leaf.checkIP(wanted) || null
    result.leaf = {
      subject: leaf.subject,
      not_after: leaf.validTo,
      issued_by_ca: issued,
      signature_ok: signatureOk,
      host_match: matched,
      sha256: certDigest(leafPath),
    }
    result.ok = result.ok && issued && signatureOk && matched !== null && Date.parse(leaf.validTo) > Date.now()
  }
  return result
}

export default {
  CA_DAYS,
  LEAF_DAYS,
  CA_COMMON_NAME,
  caDirOf,
  caPathsOf,
  ensureCa,
  ensureLeaf,
  exportCa,
  guideText,
  verifyChain,
  certDigest,
}
