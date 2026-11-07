# DSH 0.2.2-rc.1 适配记录（2026-11-06）

宿主：官方桌面版 `D:\Deepseek Harness`，`resources/app.asar` 内 `@deepseek-ai` 331 个包全部 `0.2.2-rc.1`
（构建时间 2026-11-04 17:30）。`dsh --version` = `0.2.2-rc.1`。

## 一、诊断方法

未解包的 `app.asar` 无法直接跑 `patchStatus`：`core.js` 的 `isFile()` / `isDir()` 会先调用
`desktop.isAsarSealedPath(fp)`，归档内路径一律返回 false，`targetFiles` 只能解析 53 个文件键里的 29 个，
其余全部落成 `missing_file`（是「键没解析出来」，不是文件真的不存在）。

可用的两条路：

1. **解包后再诊断**（本次采用）。用 Electron 的 Node 模式（`ELECTRON_RUN_AS_NODE=1`）跑脚本，
   此时 `node:fs` 自带 asar 支持，可以直接 `readdirSync` / `readFileSync` 归档内部路径。
   把 `app.asar/dsh/node_modules/@deepseek-ai` 整棵写到 `.scratch/diag-0.2.2-rc.1/`，
   再用普通 `node` 对真实磁盘路径跑 `patchStatus`。本次 10721 文件 / 317403755 B / 0 错误。
2. 覆盖 `hostFs` 后再诊断（只适合抽查）。在 Electron 进程里先 import `lib/extract-asar.js`，
   再把 `hostFs` 的 `existsSync/statSync/readFileSync/...` 换成 `node:fs` 同名方法。
   能读文件，但绕不过 `isAsarSealedPath`，`targetFiles` 仍然解析不全。

> 注意：`fs.cpSync` 在 Electron Node 下复制 asar 内部目录会 `ENOENT`，必须自己遍历。

## 二、漂移的锚点

| # | 补丁 | 0.2.2 的变化 | 处理 |
| --- | --- | --- | --- |
| 14 | ESCALATION_GRANT_UNCONDITIONAL | `approver.request` 前新增 `approver === void 0` / `agent === void 0` 两条抛错守卫；`displayReason` 改调 `escalationDisplayReason(mode, justification)` | 两条新 pattern：一条覆盖「守卫 + 函数式 displayReason」，一条覆盖「守卫已被 #13 删掉、只剩函数式 displayReason」的形态；替换成三元表达式，缺服务时按 `allowed-once` 放行 |
| 17 | FS_OBSERVATION_INTENT_FREE | `editIntent` 收成一行 `return this.requirePresent(target, actor, "edit")`，真正的读后写闸门搬进 `requirePresent` | 追加 `editIntent` 的新形态 pattern，替换为直接 `return void 0` |
| 40 | COMPLETE_PROMPT_KEEP_INJECT | `assemble` 返回值新增 `tools`；early return 改成 `{ ...transformed, tools }`；`requiredContexts` 挪到第二个 return 前 | 新 pattern 保留 `tools` 与 requiredContexts 过滤 |
| 67 | AGENT_LOOP_MESSAGES_GUARD | 文本逐字一致，try 块多缩进一层（4 tab → 5 tab） | 追加 5-tab 变体 |
| 74 | ASSEMBLE_BEFORE_PRESTEP | preStep 先 `model.current()`、再 `tools.resolve`、最后 `assemble`；claim+assemble 锚点被拆开 | 锚点改挂 claim 之后、取 model 之前 |

补 pattern 时沿用 1.1.88 的约定：**旧 pattern 全部保留，新 pattern 追加**，避免一边补一边把别的宿主版本弄坏。
1.0.10 把支持口径收窄到 0.2.2-rc.1 之后，又做了一轮清理：按 0.2.2 上的真实执行顺序判定，删掉 28 条永不命中的旧版本文案变体，
整条删除只服务旧版的 #2（0.2.2 已无 `REPLACEMENT_WORKSPACE_CONTEXT_INTRO`），带 `mantis` 痕迹的撤销/幂等变体保留，补丁表 88 → 87。
清理前后各打一遍，10775 个文件逐字节一致，二次 apply 0 改动。

注意 #13 / #14 的先后：#13 会先删掉两条 `approver`/`agent` 守卫，所以 #14 必须同时认识「守卫还在」和「守卫已被删」两种文本，
否则打完 #13 之后 #14 会显示漂移（功能上不致命，但状态面板会一直挂一条红）。
同理 #17 的两条 replacement 必须都命中，markers 是 every 语义，只命中一半就是漂移。

## 三、0.2.2 的两处预设硬断点

1. `@deepseek-ai/dsh-tool-subagent-control` 的 `exports` 只剩包根，`./list-agents` 子路径没了
   （`list_agents` 已并入主 `lib/index.js`）。预设里保留
   `- id: tool-subagent-list-agents` 会让**整份预设注册失败**。
   → `presets/redteam/agent.cordis.yml` 删除该行；`lib/redteam/index.js` 的 `repairDelegation`
   新增「从旧用户预设里整块删除该行」的迁移。
2. `dsh-tool-subagent` 的 Config 里键名是 `modelSelection`（`z.boolean().default(false)`），
   没有 `modelSelectionSettings`。旧名会被 schema 静默丢弃，等于模型选择没开。
   → 预设改用 `modelSelection: true`；`repairDelegation` 顺带把旧键名迁移成新键名。

## 四、验证

```powershell
# 1) 语法
node --check lib\core.js; node --check lib\host-compat.js; node --check lib\redteam\index.js

# 2) 对解包后的 0.2.2 树跑逐条状态（打之前）
node scripts\tmp-status-diag.mjs
# HOST_TARGETS ["0.2.2-rc.1","0.2.1-rc.2","0.2.1-rc.5"]   ← 收窄前；1.0.10 起只有 ["0.2.2-rc.1"]
# resolvedKeys 53 of 53, unresolvedKeys 空
# COUNTS {"pending":60,"applied":5,"na":17,"skipped":5,"missing_file":1}  ← drifted 为 0

# 3) 真打一遍再撤回（备份 → apply → status → revert → 逐字节比对）
$env:DSH_HOME = "$PWD\.scratch\apply-home"
node scripts\tmp-apply-test.mjs
# COUNTS {"applied":66,"na":17,"skipped":4,"missing_file":1}   ← pending 0、drifted 0
# changed 50（其中 40 个 JS 文件 node --check 全部通过）
# AFTER REVERT COUNTS {"pending":60,"applied":5,"na":17,"skipped":5,"missing_file":1}
# files differing after revert 0
```

`missing_file` 只剩 #71 `LIANGSHEN_IDENTITY_LINE`：该补丁针对第三方 liangshen 预设，
本机未安装，属预期。`pending` 是「宿主还是干净的、补丁没打」，不是漂移。
`revertAll` 只有在先 `backupAll` 之后才能还原；单独跑 `revertAll` 不会动文件（本次第一次试验就是这种情况）。

## 五、未做

- 上游 1.1.91 的 #211（撤销按钮 `checkVisibility` + z-index 降到 900）未吸收：与本次宿主升级无关。
- 未对真实桌面宿主执行 `apply`（会改写 `app.asar` 并触发换包重启），本次只做只读诊断与源码适配。
