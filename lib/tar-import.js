import fs from "node:fs";
import path from "node:path";
import { assertNoLinkedDescendants } from "./path-boundary.js";
import { safeArchiveName } from "./zip-extract.js";

const TAR_BLOCK = 512;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LENGTH = 12;

function isZeroBlock(buf, offset) {
  for (let i = offset; i < offset + TAR_BLOCK; i += 1) if (buf[i] !== 0) return false;
  return true;
}

/** tar 大小字段：既支持八进制文本，也支持 GNU base-256；负数与越界一律拒绝。 */
function tarEntrySize(buf, offset) {
  const field = buf.subarray(offset + TAR_SIZE_OFFSET, offset + TAR_SIZE_OFFSET + TAR_SIZE_LENGTH);
  if (field.length !== TAR_SIZE_LENGTH) throw new Error("tar header is truncated");
  if (field[0] & 0x80) {
    if (field[0] === 0xff) throw new Error("tar size field is negative, refused");
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i += 1) {
      value = value * 256 + field[i];
      if (!Number.isSafeInteger(value)) throw new Error("tar size field is out of range, refused");
    }
    return value;
  }
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error("tar size field is unreadable, refused");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("tar size field is out of range, refused");
  return value;
}

function parsePaxRecords(data) {
  let cursor = 0;
  let sizeOverride;
  let pathOverride;
  let sawLinkpath = false;
  while (cursor < data.length) {
    if (data[cursor] === 0) break;
    let space = -1;
    for (let i = cursor; i < data.length; i += 1) {
      if (data[i] === 0x20) { space = i; break; }
      if (data[i] < 0x30 || data[i] > 0x39) break;
    }
    if (space < 0) throw new Error("tar PAX record is unreadable, refused");
    const lengthText = data.toString("ascii", cursor, space);
    if (!/^\d+$/.test(lengthText)) throw new Error("tar PAX record length is unreadable, refused");
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > data.length) throw new Error("tar PAX record length out of bounds, refused");
    if (data[cursor + length - 1] !== 0x0a) throw new Error("tar PAX record does not end with a newline, refused");
    const body = data.subarray(space + 1, cursor + length - 1);
    const eq = body.indexOf(0x3d);
    if (eq <= 0) throw new Error("tar PAX record has no key separator, refused");
    const key = body.toString("utf8", 0, eq);
    if (key === "size") {
      const value = body.toString("ascii", eq + 1);
      if (!/^\d+$/.test(value)) throw new Error("tar PAX size record is unreadable, refused");
      const parsed = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsed)) throw new Error("tar PAX size record out of range, refused");
      sizeOverride = parsed;
    } else if (key === "linkpath") {
      sawLinkpath = true;
    } else if (key === "path") {
      pathOverride = body.toString("utf8", eq + 1);
    }
    cursor += length;
  }
  return { sizeOverride, pathOverride, sawLinkpath };
}

function tarHeaderChecksumOk(buf, offset) {
  if (offset + TAR_BLOCK > buf.length) return false;
  const stored = buf.toString("ascii", offset + 148, offset + 156).replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(stored)) return false;
  const expected = Number.parseInt(stored, 8);
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : buf[offset + i];
  return sum === expected;
}

/**
 * 解 tar（含 GNU/PAX 扩展头）。只认普通文件与目录：链接条目、稀疏条目、
 * 其它类型一律拒绝；先完整解析出清单再落盘，落盘只建目录和新建普通文件。
 */
export function extractSkillTar(buffer, root, { maxBytes, maxEntries }) {
  let offset = 0;
  let total = 0;
  let pending;
  const entries = [];
  while (offset + TAR_BLOCK <= buffer.length && !isZeroBlock(buffer, offset)) {
    if (!tarHeaderChecksumOk(buffer, offset)) throw new Error("tar header checksum failed");
    const field = (start, end) => buffer.toString("utf8", offset + start, offset + end).split("\0")[0];
    const type = field(156, 157);
    const size = tarEntrySize(buffer, offset);
    const start = offset + TAR_BLOCK;
    const extension = ["x", "g", "L"].includes(type);
    const length = extension ? size : (pending?.sizeOverride ?? size);
    if (length > buffer.length - start) throw new Error("tar entry data is incomplete");
    const body = buffer.subarray(start, start + length);
    if (extension) {
      if (pending) throw new Error("nested tar extension headers are not supported");
      const metadata = type === "L" ? { pathOverride: body.toString("utf8").replace(/\0+$/, "") } : parsePaxRecords(body);
      if (metadata.sawLinkpath) throw new Error("Archive contains link entries");
      if (type === "g" && (metadata.sizeOverride !== undefined || metadata.pathOverride !== undefined)) {
        throw new Error("Global tar headers overriding size or path are not supported");
      }
      if (type !== "g") pending = metadata;
    } else {
      if (!["", "0", "5", "7"].includes(type)) throw new Error("tar only supports regular files and directories");
      const prefix = field(257, 263) === "ustar" ? field(345, 500) : "";
      const name = safeArchiveName(pending?.pathOverride ?? (prefix ? prefix + "/" : "") + field(0, 100));
      const directory = type === "5";
      if ((!directory && !name) || (directory && length)) throw new Error("Invalid tar entry");
      total += length;
      if (total > maxBytes || entries.length >= maxEntries) throw new Error("Unpacked archive is too large or has too many entries");
      entries.push({ name, directory, body });
      pending = undefined;
    }
    offset = start + Math.ceil(length / TAR_BLOCK) * TAR_BLOCK;
  }
  if (pending || offset > buffer.length || buffer.subarray(offset).some((byte) => byte !== 0)) throw new Error("tar trailer is incomplete");
  for (const { name, directory, body } of entries) {
    const target = assertNoLinkedDescendants(root, path.join(root, name), fs);
    if (directory) fs.mkdirSync(target, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body, { flag: "wx" });
    }
  }
}
