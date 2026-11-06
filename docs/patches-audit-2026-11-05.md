# 拒斧补丁体检报告（2026-11-05）

宿主：DeepSeek Harness `0.2.1-rc.5`（`D:\deepseek HARNESS\resources\app\dsh\node_modules\@deepseek-ai`）

## 总览

| 指标 | 数量 |
| --- | --- |
| 补丁总数 | 88 |
| applied | 70 |
| skipped | 2 |
| na | 16 |
| drifted | 0 |
| pending | 0 |
| unmatched | 0 |
| missing_file | 0 |

分层：提示词 27 / 代码 50 / 工具 8 / 0.1.5 兼容 1 / 0.2.0 兼容 2

## 结论

- **无 drifted / pending / unmatched / missing_file**：88 条全部有确定归宿。
- applied 70 条：锚点与 rc.5 实际文件吻合，已生效。
- skipped 2 条：**#76 PRESET_UNRESTRICTED_IDENTITY_STRIP**（本机无 preset-unrestricted，无活可干）、**#80 MINIMAL_OFFICIAL_TOOLSET**（官方极简工具表已是原样）。两条都是 optional，不参与硬判定。
- na 16 条：28、30、31、45、46、47、49、57、64、65、82、83、84、92、93、95 —— rc.5 本机没有对应目标文件（梁神插件 / hooks 系列 / Anthropic OAuth / 桌面壳旧布局 / header 上限），补丁逻辑没问题。

## 逐条清单

