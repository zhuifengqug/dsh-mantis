// Plugin-owned tuning state. Deliberately NOT stored in the profile cordis config:
// switching a behaviour must never require editing a DSH file or a restart of the
// profile's YAML, and must survive `dsh plugin add`.
import fs from "node:fs";
import path from "node:path";
import { findDshHome } from "./core.js";
import { logAudit } from "./audit.js";
import { atomicFiles } from "./atomic-files.js";

export const TUNING_FILE = "tuning.json";

/** 读不出来时抛的错码：调用方据此区分"没配过"（走默认）和"配坏了"（要人看）。 */
export const TUNING_UNREADABLE = "TUNING_UNREADABLE";

function unreadable(file, reason) {
  return Object.assign(
    new Error(`无法读取 ${file}（${reason}）。请检查文件或从备份恢复。`),
    { code: TUNING_UNREADABLE, path: file },
  );
}

/** 默认值即"全开"：破甲是这个插件的唯一目的，默认就不该留门。 */
export const TUNING_DEFAULTS = Object.freeze({
  boost: true, // 尾部强化段
  injectPosition: "head", // head | tail | both —— 注入在系统提示词里的位置
  askNoBlock: true, // 兼容字段：现在只把 -1（无限等）收成 300s，见补丁 #89
  rewind: true, // 输入框右侧的「回退」按钮（原版功能，可按需隐藏）
  refusalRetry: false, // 模型推脱时自动加一句加固重试一次（llm/stream 钩子）
  extraPatches: [], // 兼容字段：等价于 contextManagement=true（#18 重复调用提醒、#19 工具结果修剪）
  permissionPatches: true, // 权限面那组补丁（审批/沙箱/提权/工具拒绝话术，见 PATCH_GROUPS）
  contextManagement: true, // 上下文面那组补丁（#18 重复调用提醒、#19 工具结果修剪）
});

function tuningPath(dshHome) {
  const home = dshHome || findDshHome();
  if (!home) return "";
  return path.join(home, "mantis", TUNING_FILE);
}

export function readTuning(dshHome) {
  const file = tuningPath(dshHome);
  if (!file) return { ...TUNING_DEFAULTS };
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    // ENOENT = 还没配过，走默认。其它（权限、IO）不能静默吞掉：悄悄退回默认
    // 等于替用户把开关全打开，他以为关掉的补丁会重新写进宿主。
    if (!error || error.code !== "ENOENT") throw unreadable(file, error?.code || error?.message || "读取失败");
    return { ...TUNING_DEFAULTS };
  }
  let saved = {};
  try {
    // 空文件按"没配过"处理，不该让一个 0 字节文件把整个插件卡死。
    saved = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw unreadable(file, "JSON 格式错误");
  }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw unreadable(file, "需要 JSON 对象");
  // 未知字段随 saved 保留（下面 writeTuning 会原样写回），新版降级时不会丢配置。
  const merged = { ...TUNING_DEFAULTS, ...saved };
  // 只认真正的 false：缺省、null、"false" 都算开——补丁默认全开是这个插件的前提。
  merged.permissionPatches = merged.permissionPatches !== false;
  merged.contextManagement = merged.contextManagement !== false;
  if (!["head", "tail", "both"].includes(merged.injectPosition)) {
    merged.injectPosition = TUNING_DEFAULTS.injectPosition;
  }
  merged.extraPatches = Array.isArray(merged.extraPatches)
    ? [...new Set(merged.extraPatches.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
    : [];
  return merged;
}

export function writeTuning(patch = {}, dshHome) {
  const file = tuningPath(dshHome);
  if (!file) throw new Error("未定位 DSH 数据目录，无法保存 tuning");
  const before = readTuning(dshHome);
  const next = { ...before, ...patch };
  // 符号链接（用户把 tuning 指到 dotfiles 仓库时）必须写真实文件，rename 会替换掉链接本身。
  let target = file;
  try {
    target = fs.realpathSync(file);
  } catch {}
  // 原子 + fsync：写一半掉电不该留下坏 JSON，否则下次启动直接 TUNING_UNREADABLE。
  atomicFiles(fs).atomicWriteSync(target, JSON.stringify(next, null, 2), "utf8", {
    exactMode: 0o600,
    directoryMode: 0o700,
    durable: true,
  });
  const effective = readTuning(dshHome);
  // Record effective values, not invalid input that readTuning normalizes away.
  // Only known, non-secret settings belong in the public audit schema.
  for (const key of Object.keys(TUNING_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key) || before[key] === effective[key]) continue;
    const auditValue = (value) => key === "injectPosition"
      ? (["head", "tail", "both"].includes(value) ? value : "invalid")
      : key === "extraPatches"
        ? (Array.isArray(value) ? value.map(Number).join(",") : "invalid")
        : (typeof value === "boolean" ? value : "invalid");
    logAudit("tuning_setting", { key, from: auditValue(before[key]), to: auditValue(effective[key]) }, path.dirname(path.dirname(file)));
  }
  return effective;
}
