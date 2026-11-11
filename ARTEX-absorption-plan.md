# ARTEX 能力吸收与「虫珀·拒斧」红队/演练台升级方案

> 研究对象：`github.com/Hinln/ARTEX`（基于 Autumn-27/ARTEX v0.3.15 的源码备份，Go + Next.js + PostgreSQL，AGPL-3.0，1.4k★）。
> 目标：把 ARTEX 的**方法论与知识**吸收进拒斧的红队模式与演练台，用我们自己的 JS/SQLite 栈重写，不照搬其源码。
> 状态：方案稿（待 G 拍板后按阶段实施）。

---

## 0. 先说一条硬边界：许可证

ARTEX 是 **AGPL-3.0**，拒斧是 **Apache-2.0**。AGPL 有强传染性（网络分发也要开源衍生作品）。
**所以只吸收「思想/架构/提示词心法」，全部用我们自己的代码与措辞重写；绝不 vendor 它的 Go 源码、不逐字复制它的提示词正文、不把它的 `db/schema.sql` 直接搬过来。**
这正是「为我所用」而非「抄一份」——下面每一项都按这个原则给落点。

---

## 1. ARTEX 能力全景（它到底强在哪）

一句话：**LLM 多 agent 驱动的自主渗透系统**，事件驱动闭环，双图驱动，全程留痕，人在环路可介入。

- **技术栈**：Go 单体后端（`go:embed` 内嵌 Next.js 前端）+ PostgreSQL；agent 能力由 `norma` SDK 提供（agentcore/tool/permission/harness/memory/transcript）。
- **双图架构**（核心）：
  - **资产图 Asset Graph**（全局共享／跨任务同一份真值库）：`root_domain / subdomain / ip / service / app / endpoint`，归属公司；父子关系与去重 key 全由程序算，agent 只交原始信息。
  - **探索图 Exploration Graph**（每任务独立）：`goal / intent / fact / finding / hint`（+ begin/digest），边 `spawns / derived_from / yields / proves / covers` 连成血缘链。
  - **锚点 `exploration_anchors(node_id ↔ asset_id)`** 把两图连起来 → 支撑「资产测试覆盖度」与「资产覆盖图（范围内资产 + 已测高亮）」。
- **事件驱动引擎闭环**：图一变 → debounce 唤醒 **planner** → 读态势（`graph_overview` 预取 + coverage/scope）→ 只在有未覆盖新方向时派 **intent** 进 frontier → **worker** 领一条 intent、用真实工具执行、把 fact/asset/finding/activity 写回 → 再触发下一轮 → 直到 `prove_goal` 自动收官。
- **planner 跨唤醒共享 todolist**：串行利用链（①注入点→②凭据→③横向→④提权）分步派、按依赖推进，不并行乱炸。
- **worker 过程级信息交换**：`search_all_worker_traces / list_worker_traces / get_worker_trace` —— 后续 worker 能复用他人「执行过程」里的观察，而不只是正式 fact。
- **六角色 agent**：`goals`（目标分解+抽约束）、`planner`、`worker`、`mainagent`（人在环路聊天）、`auto`（平台操作助手）、`pentest`（单人独立渗透，自带规划+执行+审计）。另有 `reporter`（写漏洞报告）、`retester`（漏洞复测）。
- **支撑子系统**：记录型 **MITM 流量代理**（CA 留痕，`traffic_search/get/blob`）、**guard/intercept 工具审批门**（人在环路审批 + 详情卡）、**enrich**（DNS/HTTP 异步补全）、**MCP**（Streamable HTTP/SSE 动态接）、**memory/transcript**、**notify**（钉钉/飞书/企微/Telegram/邮件/webhook，带脱敏+SSRF 防护+签名）、**selfupdate**（暂存校验+3 次失败回滚）、**ScopeSentry 资产同步**、**任务模板/归档/调度器**、**cold-digest 压缩**、**side questions**。
- **技能**：`api-recon`（路由地图、权限树、静态/运行时 harvest、SPA/MPA 抓取）、`playwright-cli`（浏览器自动化）。

---

## 2. 最值得吸收的 12 项（按价值排序）