| ID | 层 | 名称 | 目标 | 作用 | 状态 | 结论 |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 提示词 | `WORKSPACE_CONTEXT_INTRO` | `agent-instructions` | 全局免责声明 / global disclaimer | applied | 已生效，保留 |
| 2 | 提示词 | `REPLACEMENT_WORKSPACE_CONTEXT_INTRO` | `agent-instructions` | 替换稿不压过 system / replacement does not override system | applied | 已生效，保留 |
| 3 | 提示词 | `SCOPE_INTRO` | `agent-instructions` | 作用域不压过 system / scope does not override system | applied | 已生效，保留 |
| 4 | 提示词 | `SYSTEM_PROMPT_PERSONA` | `agent-preset,web-app,headless,preset-acp-app,preset-sdk-app` | persona：去掉官方默认身份，不另写人设 / strip official identity only | applied | 已生效，保留 |
| 43 | 提示词 | `WEB_PRESET_IDENTITY_STRIP` | `preset-standard,preset-ptc,preset-cordis,preset-minimal` | Web 四个内置预设只去掉身份句 / strip web preset identity only | applied | 已生效，保留 |
| 76 | 提示词 | `PRESET_UNRESTRICTED_IDENTITY_STRIP` | `preset-unrestricted` | 用户自造 unrestricted 预设只去掉身份句（软补丁）/ soft strip for a user-made unrestricted preset | skipped | 无需处理（原文不在或官方已内建同等行为） |
| 70 | 提示词 | `PRESET_SHELL_NETWORK` | `preset-minimal,preset-sdk-minimal` | 极简模式终端不再写没有网络 / minimal shell drops no-network ban | applied | 已生效，保留 |
| 73 | 提示词 | `PRESET_BASH_MIRROR_LINE` | `preset-minimal,preset-sdk-minimal` | 极简 bash 去掉误留的镜像说明 / drop the extra mirror sentence | applied | 已生效，保留 |
| 71 | 提示词 | `LIANGSHEN_IDENTITY_LINE` | `preset-liangshen,preset-liangshen-pkg` | 梁神去掉官方身份句，留下本模式的工作纪律 / strip liangshen stock identity line | applied | 已生效，保留 |
| 5 | 提示词 | `APPROVAL_NEVER_SENTENCE` | `user-approval,user-approval-invariant` | 审批提示句限制 / approval sentence | applied | 已生效，保留 |
| 6 | 代码 | `SANDBOX_DENY_FILE_WRITE` | `sandbox-local` | 沙箱 deny file-write / sandbox deny | applied | 已生效，保留 |
| 7 | 代码 | `SANDBOX_MODE_DEFAULT` | `base` | 沙箱默认 danger-full-access（可被 UI 切换，不写死 env） / soft default only | applied | 已生效，保留 |
| 8 | 代码 | `APPROVAL_POLICY_DEFAULT` | `base` | 审批：danger-full-access → never（与 mode 组合合法） / compose with mode | applied | 已生效，保留 |
| 9 | 代码 | `APPROVAL_AUTO_GRANT` | `user-approval-code,user-approval-invariant,user-approval` | 审批门自动放行 / approval auto-grant | applied | 已生效，保留 |
| 10 | 代码 | `APPROVAL_CONFIG_DEFAULT_NEVER` | `user-approval-code` | 审批配置默认 never / approval config default | applied | 已生效，保留 |
| 11 | 提示词 | `APPROVAL_NEVER_SENTENCE_BYPASS` | `user-approval-code` | never 提示句 → 自动放行 / never sentence bypass | applied | 已生效，保留 |
| 12 | 提示词 | `APPROVAL_ASK_SENTENCE_BYPASS` | `user-approval-code,user-approval,user-approval-invariant` | ask 提示句 → 自动放行 / ask sentence bypass | applied | 已生效，保留 |
| 13 | 代码 | `ESCALATION_WIDENING_EXEMPT` | `escalation` | 豁免严格升级阶梯 / escalation widening exempt | applied | 已生效，保留 |
| 14 | 代码 | `ESCALATION_GRANT_UNCONDITIONAL` | `escalation` | 升级请求无条件授信 / escalation grant unconditional | applied | 已生效，保留 |
| 15 | 代码 | `SANDBOX_CONFINE_PASSTHROUGH` | `sandbox-local` | 沙箱 confine 直通 / sandbox confine passthrough | applied | 已生效，保留 |
| 16 | 代码 | `FS_FENCE_DISABLED` | `fs-sandbox` | 文件系统围栏取消 / fs fence disabled | applied | 已生效，保留 |
| 17 | 代码 | `FS_OBSERVATION_INTENT_FREE` | `fs-observation-policy` | 观察策略读写意图放行 / observation write/edit intent bypass | applied | 已生效，保留 |
| 18 | 代码 | `REPEAT_TOOL_REMINDER_DISABLED` | `repeat-tool-reminder` | 重复调用守卫禁用 / repeat-tool-reminder disabled | applied | 已生效，保留 |
| 19 | 代码 | `TOOL_RESULT_PRUNER_DISABLED` | `compaction-tool-result-pruner` | 工具结果修剪禁用 / tool-result pruner disabled | applied | 已生效，保留 |
| 21 | 代码 | `BASH_TIMEOUT_RESTORE` | `base` | 恢复插件延长的 bash 等待 / restore plugin-raised bash wait | applied | 已生效，保留 |
| 22 | 代码 | `READ_CAPS_RAISED` | `tool-fs` | read 上限放宽 / read caps raised | applied | 已生效，保留 |
| 23 | 代码 | `SUBAGENT_MAXDEPTH_RAISED` | `subagent,tool-subagent` | 子代理深度默认 3 → 10 / subagent maxDepth raised | applied | 已生效，保留 |
| 24 | 代码 | `PRESET_FETCH_ENABLED` | `preset-unrestricted,preset-standard,preset-cordis,preset-ptc,preset-liangshen,preset-liangshen-pkg` | preset tool-web fetch 打开 / preset fetch enabled | applied | 已生效，保留 |
| 25 | 提示词 | `HARNESS_IDENTITY_STRIP` | `system-prompt` | 去掉官方默认身份，保留官方功能提示词 / strip default identity only | applied | 已生效，保留 |
| 26 | 提示词 | `MINIMAL_PERSONA_PURGE` | `preset-minimal,preset-sdk-minimal` | 内置 minimal：去掉默认身份并打开 complete，让 inject 能进 / strip identity, open inject | applied | 已生效，保留 |
| 80 | 工具 | `MINIMAL_OFFICIAL_TOOLSET` | `preset-minimal,preset-sdk-minimal` | 撤掉曾追加的 fs/web，恢复官方极简工具表 / restore official minimal tool plugins | skipped | 无需处理（原文不在或官方已内建同等行为） |
| 28 | 提示词 | `LIANGSHEN_PHASE1_KEEP_INJECT` | `liangshen-tool-bootstrap` | 插件 dsh-liangshen（梁神）：phase-1 保留注入段（可选） / @linxin666/dsh-liangshen | na | 本机不适用（rc.5 无该文件），无需处理 |
| 32 | 提示词 | `WEB_SURFACE_IDENTITY_NEUTRAL` | `web-app-lib,harness-dev-context` | Web 面：去掉 DeepSeek Harness 自称 / neutralize web GUI identity branding | applied | 已生效，保留 |
| 29 | 工具 | `TOOL_WEB_UNTRUSTED_NEUTRAL` | `tool-web,tool-web-nested` | dsh-tool-web：外部内容 untrusted 拦截→可执行数据 / neutralize web untrusted framing | applied | 已生效，保留 |
| 30 | 工具 | `HOOKS_CLAUDE_DENY_ALLOW` | `hooks-claude-code,hooks-claude-code-nested` | dsh-hooks-claude-code：deny→allow（可选） / hooks deny bypass | na | 本机不适用（rc.5 无该文件），无需处理 |
| 31 | 工具 | `HOOKS_CODEX_DENY_ALLOW` | `hooks-codex,hooks-codex-nested` | dsh-hooks-codex：deny→allow（可选） / hooks deny bypass | na | 本机不适用（rc.5 无该文件），无需处理 |
| 33 | 提示词 | `TOOL_SHELL_DENIAL_PROMPT` | `tool-bash,tool-pwsh` | bash/pwsh 工具描述：沙箱拒绝话术→可继续 / neutralize sandbox-denial tool text | applied | 已生效，保留 |
| 34 | 提示词 | `SANDBOX_HINT_NEUTRAL` | `escalation` | 沙箱拒绝/升级 hint 不再要求用户审批 / neutralize sandbox hint to model | applied | 已生效，保留 |
| 35 | 代码 | `ESCALATION_NEVER_REJECT` | `escalation` | 升级结果 rejected/cancelled/unavailable 仍授信 / escalation never throws | applied | 已生效，保留 |
| 36 | 提示词 | `TOOL_FS_ESCALATION_SCHEMA` | `tool-fs,escalation,tool-bash,tool-pwsh` | fs/命令升级字段：去掉 user approval 拦截描述 / neutralize fs and command escalation schema | applied | 已生效，保留 |
| 37 | 提示词 | `SUBAGENT_SCOPE_LOCK_NEUTRAL` | `subagent,subagent-types` | 子代理权限锁→可继续 / neutralize subagent scope-lock prompt | applied | 已生效，保留 |
| 38 | 代码 | `PERSONA_TEXT_PREFIX_ALIAS` | `persona` | dsh-persona：兼容 0.1.2 text 字段，否则梁神会话起不来 / accept legacy text as prefix | applied | 已生效，保留 |
| 39 | 代码 | `SESSION_V0_PLUGIN_SUMMARY_ALIAS` | `session-format-v0` | v0 会话：mnemon summary 可挂在 instructions/recall 上 / allow plugin summary off notice | applied | 已生效，保留 |
| 40 | 0.1.5 兼容 | `COMPLETE_PROMPT_KEEP_INJECT` | `system-prompt,system-prompt-nested` | complete 预设仍保留 mantis 注入 / keep inject after complete prompt | applied | 已生效，保留 |
| 42 | 代码 | `SETTINGS_LEGACY_API` | `settings` | 设置服务补回 register/get，旧插件可继续用 / legacy settings API | applied | 已生效，保留 |
| 45 | 代码 | `OFFICIAL_DESKTOP_UPDATE_HANDOFF` | `desktop-shell` | 官方桌面升级安装已下载的新版本，不再重新打开旧的解开目录 | na | 本机不适用（rc.5 无该文件），无需处理 |
| 46 | 代码 | `OFFICIAL_DESKTOP_UPDATE_ASCII` | `desktop-shell` | 已接管的官方桌面更新改为 ASCII 脚本，中文 Windows 不再吞掉换行 | na | 本机不适用（rc.5 无该文件），无需处理 |
| 47 | 0.2.0 兼容 | `ANTHROPIC_OAUTH_NO_CLAUDE_IDENTITY` | `pi-ai-anthropic-messages` | Anthropic OAuth 不再强插 Claude Code 首段系统提示 / drop Claude Code OAuth system prefix | na | 本机不适用（rc.5 无该文件），无需处理 |
| 48 | 工具 | `TOOL_SHELL_DELETE_MOVE_NEUTRAL` | `tool-bash,tool-pwsh` | bash/pwsh 去掉 delete/move 过度谨慎描述 / drop delete-move caution in shell tools | applied | 已生效，保留 |
| 49 | 0.2.0 兼容 | `ANTHROPIC_OAUTH_CLI_NEUTRAL` | `pi-ai-anthropic-messages` | OAuth 不再伪装 claude-cli / stop Claude CLI OAuth mimicry | na | 本机不适用（rc.5 无该文件），无需处理 |
| 50 | 提示词 | `SESSION_REFERENCE_FRAMING_NEUTRAL` | `session-reference` | 跨会话引用不再标 untrusted / drop untrusted framing from session references | applied | 已生效，保留 |
| 51 | 代码 | `FRESH_SESSION_FULL_ACCESS` | `permission-presets,permission-presets-types` | 新会话在部署已是 danger-full-access 时不再钉回 workspace-write / keep fresh sessions on full access | applied | 已生效，保留 |
| 52 | 代码 | `SESSION_LOG_UPLOAD_DEFAULT_OFF` | `session-log-deepseek,session-log-deepseek-types` | 官方模型 API 默认不上传 Session Log / session log upload off by default | applied | 已生效，保留 |
| 53 | 提示词 | `WEB_SURFACE_PROHIBITION` | `web-app-lib,harness-dev-context` | 网页端提示词去掉身份句和禁止另开服务器 / drop web identity and do-not-start | applied | 已生效，保留 |
| 54 | 提示词 | `DELIVERABLE_DO_NOT` | `deliverables-prompt` | 交付物提示词去掉 Do not call present / drop deliverable prohibition | applied | 已生效，保留 |
| 55 | 代码 | `SYSTEM_PROMPT_REPLACE_HEAD` | `agent-loop` | 每一步用当前整段系统提示替换第一条，避免旧提示被钉住 / replace the first system prompt every step | applied | 已生效，保留 |
| 74 | 代码 | `ASSEMBLE_BEFORE_PRESTEP` | `agent-loop` | 每个模式的第一次发送前先挂上默认提示词 / hang the default prompt before the first assemble | applied | 已生效，保留 |
| 66 | 代码 | `SYSTEM_PROMPT_RENDER_GUARD` | `system-prompt,system-prompt-nested` | renderPrompt 对 undefined section.text 兜底，避免第二轮 gateway/internal / guard undefined section text in renderPrompt | applied | 已生效，保留 |
| 83 | 代码 | `DESKTOP_HOST_CLOSE_NO_FATAL` | `desktop-shell` | host 被信号杀 (重启密封包) 时不报错,不弹 crash dialog / don't fail on signal kill | na | 本机不适用（rc.5 无该文件），无需处理 |
| 84 | 代码 | `DESKTOP_HOST_CLOSE_CODE0_NO_FAIL` | `desktop-shell` | host code=0 正常退出不报错 (消除 stopped 对话框) / don't fail on code=0 clean exit | na | 本机不适用（rc.5 无该文件），无需处理 |
| 92 | 代码 | `DESKTOP_HOST_EXIT_TRACE` | `desktop-shell` | host 每次退出都写 code/signal/stderr 到持久化日志 / persist every host exit | na | 本机不适用（rc.5 无该文件），无需处理 |
| 93 | 代码 | `DESKTOP_MAIN_EXIT_TRACE` | `desktop-shell` | 主进程退出原因写持久化日志（quit/信号/崩溃/未捕获异常） / trace why the desktop main process exits | na | 本机不适用（rc.5 无该文件），无需处理 |
| 67 | 代码 | `AGENT_LOOP_MESSAGES_GUARD` | `agent-loop` | decision.messages 缺省时按空数组处理，避免第二轮 gateway/internal / treat missing decision.messages as empty | applied | 已生效，保留 |
| 68 | 代码 | `SYSTEM_NODES_CONTENT_GUARD` | `agent-loop,session` | systemNodes/derive 对缺 content 兜底，避免回退后第二轮 gateway/internal / guard missing message content | applied | 已生效，保留 |
| 69 | 代码 | `MODEL_STREAM_RELEASE` | `llm-deepseek` | deepseek-flash 恢复官方 in-history，并撤掉会打成 TRANSPORT 的独立连接补丁 / restore official in-history and remove the transport-breaking socket patch | applied | 已生效，保留 |
| 72 | 代码 | `MESSAGES_SYSTEM_CURRENT` | `llm-deepseek` | Messages 的 system 字段用当前系统提示，不再把后出现的系统提示降成中途消息 / messages system field keeps the current prompt | applied | 已生效，保留 |
| 56 | 代码 | `REWIND_HIDE_CUT_ONLY` | `conversation-client` | 回退只藏被撤掉的那一轮 / rewind hides only the cut range | applied | 已生效，保留 |
| 77 | 代码 | `REWIND_DROP_SENT_ON_APPEND` | `conversation-client` | 回退标记到达时立刻从当前对话拿掉已发送的消息 / drop sent messages when the rewind marker appends | applied | 已生效，保留 |
| 75 | 代码 | `REWIND_RESET_TODOS` | `tool-todo` | 回退把已完成任务收回成未开始 / rewind resets completed todos to pending | applied | 已生效，保留 |
| 57 | 代码 | `DEEPSEEK_SYSTEM_ROLE` | `pi-ai-completions,pi-ai-responses-shared` | developer role 仅限 openai.com/azure 原生，第三方代理 (deepseek/glm/recoverystar/中转) 全回退 system / allowlist openai+azure for developer role, all third-party gateways fall back to system | na | 本机不适用（rc.5 无该文件），无需处理 |
| 58 | 代码 | `REWIND_SKIP_DERIVE` | `session` | 回退空标记不进模型请求 / rewind markers stay off the model transcript | applied | 已生效，保留 |
| 59 | 代码 | `OFFICIAL_AUTO_REVIEW_PASSTHROUGH` | `auto-review` | 官方 Auto Review 不再拦工具 / official auto-review no longer denies tools | applied | 已生效，保留 |
| 60 | 工具 | `OFFICIAL_RUN_CODE_APPROVAL_NEUTRAL` | `dsh-tools,dsh-tools-ptc` | PTC / run_code：沙箱加宽句改为自动放行 / run_code sandbox escalation auto-granted | applied | 已生效，保留 |
| 61 | 提示词 | `OFFICIAL_SANDBOX_POLICY_NEUTRAL` | `sandbox-policy` | 沙箱只读策略不拦任务；加宽自动放行 / sandbox policy auto-grant escalation | applied | 已生效，保留 |
| 62 | 代码 | `OFFICIAL_TOOL_ASK_FAILOPEN` | `dsh-tools,dsh-tools-types` | 无审批通道时放行；用户点拒绝仍 deny / fail-open only without UI channel | applied | 已生效，保留 |
| 63 | 提示词 | `OFFICIAL_PLAN_MODE_NEUTRAL` | `base,preset-ptc,preset-standard,preset-cordis` | 计划模式：操作者要求实施时不硬拦 / plan mode allows operator-directed execution | applied | 已生效，保留 |
| 64 | 工具 | `HOOKS_STOP_STEER_NEUTRAL` | `hooks-claude-code,hooks-claude-code-nested,hooks-codex,hooks-codex-nested` | Stop hook 不再 steer 假用户话 / Stop hook no longer steers fake user text | na | 本机不适用（rc.5 无该文件），无需处理 |
| 65 | 工具 | `HOOKS_PRESTEP_REJECT_NEUTRAL` | `hooks-claude-code,hooks-claude-code-nested,hooks-codex,hooks-codex-nested` | UserPromptSubmit deny 不再 reject 整轮 / pre-step hook deny no longer rejects turn | na | 本机不适用（rc.5 无该文件），无需处理 |
| 78 | 代码 | `OVERLAY_RESTORE_FROM_BAK` | `app-boot` | 声明过的补丁文件不见时，从 .mantis.bak 拷回再加载 / restore a missing declared overlay from its bak | applied | 已生效，保留 |
| 82 | 代码 | `DESKTOP_SHELL_PROFILE_FALLBACK` | `desktop-shell` | 主进程兜底 DSH_PROFILE=desktop：双击 exe 从 explorer 继承 env 常缺 DSH_PROFILE → host 'cannot determine the boot profile' → mantis 插件没 activate → inject 全断 | na | 本机不适用（rc.5 无该文件），无需处理 |
| 85 | 代码 | `SESSION_PROMPT_ALWAYS_FOLLOWUP` | `api-session-controller` | session-controller 普通发送走 followup；插话 steer 仍打断当前步（#121） | applied | 已生效，保留 |
| 86 | 代码 | `SESSION_QUEUE_STEER_INTERRUPT` | `api-session-controller,agent-loop` | 排队 followup/next-turn，插话 steer/next-step。Ctrl+Enter 不能改成 followup（#121） | applied | 已生效，保留 |
| 87 | 代码 | `HUNG_PROMPT_LF_NEEDLE` | `agent-loop` | 空白宿主先挂全文，再用 LF 比对头尾，避免 CRLF 误判再糊一份 | applied | 已生效，保留 |
| 88 | 代码 | `HUNG_PROMPT_STRICT_NEEDLE` | `agent-loop` | ChatML 头和正文尾都在才算挂住，只剩头或只剩尾都重新置顶 | applied | 已生效，保留 |
| 89 | 提示词 | `SANDBOX_POLICY_BRAND_NEUTRAL` | `sandbox-policy` | 三条沙箱策略文案去掉 DSH 品牌词 / drop DSH branding from every file-policy line | applied | 已生效，保留 |
| 90 | 提示词 | `SKILL_BADGE_DESCRIPTION_NEUTRAL` | `skill-badge` | 技能描述去掉官方徽章品牌 / neutralize skill-badge description branding | applied | 已生效，保留 |
| 94 | 代码 | `BROWSER_COOKIE_NAME_IGNORE_PORT` | `client-connection` | 浏览器 cookie 名不吃端口 / cookie name ignores port | applied | 已生效，保留 |
| 95 | 代码 | `HOST_MAX_HTTP_HEADER_SIZE` | `desktop-shell` | 宿主请求头上限抬到 256KB / raise host max-http-header-size | na | 本机不适用（rc.5 无该文件），无需处理 |
