// host-compat：宿主版本兼容性诊断。
//
// 从 mantis 1.6.69 的 lib/community.js 里抽出的四段
// （QUALIFIED_HOST_VERSIONS / compatibility / requirePatchCompatibility /
// diagnosePatches），去掉整包安装与 Maintenance 那 900 行的依赖，只留
// 「宿主在哪、什么版本、锚点还对不对」这三件事。
//
// 原则：只做诊断，不做门禁。找不到宿主才算写不了；版本不在已验证清单内
// 只是 unverified，照样写，写前备份，写完看逐条状态。

import fs from "node:fs";
import path from "node:path";
import { normalizeHostBase } from "./instance.js";

/**
 * 逐条锚点回归验证过的宿主版本。
 * 0.2.1-rc.5：官方 nightly 2026-10-29 构建；桌面壳 5 条（#45/#46/#82/#83/#84）
 * 在 Resources/app 布局下同样命中，运行时表现由自检卡片确认。
 */
export const QUALIFIED_HOST_VERSIONS = Object.freeze([
  "0.2.1-rc.1",
  "0.2.1-rc.2",
  "0.2.1-rc.3",
  "0.2.1-rc.5",
]);

function readVersion(reader, aiBase, pkg) {
  try {
    return JSON.parse(
      reader.readFileSync(path.join(aiBase, pkg, "package.json"), "utf8"),
    ).version;
  } catch {
    return "";
  }
}

/**
 * 兼容性报告。只做诊断，不做禁用：宿主找得到就允许写入（写前必备份），
 * 锚点漂移由逐条诊断上报，不再用一个全局开关把所有版本的补丁一起停掉。
 */
export function compatibility(aiBase, reader = fs) {
  aiBase = normalizeHostBase(aiBase, reader);
  const version = readVersion(reader, aiBase, "dsh-agent-loop");
  const promptVersion = readVersion(reader, aiBase, "dsh-system-prompt");
  const mixed = !!version && !!promptVersion && version !== promptVersion;
  let layout = false;
  try {
    layout =
      !!aiBase &&
      reader
        .statSync(path.join(aiBase, "dsh-agent-instructions", "lib"))
        .isDirectory();
  } catch {
    layout = false;
  }
  const qualified =
    !mixed &&
    !!version &&
    version === promptVersion &&
    QUALIFIED_HOST_VERSIONS.includes(version);
  // 只有「根本没找到宿主」才算写不了。组件版本不一致也只是报告：
  // 补丁该打的一条不少，写坏的风险由逐条状态 + 备份兜底。
  const patchWritesAllowed = layout;
  const runtimeSupported =
    !mixed && !!version && !!promptVersion && version === promptVersion;
  return {
    host_version: version || "unknown",
    prompt_version: promptVersion || "unknown",
    runtime_supported: runtimeSupported,
    patch_writes_allowed: patchWritesAllowed,
    layout_found: layout,
    qualified,
    level: mixed
      ? "mixed"
      : !layout
        ? "no-host"
        : qualified
          ? "qualified"
          : "unverified",
    message: mixed
      ? "宿主组件版本不一致（agent-loop 与 system-prompt 不同版）：仍按补丁表写入，逐条状态为准；建议修好安装。"
      : !layout
        ? "未定位到宿主 @deepseek-ai 目录。官方桌面版点「应用」会解开 app.asar 后重启并自动继续。"
        : qualified
          ? `DSH ${version}：逐条补丁锚点已回归验证，可直接应用；写入前自动备份。`
          : `DSH ${version} 未在已验证清单内：仍可应用，写入前备份，应用后请看逐条诊断确认锚点是否漂移。`,
  };
}

/**
 * 兼容旧调用点：只在「完全找不到宿主」时抛错。
 * 版本未知、锚点漂移都不再阻断——那属于状态展示，不是写入门禁。
 */
export function requirePatchCompatibility(aiBase, reader = fs) {
  const value = compatibility(aiBase, reader);
  if (!value.layout_found)
    throw Error(`拒斧：未定位到宿主目录，无法写入。${value.message}`);
  if (value.level === "mixed")
    console.warn(`[mantis] ${value.message}`);
  return value;
}

/** 逐条锚点诊断：宿主升级后用它确认哪几条补丁的定位字符串变了。 */
export async function diagnosePatches(aiBase, coreModule) {
  const core = coreModule || (await import("./core.js"));
  const status = await core.patchStatus(aiBase);
  return core.ALL_PATCHES.map((p) => ({
    id: p.id,
    name: p.name,
    layer: p.layer,
    optional: !!p.optional,
    status: status[p.id],
    keys: Array.isArray(p.file) ? p.file.slice() : [p.file],
  })).filter((row) => row.status !== "applied" && row.status !== "na");
}