| # | ARTEX 机制 | 为何值得 |
|---|---|---|
| 1 | **双图 + 锚点 + 覆盖度** | 「测到哪、哪没测」可见可验收，告别拍脑袋 |
| 2 | **事件驱动 planner/worker frontier** | 自主推进、不重不漏、可自动收官 |
| 3 | **共享 todolist 串行利用链** | 把「发现→拿凭据→横向→提权」按依赖分步走 |
| 4 | **worker 轨迹交换** | 经验在 worker 间以「过程」粒度流动，少重复劳动 |
| 5 | **提示词知识**（pentest 六心法 / planner 决策流程 / worker 写回纪律 / goals 分解） | 纯文本、零成本、立刻提升所有角色智力 |
| 6 | **流量录制 MITM + traffic_*** | 证据可回看、报告可引用、少重复 curl |
| 7 | **guard/intercept 审批门** | 高危动作人在环路，可审可拦可回放 |
| 8 | **goals 分解 + 操作约束 task_constraints** | 开局面就锁定范围与红线，注入每轮提示 |
| 9 | **retester 漏洞复测** | 三态结论（仍可复现/已修复/无法确认）闭环 |
| 10 | **reporter 报告 agent** | 一报漏洞自动产专业报告，绑定证据版本 |
| 11 | **api-recon / playwright-cli 技能** | 补上接口侦察与浏览器自动化的硬能力 |
| 12 | **平台化**（MCP/ScopeSentry/通知/模板/归档/cold-digest） | 从「能打」到「好用、可协作、可复用」 |

---

## 3. 拒斧现状对照

**已有（复用得上的）**：64 个 `redteam_*` 工具；23 张表（`scan_run/segment/asset/asset_name/port/service/fingerprint/observation/edge/tag/vuln/score_point/stage/score_hit/credential/access_session/webshell/tunnel/http_evidence/attack_file/attack_step/shot/poc`）；`commander + 6 角色`（recon/assess/vuln-scan/exploit/internal）用 `subagent` 顺序派活、并发≤3、maxDepth 1；证据链 `claimed→observed` 校验；`poc` 库；`drill-grant` 演练台授权；随包技能同步 `$DSH_HOME/redteam/skills`；右侧栏控制台 UI。

**缺（ARTEX 有、我们没有）**：
- 无**探索图**（goal/intent/fact/finding/hint + 血缘 + anchors + activity）；现结构是「资产 + 攻击步骤」，没有「意图/推进入口/证明关系」。
- 无**事件驱动 frontier 引擎**（现在是 commander 按固定角色顺序派；不是 planner 读态势派 intent、worker 领 intent）。
- 无**共享 todolist**、无 **worker 轨迹检索**。
- 无**流量录制代理**（只有静态 `http_evidence` 表，不能回放抓包）。
- 无**工具审批门**（有 drill-grant，但不是每个高危工具的 intercept/review）。
- 无**独立 goals 分解器 + 操作约束**注入。
- 无 **retester / reporter** 专用 agent。
- 技能库偏空（只有用户自配 + 少量），缺 api-recon / playwright。
- 无**资产覆盖图**、无 **ScopeSentry 同步**、无**多渠道通知**、无**任务模板/归档**、无 **cold-digest** 长任务压缩。

---

## 4. 吸收策略（取神不抄形）

三条原则：
1. **栈翻译**：Go/PostgreSQL → Node/SQLite（拒斧 `store-core.js` 已是 SQLite 资产库，探索图作为新表挂同一库）。
2. **保定位**：拒斧是「评分/演练」导向（score_point/score_hit），ARTEX 是「探索」导向。吸收后**两条线并存**：探索图负责「怎么推进」，评分体系负责「拿多少分」，用 anchors 把得分点锚到探索节点。
3. **宿主适配**：ARTEX 自研引擎循环，拒斧宿主已有 `subagent / workflow / todo / 调度`。**用 DSH 现有编排能力实现 planner/worker 循环**（planner 轮次 = 一次 subagent 规划调用；worker = 领一条 intent 的 subagent），不重写一个 Go 式常驻引擎。

映射表（ARTEX → 拒斧落点）：

| ARTEX | 拒斧落点 |
|---|---|
| `explorations / exploration_nodes / exploration_edges / exploration_anchors / activity` | 新增 SQLite 同名表（`redteam_` 前缀，挂 store-core） |
| `goal/intent/fact/finding/hint/digest` 节点 | `kind` 字段复刻（枚举照搬语义，代码自写） |
| planner / worker / goals / pentest 提示词 | **用自己话重写**成拒斧角色稿（融入六心法） |
| frontier 引擎 | `redteam_intent_claim`/`redteam_intent_add` + planner 轮次编排（subagent 驱动） |
| worker traces | `redteam_trace_search/list/get`，数据源 = `attack_step` + `activity` |
| MITM 录制 + traffic_* | 复用/扩展 `http_evidence` + 本地记录代理（见 P3） |
| guard/intercept | 给 `redteam_*` 高危工具加审批前置（复用 host approval 栈） |
| retester / reporter | 新增两个预设子角色稿 + `redteam_retest_*` / `redteam_report_*` 工具 |
| api-recon / playwright-cli | 收编为随包技能 `presets/redteam/skills/`（自写或改写，注意 AGPL） |
| ScopeSentry 同步 | `redteam_asset_import`（外部 API 适配） |
| 通知/模板/归档/cold-digest | 依次 P4 |

