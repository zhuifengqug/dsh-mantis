---
name: campaign-planning
description: 红队作战规划：把“靶标名称”转成目标、范围白名单、攻击假设、时间盒、噪声预算、停止条件和清理计划；动手前先定打法，避免只按得分清单机械扫描
whenToUse: 开始一个新靶标、阶段推进、连续失败、需要决定“下一步打哪条路”时
role: plan
enabled: true
---

# 红队作战规划（先定目标，再动手）

## 为什么需要

没有计划的“扫描 + 找漏洞”会变成三件事：重复打、噪声大、只捡容易分的漏洞。
真实红队先回答：**为了什么、打哪里、怎么打、什么时候停、怎么证明、怎么收尾**。

> 本地适配：本机是**主会话指挥 + 五个执行角色**（`recon / assess / vuln-scan / exploit / internal`，同一靶标最多 3 个并发执行智能体，由 `redteam_agent_slot` 硬卡）的编排，没有上游那套 worker 战役预设与 `redteam_next_action` 队列。所以规划产物落在**本会话 + 资产库**里：范围进 `redteam_engagement_open` 的 scope，打法进子智能体的角色稿，进度看 `redteam_score_list` / `redteam_explore_overview` / `redteam_unknown_list`。

## 一、开工前必须产出的 7 件事

1. **目标与成功标准**
   - 计分目标：当前得分、剩余高分点、必须拿下的阶段（先 `redteam_score_list` 看 `cap_used` / `capped`）；
   - 业务目标（用户提供时）：核心系统、数据、域控/云控制面；
   - 成功标准写成可验证的结果，不写“尽量多打”。

2. **范围白名单**
   - 域名、IP/CIDR、云账号、供应商/子公司、时间窗 —— 写进 `redteam_engagement_open` 的 `scope`；
   - 只打白名单内资产；落库前用 `redteam_scope_check` 过一遍，`out` 的只记线索不探测；
   - 供应商/第三方/云服务必须用户明确确认，不能默认“同单位”；
   - **资产分级 T0–T3**：T0 直接归属 / T1 强相关（需证据）/ T2 弱相关（同 C 段、旁站、同 favicon、共享托管、供应商）/ T3 无关；T0/T1 穷尽后才申请 T2，T3 不碰；
   - **穷尽标准**：RCE/进内网、数据接口/数据库、凭据复用路径都试过并记录失败/阻塞（`redteam_asset_test` 的 `surface` 清空、`redteam_unknown_record` 写清卡点），不只是扫完端口。

3. **资产类型盘点**
   - 按 `Web / 服务器 / 数据库 / 身份与 AD / 边界设备 / 网络设备 / 云与 K8s / IoT-OT / 文件与备份 / AI-Agent / 供应链` 分类（分类决定用哪套打法，见 `specialist-paths`）；
   - 每类至少回答：入口在哪里、谁能访问、当前有什么证据、最可能拿什么分。

4. **攻击假设（多条路径）**
   - 至少写 2–3 条互相独立的初始访问路径；
   - 每条路径写：入口 → 需要的条件 → 预期证据 → 失败信号 → 替代路径；
   - 不要把所有资源压在一个 Nday 或一个后台弱口令上。

5. **时间盒与预算**
   - 每个阶段/资产类别的最长时间、请求量、并发数（并发执行智能体 ≤3）；
   - 明确“什么时候停止这条路径”，避免无限爆破/无限重试；
   - 优先高分且证据要求明确的路径，但不为凑分在同一个服务刷账号（G1/G3）。

6. **OPSEC 与停止条件**
   - 扫描速率、源 IP/出口、User-Agent、工具指纹、账号锁定风险；
   - 哪些动作会触发 EDR/IDS/蜜罐/封禁（细节见 `opsec-hygiene`）；
   - 出现以下情况立即停：账号锁定、目标业务异常、被明确封禁、误伤非靶标、用户要求停止；
   - 不做破坏性动作；改配置先备份、留回滚值。

7. **验证与交付**
   - 高价值成果必须**独立复核**：换一条命令、重新登录、另一个智能体复现（`redteam_evidence_verify` 记复核结论）；
   - 证据状态标 `self`（自测）或 `verified`（复核），报告只把 verified 当强结论；
   - 复现材料：命令/报文/截图/攻击文件路径（`redteam_chain_add` + `redteam_shot_add` + `redteam_http_evidence_add`）；
   - 收尾：`redteam_cleanup op=list status=open` 归零后交付，保留必要证据，不清理目标日志。

## 二、作战节奏

`text
情报与范围 → 资产分类 → 攻击假设 → 小步验证 → 扩大成果 → 独立复核 → 交付/清理
`

- 每个阶段结束先看落库和证据（`redteam_asset_stats` / `redteam_explore_coverage`），再决定下一阶段；
- 失败路径要写“为什么失败、还差什么”（`redteam_unknown_record`），不要静默换目标；
- 新发现的双网卡/云凭证/AD 路径，回到规划层重排优先级；
- 派活：`redteam_role_prompt` 取角色稿 → 子智能体 prompt 第一行写 `redteamRole: <code>`；`redteam_agent_slot` 占并发名额。

## 三、和现有工具/技能配合

- `redteam_preflight`：资源与技能可用性（缺 key/缺工具先要，别打到一半才发现）；
- `redteam_score_list` / `redteam_asset_stats` / `redteam_sessions`：当前事实；
- `redteam_asset_query` / `redteam_vuln_query`：避免重复；
- `redteam_batch`：批量落资产/评估/漏洞（资产 500、评估与漏洞各 200），比逐条调用省轮次；
- `redteam_chain_add`：把“假设 → 动作 → 结果”留痕；`redteam_score_hit` 的 `evidence` 只写结果；
- `specialist-paths`：资产不属于 Web/服务器时按类型换打法；
- `score-coverage`：把打法映射到 25 个得分 code；
- `deepseek-web-intel`：公开情报检索与网页正文；
- `browser-automation` / `kimi-webbridge`：需要真实登录/交互验证时。

## 四、常见错误

- 只按容易扫的 Web 资产推进，忽略 VPN/VDI/Exchange/AD/云；
- 一个入口失败就反复重试，不写失败原因；
- 为了分数在同一服务刷多个账号（服务已拿满，不计分）；
- 账号类得分不带 `access_id`、只拿未授权接口当账号权限；
- 没有停止条件，扫描到被封才停；
- 自测即当成果，没有独立复核；
- 报告只有得分，没有目标、影响、清理和未覆盖项。
