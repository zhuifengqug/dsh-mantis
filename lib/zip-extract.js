import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { assertNoLinkedDescendants } from "./path-boundary.js";

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

/** 归档条目名落到本地路径前必须过这一关：路径穿越、盘符、控制字符、Windows 保留名。 */
export function safeArchiveName(name) {
  const rel = String(name || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!rel || rel === ".") return "";
  if (rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) throw new Error("Invalid archive path");
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === ".." || /[\x00-\x1f:]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Invalid archive path");
  }
  return parts.join("/");
}

function isSymlinkMode(mode) {
  return (mode & S_IFMT) === S_IFLNK;
}

function eocdIsSelfConsistent(buf, i) {
  const totalDisk = buf.readUInt16LE(i + 8);
  const total = buf.readUInt16LE(i + 10);
  const centralSize = buf.readUInt32LE(i + 12);
  const centralOffset = buf.readUInt32LE(i + 16);
  const commentLength = buf.readUInt16LE(i + 20);
  if (i + 22 + commentLength !== buf.length) return false;
  if (centralSize === 0xffffffff || centralOffset === 0xffffffff) return false;
  if (totalDisk !== total) return false;
  if (centralOffset + centralSize !== i) return false;
  if (total === 0) return centralSize === 0 && centralOffset === 0;
  let cursor = centralOffset;
  for (let n = 0; n < total; n += 1) {
    if (cursor + 46 > i || buf.readUInt32LE(cursor) !== 0x02014b50) return false;
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    cursor += 46 + nameLen + extraLen + commentLen;
    if (cursor > i) return false;
  }
  return cursor === i;
}

/** 只认真实自洽的 EOCD：尾部注释里伪造的魔数不算，多个候选直接拒绝。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  const candidates = [];
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    if (eocdIsSelfConsistent(buf, i)) candidates.push(i);
  }
  if (!candidates.length) throw new Error("Not a zip file");
  if (candidates.length > 1) throw new Error("Zip contains multiple EOCD candidates, refused");
  return candidates[0];
}

function readZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("Not a zip file");
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  let cursor = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < total; n += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Corrupt zip central directory");
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    entries.push({
      name: buf.toString("utf8", cursor + 46, cursor + 46 + nameLen),
      crc: buf.readUInt32LE(cursor + 16),
      method: buf.readUInt16LE(cursor + 10),
      compSize: buf.readUInt32LE(cursor + 20),
      uncompSize: buf.readUInt32LE(cursor + 24),
      localOffset: buf.readUInt32LE(cursor + 42),
      mode: buf.readUInt32LE(cursor + 38) >>> 16,
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function listZipEntries(buf) {
  return readZipEntries(buf).map((entry) => entry.name.replace(/\\/g, "/"));
}

export function listZipFile(zipPath) {
  return listZipEntries(fs.readFileSync(zipPath));
}

function localDataOffset(buf, localOffset) {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Corrupt zip local header");
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  return localOffset + 30 + nameLen + extraLen;
}

/**
 * 逐条目解 zip：条目名过 safeArchiveName、拒绝链接条目与重复路径、目标路径过
 * assertNoLinkedDescendants、未压缩总量与条目数封顶、可选 CRC 校验，落地用 wx。
 */
export function extractZipBuffer(buf, dest, { maxBytes = 200 * 1024 * 1024, maxEntries = 65535, verifyCrc = false } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  const entries = readZipEntries(buf);
  if (entries.length > maxEntries) throw new Error("Too many entries in the archive");
  if (entries.some((entry) => isSymlinkMode(entry.mode))) throw new Error("Archive contains link entries");
  let totalBytes = 0;
  const seen = new Set();
  for (const entry of entries) {
    const rel = safeArchiveName(entry.name);
    if (!rel) continue;
    if (seen.has(rel)) throw new Error("Archive contains duplicate paths");
    seen.add(rel);
    const out = assertNoLinkedDescendants(root, path.resolve(root, rel), fs);
    if (entry.name.endsWith("/")) {
      fs.mkdirSync(out, { recursive: true });
      continue;
    }
    if (entry.uncompSize > maxBytes - totalBytes) throw new Error("Unpacked archive exceeds the size limit");
    if (entry.compSize === 0xffffffff || entry.localOffset === 0xffffffff) throw new Error("zip64 is not supported");
    if (entry.method !== 0 && entry.method !== 8) throw new Error(`Unsupported zip compression method ${entry.method}`);
    const start = localDataOffset(buf, entry.localOffset);
    const end = start + entry.compSize;
    if (end > buf.length) throw new Error("Truncated zip data");
    const compressed = buf.subarray(start, end);
    const body = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, maxBytes - totalBytes) });
    if (body.length !== entry.uncompSize) throw new Error("Zip entry size does not match the directory");
    if (verifyCrc && zlib.crc32(body) !== entry.crc) throw new Error("Zip entry CRC check failed");
    totalBytes += body.length;
    if (totalBytes > maxBytes) throw new Error("Unpacked archive exceeds the size limit");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body, { flag: "wx" });
  }
}

/**
 * 解压 zip 归档。所有平台都走同一个受限的 Node 读取器，**不**回退 tar/unzip/powershell：
 * 外部工具会把链接条目建成真链接，且各家的错误恢复行为不同，一旦回退，
 * maxEntries / verifyCrc / assertNoLinkedDescendants 三层保护会静默失效。
 *
 * 返回值固定 "node"，保留旧形状供调用方继续读。
 */
export function extractZipArchive(zipPath, dest, options = {}) {
  fs.mkdirSync(dest, { recursive: true });
  extractZipBuffer(fs.readFileSync(zipPath), dest, options);
  return "node";
}