---

## 5. 分阶段落地（文件级 + 验收 + 风险）

### Phase 0 · 知识与技能吸收（零架构风险，先做）
- **提示词心法**并入角色稿：把 pentest「六心法」（先广后聚/走透再判死/封锁不无理由重试/对抗式自检/要具体结论/不轻言放弃）、planner「决策流程」、worker「写回纪律（只写增量、observed/inferred、report_finding 必须真触发）」、goals「目标分解 + 抽约束」改写成拒斧自己的 `agents/*.md` 与 `presets/redteam` persona。
- **skills 收编**：新增 `presets/redteam/skills/api-recon/`、`playwright-cli/`（自写实现或参考改写，**不逐字拷贝**）。
- **验收**：起红队会话，六个角色提示词含心法要点；技能库里能看到并加载 api-recon/playwright-cli；`node --check` 通过；`npm pack --dry-run` 无明文泄漏。
- **风险**：极低（改提示词与加技能目录）。

### Phase 1 · 探索图（schema + 工具 + 视图）
- 新表：`exploration / exp_node / exp_edge / exp_anchor / activity`（SQLite）。
- 新工具：`redteam_goal_add/prove/list`、`redteam_intent_add/claim/update/list`、`redteam_fact_record/list`、`redteam_trace_search/list/get`、`redteam_coverage`。
- UI：血缘视图（力导向）+ 资产覆盖图（范围内资产 + 已测高亮）。
- **验收**：一次会话能建 goal→intent→fact→finding 血缘；coverage 数字与实际资产一致；UI 可点开节点看证据。
- **风险**：中（新表迁移 + UI）。

### Phase 2 · 事件驱动 planner/worker（用 DSH subagent 承载）
- planner 轮次：读 `graph_overview`（预取）→ 派 0..N intent → 触发下一轮；`prove_goal` 自动收官；共享 todolist（按任务持久化）。
- 与现有 commander **并存**，用开关切换（`redteam_engine: 'commander' | 'frontier'`）。
- **验收**：给一个靶标，engine=frontier 下能自主跑完多步并自动收官，不重复意图、串行链不错序。
- **风险**：中高（编排逻辑 + 与宿主 subagent 生命周期对接）。

### Phase 3 · 流量录制 + 工具审批门
- 本地记录代理（等价 `:8788`）+ `traffic_search/get/blob`；高危工具（exploit/内网上传/凭据使用）加 intercept 审批前置。
- **验收**：一次利用的请求/响应被录制并可回看；高危动作弹审批、可拦可放可回放。
- **风险**：中（代理与证书、审批栈接入）。

### Phase 4 · retester / reporter / 通知 / 归档 / 模板 / ScopeSentry
- 逐项补平台化能力。
- **风险**：低-中，各自独立。

---

## 6. Phase 0 具体清单（建议立刻做）

1. `presets/redteam/skills/api-recon/`：SKILL.md + scripts（route map / perm tree / static+runtime harvest）。
2. `presets/redteam/skills/playwright-cli/`：SKILL.md + references。
3. `lib/redteam/index.js` 的 `installPreset` 同步新技能目录。
4. 六个 `agents/<code>.md` 角色稿融入六心法与写回纪律（自写措辞）。
5. persona（`agent.cordis.yml`）加「先广后聚 / 走透再判 / 对抗自检 / 只报可复现成果」要点。
6. 新增 `redteam_goal_add/prove`、`redteam_constraint_add/list` 两个最小工具 + 表（为 Phase 1 铺路）。
7. 验证：`node --check`、技能加载、`npm pack --dry-run` 无明文、控制台技能页可见。

---

## 7. 需要 G 拍板的三件事

1. **先做哪一档**：建议 **Phase 0**（零风险、立刻提升智力）先落地，再上 Phase 1 探索图。
2. **是否接受「并行保留 commander」**：Phase 2 让新引擎与旧顺序派活共存、开关切换（更稳，但多一份维护）。
3. **许可证口径**：确认「只取思想/自写实现、不 vendor ARTEX 源码」——这是 Apache-2.0 下唯一稳妥做法。
