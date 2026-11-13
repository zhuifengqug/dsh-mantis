# 1.4.0

## 中文

- **适配 DSH 0.2.2-rc.3**：宿主把沙箱升级错误从 `Error` 改为带错误码的 `SandboxEscalationError`，`repeat-tool-reminder` 去掉 block 分支；补丁表为 #13 / #35 / #18 追加 rc.3 变体（旧 pattern 保留），解包 rc.3 树跑 `patchStatus` 漂移归零；`dshTarget/dshTargets` 与已验证宿主清单改为 `0.2.2-rc.3`。
- **录制触发改为后端驱动**：不再「进流量页就开录」，改为派发第一个智能体时自动开录、最后一个结束时自动停（只停自动起的这次）；面板只读状态、留手动按钮。
- **工具错误码**：`withStructuredErrors` 输出新增 `error_code`，优先按宿主显式错误码归类（bad_input / unavailable / failed）。

- **零配置录制（方案 A）**：录制期间自动把 `HTTP(S)_PROXY/ALL_PROXY`、`NODE_USE_ENV_PROXY` 及 `NODE_EXTRA_CA_CERTS / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE / SSL_CERT_FILE / GIT_SSL_CAINFO` 注入宿主进程环境（`NO_PROXY` 并回环），子智能体 shell 的 curl/python/git/node 自动走本机 MITM 并信任自签 CA，停止即还原；不改系统代理、不写信任库。派首个智能体时自动开录、末个结束自动停。
- **插件出站也落库（方案 B）**：插件自身的 HTTP 出站（WebShell 连通性探测）直接写一条 `traffic_flow`（`source='plugin-http'`），与录制/导入同表、同检索、同绑定。
- **移除方案 C**：删除面板「证书」子页与 `mitmCaInfo/mitmCaExport` 导出/安装指引——CA 只自动生成给子进程用，不再有手动导出/装信任库入口。
- **流量导入（方案 b）**：新增「导入 HAR」——不启代理、不装 CA，直接把 Burp / mitmproxy / Chrome DevTools 导出的 `.har` 解析进 `traffic_flow`（`source='har'`）。复用现有检索 / 详情 / blob / 绑定，body 按 sha256 落本机 blob；`flow_key = sha256('har'+idx+method+url+startedDateTime)`，同一份 HAR 重复导入幂等。内置 MITM 录制与审批门保留，降为可选。面板「流量/审批 → 流量」工具栏新增按钮；`trafficImport` 走 dispatch，仅面板入口，不新增智能体工具。

## English

- **DSH 0.2.2-rc.3 support**: the host now throws a coded `SandboxEscalationError` on sandbox escalation and drops the block branch in `repeat-tool-reminder`; the patch table gains rc.3 variants for #13 / #35 / #18 (old patterns kept), and `patchStatus` on the extracted rc.3 tree is drift-free. `dshTarget/dshTargets` and the qualified-host list move to `0.2.2-rc.3`.
- **Backend-driven recording trigger**: no longer "open the Traffic tab to record"; the backend auto-starts recording when the first agent is dispatched and stops when the last one ends (only the auto-started session). The panel shows status and keeps a manual button.
- **Tool error codes**: `withStructuredErrors` now emits `error_code` and classifies by the host's explicit codes first (bad_input / unavailable / failed).

- **Zero-config recording (option A)**: while recording, the plugin injects `HTTP(S)_PROXY/ALL_PROXY`, `NODE_USE_ENV_PROXY` and `NODE_EXTRA_CA_CERTS / CURL_CA_BUNDLE / REQUESTS_CA_BUNDLE / SSL_CERT_FILE / GIT_SSL_CAINFO` into the host process env (`NO_PROXY` includes loopback). Child-agent shells (curl/python/git/node) automatically use the local MITM and trust the self-signed CA; restored on stop. No system proxy, no trust-store write. Recording auto-starts when the first agent is dispatched and stops when the last one ends.
- **Plugin egress recording (option B)**: the plugin's own HTTP egress (WebShell connectivity probe) writes a `traffic_flow` row (`source='plugin-http'`), same table / search / bind as recorded or imported flows.
- **Option C removed**: deleted the panel's "证书" sub-tab and the `mitmCaInfo/mitmCaExport` export/install-guide ops — the CA is auto-generated for child processes only; no manual export/trust-store entry.
- **Traffic import (option b)**: new "Import HAR" — no proxy, no CA. Parses Burp / mitmproxy / Chrome DevTools `.har` files into `traffic_flow` (`source='har'`), reusing the existing search / detail / blob / bind paths. Bodies are stored as local sha256 blobs; `flow_key = sha256('har'+idx+method+url+startedDateTime)` makes re-imports idempotent. The built-in MITM recorder and approval gate remain, now optional. Button lives in the Traffic toolbar; `trafficImport` is panel-only (no new agent tool).

# 1.2.0

## 中文

- 版本 **1.2.0**：三缺口收口 —— **L2 面板「开始 / 停止录制」按钮**、**L1 红队「报告员 / 复测员」两个独立预设**、**L3 `traffic_flow` 按靶标隔离**。三块均先落设计契约（`docs/redteam/L1L2L3-design.md`）再实现，红队工具总量保持 **111 个**（64 基线 + 29 探索 + 11 P4 + 7 流量/审批），既有工具签名未改、关闭与回滚路径未动。版本号 `1.1.0 → 1.2.0`（新增 `./redteam/tools-ops` 导出属发布面 minor 变更）。
- **L2 · 面板「开始 / 停止录制」按钮**（`lib/redteam/store-core.js` + `lib/redteam/client.js`）：
  - 后端补齐三个面板 op：同步 `proxyStatus`、异步 `proxyStart` / `proxyStop`，统一经 `proxyView` 返回 `{running, port, mode:'mitm', caPath, caReady, flows, ...}`。此前 `proxy.js` 的启停能力齐备，但 dispatch 表里没有对应 op、面板点不到，这次接上。
  - 「流量」页签顶部新增录制控制条：开始 / 停止 / 重试、绿脉冲运行态、实时端口与已录条数（录制中每 1.5 秒轮询 `proxyStatus`）、`mode: mitm` 提示；错误按 code 给文案：`EADDRINUSE`（端口 18081–18099 全占 → 改起始端口）、`EACCES`、`ALREADY_RECORDING`（别的靶标在录）、`NO_ENGAGEMENT`（未选靶标，不建库）。
  - **单活跃录制**：`mitm/state.json` 只存一份，故同一时刻只允许一个靶标录制；`proxyStart` 前先查 `proxyStatus`，别的靶标在录直接返回 `ALREADY_RECORDING`，不覆盖。
  - **CA 仍只生成、只导出**：`caReady` 只表示证书文件已生成，不代表已被系统信任；未装信任时 HTTPS 站点报证书错，面板提示去「证书」页导出并手动安装。插件任何路径都不执行 `certutil -addstore` / `security add-trusted-cert` / `update-ca-certificates`，**信任库必须人手动装**；`mode` 写死 `mitm`，不设系统代理、不改 `HTTP_PROXY`。
- **L1 · 红队「报告员 / 复测员」两个独立预设**（`presets/redteam-reporter`、`presets/redteam-retester` + `lib/redteam/index.js` / `tools.js` / `tools-ops.js`）：
  - 新增两个随包预设：**红队·报告员**（order 11，只读资产/漏洞/证据/得分/攻击链，产出 `redteam_report_build`「score/finding/coverage/final」；不动手攻击、不复测、不派活）与 **红队·复测员**（order 12，对单条 finding 复测，落 `reproduced/fixed/inconclusive` 结论并联动 `vuln.status`，不写整份报告）。
  - 两者 `name` 均保留「红队」二字以命中 `isRedteamPresetId`；工具面用 `tools.js` 的 `PROFILE_TOOLS` 白名单按 profile 收口 —— 主预设（`full`）零差异，报告员 **44 个**（41 个主工具 + 3 个只读流量：`traffic_search|get|blob`，无绑定 `traffic_bind`、无审批 `intercept_*`、无提权/复测/通知）、复测员 **12 个**工具（有 `redteam_retest_request|list|conclude` + `vuln_update`，无报告/模板）。`tools-ops.js` 补 `name/inject/apply` 导出并作为独立插件行挂载，`package.json exports` 增 `./redteam/tools-ops`；`index.js` 的 `installPreset/apply/buildDefinition/registerOnce` 循环化三个预设。
  - **何时用**：主预设走全流程（指挥 + 五角色 + 并发≤3）；报告员用于已有 findings/score 之后收尾出报告；复测员用于修复后对 `open` 漏洞逐条回验。三预设共用同一 `RedteamStore` / `engagements/` 目录、靶标互通；从主预设切到报告员是新建会话、需重新绑定同一靶标（不继承会话上下文，有意为之）。
- **L3 · `traffic_flow` 按靶标隔离**（`lib/redteam/schema.js` / `traffic.js` / `store-core.js` / `proxy.js` / `tools-traffic.js`）：
  - `traffic_flow` 增两列 `engagement_id`、`target`（`NOT NULL DEFAULT ''`）与索引 `ix_traffic_engagement`；旧库走 `migrate()` 的 `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` 补齐，**不重建表、不丢历史数据**，回填在 `db()` 打开时按当前靶标 id 跑一次。
  - 写入端三层带靶标：flow 行内、`buildRow` 输出、spool 目录的 `owner.json`；`ingest` 只灌归属本靶标的 spool，别的靶标流量不再串进当前库。
  - 读取端 `search/get/blob/bind` 默认按当前靶标过滤，跨靶标被拒；仅工具 `redteam_traffic_search` 增 `all_targets:true` 显式跨靶标（返回带 `cross:true`），面板不提供该开关。面板零改。
- **打包卫生**：`.npmignore` 增补 `docs/agents/` 与 `scripts/tmp-*`，`npm pack --dry-run` 复核结果不含 `default-prompt-inject*` / `*.bak` / `*.old.*` / `docs/agents` / 临时脚本；三组预设（`redteam`、`redteam-reporter`、`redteam-retester`）正常随包。
- **验证**：`node --test` **98/98 全绿**（新增 `proxy-panel-ops` 4 例、`traffic-isolation` 5 例、`preset-l1` 3 例）；`node --check` 覆盖 `lib/**`、`client.js`、`bin/` 共 **93 个 JS 文件**全通过；`npm pack --dry-run` 文件清单干净。**未做**：真实宿主热重载 L1（需重启宿主才生效）。
- **残余风险**：① 运行中的宿主不会热重载 L1，需重启后才出现两个新预设；② 旧库历史上已串入的流量无法自动拆回真实靶标，需按 `session_id` / 时间窗手工 SQL 更正（`UPDATE traffic_flow SET engagement_id='<靶标>', target='<名>' WHERE session_id='<key>'`）；③ 旧 spool 无 `owner.json` 时由第一个 ingest 的靶标先到先得认领。

## English

- **1.2.0** — closing three known gaps: the L2 panel **Start/Stop recording** button, two standalone L1 red-team presets (**reporter / retester**), and **per-engagement isolation** of `traffic_flow`. All three were contract-first (`docs/redteam/L1L2L3-design.md`) then implemented; the red-team tool total stays **111** (64 baseline + 29 exploration + 11 P4 + 7 traffic/approval), existing signatures untouched, close/rollback paths unchanged. Version `1.1.0 → 1.2.0` (the new `./redteam/tools-ops` export is a minor surface change).
- **L2 · panel Start/Stop recording** (`lib/redteam/store-core.js` + `lib/redteam/client.js`):
  - Three panel ops added: synchronous `proxyStatus`, asynchronous `proxyStart` / `proxyStop`, all normalized through `proxyView` to `{running, port, mode:'mitm', caPath, caReady, flows, ...}`. `proxy.js` already had start/stop; the dispatch table had no matching op so the panel could not reach them — now wired.
  - A recording bar atop the Traffic tab: start / stop / retry, a green pulse while running, live port and flow count (re-polling `proxyStatus` every 1.5 s), a `mode: mitm` note; errors map by code — `EADDRINUSE` (ports 18081–18099 all taken → change the start port), `EACCES`, `ALREADY_RECORDING` (another engagement is recording), `NO_ENGAGEMENT` (no engagement selected; no DB is created).
  - **Single active recording**: `mitm/state.json` holds one slot, so only one engagement records at a time; `proxyStart` checks `proxyStatus` first and returns `ALREADY_RECORDING` instead of overwriting.
  - **CA is still generate-and-export only**: `caReady` means the cert file exists, not that it is trusted; if trust is missing, HTTPS sites report cert errors and the panel says to export in the Certificates tab and install manually. No path ever runs `certutil -addstore` / `security add-trusted-cert` / `update-ca-certificates` — **installing trust is manual**; `mode` is fixed at `mitm`, no system proxy, no `HTTP_PROXY` change.
- **L1 · standalone reporter / retester presets** (`presets/redteam-reporter`, `presets/redteam-retester` + `lib/redteam/index.js` / `tools.js` / `tools-ops.js`):
  - **Red-team · Reporter** (order 11: reads assets/vulns/evidence/score/attack chains, produces `redteam_report_build` for `score/finding/coverage/final`; no attacking, no retesting, no delegation) and **Red-team · Retester** (order 12: retests a single finding, records `reproduced/fixed/inconclusive` and updates `vuln.status`; no full report).
  - Both keep 「红队」 in `name` to satisfy `isRedteamPresetId`; the tool surface is filtered by the `PROFILE_TOOLS` allowlist in `tools.js` — the main preset (`full`) is unchanged, while reporter gets **44** (41 core + 3 read-only traffic: `traffic_search|get|blob`, with no `traffic_bind`, no `intercept_*`, no exploit/retest/notify) and retester **12** (reporter has `redteam_report_build`; retester has `redteam_retest_request|list|conclude` + `vuln_update` but no report/templates). `tools-ops.js` gains `name/inject/apply` exports and mounts as its own plugin row; `package.json exports` adds `./redteam/tools-ops`; `index.js` `installPreset/apply/buildDefinition/registerOnce` loop over the three presets.
  - **When to use**: the main preset runs the full flow (commander + five roles + concurrency ≤ 3); the reporter finishes reporting once findings/score exist; the retester re-verifies `open` vulns after a fix. All three share the same `RedteamStore` / `engagements/` directory (targets interoperate); switching from the main preset to the reporter is a new session and needs the same engagement re-bound (no context carry-over, by design).
- **L3 · per-engagement `traffic_flow` isolation** (`lib/redteam/schema.js` / `traffic.js` / `store-core.js` / `proxy.js` / `tools-traffic.js`):
  - `traffic_flow` gains `engagement_id`, `target` (`NOT NULL DEFAULT ''`) and index `ix_traffic_engagement`; old DBs are upgraded via `migrate()`'s `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` — **no table rebuild, no data loss** — with a one-time backfill at `db()` open against the current engagement id.
  - Three write layers carry the target: the flow row, `buildRow`, and the spool `owner.json`; `ingest` only loads spools owned by the current engagement, so another engagement's traffic no longer leaks into this store.
  - Reads (`search/get/blob/bind`) filter by the current engagement and reject cross-engagement access; only the `redteam_traffic_search` tool exposes `all_targets:true` for an explicit cross-target query (returns `cross:true`), and the panel does not offer that switch. The panel is unchanged.
- **Packaging hygiene**: `.npmignore` now excludes `docs/agents/` and `scripts/tmp-*`; `npm pack --dry-run` confirms no `default-prompt-inject*` / `*.bak` / `*.old.*` / `docs/agents` / temp scripts, and all three preset groups (`redteam`, `redteam-reporter`, `redteam-retester`) ship.
- **Verification**: `node --test` **98/98 green** (new `proxy-panel-ops` ×4, `traffic-isolation` ×5, `preset-l1` ×3); `node --check` passes over **93 JS files** (`lib/**`, `client.js`, `bin/`); `npm pack --dry-run` file list is clean. **Not done**: a live host hot-reload of L1 (a restart is required for the two new presets to appear).
- **Residual risks**: (1) a running host does not hot-reload L1 — restart to see the two new presets; (2) traffic already cross-contaminated in an old DB cannot be auto-split, fix by hand with SQL keyed on `session_id` / time window (`UPDATE traffic_flow SET engagement_id='<target>', target='<name>' WHERE session_id='<key>'`); (3) a legacy spool with no `owner.json` is claimed first-come-first-served by whichever engagement ingests it.

# 1.1.0

## 中文

- 版本 **1.1.0**：ARTEX 吸收线（P1 数据层已在 `81093ae` 落地）。本次接入 **P2 探索引擎与工具层**、**P4 报告 / 复测 / 通知 / 归档 / 任务模板 / 调度**，以及 G 拍板的 P3 方案 (a) **流量录制与审批门**。红队工具从 64 个增到 **111 个**，既有 64 个一行未删，关闭与回滚路径零改动。
- **P2 探索引擎：被动驱动，零常驻进程**（`lib/redteam/engine.js`）。引擎不单独跑，寄生在工具返回值里，闭环不靠任何定时器：
  - **`wake` 回声**：写类工具成功后返回 `{planner:true, reason, frontier_open, running, findings, scheduled_due?}`，`reason` 六值（`frontier_changed` / `intent_state_changed` / `fact_recorded` / `finding_recorded` / `graph_changed` / `scheduled_due`）；读类工具不带 wake。
  - **planner 轮次**：`redteam_explore_plan {action:'begin'}` 让 `round_no` +1 并返回 briefing；`decision` 由服务端按 `frontier_open` / `running` / 并发上限 / `findings` 确定性算出 `dispatch|wait|prove|replan`，不由模型拍脑袋。
  - **worker 领取用 CAS**：`UPDATE exploration_node SET state='running' WHERE id=? AND kind='intent' AND state='open'`，`changes===0` 即已被领或不存在，子会话换下一条 —— 双开挡在这一层。领取动作发生在真正的执行者身上，指挥只把 `intent_id` 写进任务书。
  - **孤儿修复**：`subagent/end` 之后 `requeueOrphans(ownerSession)` 把该子会话还挂着的 `running` intent 回 `open`，`blocked_reason='worker-exit-unexpected'`，原 owner 留在 `payload.prev_owner`；没有「子会话 → 靶标」映射就跳过，不猜靶标。
  - **收官守卫**：`redteam_explore_prove` 在还有 `open`/`running` intent 时拒绝 `achieved`（返回被卡的节点清单），除非 `force:true` + `reason`；四条量化判据 `min_findings`（默认 1）/ `min_facts` / `min_coverage_pct` / `require_no_open_intents`，算出 `score∈[0,1]`，prove 成功写审计 digest 节点。
  - **卡死判定与开关**：`running` 且 30 分钟未更新的 intent 列为 `stale_running` 进 briefing；引擎开关 `settings.redteam_engine`（`commander` 默认 / `frontier`），环境变量 `REDTEAM_ENGINE` 次之，非法值回落默认。
- **P2 工具层**：新增 29 个 `redteam_explore_*`（`lib/redteam/tools-exploration.js`）——§1.4 标准 23 个（含 `redteam_engine`），加上任务点名的 6 个别名（`create` / `add_node` / `add_edge` / `list_frontier` / `overview` / `constraint`，共用同一份实现，不复制逻辑），合计 29 个。写 fact / finding 时 `payload.provenance` 必须区分 `observed`（工具/命令实际回显、抓到的响应）与 `inferred`（由已有事实推断、尚未直接验证），报告与复测据此判证据强度。
- **前端「探索」页签**：只读聚合 `exploreGraph`，显示探索状态 / 轮次 / 目标、按 kind/state 的计数、资产覆盖率进度条，节点表点行展开正文 + payload + owner / 父节点 / 优先级 / 阻塞原因，另有前沿意图（P 优先级）、边（`spawns` / `derived_from` / `yields` / `proves` / `covers`）与约束（allow/deny）；本地按类型 / 状态 / 关键字过滤，不发写请求。
- **P4 六项：全部工具触发，无一常驻**（`lib/redteam/ops.js` + `tools-ops.js`，11 个工具）：
  - **报告** `redteam_report_build`：`kind` 四选一 `score|finding|coverage|final`，只读聚合既有表，写 `<靶标目录>/reports/<kind>-<时间戳>-<n>.md` 并落一行 `report_run`，markdown 全文同时存进 `report_run.manifest`（不读文件也能从库里拿全文）；不改业务数据，也不复活已弃用的 `redteam_report` / `redteam_report_targets`。
  - **复测** `redteam_retest_request|list|conclude`：状态 `pending|running|done`，结论 `reproduced|fixed|inconclusive`；`fixed` 把 `vuln.status` 推成 `fixed`，`reproduced` 回到 `open`；不新建漏洞、不碰计分与探索图。
  - **通知** `redteam_notify_send|test`：**严格占位，恒不发请求** —— 只校验事件、脱敏（`Authorization` / `Cookie` / 密码类字段打 `[REDACTED]`）、正文 4096 字符截断，返回 `requests_made:0` 与 `delivered[].status='stub'`。配置在 `settings.notify`，默认 `enabled:false` 且 `urls:[]`；URL 只能由面板写入，工具不接受任意 url 入参（顺手封掉 SSRF 面）。
  - **归档**：靶标状态位写进 `engagement.yaml`（`archived` / `archived_at` / `archive_note`），写保护由 `archivedGuard` 一处实现、dispatch 与工具层共用；归档后写类操作返回 `error_kind='archived'`，读操作、报告生成、复测结论照常。解除归档只有面板 `archiveSet`，不给智能体工具。
  - **任务模板** `redteam_template_list|apply|save`：随包两条 `default` / `web`，用户目录 `<root>/templates/*.json` 同名优先；模板是纯数据（goal + constraints + score_hints + roles），`apply` 默认不覆盖已有 goal/约束，不建资产、不建探索图。
  - **调度** `redteam_schedule_add|list`：`kind` 取 `retest|report|notify`，状态 `due|done|skipped|cancelled`；**没有调度器，只有调度记录** —— 到期条数由 `wake.scheduled_due` 与面板列出，执行仍靠人 / 指挥显式调对应工具。
- **P3 流量录制与审批门**（G 拍板的方案 (a)：`proxy.js` / `ca.js` / `traffic.js` / `intercept.js`）：
  - **MITM 录制代理**：只监听 `127.0.0.1`（显式传 host 才放开），端口从 **18081** 起逐个 bind，占用就 +1，到 18099 仍占用即失败；明文 absolute-form 与 `CONNECT` 解密都走；**默认不自启**，插件 dispose 时统一停。
  - **录制落库**：代理只写 spool（`flows.jsonl` → 完成后 `flows.jsonl.done`），SQLite 由宿主进程这个唯一写者幂等 ingest，重复跑不重复入库；body 按 sha256 去重存 blob，单方向体上限 `recordBodyMax` 默认 2 MiB（0 = 只记头）。
  - **自签 CA**：`CN=ChongPo MITM CA`，落 `<toolkit>/ca`（默认 `$DSH_HOME/redteam/toolkit/ca`），openssl 优先、`node:crypto` + DER 兜底；面板只做信息展示、导出到指定路径与安装步骤文本，**绝不自动改信任库**（信任库那一步必须人手动）。
  - **审批门**：规则两源（`<root>/intercept.json` 文件 + `intercept_rule` 表），命中 `deny` 优先；待批队列 `pending|approved|rejected` 记谁批、何时、什么理由，放行可带 TTL（默认 3600 秒）；`mode` 默认 `off`，off 时判定零开销直接放行。
  - **流量检索与绑定**：4 个 `redteam_traffic_search|get|blob|bind` 加 3 个 `redteam_intercept_check|decide|rule`；`traffic_binding` 可把一条流量绑到 `finding_id` / `vuln_id` / `step_id` / `asset_id`，重复绑定幂等（SQLite 的 NULL 互不相等，所以按「给了就 `=`、没给就 `IS NULL`」显式查重）。
  - **前端「流量/审批」页签**三子页：流量（检索 + 请求/响应头体预览 + 绑定回读）、审批（开关、规则表、待批处理填理由与 TTL）、证书（CA 路径、SHA-256、端口区间、导出与安装指引）。
- **数据与隐私（硬约束不变）**：探索图、流量、审批记录、报告、复测、模板、调度全部落在 `$DSH_HOME/redteam` 的本机 SQLite 与文件里；不上传、无遥测；通知通道默认关闭且不发请求；CA 私钥只在本机 `toolkit/ca` 下生成与导出，插件不写任何信任设置。
- **验证**：`node --test` **84/84 全绿**（engine 15、exploration-graph 2、explore-tools 34、ops-p4 20、traffic-mitm 6、intercept-gate 3、traffic-tools 4）；`node --check` 覆盖 93 个 JS 文件（`lib/**`、`client.js`、`bin/`）全部通过；工具数量自检为 64 基线 + 29 探索 + 11 P4 + 7 流量/审批 = 111；通知未配置时 loopback 反证 0 请求。未执行：真实 MITM 抓包与真实宿主面板截图（需人工在宿主里开一次录制并刷新页面）。

## English

- **1.1.0** — the ARTEX absorption line (P1 data layer landed in `81093ae`). This build adds the **P2 exploration engine and tool layer**, **P4 reporting / retest / notify / archive / task templates / schedule**, and the G-approved P3 plan (a): **traffic recording with an approval gate**. Red-team tools go from 64 to **111**; the existing 64 are untouched and the close/rollback paths are unchanged.
- **P2 engine: passive, no daemon** (`lib/redteam/engine.js`). The engine is not a process; it rides inside tool return values, so the loop needs no timer:
  - **`wake` echo**: every write tool returns `{planner:true, reason, frontier_open, running, findings, scheduled_due?}` with one of six reasons (`frontier_changed`, `intent_state_changed`, `fact_recorded`, `finding_recorded`, `graph_changed`, `scheduled_due`); read tools carry no wake.
  - **planner round**: `redteam_explore_plan {action:'begin'}` bumps `round_no` and returns a briefing; `decision` is computed deterministically from `frontier_open` / `running` / the concurrency cap / `findings` as `dispatch|wait|prove|replan`.
  - **worker claims by CAS**: `UPDATE exploration_node SET state='running' WHERE id=? AND kind='intent' AND state='open'`; `changes===0` means someone else took it, so the child moves on. Double-dispatch dies here, and the claim happens on the real executor — the commander only writes `intent_id` into the task brief.
  - **orphan repair**: after `subagent/end`, `requeueOrphans(ownerSession)` reopens that child's dangling `running` intents with `blocked_reason='worker-exit-unexpected'`, keeping the old owner in `payload.prev_owner`; no child→engagement mapping means skip, never guess.
  - **close-out guard**: `redteam_explore_prove` refuses `achieved` while `open`/`running` intents remain (returning the blocking node list) unless `force:true` + `reason`; four quantitative criteria `min_findings` (default 1) / `min_facts` / `min_coverage_pct` / `require_no_open_intents` produce `score∈[0,1]`, and a successful prove writes an audit digest node.
  - **stale detection and switch**: intents `running` for over 30 minutes surface as `stale_running` in the briefing; the engine switch is `settings.redteam_engine` (`commander` default / `frontier`), then env `REDTEAM_ENGINE`, falling back to the default.
- **P2 tool layer**: 29 new `redteam_explore_*` tools (`lib/redteam/tools-exploration.js`) — the 23 standard names (including `redteam_engine`) plus 6 task-named aliases (`create`, `add_node`, `add_edge`, `list_frontier`, `overview`, `constraint`, sharing one implementation, no duplicated logic), 29 in total. Writing a fact or finding requires `payload.provenance` to separate `observed` (actual tool output, captured response) from `inferred` (unverified conclusion); reports and retests judge evidence strength by it.
- **Explore tab** (front end): read-only `exploreGraph` aggregate — status / round / target, counts by kind and state, an asset-coverage bar, a node table that expands to body + payload + owner / parent / priority / blocked reason, the frontier (priority-ordered), edges (`spawns`, `derived_from`, `yields`, `proves`, `covers`) and constraints (allow/deny); local filtering by type / state / keyword, no write requests.
- **P4: six features, all tool-triggered, none resident** (`lib/redteam/ops.js` + `tools-ops.js`, 11 tools):
  - **Report** `redteam_report_build`: `kind` is `score|finding|coverage|final`; it aggregates existing tables read-only, writes `<engagement dir>/reports/<kind>-<stamp>-<n>.md` and one `report_run` row, with the full markdown also stored in `report_run.manifest` so the whole report is readable from the DB alone; no business data is modified and the retired `redteam_report` / `redteam_report_targets` are not revived.
  - **Retest** `redteam_retest_request|list|conclude`: states `pending|running|done`, conclusions `reproduced|fixed|inconclusive`; `fixed` pushes `vuln.status` to `fixed`, `reproduced` returns it to `open`; no new vulnerabilities, no score changes, no exploration writes.
  - **Notify** `redteam_notify_send|test`: **strict placeholder, never sends a request** — it validates the event, redacts (`Authorization`, `Cookie`, password-like keys become `[REDACTED]`), clips the body to 4096 characters, and returns `requests_made:0` with `delivered[].status='stub'`. Config lives in `settings.notify`, default `enabled:false` and `urls:[]`; URLs can only be written by the panel, and no tool accepts an arbitrary url argument.
  - **Archive**: an archive flag in `engagement.yaml` (`archived`, `archived_at`, `archive_note`) plus write protection from a single `archivedGuard` shared by dispatch and the tool layer; after archiving, write ops return `error_kind='archived'` while reads, report generation and retest conclusions still work. Unarchiving is panel-only (`archiveSet`), not an agent tool.
  - **Task templates** `redteam_template_list|apply|save`: two bundled templates (`default`, `web`), with `<root>/templates/*.json` shadowing them by name; a template is pure data (goal + constraints + score_hints + roles), and `apply` does not overwrite an existing goal/constraints by default, creates no assets and no exploration graph.
  - **Schedule** `redteam_schedule_add|list`: `kind` is `retest|report|notify`, status `due|done|skipped|cancelled`; **there is no scheduler, only schedule records** — due counts appear in `wake.scheduled_due` and the panel, and execution stays an explicit tool call by a human or the commander.
- **P3 traffic recording and approval gate** (plan (a), `proxy.js` / `ca.js` / `traffic.js` / `intercept.js`):
  - **MITM recording proxy**: binds `127.0.0.1` only (a host must be passed explicitly), walks ports from **18081**, +1 on `EADDRINUSE`, failing once 18099 is also taken; handles absolute-form plaintext and `CONNECT` decryption; **never auto-starts**, and is stopped on plugin dispose.
  - **Recording to store**: the proxy only writes spool files (`flows.jsonl` → `flows.jsonl.done` when finished); the host process is the single SQLite writer and ingests idempotently, so re-runs do not duplicate rows. Bodies are deduplicated into blobs by sha256, with a per-direction cap of `recordBodyMax` (default 2 MiB, 0 = headers only).
  - **Self-signed CA**: `CN=ChongPo MITM CA`, under `<toolkit>/ca` (default `$DSH_HOME/redteam/toolkit/ca`), openssl first with a `node:crypto` + DER fallback; the panel only shows info, exports to a chosen path and prints install steps — it **never touches the trust store**; that step is manual.
  - **Approval gate**: rules come from two sources (`<root>/intercept.json` and the `intercept_rule` table) with `deny` winning; the pending queue is `pending|approved|rejected` and records who, when and why, with an optional TTL on allow (default 3600 s); `mode` defaults to `off`, where the check costs nothing and passes through.
  - **Traffic search and binding**: four `redteam_traffic_search|get|blob|bind` tools plus three `redteam_intercept_check|decide|rule`; `traffic_binding` attaches a flow to `finding_id`, `vuln_id`, `step_id` or `asset_id`, and repeat binds are idempotent (SQLite NULLs never compare equal, so dedupe is explicit: `=` when given, `IS NULL` when not).
  - **Traffic/Approval tab**, three sub-pages: traffic (search, request/response header and body preview, binding read-back), approvals (switch, rule table, decide with reason and TTL), certificates (CA paths, SHA-256, port range, export and install guidance).
- **Data and privacy (hard constraints unchanged)**: exploration graphs, traffic, approval records, reports, retests, templates and schedules all land in the local SQLite and files under `$DSH_HOME/redteam`; nothing is uploaded, there is no telemetry, the notify channel is off by default and sends nothing, and the CA private key is only generated and exported under local `toolkit/ca` — the plugin writes no trust settings.
- **Verification**: `node --test` **84/84 green** (engine 15, exploration-graph 2, explore-tools 34, ops-p4 20, traffic-mitm 6, intercept-gate 3, traffic-tools 4); `node --check` passes over 93 JS files (`lib/**`, `client.js`, `bin/`); the tool-count assertion is 64 baseline + 29 exploration + 11 P4 + 7 traffic/approval = 111; with notify unconfigured, a loopback counter-check shows 0 requests. Not executed: a real MITM capture and a screenshot of the real panel (they need a human to start recording in the host and refresh the page).

# 1.0.13

## 中文

- **面板改版：墨 + 琥珀**。原来的绿灰配色与「虫珀 · 拒斧」这个名字没关系，这版换成墨色纸面 + 琥珀强调色，并把版式重排：
  - **牌头**：面板顶部加一条 masthead —— 白底圆角方块里放螳螂 glyph（与插件页 `icon.svg` 同一套路径）、名称「虫珀 · 拒斧」、以及等宽大写副题 `MANTIS · HOST PURGE & DRILL`。
  - **分节序号**：补丁 / 规则集 / 技能 / 界面显示 四节分别标 `01`–`04`，琥珀色等宽数字。
  - **指标卡**：改自适应栅格（`repeat(auto-fit,minmax(148px,1fr))`），每张卡左侧加一条 2px 状态竖条（正常墨绿 / 待处理琥珀 / 异常砖红），数字改等宽（`font-variant-numeric: tabular-nums`），扫描时不再跳动。
  - **按钮**：主按钮琥珀实底，次级按钮透明底 + 细描边（原来次级按钮在深色主题下是一块灰底，对比度很差）；危险按钮保留红色描边。
  - **表格**：行悬停加 7% 琥珀底，长列表更好跟行。
  - **深色主题**：琥珀提亮到 `#d9a75c`、描边降到 24%，避免在深色纸面上糊成一团。
- **新增第 4 张指标卡「已生效 / 未生效」**。它直接读 `asar_still_sealed`：宿主还在从 `app.asar` 跑就是「未生效」，从解包目录跑就是「已生效」。之前这个信息只在上面那条红色警告横幅里出现，正常状态反而看不到。
- **删掉过时的「本地靶场」说明**。那段写「开源版攻击任务只放行本机/内网 IP……解析失败或混有公网地址一律拦截」，但区域门禁在导入 `dsh-purge` v1.1.90 时就已经整块剥掉了 —— `lib/net-scope.js` 开头自己写着「本插件不带区域门禁（不判断攻击任务、不拦公网目标）」，`ownServerNote()` 直接 `return ""`，白名单永远不会进提示词；面板里那张卡也没有输入框、没有按钮，纯粹是一段死文案。这次连同 `own.title`、`own.hint`、`own.save`、`saved.own`、`saved.own.dropped` 五个无人引用的 i18n 键一起删干净。
- **验证**：`node --check client.js` 通过；抽出 `PURGE_CSS` 生成浅色 / 深色两份静态预览，用 headless Chrome 逐版核对布局与对比度（牌头、指标卡、按钮、表格、分节序号）。未执行：真实面板截图（需宿主刷新后由人确认）。

## English

- **Panel redesign: ink + amber.** The old green-grey palette had nothing to do with the name "虫珀 · 拒斧", so this build switches to an ink-paper base with an amber accent and reflows the layout:
  - **Masthead**: a header strip at the top of the panel — the mantis glyph (same paths as the plugin's `icon.svg`) in a white rounded tile, the name, and a monospaced uppercase subtitle `MANTIS · HOST PURGE & DRILL`.
  - **Section numbers**: the four sections (patches / rules / skills / display) are numbered `01`–`04` in amber monospace.
  - **Metric cards**: switched to an auto-fit grid (`repeat(auto-fit,minmax(148px,1fr))`), each card gets a 2px status bar on the left (ok / warn / bad) and tabular figures so numbers stop jittering as they change.
  - **Buttons**: primary is solid amber; secondary buttons are transparent with a hairline border (they used to render as a grey block on the dark theme, with poor contrast); destructive keeps a red outline.
  - **Table**: 7% amber row highlight on hover.
  - **Dark theme**: amber brightens to `#d9a75c` and hairlines drop to 24% so nothing smears on the dark paper.
- **New fourth metric card, "Live / Not live".** It reads `asar_still_sealed` directly: if the host is still running from `app.asar` it says Not live, if it runs from the unpacked directory it says Live. Previously that only appeared in the red warning banner, so the healthy state was invisible.
- **Removed the outdated "local range" note.** It claimed attack tasks were limited to loopback / LAN IPs, but the region gate was stripped wholesale when the `dsh-purge` v1.1.90 tree was imported — `lib/net-scope.js` literally says the plugin carries no region gate, `ownServerNote()` returns `""`, and the allow-list never reaches the prompt. The card had no input and no button either: pure dead copy. It is gone, together with the five unreferenced i18n keys `own.title`, `own.hint`, `own.save`, `saved.own`, `saved.own.dropped`.
- **Verification**: `node --check client.js` passes; `PURGE_CSS` was extracted into light and dark static previews and checked in headless Chrome for layout and contrast. Not done: a screenshot of the real panel (needs a host refresh and a human eye).

# 1.0.12

## 中文

- **修掉「点了交接，什么都没发生」**。上一版会 spawn 一个 PowerShell 去杀 Electron、挪走 `app.asar`，但它一开始就被连坐杀掉：Chromium 把子进程放进 job object，宿主 `process.exit(0)` 时 job 里所有进程一起死，`detached: true` 在 Windows 只能换进程组、逃不出 job。现场证据是交接脚本 `%TEMP%\mantis-asar-swap-<pid>.ps1` 存在，但 `mantis-desktop.log` 里连一行 `[asar-swap]` 都没有、`app.asar.bak` 与 `rename-pending` 都不存在。
  - **改用 WMI 创建进程**：新增 `launchEscapedPowerShell()`（`lib/desktop.js`），把 `powershell.exe ... -File <脚本> -WaitPid ... -AsarPath ... -ExePath ...` 整条命令行 base64 传进一个极短的 launcher，由它调 `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` 创建真正的交接脚本。这样脚本的父进程是 `WmiPrvSE`，不在任何 job 里，宿主死了它照跑。launcher 把 `ReturnValue|ProcessId` 写进 `%TEMP%\mantis-asar-swap-launch-<pid>.txt`，`started=true` 才认。
  - **确认起来了才退出**：`scheduleAsarSwapRestart()` / `restartOfficialHarness()` / `scheduleRestart()` / `core.restartSealedDesktopIfNeeded()` / `host.scheduleRestart()` 全部改成 async，`lib/index.js` 里 8 个调用点补 `await`（含 `/mantis/apply` 的 400ms 延迟交接、`/mantis/restart`、启动自愈、auto-update、`scheduleApplyRestart()`）。launcher 起不来就**不退出宿主**，原样返回 `error`，面板与 `audit.jsonl` 的 `asar_swap` 事件都会记成 `ok:false`，不再出现「显示已交接、其实没动」。
  - **可诊断性**：`ASAR_SWAP_PS1` 开头加一行 `[asar-swap] begin pid=… waitPid=… asar=…`，下次若脚本没起来，日志里是空的；没 runtime 可用时的自杀兜底由 1500ms 放宽到 **8000ms**（正常情况下脚本会先杀掉本进程，这个定时器只是防万一）。
- **验证**：`node --check` 全绿（`lib/**/*.js`、`client.js`、`bin/mantis.js`）。用 Electron 的 Node 模式实跑新函数：`launched = {"started":true,"pid":16868}`，父进程立刻 `exit(0)`，3 秒后无害测试脚本仍写出标记 `escaped-ok 16868` —— 即脚本确实脱离了宿主 job object。未执行：真实 apply + 交接（会重启宿主，按约定由用户自己点）。

## English

- **Fixed "I clicked hand off and nothing happened"**. The previous build spawned a PowerShell to kill Electron and rename `app.asar`, but it was killed before it ever ran: Chromium puts children in a job object, so the host's `process.exit(0)` takes every process in the job down with it, and `detached: true` on Windows only changes the process group — it does not escape the job. The evidence: `%TEMP%\mantis-asar-swap-<pid>.ps1` existed, yet `mantis-desktop.log` had not a single `[asar-swap]` line and neither `app.asar.bak` nor `app.asar.rename-pending` was ever created.
  - **Create the process through WMI**: new `launchEscapedPowerShell()` in `lib/desktop.js` base64-encodes the full `powershell.exe ... -File <script> -WaitPid ... -AsarPath ... -ExePath ...` command line into a tiny launcher, which calls `Invoke-CimMethod -ClassName Win32_Process -MethodName Create`. The swap script's parent becomes `WmiPrvSE`, outside any job, so it keeps running after the host dies. The launcher writes `ReturnValue|ProcessId` to `%TEMP%\mantis-asar-swap-launch-<pid>.txt`, and only `started=true` counts.
  - **Do not exit until it is really running**: `scheduleAsarSwapRestart()`, `restartOfficialHarness()`, `scheduleRestart()`, `core.restartSealedDesktopIfNeeded()` and `host.scheduleRestart()` are now async, with `await` added at all eight `lib/index.js` call sites (including the 400 ms deferred handoff in `/mantis/apply`, `/mantis/restart`, boot self-heal, auto-update and `scheduleApplyRestart()`). If the launcher cannot start, the host **stays alive** and the route returns `error`; the panel and the `asar_swap` audit event both record `ok:false` instead of claiming a handoff that never happened.
  - **Diagnosability**: `ASAR_SWAP_PS1` now logs `[asar-swap] begin pid=… waitPid=… asar=…` first, so a future silent failure is immediately visible as a missing line; the no-runtime self-exit fallback was relaxed from 1500 ms to **8000 ms** (the script normally kills this process first; the timer only guards against the odd case).
- **Verification**: `node --check` clean across `lib/**/*.js`, `client.js` and `bin/mantis.js`. Running the new function under Electron's Node mode gave `launched = {"started":true,"pid":16868}`; the parent exited immediately and the benign test script still wrote `escaped-ok 16868` three seconds later — proof it left the host's job object. Not executed: a real apply + handoff (it restarts the host; per policy the user runs that).

# 1.0.11

## 中文

- **修掉「面板显示已清洗，实际一条没生效」**。根因是密封桌面下补丁只写进 `resources\app`，宿主还在从 `app.asar` 跑：`/mantis/apply` 只回一个 `needs_full_quit`，交接交给一个最多等 30 分钟就过期的 idle 助手，宿主不退就永远换不成包。
  - **应用成功即自动交接**：`lib/index.js` 的 `/mantis/apply` 在 `shouldRestart && handoff && sealedNow` 时，先把响应发出去，400ms 后调用 `core.restartSealedDesktopIfNeeded({ ctx })`（挪走 `app.asar` + 重开宿主），结果写进 `audit.jsonl` 的 `asar_swap` 事件。
  - **状态如实上报**：`asar_swap_started` / `needs_full_quit` 反映真实交接；`core.gatherState()` 的 `asar_still_sealed` 增加 `asarStillSealedFor(aiBase)` 兜底——CLI 里 `detectSurface()` 一直是 `web`，旧判定恒为 `false`。
  - **面板与 CLI 都说清楚**：新增未生效横幅 +「完成交接并重启」按钮（`asar_still_sealed` 且已打补丁时出现）；`apply.hint` 补一句「写入 ≠ 生效」；`mantis --status` 增「生效状态 / live」行，`--apply` 在密封桌面下明确提示需完全退出宿主。
- **修掉 `DSH_BASE` 指到桌面安装内部被丢弃**：`findAiBase()` 现在优先认 `MANTIS_AI_BASE` / `DSH_BASE`（允许指向 `resources\app\...`）。以前 CLI 会落到 npx 缓存里的旧宿主（0.1.5）上打补丁，报 13 条漂移，真正在跑的桌面版没人管。
- **验证**：`node --check` 全绿（`lib/**/*.js`、`client.js`、`bin/mantis.js`）。`DSH_BASE=<桌面>\resources\app\dsh\node_modules\@deepseek-ai node bin/mantis.js --status` → 66/87 已清洗、0 待清洗、0 漂移、宿主 `0.2.2-rc.1`、生效状态「未生效（宿主仍从 app.asar 运行）」。未执行：真实 apply + 交接（会重启宿主，按约定由用户自己点）。

## English

- **Fixed "panel says cleaned but nothing is live"**. On a sealed desktop the patches only land in `resources\app` while the host keeps running from `app.asar`: `/mantis/apply` returned `needs_full_quit` and delegated the handoff to an idle helper that gives up after 30 minutes, so a host that never quits never gets the archive swapped.
  - **Apply now performs the handoff**: in `lib/index.js`, when `shouldRestart && handoff && sealedNow`, the route flushes its response and then calls `core.restartSealedDesktopIfNeeded({ ctx })` 400 ms later (rename `app.asar` aside, reopen the host), recording an `asar_swap` event in `audit.jsonl`.
  - **Honest state**: `asar_swap_started` / `needs_full_quit` mirror the real handoff, and `core.gatherState()`'s `asar_still_sealed` is now backed by `asarStillSealedFor(aiBase)` because `detectSurface()` is always `web` in the CLI (the old check was permanently `false`).
  - **Panel and CLI both say it**: a not-live banner with a "Finish handoff and restart" button (shown when `asar_still_sealed` and patches are written), a "written is not live" note in `apply.hint`, a "生效状态 / live" line in `mantis --status`, and an explicit warning in `--apply` when the desktop is still sealed.
- **Fixed `DSH_BASE` being dropped when it points inside a desktop install**: `findAiBase()` now honours `MANTIS_AI_BASE` / `DSH_BASE` first, including `resources\app\...` paths. Previously the CLI patched the stale npx copy (0.1.5), reported 13 drifted patches, and never touched the desktop build actually in use.
- **Verification**: `node --check` clean across `lib/**/*.js`, `client.js`, `bin/mantis.js`. `DSH_BASE=<desktop>\resources\app\dsh\node_modules\@deepseek-ai node bin/mantis.js --status` → 66/87 applied, 0 pending, 0 drifted, host `0.2.2-rc.1`, live state "not live (host still runs app.asar)". Not executed: a real apply + handoff (it restarts the host; per policy the user runs that).
# 1.0.10

## 中文

- 版本 **1.0.10**（本地自建线；上游 dsh-purge 最新 1.1.92 仍停在 `dshTarget 0.2.1-rc.5`，尚未适配 0.2.2，本次先行）。
- **适配 DSH 0.2.2-rc.1**（官方桌面版 2026-11-04 构建）。把补丁表在解包后的 0.2.2 树上逐条回归，4 条锚点直接漂移，另有 1 条（#17）要等 #13 打完之后才暴露；全部按 1.1.88 的约定「旧 pattern 全保留、新 pattern 追加」补齐：
  - **#14 沙箱升级审批**：0.2.2 在 `approver.request` 前新增 `approver === void 0` / `agent === void 0` 两条守卫并直接抛错，`displayReason` 由对象字面量改成 `escalationDisplayReason(mode, justification)`。补两条 pattern：「守卫 + 函数式 displayReason」和「守卫已被 #13 删掉、只剩函数式 displayReason」。替换成三元表达式：缺审批服务时按 `allowed-once` 放行，不再整轮抛错。
  - **#17 读写意图放行**：0.2.2 把 `editIntent` 收成一行 `return this.requirePresent(target, actor, "edit")`，真正的读后写闸门搬进 `requirePresent`。追加该形态的 pattern，替换为直接 `return void 0`（markers 是 every 语义，只命中一半会显示漂移）。
  - **#40 complete prompt 保留 inject**：`assemble` 返回值多了 `tools` 字段，early return 从 `return transformed` 变成 `return { ...transformed, tools }`，`requiredContexts` 的计算挪到第二个 return 之前。新 pattern 保留 `tools` 字段与 requiredContexts 过滤，仍把 mantis 段排到最前。
  - **#67 messages guard**：文本与旧版逐字一致，只是 try 块整体多缩进一层（4 tab → 5 tab）。追加 5-tab 变体。
  - **#74 prepare assemble**：0.2.2 的 preStep 先 `this.model.current()`、再 `tools.resolve`、最后才 `assemble`，原锚点（claim + assemble）被拆开。锚点改挂到 claim 之后、取 model 之前，仍然早于本次 assemble。
- **版本门禁收窄**：`lib/host-compat.js` 的 `QUALIFIED_HOST_VERSIONS` 只留 `0.2.2-rc.1`；`package.json` 的 `dshTarget` 与 `dshTargets` 也都只写 `0.2.2-rc.1`。本机自用，不再承诺 0.2.1 及更早；只服务这些版本的旧 pattern 也一并清掉了（见下条）。
- **旧版本 pattern 清理**：按 0.2.2 上的真实执行顺序逐条判定（先跑一遍完整 apply 记录每条补丁拿到的输入文本，再逐变体试删比对），删掉 28 条永不命中的旧版本文案变体，并整条删除只服务旧版的 #2（`REPLACEMENT_WORKSPACE_CONTEXT_INTRO`，0.2.2 已无该常量，6 条变体全失效）；带 `mantis` 痕迹的撤销/幂等变体一律保留。补丁表 **88 → 87**，同时清掉因此失效的 `replacementPrecedenceRewrites` / `quotedConst` 等辅助代码。
- **红队预设的 0.2.2 硬断点**：
  - `@deepseek-ai/dsh-tool-subagent-control` 不再导出 `./list-agents`（`list_agents` 已并入主包）。`presets/redteam/agent.cordis.yml` 与自愈逻辑 `repairDelegation` 同步摘掉 `tool-subagent-list-agents` 行；自愈还会把旧用户预设里的这一行整块删掉，避免整份预设注册失败、模式下拉选不中。
  - `dsh-tool-subagent` 的 `modelSelectionSettings` 改名为 `modelSelection`；预设改用新键，自愈逻辑顺手迁移旧键（旧名会被 schema 静默丢弃，等于模型选择没开）。
- **插件页标题不再显示包名**：新增 `locale/en.json` / `locale/zh.json`（`meta.title` / `meta.description`），卡片标题变成「虫珀 · 拒斧」（英文环境 Mantis · Jufu）；`package.json` 补上 `"./locale/*.json"` 导出——没有这条导出宿主根本读不到 locale，标题会退回包名；`files` 白名单同时加 `locale`。
- **图标换成黑白剪影**：`icon.svg` 由彩色螳螂改为单色剪影（`#10171a`，两只白色复眼），正视、抬起的捕捉足、窄前胸、宽腹，和宿主自己的鲸鱼图标同一套观感：白色圆角底板 + 深色实体 + 白色负空间，深浅色主题下都不会消失，24px 下仍能认出轮廓。
- **文档**：README 合并为一份，只留「功能」与「安装」；删掉 `README.zh-CN.md` / `README.ja.md`，`files` 白名单同步收口。插件页简介（`description`）换成一句话。
- **验证**：解包 0.2.2-rc.1 的 `@deepseek-ai`（10721 文件 / 317 MB）跑 `patchStatus`，`drifted` 由 4 条降到 **0**；随后在副本上真打一遍（`backupAll` → `applyPatches` → `revertAll`），**applied 65 / na 17 / skipped 4 / missing_file 1 / pending 0 / drifted 0**，改写的 50 个文件里 40 个 JS 全部通过 `node --check`，撤回后逐字节比对 **0 差异**。清理 pattern 前后各打一遍，10775 个文件逐字节一致（**0 差异**），二次 apply **0 改动**（幂等）。`missing_file` 只剩 #71（liangshen 第三方预设未安装，预期内）。
- **吸收上游 1.1.91 的 #211**：撤销浮层宿主的 `z-index` 由 `2147482500` 降到 `900`，`place()` 增加 `checkVisibility` 判断，宿主收起编辑区或切走标签页时不再定位，避免压住宿主自己的弹窗与菜单。#213 / #209 / 1.1.92 的 skills 发布本地早已有。

## English

- **1.0.10** (local fork line; upstream dsh-purge is still at 1.1.92 with `dshTarget 0.2.1-rc.5` and has not migrated to 0.2.2 yet).
- **DSH 0.2.2-rc.1 support** (official desktop build, 2026-11-04). The whole patch table was re-run against the extracted 0.2.2 tree: four anchors had drifted outright and a fifth (#17) only surfaces once #13 has run. Each was fixed the 1.1.88 way — keep every old pattern, append a new one:
  - **#14 sandbox escalation**: 0.2.2 throws before `approver.request` when `approver` or `agent` is missing, and `displayReason` now calls `escalationDisplayReason(mode, justification)`. Two new patterns: guards + functional displayReason, and the same block after #13 has already removed the guards. The replacement is a ternary that falls back to `allowed-once` instead of throwing.
  - **#17 observation intents**: 0.2.2 collapses `editIntent` into `return this.requirePresent(target, actor, "edit")`, moving the read-before-write gate into `requirePresent`. Added that shape and replaced it with a plain `return void 0` (markers are every-semantics, so a half match reports as drift).
  - **#40 complete prompt keeps inject**: `assemble` now returns a `tools` field, the early return became `{ ...transformed, tools }`, and `requiredContexts` moved above the second return. The new pattern keeps `tools` and the requiredContexts filter, and still puts mantis sections first.
  - **#67 messages guard**: the text is byte-identical, but the try block is indented one level deeper (4 tabs → 5 tabs). Added the 5-tab variant.
  - **#74 prepare assemble**: preStep now resolves `model.current()` and `tools.resolve` before `assemble`, so the old claim+assemble anchor no longer exists. The anchor moved to right after `claim`, still before this turn's assemble.
- **Version gate narrowed**: `QUALIFIED_HOST_VERSIONS` in `lib/host-compat.js` keeps only `0.2.2-rc.1`; `dshTarget` and `dshTargets` list only `0.2.2-rc.1`. This is a local-only build, so 0.2.1 and older are no longer promised, and the patterns that only ever matched them are gone too (next bullet).
- **Old-version pattern cleanup**: dead variants were identified in real execution order (run a full apply once, capture the exact input text each patch received, then try removing each variant and compare), not by testing each patch in isolation. 28 variants that can never match 0.2.2 were deleted, and patch #2 (`REPLACEMENT_WORKSPACE_CONTEXT_INTRO`, whose constant no longer exists in 0.2.2 — all six variants dead) was dropped entirely. Variants carrying a `mantis` trace are kept: they are the undo/idempotency half of the table. Patch table **88 → 87**, and the helpers that only #2 used (`replacementPrecedenceRewrites`, `quotedConst`, …) are gone.
- **Red-team preset hard breakages under 0.2.2**:
  - `@deepseek-ai/dsh-tool-subagent-control` no longer exports `./list-agents` (`list_agents` moved into the main package). The preset and `repairDelegation` drop that row, and the self-heal now deletes the whole row from existing user presets so the preset keeps registering.
  - `modelSelectionSettings` on `dsh-tool-subagent` is now `modelSelection`; the preset uses the new key and self-heal migrates the old one, which the schema silently discards.
- **The plugin card shows a name, not a package id**: added `locale/en.json` / `locale/zh.json` (`meta.title` / `meta.description`), so the card reads “虫珀 · 拒斧” (“Mantis · Jufu” in English). `package.json` also gains the `"./locale/*.json"` export — without it the host cannot read the locale files at all and falls back to the package name — plus `locale` in `files`.
- **Icon is now a black-and-white silhouette**: `icon.svg` goes from a colored mantis to a single `#10171a` glyph with two white eyes — front view, raptorial forelegs raised, narrow prothorax, broad abdomen — on a white rounded tile, in the same visual language as the host's own whale icon (dark mass, white negative space), so it survives dark surfaces too and stays legible at 24 px.
- **Docs**: the READMEs are merged into one file with only **Features** and **Install**; `README.zh-CN.md` / `README.ja.md` are gone and the `files` allow-list is trimmed to match. The plugin-page blurb (`description`) is now a single sentence.
- **Verification**: `patchStatus` over the extracted 0.2.2 `@deepseek-ai` tree (10,721 files / 317 MB) drops `drifted` from 4 to **0**; a real run on a copy (`backupAll` → `applyPatches` → `revertAll`) ends at **applied 65 / na 17 / skipped 4 / missing_file 1 / pending 0 / drifted 0**, all 40 rewritten JS files pass `node --check`, and reverting restores every file byte-for-byte (**0 diffs**). Before and after the cleanup the patched trees are byte-identical across 10,775 files (**0 diffs**), and a second apply changes **0 files** (idempotent). The only `missing_file` is #71 (liangshen preset not installed, expected).
- **Upstream 1.1.91 #211 absorbed**: the rewind host's `z-index` drops from `2147482500` to `900`, and `place()` now checks `checkVisibility`, so it stops positioning while the host has the composer collapsed or another tab open instead of covering the host's own dialogs and menus. #213 / #209 / the 1.1.92 skills publish were already present locally.

# 1.1.90

## 中文

- 版本 **1.1.90**。
- **#208 Android 切后台回来输入框整块消失**：撤销按钮原先注册在宿主的 `conversation.input.right` 槽位，这个槽位渲染在 composer 的 React 子树里。宿主在提交阶段只要抛一次错，React 会把整棵树卸载，症状就是输入框连带按钮一起没了。
  - 撤销按钮不再走任何槽位。改为在 `body` 上挂一个 `position: fixed` 的宿主节点，用 `createPortal` 把按钮传进去，渲染树完全脱离 composer；composer 内部再出错也牵连不到它。
  - 位置按最靠下的那组 `.standardControls`（就是 composer 底部工具条）的矩形实时对齐，并给它留 `padding-left` 空位，不遮住模型选择器；预留宽度跟着按钮实测宽度走。
  - 会话切换、窗口尺寸变化、页面滚动都会重新对齐；没有会话时按钮不显示、留白也一起归还。
  - 锚点查找带缓存和节流，只在锚点缺失或掉线时才扫一次 DOM，长会话滚动不受影响。
- **验证**：`client.js` 语法检查通过；`conversation.input.right` 在本插件中已无任何注册点；双宿主 `standardControls` 类名核对一致。

## English

- **1.1.90**.
- **#208 the whole composer vanished after switching apps**: the undo button was registered into the host's `conversation.input.right` slot, which renders inside the composer's React subtree. One throw during a commit phase makes React unmount that tree, and the input box goes with it.
  - The undo button no longer uses any slot. It renders through `createPortal` into a `position: fixed` host appended to `body`, fully outside the composer subtree, so a composer error can no longer take it down.
  - It aligns itself to the rectangle of the bottom-most `.standardControls` (the composer toolbar) and reserves `padding-left` there so the model picker is not covered; the reserved width follows the button's measured width.
  - It re-aligns on session change, resize and scroll, and releases both the button and the reserved space when there is no session.
  - Anchor lookup is cached and throttled: the DOM is scanned only when the anchor is missing or detached, so long chats keep scrolling smoothly.
- **Verification**: `client.js` passes the syntax check; no `conversation.input.right` registration remains in the plugin; the `standardControls` class name matches on both hosts.

# 1.1.89

## 中文

- 版本 **1.1.89**。
- **#204 工作目录提示恢复**：`deployment:persona-suffix` 优先写会话真实 cwd 字面量（`interpolate: false`），拿不到才退静态描述；同时把 `cwd` 补进 `assembly.variables`，用户自己模板里的 `{{cwd}}` 也能渲染。0.2.1 不再抛 `unknown prompt variable`，工作目录提示不再变成 `the current workspace`。
- **#207 桌面静默退出可诊断**：
  - 新增 #92：宿主每次退出都把 `code` / `signal` / stderr 尾巴写进 `%TEMP%\mantis-desktop.log`（不再只记 signal 分支）。
  - 新增 #93：主进程记录 `boot` / `before-quit` / `will-quit` / `quit code` / `window-all-closed` / `render-process-gone`（附渲染进程最后几行 console）/ `child-process-gone` / 信号 / 每分钟心跳。只用 `uncaughtExceptionMonitor`，不改变崩溃行为。
  - asar 换包脚本：`Move-Item` 失败后改用 `.NET File.Move` 重试，成功/失败都 `Test-Path` 复核并记录真实错误；空闲改名脚本同样记录失败原因（限流，不刷屏）。
- **#202 原子写**：`atomicWriteFile` 保持 `writeFile + rename`（不依赖 hostFs 白名单里没有的 `open`）；CLI `--apply` 成功后补打应用戳，下次启动 settle 不会误判未对齐再重打。
- **修复重复标记**：#32 / #53 的 export 行锚点原来自我匹配，每点一次「应用」就多追加一行注释；改成带负向前瞻的正则，连续应用保持幂等。
- **验证**：web + desktop 双宿主现有补丁全部 applied；rc.2 夹具与 rc.5 实机 pattern 全绿；沙箱 42 个目标文件 apply/revert 字节级还原；生成的 PowerShell 脚本通过 `Parser::ParseFile` 语法检查。

## English

- **1.1.89**.
- **#204 working directory restored**: the persona suffix now uses the real session cwd as a literal (`interpolate: false`) and only falls back to the static sentence when no cwd is available; `cwd` is also added to `assembly.variables`, so user templates with `{{cwd}}` render. 0.2.1 no longer throws `unknown prompt variable`, and the prompt keeps the real path instead of `the current workspace`.
- **#207 desktop exit is diagnosable**:
  - New #92: every host exit writes `code` / `signal` / stderr tail to `%TEMP%\mantis-desktop.log`.
  - New #93: main process logs `boot` / `before-quit` / `will-quit` / `quit code` / `window-all-closed` / `render-process-gone` (with the renderer console tail) / `child-process-gone` / signals / a one-minute heartbeat. Uses `uncaughtExceptionMonitor` only, so crash behavior is unchanged.
  - ASAR swap: falls back to `.NET File.Move` after `Move-Item` fails, verifies with `Test-Path`, and records the real error; the idle rename script logs failures too (rate-limited).
- **#202 atomic writes**: `atomicWriteFile` stays on `writeFile + rename` (the hostFs whitelist has no `open`); the CLI `--apply` now also writes the applied stamp so the next boot's settle does not re-apply.
- **Duplicate markers fixed**: the #32 / #53 export-line anchors matched their own output and appended another comment on every Apply; both now use negative lookaheads and are idempotent.
- **Verified**: all existing patches applied on both web and desktop hosts; rc.2 fixtures and rc.5 real files green; sandbox apply/revert restored 42 target files byte-for-byte; generated PowerShell scripts pass `Parser::ParseFile`.

# 1.1.88

## 中文

- 版本 **1.1.88**。
- **双版本适配（rc.2 + rc.5）**：#32/#36/#50/#53/#57/#62 在 0.2.1-rc.2 与 0.2.1-rc.5 上都能命中。旧 pattern 全部保留，rc.5 的新 pattern 追加，不再用新文案覆盖旧版。
- **#36 升级字段**：bash/pwsh 的 `sandbox_permissions` justification 描述一并清洗；补上 `Approval is auto-granted.` 大写 marker，tool-fs 不再因为大小写差异永远漂移。
- **#50 跨会话引用**：去掉 untrusted / “不要跟随指令”话术，保留只读快照的事实描述。
- **#57 developer role**：rc.5 responses 通路的 `instructionRole` 分支纳入 openai/azure 白名单。
- **#62 审批 fail-open**：rc.5 的 `void 0` 分支（无 approval 服务 / 无 agent / unavailable）全部放行；已打过旧 approval 分支的文件不会因 marker 被整条跳过。
- **#32 / #53 状态标记**：#53 不再共用 #32 的注释 marker，旧宿主不会假绿；rc.5 残留的 `local web GUI` 前缀与 `DeepSeek Harness Web GUI` 描述已清掉。
- **宿主门禁**：`package.json` 增加 `dshTargets`，状态页同时接受 rc.2 与 rc.5。
- **验证**：web + desktop 双宿主 73/85 applied、0 pending、0 drifted；沙箱 42 个目标文件 apply/revert 字节级还原通过。

## English

- **1.1.88**.
- **Dual-version support (rc.2 + rc.5)**: patches #32/#36/#50/#53/#57/#62 now match both 0.2.1-rc.2 and 0.2.1-rc.5. Old patterns are kept; rc.5 patterns are added instead of replacing them.
- **#36 escalation schema**: also neutralizes the bash/pwsh `sandbox_permissions` justification text; adds the capitalised `Approval is auto-granted.` marker so tool-fs no longer drifts on case alone.
- **#50 session references**: drops untrusted / "do not follow instructions" framing while keeping the read-only snapshot wording.
- **#57 developer role**: the rc.5 `instructionRole` responses branch is included in the openai/azure allowlist.
- **#62 approval fail-open**: rc.5 `void 0` branches (no approval service / no agent / unavailable) all allow; files already stamped by the old approval branch are re-processed instead of skipped.
- **#32 / #53 markers**: #53 no longer shares #32's comment marker, so older hosts cannot show a false green; rc.5 leftovers (`local web GUI` prefix and `DeepSeek Harness Web GUI` description) are removed.
- **Host gate**: `package.json` gains `dshTargets`, and the status page accepts both rc.2 and rc.5.
- **Verified**: on both web and desktop hosts, 73/85 applied, 0 pending, 0 drifted; sandbox apply/revert restored all 42 target files byte-for-byte.

# 1.1.87

## 中文

- 版本 **1.1.87**。
- **回滚 / 备份加固**：
  - 0 字节的 `.mantis.bak` 不再被当成"原版"写回宿主：`revertAll` / `restoreFromBak` 遇到空备份会改名为 `.bad` 并跳过，下次启动顺手清掉残骸。
  - 宿主升级后刷新过期 bak 时补上单数 `marker` 的补丁（#6/#7/#8/#10），不再漏掉这些基线，避免旧 bak 覆盖新版文件导致新旧代码混合。
  - 备份、配置、状态、覆盖文件统一走原子写（临时文件 + fsync + rename），断电或进程被杀不会留下半截文件。
- **补丁命中契约**：标记 `optional` 的补丁命中数不符时记为软失败，不再阻断整体应用；#42 的两处插入型替换加探针，重复应用不会二次插入。
- **桌面 / 进程（Windows）**：
  - 进程枚举改用 `|` 分隔并强制 UTF-8 输出，修复中文安装路径下换包时旧进程杀不掉的问题。
  - helper 只有在确实拿到 exe 路径时才带 `killApp`；换包失败会把原版重新拉起并写日志，不再留空桌面。
- **安全加固**：
  - asar 解包校验输出路径必须位于目标目录内，越界条目跳过并告警。
  - 红队文件读写路径校验对最近存在的祖先做 `realpath`，堵住 symlink 逃逸。
  - 更新检查只允许 `https`。
  - 报告回放生成的 curl / HTTP 报文对头部、Cookie、请求体去除换行，防注入。
- **提示词 / 运行钩子**：插件停用后 `rewriteFn` 直接返回宿主原始装配文本，不再残留注入；停用时清理 assemble guard；运行时缓存签名纳入红队设置、策略与 override 版本，状态变化立即生效。
- **红队演练台**：`listEngagements` 默认不再逐条统计；漏洞列表与报告支持 `evidenceLimit`，大证据不再拖慢面板。
- **子代理**：名额占位改为立即占用（`n+1`），append 失败时回退，避免并发派出超限。
- **CLI**：`--apply` 存在失败项时以退出码 1 结束，脚本调用能感知失败。
- **清理**：删除无引用的 `lib/mnemon-settings.js` 及 13 处死代码 / 未使用的 import；移除 `test/` 目录与 `test` 脚本，发布 CI 只做语法检查。

## English

- **1.1.87**.
- **Rollback / backup hardening**:
  - A zero-byte `.mantis.bak` is no longer treated as the original and written back to the host: `revertAll` / `restoreFromBak` rename it to `.bad` and skip it; leftovers are swept on the next start.
  - When refreshing stale backups after a host upgrade, patches that use the singular `marker` form (#6/#7/#8/#10) are now included, so their baseline is not missed and an old backup can no longer overwrite the new file.
  - Backups, config, state and override files are written atomically (temp file + fsync + rename), so a crash never leaves a half-written file.
- **Patch hit contract**: `optional` patches that miss their expected hit count are recorded as soft failures instead of blocking the whole apply; the two insert-type replacements in #42 gained probes so re-applying does not insert twice.
- **Desktop / processes (Windows)**:
  - Process enumeration now uses `|` separators and forces UTF-8 output, fixing the case where the old process survived an asar swap under a Chinese install path.
  - The helper passes `killApp` only when an exe path is known; a failed swap relaunches the original app and writes a log instead of leaving an empty desktop.
- **Security hardening**:
  - Asar extraction verifies each output path stays inside the destination directory; entries outside are skipped with a warning.
  - Red-team path validation resolves `realpath` for the nearest existing ancestor, closing the symlink escape.
  - Update checks accept `https` only.
  - Curl / HTTP replay text strips newlines from headers, cookies and body to prevent injection.
- **Prompt / runtime hooks**: after the plugin is disabled, `rewriteFn` returns the host's assembled prompt unchanged and the assemble guard is cleared; the runtime cache signature now includes red-team settings, policy and override revision so changes take effect immediately.
- **Red-team console**: `listEngagements` no longer computes per-row stats by default; vuln lists and reports accept `evidenceLimit` so large evidence no longer slows the panel.
- **Subagents**: slot reservation now takes effect immediately (`n+1`) and rolls back if the append fails, preventing over-limit dispatch under concurrency.
- **CLI**: `--apply` exits with code 1 when any item failed, so scripts can detect the failure.
- **Cleanup**: removed the unreferenced `lib/mnemon-settings.js` plus 13 dead functions / unused imports; dropped the `test/` directory and `test` script — release CI now runs syntax checks only.

# 1.1.86

## 中文

- 版本 **1.1.86**。
- **Web「应用 → 自动重启」后残留 server 导致 EADDRINUSE 起不来（#197，合并 PR #197）**：
  - `restart-web.js` 把后台 server 的 pid/url 记到 `$DSH_HOME/mantis/web-server-<port>.json`；`killOldServer` 增加按端口兜底，清掉旧版本留下、没有记录的孤儿。
  - 新增 `lib/bin-preflight.js`：把回收钩子注入宿主 `bin.js` 顶部（跨平台），在 Cordis 激活、webserver 绑端口之前先回收残留；只杀命令行命中 `@deepseek-ai/dsh/lib/bin.js … web` 的进程。
  - 重启时打印「后台运行、关窗不会停」，避免把提示符返回误判成程序已退出。
  - 加固：记录里的 pid 拿不到命令行时，必须仍占着该端口才允许杀，防 PID 复用误杀；杀不掉就保留记录下次再试；杀完等待进程真正退出再绑端口。
- **桌面端点「应用」换包顺序（#198，合并 PR #198）**：
  - 先按安装根路径且不含 `--type=` 识别并杀掉 Electron main，再扫安装目录其余进程，避免 host 先死、main 还活着弹「host stopped」。
  - 挪包失败（asar 仍被占用）时补上 `Start-Process`，把原版应用拉起来并写入 `%TEMP%\mantis-desktop.log`，不再留空桌面。
- 测试：96/96 通过。

## English

- **1.1.86**.
- **Stale web server after "Apply → auto restart" caused EADDRINUSE on boot (#197, merged PR #197)**:
  - `restart-web.js` records the background server pid/url in `$DSH_HOME/mantis/web-server-<port>.json`; `killOldServer` now also reclaims by port, catching orphans left by older versions with no record.
  - New `lib/bin-preflight.js` injects a reclaim hook at the top of the host `bin.js` (cross-platform) so it runs before Cordis activates and before the webserver binds; only processes whose command line matches `@deepseek-ai/dsh/lib/bin.js … web` are killed.
  - The restart prints "running in the background; closing this window will NOT stop it" so the returned prompt is not mistaken for an exit.
  - Hardening: when the recorded pid's command line cannot be read, it is killed only if it still listens on that port (guards against PID reuse); a failed kill keeps the record for the next boot; boot waits for the killed process to actually exit before binding.
- **Desktop asar swap order (#198, merged PR #198)**:
  - Electron main is identified by install root plus "no `--type=`" and killed first, then the rest of the install tree is swept, so the host no longer dies while main stays alive showing a "host stopped" dialog.
  - If the asar move fails (still locked), the original app is relaunched and the reason is appended to `%TEMP%\mantis-desktop.log` instead of leaving an empty desktop.
- Tests: 96/96 pass.

# 1.1.85

## 中文

- 版本 **1.1.85**。
- **#196**：修复深色模式下部分按钮白底白字、完全看不清的问题。
  - 根因：宿主暗色主题把 `--dsw-alias-brand-primary` 解析成近白色（`neutral-bluish-50` `#f9fafb`）。插件里凡是"品牌色作底 + 白字"的按钮（设置页的「应用」「保存注入」、演练台的「保存」「检索」「检测连通性」以及各类主按钮）在暗色下就变成一整块白。
  - 现在暗色（`body[data-ds-dark-theme]`、`[data-theme="dusk"]`）下主按钮统一用绿色实底 `#3d8f68` + 白字，悬停用更深的 `#347a59`；`-webkit-text-fill-color` 一并显式指定，避免宿主强制白字穿透。
  - 报告里的步骤序号圆点（`.rt-rep-step-no`）同样改为绿底白字。
  - 浅色模式表现不变；新增 `test/client-dark-theme.test.js` 静态守护这几条暗色规则。
- 测试：84/84 通过。

## English

- **1.1.85**.
- **#196**: fix buttons in dark mode rendering as a solid white block (white text on white background).
  - Root cause: the host dark theme resolves `--dsw-alias-brand-primary` to a near-white token (`neutral-bluish-50`, `#f9fafb`). Every plugin button that used "brand color as background + white text" (settings **Apply**, **Save injection**, drill console **Save**, **Search**, **Test connectivity**, and other primary buttons) turned into a white block in dark mode.
  - Primary buttons under dark themes (`body[data-ds-dark-theme]`, `[data-theme="dusk"]`) now use a solid green `#3d8f68` with white text, with `#347a59` on hover; `-webkit-text-fill-color` is set explicitly so host-forced white text cannot leak through.
  - The report step-number dots (`.rt-rep-step-no`) are switched to the same green/white pair.
  - Light mode is unchanged; added `test/client-dark-theme.test.js` to guard these dark-mode rules.
- Tests: 84/84 pass.

# 1.1.84

## 中文

- 版本 **1.1.84**。
- **尾部锚点与子代理审批接管**（接线 `anchor.js` / `subagent-control.js`）：
  - 锚点段物理追加到 system prompt 的 sections 数组末尾（waterfall 按数组顺序渲染，order 不参与排序），把身份与格式规则放回 recency 位；已有同名段先滤再追加，不会出现两份。
  - 锚点规则改为跟随操作者语言：中文请求回中文，锚点本身是英文不算语言指令；删掉写死的英文开头句（这是红队模式回答变英文的直接原因）。
  - 子会话被宿主写成 `approval/policy = "never"` 时改回 `ask`，并在 `approval/request` 瀑布放行，子代理不再"一直被拒"。
  - 回滚开关：`anchorMode: "off"`、`subagentControl: false`。
- **红队模式中文化**：模式名与描述、角色名、五阶段攻击链、25 项计分规则与 POC 分类、技能修复说明、环境适配提示、面板与服务端报错、成果报告与成果复现报告全部回中文。
- **#194**：desktop 端启动后窗口永不显示。
  - hung-operator 提示改为按内容变更缓存（home + mtime + 已提交修订号），内容没变不再每轮重算约 23KB。
  - 增加风暴熔断（10 秒 120 次）与慢调用熔断（1.5 秒触发、30 秒冷却），熔断期直接返回缓存文本，不挂死 desktop host。
  - 同一次 assemble 的重复改写用 WeakMap 去重。
  - 新增补丁 **#91**：宿主 `code === null || signal` 静默 resolve 前写一条 `[desktop.hostExit]` 到 `%TEMP%\mantis-desktop.log`，保持不弹框但有据可查。
- **#188（0.2.1-rc.4 专属部分）**：新增 **#89** 沙箱策略去品牌、**#90** skill-badge 描述中文化，扩展 **#32/#53** 的 rc.3 变体与 marker；三条新补丁均为 optional，宿主没有对应文件时静默跳过。
- 测试：81/81 通过；新增锚点接线与红队文案测试。

## English

- **1.1.84**.
- **Tail anchor and subagent approval takeover** (wiring `anchor.js` / `subagent-control.js`):
  - The anchor section is physically appended to the end of the system-prompt sections array (the waterfall renders by array order, not by `order`), putting identity and format rules back in the recency slot; any existing same-named section is filtered first so there is never a duplicate.
  - Anchor rules now follow the operator's language: a Chinese request gets a Chinese answer, and the anchor being written in English is not a language instruction. The hard-coded English opener was removed (the direct cause of red-team mode answering in English).
  - When the host writes `approval/policy = "never"` for a child session, it is flipped back to `ask` and allowed in the `approval/request` waterfall, so subagents are no longer refused every time.
  - Rollback switches: `anchorMode: "off"`, `subagentControl: false`.
- **Red-team mode localized to Chinese**: mode name and description, role names, the five-stage attack chain, the 25-item scoring rules and POC categories, skill-fix guidance, environment-adaptation hints, panel and server messages, and both the results report and the replay report.
- **#194**: desktop window never appears after launch.
  - The hung-operator prompt is now cached by content change (home + mtime + committed revision); an unchanged prompt is no longer rebuilt (~23KB) on every refresh.
  - Storm breaker (120 calls / 10s) and slow-call breaker (trip at 1.5s, 30s cooldown) return the cached text instead of stalling the desktop host.
  - Duplicate rewrites within the same assemble call are deduped with a WeakMap.
  - New patch **#91**: before the host silently resolves `code === null || signal`, append a `[desktop.hostExit]` line to `%TEMP%\mantis-desktop.log` — still no dialog, but no longer invisible.
- **#188 (0.2.1-rc.4-specific parts)**: new **#89** sandbox-policy brand neutralization and **#90** skill-badge description localization, plus rc.3 variants and markers for **#32/#53**; all three new patches are optional and are skipped silently when the host has no matching file.
- Tests: 81/81 pass; new coverage for anchor wiring and red-team copy.

# 1.1.83

## 中文

- 版本 **1.1.83**。修复 bug，修复稳定性。
- **#185**：修复 pnpm 11（DSH 内置 11.2.2）下 `pnpm install` 因 `allowBuilds` 崩溃的问题。
  - 之前 profile 的 `pnpm-workspace.yaml` 会写入 `mantis@https://...` 这类 URL 键，pnpm 把它当版本联合解析，直接报 `[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union`。
  - 现在只写裸包名 `mantis`：pnpm 的 `allowBuilds` 本来就按包名匹配，tarball / git / registry 三种安装形态都放行。
  - 自愈加强：所有 `mantis@*` 历史键（URL 键、旧截断键 `mantis@https`、`@1.1.81` 之类版本键）一律清掉，只保留裸包名；非 mantis 的键原样保留。
- **#191**：修复 macOS DSH Desktop（0.2.1-rc.4）启动崩溃 `failed to parse overlay .../cordis.patch.yml`。
  - 宿主生成的 profile 层 `cordis.patch.yml` 可能整体只有一个空 flow 序列 `[]`，那本身就是一个完整 YAML 文档；再往文件尾追加 `- insert:` 会变成第二个文档，宿主解析直接失败。
  - 现在写之前先判断数据部分形态：空 flow 序列（`[]`，可带 `---` 前缀）→ **替换** `[]` 整行而不是追加；空文件 / 只有注释 → 直接写 insert 块；正常块序列 → 沿用原来的追加行为。
  - 非空 flow 序列（宿主或用户自己的内容）认不准就不动，返回 `{ ok: false, wrote: false }`，宁可留着也不写坏。

## English

- **1.1.83**. Bug fixes and stability.
- **#185**: fix `pnpm install` crashing under pnpm 11 (11.2.2, bundled with DSH) because of `allowBuilds`.
  - The profile `pnpm-workspace.yaml` used to get a `mantis@https://...` URL key, which pnpm parses as a version union and rejects with `[ERR_PNPM_INVALID_VERSION_UNION] Invalid versions union`.
  - Now only the bare package name `mantis` is written: pnpm matches `allowBuilds` by package name, so tarball / git / registry installs are all allowed.
  - Stronger self-healing: every `mantis@*` legacy key (URL keys, truncated `mantis@https`, `@1.1.81`-style version keys) is dropped and only the bare name is kept; non-mantis keys are preserved as-is.
- **#191**: fix the macOS DSH Desktop (0.2.1-rc.4) startup crash `failed to parse overlay .../cordis.patch.yml`.
  - The host-generated profile `cordis.patch.yml` may consist of a single empty flow sequence `[]`, which is already a complete YAML document; appending `- insert:` after it creates a second document and the host fails to parse it.
  - The data shape is now detected before writing: an empty flow sequence (`[]`, optionally `---`-prefixed) → **replace** the `[]` line instead of appending; empty file / comments only → write the insert block; a normal block sequence → the previous append behaviour is kept.
  - A non-empty flow sequence (host or user content) is left alone and returns `{ ok: false, wrote: false }` — better to skip than to write something broken.

# 1.1.82

## 中文

- 版本 **1.1.82**。修复 bug，修复稳定性。
- **#180**：修复 profile 的 `pnpm-workspace.yaml` `allowBuilds` 被反复写坏（`mantis@https: true` 畸形键 → `ERR_PNPM_INVALID_VERSION_UNION`，重复键 → `duplicated mapping key`）。
  - URL 键解析不再被冒号截断；写回含 `://` 的键自动加引号。
  - 重写只保留精确等于期望键的 `mantis@*`，旧污染键（畸形的、过期的版本/commit URL）自动清掉，不用手工修。
  - 期望键优先从 profile 的 `pnpm-lock.yaml` 读实际解析的 tarball URL（固定 commit 安装也不再有双 URL 键），读不到才退回 `package.json`。
  - 重写结果先过最小 YAML 校验（键不重复、round-trip 无损），不过就不写盘；健康文件零写入，启动不再反复重写。

## English

- **1.1.82**. Bug fixes and stability.
- **#180**: stop rewriting the profile `pnpm-workspace.yaml` `allowBuilds` into garbage (`mantis@https: true` malformed key → `ERR_PNPM_INVALID_VERSION_UNION`; duplicated keys → `duplicated mapping key`).
  - URL keys no longer truncate at the first colon; keys containing `://` are written back quoted.
  - Rewrites keep only `mantis@*` keys exactly equal to the wanted set; stale polluted keys (malformed, old version/commit URLs) self-heal away on the next ensure.
  - The wanted key prefers the tarball URL actually resolved in the profile `pnpm-lock.yaml` (fixed-commit installs no longer get a duplicate URL key); falls back to `package.json`.
  - Rewritten output passes a minimal YAML check first (no duplicate keys, lossless round-trip); healthy files are never written again, so boot no longer rewrites each run.

# 1.1.81

## 中文

- 版本 **1.1.81**。修复 bug，修复稳定性。
- **#174**：识别 DSH NEXT 社区桌面（路径、进程、快捷方式、密封 asar）。`DSH_SURFACE=web` 也不再误报；不把任意 `app.asar` 当桌面。
- **#175**：补 ip / 计分 / settle 单测，删草稿文档和 `.bak`。`npm test` 23 条全过。
- **#171 / #173**：zip 目录条目和 skills `fs` 导入已在 1.1.80，本版用单测锁住。

## English

- **1.1.81**. Bug fixes and stability.
- **#174**: detect DSH NEXT desktop (paths, process, shortcuts, sealed asar). Still desktop when `DSH_SURFACE=web`. A random `app.asar` is not treated as the host.
- **#175**: add ip / score / settle tests; drop draft docs and `.bak`. `npm test` is 23/23 green.
- **#171 / #173**: zip directory entries and the skills `fs` import shipped in 1.1.80; this release locks them with tests.

# 1.1.80

## 中文

- 版本 **1.1.80**。修复 bug，修复稳定性。
- **#168**：pnpm 12 的 `allowBuilds` 把 `mantis@codeload...` 也写成 `true`，装别的插件不再留下 `set this to true or false`。
- **#169**：芯片 / 应用按钮强制系统字体和实色字，不再被宿主图标字体吃掉。
- **#170**：纯 Node 解 zip 时目录条目建目录，不再写成同名空文件导致 EEXIST。
- **#172**：`lib/skills.js` 补上 `fs`，#54 软链重叠守卫重新生效。
- **#176**：写清 **不支持 DSH 0.2.1-rc.3 及更新的 rc**，请退回 **0.2.1-rc.2**。对不上的补丁待应用或跳过，不乱改文件。

## English

- **1.1.80**. Bug fixes and stability.
- **#168**: pnpm 12 `allowBuilds` also sets `mantis@codeload...` to `true`, so installing other plugins no longer leaves `set this to true or false`.
- **#169**: chip / Apply buttons force a system font and solid text color so the host icon font cannot hide the label.
- **#170**: Node zip fallback creates directories for directory entries instead of empty files (no more EEXIST).
- **#172**: import `fs` in `lib/skills.js` so the #54 symlink overlap guard works again.
- **#176**: **DSH 0.2.1-rc.3 and newer RCs are not supported.** Stay on **0.2.1-rc.2**. Unmatched patches stay pending or skipped.

# 1.1.79

## 中文

- 版本 **1.1.79**。修复 bug，修复稳定性。
- **#165**：社区版 DS Bot / DeepSeek Bot 按桌面宿主识别（`ds-bot` profile、Electron asar），不再误报 `set DSH_BASE`。
- **#166**：pnpm 12 拦 `postinstall` 时补 `allowBuilds`，并写清 `--allow-build=mantis` / `approve-builds`。
- **#167**：升级后补回 `bundles` + 本体 insert，空芯片不再把启动钮藏掉，1.1.74 有的按钮会回来。
- 应用/还原/卸载进度条跟 job 阶段；主智能体和子智能体同一份注入、权限和能力协议。
- 新建会话不再把 `mantis` 芯片甩到行尾。

## English

- **1.1.79**. Bug fixes and stability.
- **#165**: community DS Bot / DeepSeek Bot is a desktop host (`ds-bot` profile, Electron asar); no more false `set DSH_BASE`.
- **#166**: pnpm 12 skipped `postinstall`; write `allowBuilds` and document `--allow-build=mantis`.
- **#167**: restore `bundles` + body insert after upgrade so the 1.1.74 button comes back.
- Apply / revert / uninstall progress follows the job; main and subagents share inject, permission, and capability text.
- New-session no longer shoves the `mantis` chip to the far right.

# 1.1.78

## 中文

- 版本 **1.1.78**。修复 bug：停用/卸载后无法新建会话。
- **#108**：停用或卸载时把 `agent-preset-registry.selectedDefault` 从 `redteam` 改回 `standard`，并清掉 `$DSH_HOME/.agent-presets/redteam`。热重载不会冲掉用户设的红队默认。
- 卸载同时处理 `dsh.profile.bundles` / `dsh.profile.plugins`，桌面 profile 不再残留 `mantis`。

## English

- **1.1.78**. Bug fix: new sessions after disable/uninstall.
- **#108**: on disable or uninstall, reset `agent-preset-registry.selectedDefault` from `redteam` to `standard`, and remove `$DSH_HOME/.agent-presets/redteam`. Hot reload keeps a user-chosen redteam default.
- Uninstall also strips `dsh.profile.bundles` / `dsh.profile.plugins`.

# 1.1.77

## 中文

- 版本 **1.1.77**。修复 bug，修复稳定性。
- 修长红队任务仍打公网：`渗透测试` / `红队` / `打点` / `拿站` 纳入门禁；正文按窗扫到 256KB，目标写在后半段也能拦。
- 修后续步骤漏拦：每一步看工具参数，`tools/pre-execute` 遇到公网 IP/域名直接停轮。
- 长文正则按窗扫，避免整篇回溯把事件循环卡死。

## English

- **1.1.77**. Bug fixes and stability.
- Long red-team tasks no longer reach the public internet: `渗透测试` / red-team / 打点 / 拿站 are gated; the body is scanned in windows up to 256KB.
- Later steps are gated too: tool arguments are checked, and `tools/pre-execute` stops on a public IP or name.
- Long-text regex runs in windows so a huge paste cannot stall the event loop.

# 1.1.76

## 中文

- 版本 **1.1.76**。适配只走 pnpm 的机器：在 profile 目录 `pnpm add` codeload 压缩包即可，`postinstall` 自动把 `mantis` 写进 `bundles`。
- 安装地址改成 `codeload.github.com`，避开 `github.com/archive` 的 302（pnpm 会 `fetch failed`）。不要 `pnpm add mantis`（npm 仓库没有这个名字）。

## English

- **1.1.76**. pnpm-only hosts: `pnpm add` the codeload tarball inside the profile; `postinstall` writes `mantis` into `bundles`.
- Install URL is `codeload.github.com` so pnpm does not die on the `github.com/archive` 302. Do not `pnpm add mantis` — that name is not on the npm registry.

# 1.1.75

## 中文

- 版本 **1.1.75**。修 Hub 市场一键安装报 `already queued: mantis`：`cordis.patch.yml` 不再把已经在 bundles 里的本体再 insert 一遍。
- README 把安装写成三步：只用 GitHub 压缩包命令，不走插件市场 / `github:` / npm。

## English

- **1.1.75**. Fix Hub one-click `already queued: mantis`: the bundle patch no longer inserts the plugin that is already in `bundles`.
- README install is three steps: GitHub tarball only; skip the plugin market / `github:` / npm.

# 1.1.74

## 中文

- 版本 **1.1.74**，优化若干拦截与加载 bug。适配 DSH **0.2.1-rc.2**（0.2.0 仍可用）。
- 修靶场门禁：域名先解析再判 IP，不再靠 `.lab` / `.htb` 后缀放行；`hosts` 指到公网、解析失败、混有公网，一律拦。
- 修身份绕过：`169.254` 云元数据不再当靶场；`::ffff:公网` 拆开再判；攻击句不写目标不再放行。
- 修 DSH 0.2.1 预设加载：对象 schema 补 `additionalProperties`，装过的 redteam 预设清掉残留 `toolFilter`。
- 修演练台被改成英文：中文页签收回。
- 禁止制作外挂：会话门口硬拦，提示词 Rule 1 改为禁止。

## English

- **1.1.74**, bug-fix release. Target DSH **0.2.1-rc.2** (0.2.0 still works).
- Lab gate: resolve first, then allow only private IPs. Suffixes are not an allow list.
- Close identity holes: drop link-local metadata, unwrap IPv4-mapped IPv6, deny unnamed attack tasks.
- DSH 0.2.1 preset load: seal object schemas; strip leftover `toolFilter`.
- Restore Chinese drill-console tabs.
- Game cheats are forbidden at the session gate.

# 1.1.73

## 中文

- 版本 **1.1.73**，适配 DSH **0.2.1-rc.2**（0.2.0 仍可用）。
- 0.2.1 兼容已落地：`{{cwd}}` 静态回退、补丁 #40、`toolFilter` 删除、`dsh-tools` 解析、hostFs fd 直通、桌面换包不自杀、`file:` 归档更新、Ctrl+Enter steer。
- 界面操作文案补齐英文（演练台、清洗面板、补丁表、计分/技能指引）；`zh` 语言包与模型提示词保持中文。靶场默认拦截的 `own.hint` 仍按本仓库策略。
- 随包技能 `paper-autopilot` + `npm run install:skill`。
- 红队证据账本：`claimed → observed` 核实链、`ResidualUnknown`、8 个 `redteam_evidence_*` / `redteam_unknown_*` 工具。

## English

- **1.1.73**, target DSH **0.2.1-rc.2** (0.2.0 still works).
- 0.2.1 compatibility in-tree: `{{cwd}}` fallback, patch #40, drop `toolFilter`, host `dsh-tools` resolve, hostFs fd pass-through, desktop helper self-kill fix, `file:` archive update, Ctrl+Enter steer.
- Operator-facing UI copy is English; `zh` locale and model prompts stay Chinese. Lab default-deny `own.hint` is unchanged.
- Bundled `paper-autopilot` skill + `npm run install:skill`.
- Red-team evidence ledger: claimed→observed verification, ResidualUnknown, eight `redteam_evidence_*` / `redteam_unknown_*` tools.

# 1.1.71

## 中文

- 版本 **1.1.71**。
- 修复 1.1.70 的 `??` 混 `||`：插件启用时 `failed to import`（桌面 / Web 同一入口）。
- #86 只改 UI 队列 steer → followup；公共 `steer()` 收回 next-step，代理间 `send_message` 仍下一步插入。
- `installed-rev` 跨版本不再沿用旧 `apply:x.y.z`。#88 按现行 `renderedPrompt` / 旧 `system` 锚点打中的那条落标记。
- 发版前 `node --check` 主入口，避免再把语法错误打进 Release。

## English

- **1.1.71**.
- Fix 1.1.70 `??` mixed with `||`: enable failed to import on desktop and web.
- #86 keeps UI queue steer → followup. Public `steer()` is next-step again so `send_message` inserts at the next step.
- Stale `apply:x.y.z` in `installed-rev` refreshes across versions. #88 marks the host anchor that actually exists (`renderedPrompt` or `system`).
- Release CI syntax-checks the plugin entry.

# 1.1.70

## 中文

- 版本 **1.1.70**。
- Hub / 残装若给 `mantis` 加上 `pluginPackages`，Cordis 会一直 pending，宿主退出码 1。本版把依赖钉回 `systemPrompt` + `tools`。
- 清洗页只合并升级链展示（免责、审批、挂全文、hooks 等），Apply 仍打全部补丁。
- 去掉已无用的 #81 / #89 清单行；挂全文并进 #87，官方 phase-1 走静默放行。
- 指挥端改为「按用户给的目标开工」。合并 #97 / #98 / #99。

## English

- **1.1.70**.
- Hub / incomplete installs that inject `pluginPackages` leave mantis pending and kill the host. Dependencies are pinned to `systemPrompt` + `tools`.
- Clean page groups upgrade-chain patches for display only; Apply still writes every patch.
- Dropped dead #81 / #89 rows. Hang lives in #87. Official phase-1 keep is silent.
- Commander bind: start from the user's target. Includes #97 / #98 / #99.

# 1.1.69

## 中文

- 版本 **1.1.69**。
- 发送时剥掉 ChatML / `project_instructions`，框和磁盘不动。
- 应用 + 重启挂当前默认，不必再点保存；框里仍是插件旧默认会刷到加密槽。
- 红队只排不折：注入 → cap → 红队正文；目标卡/角色段改名 `dshpg-*`。
- 隔离 ctx 也注册 inject/cap；#86 steer 改 next-turn；#87 hang 用 LF 比对。
- 红队操作稿锁「上面的提示词作准」；指挥端去掉「给了单位名就授权」。

## English

- **1.1.69**.
- Peel ChatML / `project_instructions` on the wire; box and disk stay intact.
- Apply + restart hangs the current default; no extra Save. Stale plugin defaults refresh from the sealed slot.
- Redteam: inject → cap → ops only (no fold). Card/role sections renamed `dshpg-*`.
- Isolated ctx also registers inject/cap. #86 steer → next-turn. #87 hang needle uses LF.
- Redteam ops note: inject wins. Commander no longer says a company name means authorized.

# 1.1.68

## 中文

- 版本 **1.1.68**。
- **#92**：技能面板认 YAML 块标量 `description`（`|` / `>`），不再误报不可用。
- **#93**：红队「版本/更新」：`file://` 转成本地路径；Windows 用 `.cmd` + `shell` 起 npm/pnpm；npm 404 回落 GitHub tags。
- **#94**：官方桌面 CLI 入口补 `app.asar.unpacked` 回退。Hub 首次安装仍可能撞官方 asar 路径。
- **#95**：拆除 `refusal-recover`（读错字段永不触发；修好会无限复读）。
- **#96**：bash 前台等待从插件标过的 600s 迁回 60s，后续工具不再被堵 10 分钟。
- 注入置顶；capability 段改名 `dshpg-capabilities`；用户 prompt 一律 followup（#85）；默认关闭自动「继续」。

## English

- **1.1.68**.
- **#92**: Skill panel parses YAML block-scalar `description`.
- **#93**: Redteam update: `file://` → fs path; Windows npm/pnpm via `.cmd`; GitHub tags if registry 404.
- **#94**: Desktop CLI falls back to `app.asar.unpacked`. Hub first-install may still hit stock asar.
- **#95**: Removed `refusal-recover` (dead reader / unbounded nudge loop).
- **#96**: Restore marked bash foreground wait 600s → 60s.
- Inject leads; capability section renamed; user prompt always followup; autoContinue default off.

# 1.1.67

## 中文

- 版本 **1.1.67**。
- **#85**：continue 续跑在传输/429 连错时不再无限兜圈。`takeContinue` 加 failStreak 阈值；`refundContinue` 不清 `lastContinueSeq`，连错 ≥3 直接放弃。
- **#84**：区域拦截的空 Assistant 流改为单批 `text-chunks` 记录（带 `.length`），不再卡住宿主 UI。
- 启动种子：进程启动时若 `$DSH_HOME/prompt-inject.md` 为空或缺失，自动把加密默认稿写一次；用户改过的稿不动。清洗完点重启后，重启成功立刻就能用默认提示词。
- Windows 官方包重启：restart 脚本名改成 `pid+random`，首启不与并发实例打架；多余的 `.cmd` 中介删掉，直接 `wscript.exe //nologo //B` 起脚本；本机旧版无 pid 后缀的脚本/日志超过 24h 启动时自动清。
- 杀进程范围收紧：`ASAR_SWAP_PS1` 不再 `/IM` 杀全名同名进程，只按安装根下 pid 停，避免误伤第三方同名。
- 官方 CLI shim 原地改写之前先存一份 `.mantis.bak`，并走原子写，断电/盘满可回退。
- 首装场景不卡：WScript 判 clean 时，两边都是 null（文件缺或读失败）放行启动，只有任一明确 dirty 才拦。
- 探测缓存：`runningExes` / `shortcutExes` 空结果不再缓存；点"应用"前 `clearDesktopLocateCache()` 仍可强刷。
- `scheduleAsarRenameWhenIdle` 的 `.rename-pending` 锁：时钟回拨或超过 30 分钟视为失效，清掉重做。
- `execFileSync` 三处 PowerShell 调用加 `maxBuffer: 8MB`，大结果不再静默 ENOBUFS 掉。
- 其他：net-scope region gate 指数退避 + IPv6 regex 收紧；identity `injectMatchers` 支持 >4096 分段匹配、`installAssembleGuard` 幂等；hooks-deny 删 R0 兜底规则改原子写；extract-asar commit 不删 `nextDir`，写 `.mantis-recover.json` 便回滚；client.js redteam preset 多路检测、shell.submit WeakMap 清理补齐。

## English

- **1.1.67**.
- **#85**: Continue loop no longer spins forever on TRANSPORT/429 streaks. `takeContinue` adds a failStreak gate; `refundContinue` leaves `lastContinueSeq` set; 3 consecutive failures abandon.
- **#84**: Region-gate empty-assistant stream becomes one batched `text-chunks` record (with `.length`), no longer hangs the host UI.
- Boot-time seeding: on startup, if `$DSH_HOME/prompt-inject.md` is empty or missing, the encrypted default is written once; a user-edited file is untouched. After the Apply → cleanup → restart cycle, the default prompt is active immediately.
- Windows official-build restart: restart script name now includes `pid+random`, so concurrent instances don't clobber each other; the `.cmd` intermediary is dropped — `wscript.exe //nologo //B` is spawned directly; legacy unsuffixed scripts/logs older than 24h are purged on each startup.
- Kill scope tightened: `ASAR_SWAP_PS1` no longer uses `/IM` to kill by full name — only pids under the install root are stopped, so same-named third-party processes aren't collateral.
- Official CLI shim repair now saves `.mantis.bak` and uses atomic write before overwriting, so power loss / disk full is recoverable.
- First-install not blocked: when WScript checks for clean markers, two nulls (missing or unreadable) now pass through; only an explicit `false` blocks startup.
- Probe caches: `runningExes` / `shortcutExes` no longer cache empty results; `clearDesktopLocateCache()` on Apply still forces a refresh.
- `scheduleAsarRenameWhenIdle` `.rename-pending` lock: clock skew or ≥30-min-old lock is treated as stale and cleared.
- Three `execFileSync` PowerShell calls get `maxBuffer: 8MB` so large results no longer silent-fail with ENOBUFS.
- Also: net-scope region-gate exponential backoff + stricter IPv6 regex; identity `injectMatchers` segments >4096-char payloads, `installAssembleGuard` is idempotent; hooks-deny drops R0 fallback and uses atomic write for state; extract-asar commit no longer deletes `nextDir` and writes `.mantis-recover.json` for rollback; client.js redteam preset detection broadened; `shell.submit` WeakMap cleanup wired.

# 1.1.66

## 中文

- 版本 **1.1.66**。
- **#80**：清洗页可关掉 hooks deny / ask 旁路。关掉且文件干净显示跳过，不计入已应用；关掉后再打开，64/65 会按官方形态再打一次。
- **#81**：继续 / 拒答续跑的来源 kind 改为 `mantis`；限流和传输失败不再自动续一轮。
- 重启后不用点保存也会挂上默认提示词；每一轮都补回全文。空的应用请求不再清空磁盘上的提示词。
- 声明过的 overlay 只剩 `.mantis.bak` 时，应用会先拷回再加载。
- 红队报告补上得分点短名。中文 README 恢复题图和预览图。

## English

- **1.1.66**.
- **#80**: The clean page can turn off the hooks deny/ask bypass. Off + clean files show skipped and are not counted as applied. Turning it back on reapplies 64/65 from the official form.
- **#81**: Continue / refusal-recover use source kind `mantis`. RATE_LIMIT and TRANSPORT no longer start another continue turn.
- Restart hangs the default prompt without a Save click; every step puts the full text back. An empty Apply body no longer wipes the disk prompt.
- A declared overlay that exists only as `.mantis.bak` is copied back before load.
- Red-team reports get short score-point names. Chinese README restores the banner and preview images.

# 1.1.65

## 中文

- 版本 **1.1.65**。
- 默认提示词按 `lib/default-prompt-inject.md` 重新加密进槽。磁盘上仍是用户自己改过的稿时，不覆盖。
- 红队接入截图登记、得分点看图，以及报告六段。可把某次演练导出成目录。
- 技能正文缺工具路径、缺密钥或 VPS 还是占位符时，不再把整条技能标成不可用。缺口留在详情里。
- 打开页面或组装提示词时，会把当前默认稿同步到磁盘，不必先点保存。
- 删掉没有调用的桌面启动封装、旧迁移脚本，以及已经注释掉的手动继续入口。

## English

- **1.1.65**.
- The default prompt is sealed again from `lib/default-prompt-inject.md`. A prompt the user already edited on disk is left as-is.
- Red team gains shot registration, score-point images, and the six-part report. An engagement can be exported to a folder.
- A skill stays usable when a documented tool path, key, or VPS placeholder is missing. The gap stays on the skill detail.
- Opening the page or assembling the prompt writes the current default to disk, without a Save click first.
- Unused desktop launch helpers, the old migration script, and the commented manual-continue entry are removed.

# 1.1.64

## 中文

- 版本 **1.1.64**。
- 红队流程八项。角色稿只在**新建靶标**时播种；已经建好的靶标，要在演练台里把智能体同步一次才会换成新稿。
- **内网**改为叶子节点，自己按收集、梳理、发现、利用做，不再往下派活。
- 并发名额：不带 key 的 release 只放最早的一条。子智能体结束由服务端自动释放；手动释放必须带上 acquire 返回的 key。
- 预检带 `include` 时只体检点名的技能，不再被全局缺密钥拖成失败。缺项带上由用户执行的修复说明。
- IPv6 计分至少两个冒号，`dc01:389` 这类主机名不再 ×3。计分只留在 `score-rules.js`。
- 攻击链计分跳过已停用的得分点。
- `.env` 认 `export KEY=value`。未加引号的行内注释会剥掉，引号里的 `#` 保留。
- 内网计分 code 改为 `central-system`、`boundary-logical`、`boundary-strong` 等，以 `redteam_score_list` 实际返回为准。
- 漏洞发现和利用从 `priority=high` 打起。优先级为空时，先回报指挥补一轮评估。
- 删掉没有调用的代码。设置页里过期的 `legacyApplyPath(...)` 调用改为 `applyPathOp`。

## English

- **1.1.64**.
- Eight red-team flow fixes. Role prompts seed **new** engagements only; sync agents on an existing engagement to pick them up.
- The internal role is a leaf and does collect, assess, scan, and exploit itself.
- A release without a key drops only the oldest reservation. Ending a subagent auto-releases; a manual release must carry the acquire key.
- Preflight `include` checks only the named skills. Broken items include fixes for the user to run.
- IPv6 scoring needs at least two colons, so `dc01:389` is no longer ×3. Scoring lives only in `score-rules.js`.
- Attack-chain scoring skips disabled score points.
- `.env` accepts `export KEY=value` and strips unquoted inline comments. A `#` inside quotes stays.
- Internal score codes match the live list (`central-system`, `boundary-logical`, `boundary-strong`, and the rest), taken from `redteam_score_list`.
- Vuln-scan and exploit start at `priority=high`. If priority is empty, report back and run another assess first.
- Unused code removed. Stale settings calls to `legacyApplyPath` now call `applyPathOp`.

# 1.1.63

## 中文

- 版本 **1.1.63**。
- 官方更新脚本去掉中文注释，避免 `official update script is not ASCII`。

## English

- **1.1.63**.
- Official update script is ASCII only, so the handoff no longer fails the ASCII check.

# 1.1.62

## 中文

- 版本 **1.1.62**。
- 继续/重试重新打开。
- 锚点门：首轮输出上限 1024→8192，最多 2 步；已调工具即放开，英文思考过不了 we 锚也不再卡住。
- 已有预设的锚点配置与包内不一致时同步，不整份覆盖。

## English

- **1.1.62**.
- Continue/retry is on again.
- Anchor gate: bootstrap cap 8192, max 2 steps; promote after the first tool call.
- Existing presets sync the anchor-gate block when it differs from the package.

# 1.1.61

## 中文

- 版本 **1.1.61**。
- **多宿主 Apply**：npm-global 与桌面 `resources/app` 一并补丁（#72 类路径问题）。
- **#73**：代理 / IP / DNS 等 benign 话题不再误触攻击闸门（`net-scope.js`）。
- **#74**：自定义提示词持久化——`resolveInjectText` 读 `prompt-inject.md`，UI 保存走 `saveOverrideContent`，启动 `ensureOperatorBody`。
- **极简**：#80 保持官方 persistent-shell；UI 选 minimal 以 `agent-preset/selected` 为准（不再被会话头 `standard` 误导）；`adaptInjectForMinimalPreset` 对齐 shell-only 工具表。
- **拒答续跑**：`refusal-recover` 识别「我不做 / 不参与」等句式。
- 注入链：`injectMatchers` 防重复段；默认提示词重加密进 `asset-table.js`。

## English

- **1.1.61**.
- **Multi-host Apply**: patch npm-global and desktop `resources/app` together.
- **#73**: Benign proxy/IP/DNS topics no longer trip the attack gate.
- **#74**: Custom prompt persists via `prompt-inject.md` + `saveOverrideContent`.
- **Minimal**: #80 official shell-only preset; preset from `agent-preset/selected`; runtime `adaptInjectForMinimalPreset`.
- **Refusal recover**: broader Chinese refusal phrasing.
- Inject assembly dedupe; default prompt re-sealed.

# 1.1.60

## 中文

- 版本 **1.1.60**。
- **极简 / PTC**：与标准同一任务却被拦，多半是 preset 里 `run_code`、沙箱、plan 文案未洗净，或内置 minimal 缺 `agent-instructions`。本版反转 #60/#61/#63，minimal 补插件（#26）。**完全退出 → 应用 → 重启 → 新开对话** 后再测。
- **回退 → 重新发送**：「回退一次 / 回退上一轮」留在当前对话；已发送句回到输入框，本轮助手输出与 todo 撤掉。**1.1.60** 起按**当前轮**定位，多轮后不会又退到第一条用户消息（#74/#75 + `lib/rewind.js`）。
- **应用 / 重启**：用户点应用、重启时写入 client 包，避免误报「清洗没有完成，已取消重启」。
- 默认提示词从 `default-prompt-inject.md` **重新加密**进 `asset-table.js`；运行时只读加密槽。
- **#66** Windows `app.asar` 无 JScript 时 PowerShell 换包；**#67** `dsh.cmd` 解包路径；**#69** 演练台 `position:fixed`；**#71** assemble 守卫幂等；**#70** 技能路径按本机 OS 判定；**#68** 文档改为 `desktop` profile + `.tar.gz`（Hub 一键仍走 git，见 README）。

## English

- **1.1.60**.
- **Minimal / PTC**: Same task blocked while standard works → uncleared `run_code`, sandbox, or plan text, or minimal preset missing `agent-instructions`. This release flips #60/#61/#63 and adds the plugin on minimal (#26). **Quit fully → Apply → Restart → new chat** before retesting.
- **Rewind → resend**: Rewind buttons stay in the same chat; your last user line returns to the composer and this round’s assistant output/todos drop. From **1.1.60**, bounds follow the **current turn**, not the first user message (#74/#75 + `lib/rewind.js`).
- **Apply / restart**: User Apply/Restart writes client bundles so restart is not cancelled as “clean incomplete”.
- Default prompt **re-sealed** into `asset-table.js`; runtime reads the encrypted slot only.
- **#66** asar swap PS fallback; **#67** `dsh.cmd`; **#69** dock fixed; **#71** idempotent assemble guard; **#70** skill paths per host OS; **#68** docs: `desktop` + `.tar.gz` (Hub one-click still git — see README).

# 1.1.59

## 中文

- 版本升级到 1.1.59。
- 点应用后不再因为宿主路径或旧标记对不上，就报「清洗没有写进当前宿主」（#65）。
- `resources\app\node_modules` 和 `resources\app\dsh\node_modules` 都认。原文里已经没有官方身份句、也没有丢掉注入的写法时，不再要求那两条标记。
- complete 段补丁同时认 tab 和空格。

## English

- Version 1.1.59.
- Apply no longer reports that the clean missed the current host just because the package path or the old markers do not match (#65).
- Both `resources/app/node_modules` and `resources/app/dsh/node_modules` count. If the official identity sentence and the inject-dropping return are already gone, those two markers are not required.
- The complete-prompt patch matches both tab and space indentation.

# 1.1.58

## 中文

- 版本升级到 1.1.58。
- 打开、应用、重启都会挂上提示词。磁盘上有正文就用磁盘，没有就用规则集，再没有就用内置默认，不用再点保存。
- 启动不再在页面发出之后改写前端 client.js，避免输入框因模块版本号对不上而消失（#63）。
- macOS / Linux 已解包桌面端点应用后会退出并重新打开；清洗标记两种写法都认（#64）。

## English

- Version 1.1.58.
- Open, Apply, and restart all hang the prompt. A saved file wins, then the active rule set, then the built-in default. Save is not required.
- Startup no longer rewrites frontend client.js after the page has taken a module revision, so the composer does not disappear (#63).
- Unpacked macOS and Linux desktop builds quit and relaunch after Apply. Both inject markers count as clean (#64).

# 1.1.57

## 中文

- 版本升级到 1.1.57。
- 应用并重启后，设置框里的提示词直接挂到系统段；框空则用当前规则集。两者都空就停下来要求输入。
- 创造、PTC、极简、unrestricted、梁神与标准模式一样清掉拦截和禁止，并保住各自的工具流程。
- 演练授权按本机目录保存，更新后不用重授权；卸载成功后才清掉。空的环境初始化不再当成已配置。
- 官方 Messages 请求的 system 字段改用当前系统提示，不再钉住第一条。

## English

- Version 1.1.57.
- After Apply and restart, the settings-box prompt is hung on the system section. An empty box uses the active rule set. If both are empty, Apply stops and asks for a prompt.
- Cordis, PTC, minimal, unrestricted, and Liangshen clear intercepts and bans the same way standard does, and keep their own tools.
- Drill authorization is stored in this install and survives updates. It is cleared only after uninstall succeeds. An empty environment init is no longer treated as configured.
- The official Messages request system field uses the current system prompt instead of the first snapshot.

# 1.1.56

## 中文

- 版本升级到 1.1.56。
- 应用按设置框、当前规则集、官方系统提示词的顺序选用。空框且没有规则时停下来要求输入，不再把内置默认写进磁盘。
- 清洗和演练台跟随 DSH 主题的透明玻璃，去掉手动换色。
- 说明只保留官方 Web 和官方桌面。

## English

- Version 1.1.56.
- Apply uses the settings box, then the active rule set, then the official system prompt. An empty box with no rules asks for a prompt and does not write the built-in default to disk.
- 清洗 and the drill console use transparent glass that follows the DSH theme. The manual theme switch is gone.
- Docs keep official Web and the official desktop only.

# 1.1.55

## 中文

- 版本升级到 1.1.55。
- 点「应用」并重启后，每一轮 assemble 都会把提示词补回最前；宿主换成新 assemble 也会再包一次，不会第二轮丢掉。
- 空框不再在前端误取消应用；重启前先落下默认提示词。密封 asar 不会因为当前进程还是旧包而取消重启。
- 第二次应用不会因为冷却把重启/注入当成取消；密封包在换掉之前每次应用都会重启一次，补丁写完后不再空转。

## English

- Version 1.1.55.
- After Apply + restart, every assemble turn puts the operator prompt back at the front. If the host replaces assemble, it is wrapped again so turn 2 does not drop the inject.
- An empty settings box no longer cancels Apply on the client; Restart seeds the default prompt first. A sealed asar no longer cancels restart just because the running process still has the old archive.
- A second Apply is not treated as a cancel because of settle cooldown. A sealed archive still restarts on each Apply until swapped; after patches are in, it does not loop.

# 1.1.54

## 中文

- 版本升级到 1.1.54。
- 官方桌面密封 asar 启动不再中途解包/杀进程：避开 Host Fiber._reload 的 INACTIVE_EFFECT / DesktopHostFatalError；补丁留给设置页「应用」。
- 桌面 settle 延后并在 context 停用时退出；启动自愈只写盘、不 scheduleRestart（#59 / #60 / #61）。
- 市场 tar 安装与空 sha / 缺 installed-rev 的无限重启修复仍在（#58–#61，1.1.53）。

## English

- Version 1.1.54.
- Official desktop no longer unpacks or kills the host mid-boot on a sealed asar; that raced Fiber._reload and threw INACTIVE_EFFECT / DesktopHostFatalError. Patches wait for Settings Apply.
- Desktop settle is delayed and aborts on an inactive context; startup self-heal writes files only and does not scheduleRestart (#59 / #60 / #61).
- Marketplace tarball install and empty-sha / missing installed-rev restart loops remain fixed (#58–#61, 1.1.53).

# 1.1.53

## 中文

- 版本升级到 1.1.53。
- 修复点「应用」后无限重启（#59 / #60 / #61）：tarball 安装没有 `installed-rev`、或 `applied.json` 空 sha 时，启动不再反复 reapply+restart；对齐后不再空转重启，并加冷却。
- web 自愈重启不再自动弹浏览器，关窗后不会再被反复拉起新窗口（#59 / #61）。
- 空 sha 只在非密封、且清洗标记还在（或找不到插件根）时补戳，避免冲掉密封宿主自愈（#56 / #57）。
- 市场安装：`package.json` 标明优先 tar.gz/zip，避免 Hub 退回 `git ls-remote` 失败（#58）。

## English

- Version 1.1.53.
- Stop Apply/startup infinite restart (#59 / #60 / #61): missing `installed-rev` after tarball install or empty `applied.json` sha no longer reapply+restart every boot; skip restart once aligned, with a cooldown.
- Web self-heal restart does not open a browser, so closing the window no longer respawns tabs (#59 / #61).
- Empty-sha heal only runs when the host is not sealed and markers are present (or the plugin root is missing), so sealed-host self-heal still works (#56 / #57).
- Marketplace install prefers tar.gz/zip in `package.json` so Hub does not fall back to a failing `git ls-remote` (#58).

# 1.1.52

## 中文

- 版本升级到 1.1.52。
- 官方桌面「应用/重启」不再自动跑官方 installer（#57）：宿主版本由用户自行升级；插件只解包打补丁，避免落盘前误判失败清掉 `resources\\app`。
- 有 `applied.json` 但宿主又回到 sealed / 找不到插件根时，判定未对齐并自愈重打；面板提示「补丁已丢失，请重新应用」。
- 插件启动路径永不自动更新，仅面板手动更新。
- 默认提示词按本地 `default-prompt-inject.md` 重新加密写入 `asset-table.js`。
- 用户自改提示词不会被「应用」盖回加密默认：磁盘正文与内置不同时一律保留；运行时内置默认只读加密槽。
- 回退切点扩到整轮并在替换后清空 derive 缓存，避免下次发送仍带上被撤掉的内容。

## English

- Version 1.1.52.
- Official desktop Apply/Restart no longer auto-runs the official installer (#57); users upgrade the host themselves; the plugin only unpacks and patches.
- If `applied.json` exists but the host is sealed again / plugin root is missing, treat as mismatched and reapply; UI shows patches-lost.
- Plugin startup never auto-updates; update only from the panel.
- Reseal the default prompt from local `default-prompt-inject.md` into `asset-table.js`.
- Keep user-replaced prompts: never overwrite disk text that differs from the bundled sealed default; runtime bundled default comes only from the sealed slot.
- Rewind cuts the whole last turn and invalidates derive cache so the next send does not keep undone content.

# 1.1.51

## 中文

- 版本升级到 1.1.51。
- 修复 `/skills import` 对 `$DSH_HOME/skills` 自身导入时先删后拷把技能删空（#54）。
- 补齐 `platformEnvAdaptStatus` / `platformEnvAdaptSkip`，发送门禁不再误报「环境还没配好」（#55）。
- 修复官方桌面：无版本/同版本 `installer.exe` 被当成待更新劫持重启；更新失败时恢复 `resources/app`；空 sha 的 applied stamp 不再跳过 reapply（#56，0.1.7/0.2 同路径）。
- 补丁 #52 兼容无 `.volatile()` 写法；#57 跟到 `useDeveloperRole` 并覆盖 responses 通路；#48 上游已删句按软完成；状态导出 `patches_ready`；桌面端 shim 显示「本端不需要」。

## English

- Version 1.1.51.
- Reject `/skills import` when source overlaps `$DSH_HOME/skills` so delete-then-copy cannot wipe skills (#54).
- Implement `platformEnvAdaptStatus` / `platformEnvAdaptSkip` so the send gate no longer false-blocks ready environments (#55).
- Official desktop: ignore unversioned/same-version `installer.exe` pending updates; restore `resources/app` if update handoff fails; empty applied stamp sha no longer skips reapply (#56, same path on 0.1.7 and 0.2).
- Patch #52 matches non-`.volatile()` defaults; #57 follows `useDeveloperRole` and covers responses; #48 soft-settles when upstream removed the caution text; export `patches_ready`; desktop shim shows not-needed-here.

# 1.1.50

## 中文

- 版本升级到 1.1.50。
- 修复 macOS 官方桌面：点「应用」假失败「失败: 正在重启。」、解包后 `dsh` CLI 失效、status 误标 ✗（#53）。
- 修复点「应用」重启后默认提示词不注入：未改过时自动落盘内置默认，不必先点保存。

## English

- Version 1.1.50.
- Fix macOS official desktop: Apply false "Failed: Restarting.", broken `dsh` CLI after asar unpack, and status ✗ false negatives (#53).
- Fix default prompt not injecting after Apply + restart; bundled default is written without requiring Save first.

# 1.1.49-beta.1

## 中文

- 版本升级到 1.1.49-beta.1（#53 测试版）。
- 修复 macOS 官方桌面点「应用」后假失败「失败: 正在重启。」：`scheduleRestart` helper/runtime 分支补回 `restarting: true`；Darwin 重启改为 osascript 优雅退出 + SIGTERM/SIGKILL，排除 CLI 进程后再 `open` 重开（剥掉 ELECTRON_RUN_AS_NODE）。
- 解包 app.asar 后自动修补官方 `dsh` CLI 入口（asar/`app/` 回退）并补 `app/runtime -> ../runtime`，避免 `dsh web` 等全部 MODULE_NOT_FOUND。
- `/purge status` 对多路径文件清单按数组逐项判断，不再把已打补丁文件标成 ✗。
- 前端重启失败文案不再把成功分支的 note 当成 error。

## English

- Version 1.1.49-beta.1 (prerelease for #53).
- Fix macOS official desktop Apply false failure "Failed: Restarting.": helper/runtime branches of scheduleRestart return restarting:true; Darwin restart uses osascript quit then SIGTERM/SIGKILL, skips CLI processes, relaunches via open without ELECTRON_RUN_AS_NODE.
- After unpacking app.asar, auto-patch the official dsh CLI entry (asar/app fallback) and add app/runtime -> ../runtime so dsh web and other subcommands keep working.
- /purge status treats multi-path file lists correctly instead of marking patched files as missing.
- Restart failure UI no longer uses the success note as the error detail.

# 1.1.48

## 中文

- 版本升级到 1.1.48。
- 修复红队指挥「只派活」约束被组装时误删，导致不派 subagent；预设在 Agent Teams 下强制重开 classic subagent。
- 增加按任务选用 skill/MCP 的协议（先读目录，再按任务调用；子代理与红队同样）；不改官方注册与工具面。
- 子代理 maxDepth 适配 0.2 无 default 的 schema，补回默认 10。

## English

- Version 1.1.48.
- Fix redteam lead dispatch-only SOP being stripped during assemble; re-enable classic subagent under Agent Teams in the redteam preset.
- Add task-matched skill/MCP selection protocol (read catalog, then call what the task needs; same for subagents and redteam). Does not change official registration.
- Raise subagent maxDepth default to 10 on 0.2 schemas that dropped .default().

# 1.1.47

## 中文

- 版本升级到 1.1.47。
- 演练台「环境适配」接通 `platformConfigGet` / `Save` / `AssignToolkit`，修复 `unknown op: platformConfigGet`，工具路径与 FOFA/VPS 配置可正常读写。
- 技能库目录探测增加 `$DSH_HOME/redteam/skills`，Windows 用 `homedir()` 回退，不再只信空的 `HOME`。
- 知识库优先使用环境适配里的 nuclei 模板路径；空库时显示本机 `knowledge.db` 路径，避免误判成接口挂了。
- 首次安装弹出用户须知：说明用途、免费开源、GitHub 仓库地址；声明背着作者营利将追究法律责任，并提示禁止违法用途。确认后本机不再弹出。
- 桌面定位与表面检测放宽，安装目录名含 `DeepseekHarnessDesktop` 等也能找到本机 Harness；失败的定位缓存不再一直卡住「还没定位」。
- 回退与请求路径小修，降低后轮卡住或假进度的情况。

## English

- Version 1.1.47.
- Wire drill Env adapt ops `platformConfigGet` / `Save` / `AssignToolkit`, fixing `unknown op: platformConfigGet` so tool paths and FOFA/VPS config work again.
- Skill catalog also probes `$DSH_HOME/redteam/skills` and falls back with `homedir()` on Windows when `HOME` is empty.
- Knowledge prefers nuclei templates from Env adapt; empty libraries show the local `knowledge.db` path so a missing API is not assumed.
- First install shows a user notice: what the plugin does, that it is free/open source, the GitHub repo URL, legal warning against profit behind the author, and illegal-use prohibitions. After confirm it does not show again on that machine.
- Broader desktop locate/surface detection (including `DeepseekHarnessDesktop` installs); failed locate caches no longer stick on "host not located".
- Small rewind/request-path fixes to reduce later-turn hangs and misleading progress.

# 1.1.46

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.46銆?.1.45 鏈夐棶棰橈紝鐣ヨ繃锛屼笉瑕佸畨瑁呫€?- 榛樿鎻愮ず璇嶆寜 `default-prompt-inject.md` 閲嶆柊鍔犲瘑鍐欏叆銆?- 淇娉ㄥ叆涓嶇ǔ瀹氾細绗簩杞垨浠诲姟鍋氬埌涓€鍗婁汉璁惧け鏁堛€佽褰撴垚 `project_instructions` 鎷嗘帀鐨勯棶棰樸€?- 宸ヤ綔鍖烘浛鎹㈢鍜屼綔鐢ㄥ煙璇存槑鏀瑰洖 0.1.7 鐨勪紭鍏堢骇锛氫笉鑳藉帇杩?system銆乨eveloper 鍜岀敤鎴峰師璇濄€備富 intro 鐨勫弽杞嫆缁濆彞淇濇寔涓嶅彉銆傚凡缁忓彔涓婄殑浣滅敤鍩熷己鍙ユ暣娈垫敹鎴愯繖涓€鍙ャ€?- 杩涙ā鍨嬪墠鍓ユ帀澶栧眰 ChatML / `<project_instructions>` 澹筹紝閬垮厤妯″瀷鎶婄湡瀹?system 娉ㄥ叆褰撴垚椤圭洰璇存槑銆?- 缁勮鍚庣殑绯荤粺鎻愮ず娈电粺涓€淇濊瘉 `text` 涓哄瓧绗︿覆锛涗笉鍐嶄細璇濋拤姝绘暣娈?sections锛岄伩鍏嶇浜岃疆 `renderPrompt` 璇?`undefined.length` 鐩存帴姝绘帀骞舵姤 `(gateway/internal)`銆?- `agent/pre-step` 濮嬬粓鎶?`decision.messages` 瑙勮寖鎴愭暟缁勶紝閬垮厤绗簩杞彂閫佹椂璇荤┖ messages 鐐告帀銆?- 鍦板尯闂搁棬锛氬鍦板潃鍩熷悕涓嶈兘鍙洜鍏朵腑涓€涓В鏋愬埌鍙楁帶鍦板尯灏辨暣绔欐嫤姝伙紙CDN/澶氱嚎鍣０ IP锛夈€?- 鍥為€€鍚?`deriveMessages` / `systemNodes` 瀵圭己 `content` 鍋氬厹搴曪紝閬垮厤鍥為€€鍐嶅彂閫佹椂 `(gateway/internal)`銆?- 娓呮礂杩涘害锛氭湭瀹氫綅瀹夸富鏃朵笉鍐嶆樉绀哄悡浜虹殑 `0/63`锛涙湰鏈轰笉闇€瑕佹垨缁勪欢鏈鐨勯」璁″叆宸插氨缁紝閬垮厤鍋囩殑 `48/63`銆?- 鐐广€屽簲鐢ㄣ€嶅氨浼氬啓鍏ラ粯璁ゆ彁绀鸿瘝骞舵敞鍏ワ紝妗嗙┖鏃剁敤鍐呯疆榛樿锛屼笉蹇呭厛鐐逛繚瀛樸€?- 淇鍥為€€锛歚snapshotEvents()` 涓虹┖鏃朵笉鍐嶈 `undefined.length`锛岄伩鍏?`(gateway/internal)` 鎶ラ敊瀵艰嚧鍥為€€鏃犳晥銆?
## English

- Version 1.1.46. Skip 1.1.45; that version has bugs. Do not install it.
- Reseal the default prompt from `default-prompt-inject.md`.
- Fix unstable inject: persona dropping on the second turn or mid-task, including cases where the model treated the system inject as `project_instructions` and rejected it.
- Replacement and scope workspace intros match 0.1.7 again: they do not override system, developer, or direct user instructions. The main intro anti-soft-refuse text stays. A stacked scope paragraph is collapsed back to that one sentence.
- Strip outer ChatML / `<project_instructions>` wrappers before the text reaches the model, so a real system inject is not read as project instructions.
- Sanitize assembled system-prompt sections so `text` is always a string; stop pinning full sections for a session, which could make the second turn crash in `renderPrompt` on `undefined.length` with `(gateway/internal)`.
- Always normalize `decision.messages` to an array in `agent/pre-step`, so a second send does not die on a missing messages list.
- Region gate: multi-address hosts are no longer blocked just because one resolved IP is in a controlled region (CDN/noise).
- After rewind, `deriveMessages` / `systemNodes` tolerate missing `content`, so resend no longer fails with `(gateway/internal)`.
- Clean progress: do not show a scary `0/63` before the host is located; items not needed on this install count as ready, so a fake `48/63` no longer appears.
- Apply writes and injects the default prompt; an empty box uses the bundled default, so a separate Save is not required.
- Fix rewind: empty `snapshotEvents()` no longer reads `undefined.length`, so undo no longer fails with `(gateway/internal)`.

# 1.1.44

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.44銆?- 瀹樻柟妗岄潰瑙ｅ紑 `app.asar` 鏃跺厛鍐欏埌鏃佽竟鐨勭洰褰曪紝瑙ｅ紑瀹屾垚鎵嶆崲涓?`resources/app`銆傜洰褰曢噷宸茬粡鏈夊涓讳箣鍚庡彧鏀硅繖浜涙枃浠躲€傚悓涓€浠藉綊妗ｅ張鍑虹幇鏃跺彧鎶婂畠鎸紑銆傚綊妗ｇ殑澶у皬鎴栨椂闂村彉浜嗭紝鎴栫洰褰曚笉鍦ㄤ簡锛屾墠鍐嶈В涓€娆°€傝В鍖呭崱浣忔垨琛ヤ竵娌″啓瀹岋紝鎶婁笂涓€浠芥斁鍥炲幓锛屽崌绾ф爣璁扮暀鍒颁笅娆″啀璇曘€?- 鍥為€€涓婁竴杞彧鎾ゆ帀鏈€鍚庝竴鏉″凡缁忓彂鍑虹殑娑堟伅鍜屽畠鐨勫洖澶嶏紝鏇存棭鐨勮疆娆＄暀鍦ㄥ璇濋噷锛屼篃浠庢ā鍨嬭姹傞噷鎷挎帀銆傝繛缁洖閫€鍚庣暀涓嬬殑绌烘爣璁颁笉鍐嶈繘涓嬩竴杞姹傦紝涓嬩竴鍙ユ寜鏂版秷鎭彂銆?- 鍙紪杈戞彁绀鸿瘝鏁翠唤鏀惧湪绯荤粺鎻愮ず鏈€鍓嶏紝鍚屼竴浠芥鏂囦笉鍐嶆嫾绗簩閬嶃€傛瘡涓€姝ョ敤褰撳墠杩欎竴浠芥浛鎹㈢涓€鏉＄郴缁熸彁绀恒€?- deepseek.com 鐨勭郴缁熸彁绀哄浐瀹氳蛋 system锛屾€濈淮閾剧収鏃у彂閫併€?- 鍦板尯鎷︽埅鍙湅杩欐浠诲姟閲岀殑鐩爣銆傝嚜宸辩殑鏈嶅姟鍣ㄥ彧璁ゅ悕鍗曚笂鐨勯偅涓€涓湴鍧€鎴栦富鏈哄悕銆傜姝㈠彞鍐欎笂涔嬪悗鎵嶇粨鏉熻繖涓€杞€?- 瀹樻柟濮嬬粓鐢ㄥ甫 CTF 鐨勯粯璁ゆ彁绀鸿瘝銆傜孩闃熷紑浜嗚鍒欓泦灏卞彧鐢ㄨ鍒欓泦锛涘惁鍒欑敤鍘绘帀 CTF 鐨勯粯璁ゆ彁绀鸿瘝锛屽啀鎺ョ孩闃熸搷浣溿€傚瓙浠ｇ悊璺熶富浼氳瘽鍚冨悓涓€浠姐€傜鐩樻病鏈夋彁绀鸿瘝鏃跺惎鍔ㄥ氨鐢ㄩ粯璁ら偅浠斤紝涓嶅繀鍏堢偣淇濆瓨銆?
## English

- Version 1.1.44.
- Unpacking `app.asar` writes beside `resources/app` and swaps in only after the unpack finishes. Once that directory is usable, later starts only edit those files. The same archive showing up again is moved aside. A new size or mtime, or a missing directory, is unpacked once. If unpacking sticks or that patch round does not finish, the previous directory is put back and the upgrade marker stays for the next start.
- Rewinding the previous round removes only that sent message and its reply. Earlier rounds stay on screen and leave the next model request. Leftover rewind markers stay off the next model request, so the next send is a new message.
- The editable prompt is placed once at the front of the system prompt. Each step replaces the first system prompt with that current text.
- Instructions for deepseek.com stay on the system role. Thinking is still sent.
- The region check looks only at this task's target. An own server is allowed only when that exact address or hostname is on the list. The turn ends after the denial sentence is written.
- Official mode always uses the default prompt, including CTF. Red team uses only the active rule set, or the default prompt without CTF followed by the red team steps. Subagents receive the same inject as the main session. If the prompt file is empty, startup uses the bundled default without requiring Save.

# 1.1.43

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.43銆?- 杩樻病瀹氫綅鍒版湰鏈?Harness 鏃讹紝涓嶅啀鎶婃瘡涓€鏉℃樉绀烘垚璺宠繃锛屽垎缁勮鏁颁篃涓嶅啀鎶婅烦杩囩畻鎴愬凡瀹屾垚銆?- 琛ヤ竵鍒楄〃琛ラ綈鍒板叏閮?52 鏉★紝鎬绘暟鍜屽垎缁勫寰椾笂銆?- 鍚姩鏃跺鏋滄殏鏃舵壘涓嶅埌瀹夸富鐩綍锛屼笉鍐嶆妸杩欎釜绌虹粨鏋滅紦瀛樹綇銆?
## English

- Version 1.1.43.
- Before this install is located, rows are no longer shown as skipped, and a skip no longer counts as done in the group total.
- The patch list now includes all 52 items, so the total matches the groups.
- A miss while looking up the host directory is not cached for the rest of the process.

# 1.1.42

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.42銆?- 娓呮礂椤垫彁绀鸿瘝涓嬮潰鍙互鐧昏鑷繁鐨勬湇鍔″櫒锛氭瘡琛屼竴涓?IP 鎴栧畬鏁翠富鏈哄悕锛岀偣淇濆瓨鍚嶅崟銆傝鏄庨噷鍐欎簡姝ラ锛屽苟闄勪簡鎴浘銆?- 鏂板璇濇妸鎻愮ず璇嶆斁鍦ㄧ郴缁熸彁绀烘渶鍓嶃€傞潰鏉挎敼涓虹櫧澧ㄧ幓鐠冿紝涓ょ涓婚閮借兘鐪嬫竻瀛椼€?- 琛ヤ竵杩涘害鍙宸插簲鐢ㄧ殑椤广€傜綉椤佃韩浠介偅鏉″湪鍚庝竴鏉℃敼鍐欏彞瀛愪箣鍚庯紝浠嶆樉绀哄凡搴旂敤銆?- 琛ヤ笂 0.1.x 鐨勫叆鍙ｉ拡銆傚凡缁忔墦杩囩殑 0.2.0 涓嶄細琚噸鍐欍€?
## English

- Version 1.1.42.
- Under Prompt on the Clean page, register your own server: one IP or exact hostname per line, then Save list. The docs include the steps and a screenshot.
- New chats place the prompt at the front of the system prompt. The dock is frosted glass, and both the light and ink themes stay readable.
- The patch count includes only applied items. The web-surface identity row stays applied after the later sentence rewrite.
- Needles for 0.1.x entry points were added. An already patched 0.2.0 host is not rewritten.

# 1.1.41

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.41銆?- 瀹樻柟妯″紡鍙敞鍏ュ綋鍓嶆彁绀鸿瘝锛涘惎鐢ㄨ鍒欓泦鍚庝互瑙勫垯闆嗕负涓汇€傜孩闃熷啀闄勪笂绾㈤槦鎿嶄綔瑕佹眰銆?- 鍥為€€鐣欏湪褰撳墠浼氳瘽锛氬厛閫夊洖閫€涓€娆℃垨涓婁竴杞紝涓婁竴鍙ユ斁鍥炶緭鍏ユ锛屽苟娓呮帀宸茬粡鍙戝嚭鍘荤殑鍐呭銆?- 瀹夸富娌℃竻娲楀畬锛屾垨娌℃湁鍙敞鍏ョ殑鎻愮ず璇嶆椂锛屼笉閲嶅惎銆?- 榛樿宸叉槸瀹屽叏鏉冮檺鏃讹紝鏂颁細璇濅笉鍐嶈閽夊洖鍙楅檺鏉冮檺銆傚畼鏂规ā鍨嬬殑 Session Log 涓婁紶榛樿鍏抽棴銆?- 鐩爣鍦板潃钀藉湪涓浗澶ч檰銆侀娓€佹境闂ㄦ椂鍋滄銆?
## English

- Version 1.1.41.
- Official modes inject the editable prompt, or the active rule set when one is enabled. Red team also keeps its operating section.
- Rewind stays on the current session: choose one step or the last round, return the last line to the composer, and clear what was already sent.
- Restart is cancelled unless the host is cleaned and inject text is present.
- A full-access default is no longer pinned back to a restricted preset. Official model Session Log upload is off by default.
- Targets whose addresses fall in mainland China, Hong Kong, or Macau are stopped.

# 1.1.40

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.40銆?- 閫傞厤 **DSH 0.2.0-rc.2**锛欰nthropic OAuth 涓嶅啀鍦ㄧ郴缁熸彁绀烘渶鍓嶉潰寮烘彃銆孻ou are Claude Code鈥︺€嶏紝鑷畾涔?`prompt-inject` 涓嶄細琚帇鍒板悗闈€?- 鍘绘帀鍦?0.2 閲屽凡涓嶅瓨鍦ㄧ殑 **patch 41**锛坉eveloper 瑙掕壊鏀瑰啓锛夛紝閬垮厤鏃犳晥琛ヤ竵鍗犱綅銆?- 璁剧疆椤电偣 **搴旂敤** 鎴愬姛鍚?**鑷姩閲嶅惎** 瀹夸富锛屼笉蹇呭啀鎵撳紑鎻掍欢鐐圭浜屾閲嶅惎銆?
## English

- Version 1.1.40.
- For **DSH 0.2.0-rc.2**, Anthropic OAuth no longer prepends 鈥淵ou are Claude Code鈥︹€?ahead of your system prompt, so custom `prompt-inject` is not pushed behind a Claude identity block.
- Removed **patch 41** (developer-role remap) because those needles are gone in 0.2.
- After **Apply** in settings, the host **restarts automatically**; you no longer need to open the plugin again to confirm restart.

# 1.1.39

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.39銆?- 涓枃 Windows 涓婏紝瀹樻柟妗岄潰鐗堢偣銆屽畨瑁呭苟閲嶅惎銆嶄笉鍐嶅仠鍦ㄣ€屾鍦ㄥ噯澶囬噸鍚€嶃€傛洿鏂拌剼鏈琛屾敼涓虹函 ASCII锛岃矾寰勯噷鐨勪腑鏂囧啓鎴?`\u` 杞箟锛岄伩鍏?Windows Script Host 鎸?GBK 鎶婃崲琛屽悶杩涙敞閲娿€?- macOS 鍜?Linux 涓嶈蛋杩欐潯鑴氭湰锛岄噸鍚柟寮忎笉鍙樸€?
## English

- Version 1.1.39.
- On Chinese Windows, the official desktop install-and-restart no longer stays on preparing to restart. The update script starts with an ASCII comment, and non-ASCII paths are written as `\u` escapes, so Windows Script Host does not swallow the newline when it reads the file as GBK.
- macOS and Linux do not use this script. Their restart path is unchanged.

# 1.1.38

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.38銆?- 绾㈤槦涓嶅啀鏇跨敤鎴蜂笅杞藉伐鍏枫€傛病鏈夊畨瑁呰剼鏈椂锛屽紩瀵兼敼璧版紨缁冨彴銆岀幆澧冮€傞厤銆嶏紝鐢辩敤鎴疯嚜宸卞～璺緞銆?- 闀挎椂闂翠换鍔′細鍦ㄧ郴缁熸彁绀鸿瘝閲屾斁涓€寮犮€屾湰娆＄洰鏍囥€嶅崱銆傛寚鎸ュ拰瀛愪唬鐞嗙湅鐨勬槸鍚屼竴寮狅細鍙墦杩欎釜鍗曚綅锛屽洖鎶ラ噷甯﹀嚭鏉ョ殑鍏跺畠鍗曚綅涓嶆墦銆傚瓙浠ｇ悊鎸夎鑹蹭娇鐢ㄨ嚜宸辩殑鎻愮ず璇嶏紝娲炬椿鏃剁殑鍗曚綅鍚嶇О蹇呴』鍜岃繖寮犲崱涓€鑷淬€?- 宸ュ叿鏌ユ壘璁ゅ彂琛岀増涓婄殑鐪熷疄鏂囦欢鍚嶏紝渚嬪 Kali 鐨?`httpx-toolkit`銆乣impacket-secretsdump`锛屼笉鍐嶆妸 Python 鐨?`httpx` 褰撴垚鎵弿鍣ㄣ€?- 瀹樻柟妗岄潰鍦?macOS銆丩inux 涓婁篃鑳芥壘鍒?`app.asar`锛圡ac 鐢?`Contents/Resources`锛夈€俉indows 浠ュ涓嶅啀鍖呬竴灞備細鎶?`require` 寮勫潖鐨勬帶鍒跺彴闅愯棌銆?- 绾㈤槦鎺ュ叆閿氱偣闂細寮€澶村嚑姝ヨ緭鍑轰笂闄?1024锛涚涓€娈垫€濊€冮噷鏈?`we`銆佹病鏈?`let me` 灏辨斁寮€锛屽惁鍒欏悓涓€杞渶澶氬啀璧?4 姝ャ€備笂涓嬫枃鍘嬬缉鍚庡啀鍏充竴娆°€傜孩闃熷伐鍏峰拰浜鸿淇濇寔鍘熸牱銆?- 闅忓寘鎶€鑳藉悓姝ュ埌 `$DSH_HOME/redteam/skills`锛岄璁剧敤 `dshHomePath` 鎸囧悜瀹冿紝涓嶅啀鎶婃煇涓€鍙扮數鑴戠殑 `node_modules` 璺緞鍐欒繘棰勮銆備綘鑷繁鐨勬妧鑳戒粛鍦?`$DSH_HOME/skills`锛屽悓鍚嶄互浣犵殑涓哄噯銆?- 淇ソ绾㈤槦妯″紡涓嶆樉绀猴細澹版槑棰勮鏃舵紡浜嗚矾寰勫彉閲忥紝鎻掍欢涓€旈€€鍑猴紝妯″紡涓嬫媺灏辨病鏈夎繖涓€椤广€?- 璇存槑閲屽姞鍥炶禐鍔╁湴鍧€銆?
## English

- Version 1.1.38.
- Red team no longer downloads tools for you. When the setup script is missing, the guide points at the drill console environment page so you fill in the paths.
- Long jobs keep a target card in the system prompt. The commander and subagents see the same card: stay on that organization, and do not switch to other names that show up in results. Each subagent loads its own role text, and dispatched work must use the name on the card.
- Tool lookup accepts distro filenames such as Kali's `httpx-toolkit` and `impacket-secretsdump`, and does not treat Python's `httpx` as the scanner.
- The official desktop app can find `app.asar` on macOS and Linux (`Contents/Resources` on Mac). Outside Windows, the console-hide wrapper that broke `require` is not installed.
- Red team uses an anchor gate: the first steps are capped at 1024 output tokens, the cap lifts when the first reasoning block contains `we` and not `let me`, otherwise it lasts at most 4 steps in that turn, and a context compaction closes the gate again. Red team tools and the persona stay as they are.
- Bundled skills are copied to `$DSH_HOME/redteam/skills` and the preset points there with `dshHomePath`, instead of a machine-specific `node_modules` path. Your own skills stay in `$DSH_HOME/skills` and win on the same name.
- Red team mode shows in the mode list again. Declaring the preset no longer exits early because a path variable was missing.
- The sponsor addresses are back in the readme.

# 1.1.37

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.37銆?- 淇敼婕旂ず鍙扮幆澧冮厤缃粴鍔ㄩ棶棰樸€?
## English

- Version 1.1.37.
- The drill console environment page scrolls, so the rest of the settings can be filled in.

# 1.1.36

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.36銆?- 瑙ｅ喅绾㈤槦妯″紡鎷掔粷闂銆?
## English

- Version 1.1.36.
- Fix red team mode refusing the cleaned prompt.

# 1.1.35

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.35銆?- 鍚姩鏃朵笉鍐嶈嚜鍔ㄦ洿鏂帮紝瑕佽嚜宸卞湪闈㈡澘閲岄€夋嫨銆?- mantis 鍏ュ彛鏀瑰埌銆屼笂涓嬫枃銆嶆梺杈癸紝涓嶅啀鎸′綇鍒殑鎻掍欢鎸夐挳銆?- 寰楀垎鍙ｅ緞瀵归綈涓婃父锛?5 椤癸紝Web 搴旂敤澧炲姞鍏滃簳褰掔被銆?- 鐭ヨ瘑搴?14 绫昏鏁板寘鍚湰鏈?nuclei 妯℃澘锛岀偣鏌愪竴绫诲彲浠ョ瓫閫夈€?- 鎶€鑳借矾寰勮窡闅?`$DSH_HOME`锛屼笉鍐嶅洜涓虹ず渚嬭矾寰勫湪鏈満涓嶅瓨鍦ㄥ氨鎶婃暣鏉℃妧鑳芥爣鎴愪笉鍙敤銆?
## English

- Version 1.1.35.
- Startup no longer auto-updates; choose the update in the panel.
- The mantis entry sits beside Context, so it no longer covers other plugin buttons.
- Scoring matches upstream: 25 items, with a fallback bucket for other web apps.
- The 14 knowledge categories count local nuclei templates, and a category filters the list.
- Skill paths follow `$DSH_HOME`. A skill is no longer marked unavailable just because an example path is missing on this machine.

# 1.1.34

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.34銆?- **婕旂粌鍙扮煡璇嗗簱鐩存帴鍒楀嚭鏈満妯℃澘**銆傛墦寮€銆岀煡璇嗗簱 路 POC / EXP銆嶅氨鑳界湅鍒颁竴椤?nuclei 妯℃澘锛屽苟鍙互缈婚〉銆佹寜 CVE 鎴栫粍浠舵悳绱€備笉鍐嶅彧鏄剧ず銆屾湰鏈烘ā鏉?N銆嶃€佷笅闈㈡槸绌虹殑銆?- **鏇存柊鍖呭湪 Windows銆乵acOS銆丩inux 涓婇兘鑳借В鍘?*銆侺inux 涓嶅啀璋冪敤 PowerShell銆傞『搴忔槸锛歐indows 鐢?tar锛屼笉琛屽啀鐢?PowerShell锛沵acOS 鍜?Linux 鐢?tar銆乽nzip銆乸ython3銆乥sdtar銆傝繖浜涢兘娌℃湁鏃讹紝鐢?Node 鑷繁瑙?zip銆傛劅璋?@cracer4869 鍦?#44 鎶ュ嚭 Kali 涓婄殑 `spawnSync powershell ENOENT`銆?
## English

- Version 1.1.34.
- **The drill knowledge page lists local templates.** Opening Knowledge shows a page of nuclei templates, with paging and search by CVE or component. It no longer shows only the template count.
- **Update archives extract on Windows, macOS, and Linux.** Linux does not call PowerShell. Windows tries tar, then PowerShell. macOS and Linux try tar, unzip, python3, then bsdtar. If none of those exist, Node extracts the zip itself. Thanks to @cracer4869 for reporting `spawnSync powershell ENOENT` on Kali in #44.

# 1.1.33

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.33銆?- **淇宸茬粡閲嶅惎鍚庯紝鎵撳紑闈㈡澘浠嶅脊鍑恒€岄渶瑕侀噸鍚€?*銆傚畼鏂瑰鎴风宸茬粡浠庤В寮€鐨?`resources/app` 杩愯鏃讹紝涓嶅啀浠呭洜涓哄綋鍓嶆槸瀹樻柟杩涚▼灏卞啀瑕佹眰閫€鍑轰竴娆°€傚彧鏈夎繖娆＄湡鐨勬尓寮€浜?`app.asar`锛屾墠浼氭彁绀洪噸鍚€?
## English

- Version 1.1.33.
- **Fix the restart dialog coming back after you already restarted.** When the official app is already running from the unpacked `resources/app`, opening the panel no longer asks you to quit again just because this is the official process. The restart prompt appears only when `app.asar` was actually moved aside in this run.

# 1.1.32

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.32銆?- **鎸夋祴璇曠増鎺ヤ笂婕旂粌鍙板竷灞€**锛氶潰鏉垮彲鎷栧姩銆佸彲鏀瑰ぇ灏忥紝娴呰壊鍜屾繁鑹茶窡瀹夸富涓婚璧般€?- **璁剧疆椤典笉鍐嶅嚭鐜版湰鎻掍欢**銆備粠浼氳瘽鏍囬鏃佺殑 mantis 鎵撳紑鍙充晶鏍忥紝娓呮礂鍜屾紨缁冨彴閮藉湪閲岄潰銆?
## English

- Version 1.1.32.
- **Bring the beta dock layout onto stable**: the panel can be dragged and resized, and light and dark follow the host theme.
- **The plugin no longer appears on the Settings page.** Open the right dock from mantis beside the session title. Clean and Drill are both in that dock.

# 1.1.31

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.31銆?- **婕旂粌鍙拌繘鍏ユ寮忕増**銆傚彸渚ф爮涓ら〉锛氭竻娲椼€佹紨缁冨彴銆傜涓€娆¤繘鍏ユ紨缁冨彴瑕佽澹版槑骞剁‘璁ゆ巿鏉冦€傝祫浜с€佹妧鑳藉拰鏈満鐜閮藉湪鏈彃浠堕噷锛屼笉鍐嶅崟鐙娴嬭瘯鐗堢孩闃熷寘銆?- **淇鍥為€€鍫嗗垎鏀?*锛氬涓讳笉鑳藉湪鍘熶細璇濋噷鎴柇锛屽洖閫€鍚庝細鎶婃棫浼氳瘽浠庝晶杈规爮绉诲嚭锛屽閫€鍑犳涓嶄細鐣欎笅涓€涓插垎鏀€?
## English

- Version 1.1.31.
- **Drill console is on the stable release.** The right dock has two pages: Clean and Drill. The first time you open Drill you read the notice and confirm authorization. Assets, skills, and the local environment ship inside this plugin.
- **Fix rewind leaving a branch every time.** The host cannot truncate a session in place. After rewind the old session leaves the sidebar, so repeated undo does not pile up branches.

# 1.1.30

## 涓枃

- 鐗堟湰鍗囩骇鍒?1.1.30銆?- **淇姝ｅ紡鐗堝拰 web 鍒囨崲鐗堟湰澶辫触**锛氫笉鍐嶇敤 `dsh plugin add` 鎷夊寘銆俻npm 璇锋眰 GitHub 鍘嬬缉鍖呬細 `http 302` 鎴?`fetch failed`銆傛敼鐢辨彃浠惰嚜宸变笅杞姐€?- **淇鎬濊€冨拰杈撳嚭姝诲惊鐜?*锛氬幓鎺夐粯璁ゆ彁绀鸿瘝閲屾病鏈夌粓姝㈡潯浠剁殑閲嶇疆銆?
## English

- Version 1.1.30.
- **Fix version switching on the desktop app and web**: stop installing through `dsh plugin add`. pnpm's fetch of the GitHub archive returns `http 302` or `fetch failed`. The plugin downloads the package itself.
- **Fix the thinking and output loop**: remove the default-prompt reset that had no stop condition.

# 1.1.28

## 涓枃

- **淇鏇存柊澶辫触 `http 302`**锛氫笅杞芥敼涓虹洿杩?`codeload.github.com`锛屽苟鎵嬪姩璺熼殢璺宠浆锛岄伩鍏?Electron/閮ㄥ垎 Node 瀵?github.com 鈫?codeload 鐨?302 澶勭悊澶辫触銆?- **淇娴嬭瘯鐗堝垪琛ㄧ┖鐧?*锛氬墠绔?`keepListedVersion` 涓庡悗绔竴鑷达紝姝ｅ紡鐗堝凡鍙戝竷鏃朵粛淇濈暀 beta tip / `beta` 鍒嗘敮锛泃ip SHA 鎷変笉鍒版椂鍥為€€ raw/jsDelivr 鎺㈡祴銆?
## English

- **Fix update failure `http 302`**: download via `codeload.github.com` and follow redirects manually so Electron/some Node builds no longer stall on github.com 鈫?codeload 302.
- **Fix empty beta list**: client `keepListedVersion` matches the server 鈥?keep the beta tip / `beta` branch after stable ships; fall back to raw/jsDelivr when tip SHA cannot be fetched.

# 1.1.27

## 涓枃

- **淇搴旂敤閲嶅惎鍚庤繘瑙勫垯璁惧畾浠嶅脊銆岄渶瑕侀噸鍚€?*锛氭墜鍔ㄣ€屽簲鐢ㄣ€嶆垚鍔熷悗鍐欏叆 `applied` 鎴筹紝閲嶅惎鍚?settle 涓嶅啀璇垽琛ヤ竵鏈榻愩€?- 鐐广€岄噸鍚€嶆竻鎺?`boot_full_quit` 绮樻€ф爣璁帮紱status 鎸夊竷灏斿€煎悓姝ュ脊绐椼€?- web `waitForRestart` 蹇呴』鍏堢湅鍒版棫杩涚▼鎺夌嚎鍐嶅垽瀹氭垚鍔燂紝閬垮厤鍚岃繘绋嬭鍒锋柊鍙堝脊绐椼€?
## English

- **Fix restart prompt still showing after Apply + successful restart**: write the `applied` stamp on successful manual Apply so settle does not think patches are out of date.
- Clear sticky `boot_full_quit` when Restart is clicked; status syncs the modal from the boolean.
- Web `waitForRestart` requires the old process to go down before treating restart as success, avoiding same-process false refresh.

# 1.1.26

## 涓枃

- **淇娴嬭瘯閫氶亾琚寮忕増鍚屽彿钘忔帀**锛歚1.1.25` 姝ｅ紡鍙戝竷鍚庯紝`1.1.25-beta.*` 鍥犮€屾寮忓凡杩戒笂銆嶉€昏緫鏁撮€氶亾涓嶅彲瑙侊紱鐜?**beta 鍒嗘敮 tip 濮嬬粓鍒楀嚭**锛堟寮?娴嬭瘯骞惰锛屾祴璇曞甫绾㈤槦锛夈€?- 宸茶拷涓婄殑鏃?beta **鏍囩**浠嶄細闅愯棌锛沗1.1.11-beta` 浠嶄笅绾裤€?
## English

- **Fix beta lane hidden by same-number stable**: after `1.1.25` stable, `1.1.25-beta.*` vanished via the 鈥渟table caught up鈥?filter; the **beta branch tip always stays listed** (parallel channels; beta carries red-team).
- Older caught-up beta **tags** still hide; `1.1.11-beta` stays withdrawn.
# 1.1.25

## 涓枃

- **淇 [#43](https://github.com/YuJunZhiXue/dsh-purge/issues/43)**锛氫笉鍐嶆妸 `profiles/*/cordis.patch.yml`锛堢敤鎴?patch 灞傦級绾冲叆 `backupAll`/`revertAll`锛涘崌绾ц嚜鎰堟椂涓嶄細鐢ㄦ棫 bak 瑕嗙洊鐢ㄦ埛鍚庢潵杩藉姞鐨?`insert`銆?- 鍚姩/杩樺師鏃朵富鍔ㄤ涪鎺夊巻鍙蹭笂璇缓鐨?`cordis.patch.yml.mantis.bak`锛屼繚鐣欏綋鍓嶇敤鎴锋枃浠躲€?- 鏂板 `npm run test:profile-patch`銆?
## English

- **Fix [#43](https://github.com/YuJunZhiXue/dsh-purge/issues/43)**: stop including `profiles/*/cordis.patch.yml` (user patch layer) in `backupAll`/`revertAll`, so upgrade reapply no longer restores an old bak over later user `insert`s.
- Drop stale `cordis.patch.yml.mantis.bak` without restoring; keep the live user file.
- Add `npm run test:profile-patch`.
# 1.1.24

## 涓枃

- **淇 [#40](https://github.com/YuJunZhiXue/dsh-purge/issues/40)**锛歚pathLooksDesktop` 涓嶅啀浠呭嚟璺緞閲岀殑 `deepseek-harness` 瀛愪覆鎶婃簮鐮佺増鍒ゆ垚妗岄潰绔紱闇€甯?`resources/` / `.exe` / `.app` 绛夊畨瑁呭舰鎬併€?- **淇 [#41](https://github.com/YuJunZhiXue/dsh-purge/issues/41)**锛氭簮鐮侀儴缃茬殑 `apps/cli`锛坱sdown 鏋勫缓浜х墿锛夌姝?hide-console 娉ㄥ叆锛沗revertAll` 鍦ㄦ棤 `.mantis.bak` 鏃跺彧璺宠繃銆佺粷涓嶅垹闄ょ洰鏍囨枃浠躲€?- 鏂板 `npm run test:surface` 鍥炲綊銆?
## English

- **Fix [#40](https://github.com/YuJunZhiXue/dsh-purge/issues/40)**: `pathLooksDesktop` no longer treats source trees as desktop just because the path contains `deepseek-harness`; require install shapes (`resources/`, `.exe`, `.app`).
- **Fix [#41](https://github.com/YuJunZhiXue/dsh-purge/issues/41)**: skip hide-console injection into source `apps/cli` build output; `revertAll` never deletes targets when `.mantis.bak` is missing.
- Add `npm run test:surface`.
# 1.1.23

## 涓枃

- **淇 [#38](https://github.com/YuJunZhiXue/dsh-purge/issues/38)**锛歚#1`/`#2`/`#3` 鎻愮ず璇嶈ˉ涓佹瘡娆?`apply` 鍙犲姞绾?+841 瀛楃銆佹案涓嶆敹鏁涖€?- **鍘熷洜**锛氭浛鎹骇鐗╀粛浠ュ墠涓€鐗堟枃鏈负鍓嶇紑锛屼笖鏈 `skipIfMarked`锛宍autoApplyOnStart` 姣忚疆閮戒細鍐嶅啓涓€灞傘€?- **淇**锛氫负 `#1`/`#2`/`#3` 琛?`skipIfMarked: true`锛圼#42](https://github.com/YuJunZhiXue/dsh-purge/pull/42)锛夛紝骞跺姞 `npm run test:idempotence` 鍥炲綊銆?- 宸茶啫鑳€鐨勫涓绘枃浠朵笉浼氳嚜鍔ㄧ缉鍥烇紝闇€杩樺師 `.mantis.bak` 鎴栭噸瑁?dsh 鍚庡啀 apply銆?
## English

- **Fix [#38](https://github.com/YuJunZhiXue/dsh-purge/issues/38)**: prompt patches `#1`/`#2`/`#3` grew by ~+841 chars on every `apply` and never converged.
- **Cause**: replacement text still starts with the previous pattern, and `skipIfMarked` was missing, so `autoApplyOnStart` rewrote every boot.
- **Fix**: set `skipIfMarked: true` on `#1`/`#2`/`#3` ([#42](https://github.com/YuJunZhiXue/dsh-purge/pull/42)); add `npm run test:idempotence`.
- Already-bloated host files are not auto-shrunk 鈥?restore `.mantis.bak` or reinstall dsh, then apply again.

# 1.1.22

## 涓枃

- **淇瀹樻柟妗岄潰鐐广€屽簲鐢ㄣ€嶆姤 ENOENT**銆俙app.asar` 杩樺湪鏃讹紝鏂板缓 `mantis-child-process-hide.mjs` 浼氬け璐ワ紝璺緞琚啓鎴?`resources\app.asar\...\mantis-child-process-hide.mjs`锛岃ˉ涓佸仠鍦ㄥ緟搴旂敤銆?- **鍘熷洜**锛氬畼鏂瑰鎴风杩樺甫鐫€ `app.asar` 鏃讹紝Electron 浼氭妸 `resources\app` 鏄犲皠杩涜繖涓綊妗ｃ€傚綊妗ｉ噷娌℃湁鐨勬柊鏂囦欢锛岀敤鏅€氭枃浠舵帴鍙ｅ幓鍒涘缓灏变細 ENOENT銆?- **涓ょ鍐欐硶閮戒繚鐣?*銆傚綊妗ｈ繕鍦ㄦ椂锛屾敼鍐欑湡瀹炵鐩樹笂鐨?`resources\app`銆傛病鏈?`app.asar` 鏃朵粛鐢ㄥ師鏉ョ殑 `node:fs`锛屽寘鎷?Web銆佺ぞ鍖烘闈紝浠ュ強瀹樻柟鍖呭凡缁忚В寮€骞舵妸褰掓。鎸垚 `app.asar.bak` 鐨勬儏鍐点€?- 瀹夎鐩綍涓嶅啓姝荤洏绗︺€俉eb 鍜岀ぞ鍖烘闈㈢殑搴旂敤銆侀噸鍚繚鎸佸師鏍枫€傚涓讳粛瀵瑰噯 **dsh 0.1.7-rc.2**銆?
## English

- **Fixes ENOENT when Apply runs on the official desktop.** While `app.asar` is still present, creating `mantis-child-process-hide.mjs` failed. The path was rewritten to `resources\app.asar\...\mantis-child-process-hide.mjs`, and patches stayed pending.
- **Cause**: with the archive still in place, Electron maps `resources\app` into `app.asar`. Creating a file that is not already in the archive through the normal file API throws ENOENT.
- **Both write paths stay.** If the archive is still there, files are written on the real `resources\app` directory. If there is no `app.asar`, the previous `node:fs` path is unchanged. That covers Web, community desktop, and an official install that has already been unpacked and had the archive moved to `app.asar.bak`.
- Install paths are not pinned to a drive letter. Web and community desktop keep their existing Apply and restart. The host target remains **dsh 0.1.7-rc.2**.

# 1.1.21

## 涓枃

- **淇蹇呴渶琛ヤ竵澶辫触 #43銆?9銆?15銆?23銆?42**銆傜偣銆屽簲鐢ㄣ€嶄笉鍐嶅洜涓鸿繖 5 鏉℃姤銆屾竻娲楁湭瀹屾垚銆嶃€傛彁绀鸿瘝鏈潵灏变細鍐欏叆锛涜繖 5 鏉℃病鍐欎笂鏃讹紝鐣岄潰鍗存妸鏁存搴旂敤鍒ゅけ璐ワ紝鐪嬭捣鏉ュ儚鎻掍欢澶辨晥銆?- **鍘熷洜**锛氫笂绾ф枃浠跺す鍚嶅彨 DeepSeek Harness 鏃讹紝鏁存５鐩綍琚綋鎴愬畼鏂规闈€俉eb 鐨?npm 鍖呭洜姝よ鎺掗櫎锛岃繖 5 鏉″寰椾笂鐨勫師鏂囦篃娌″啓杩涘幓銆傚畨瑁呰矾寰勪笉鍐欐鐩樼銆傜幇鍦ㄥ彧鏈夋梺杈圭湡鏈夋闈㈢▼搴忥紝鎴栬矾寰勫湪璇ュ畨瑁呯殑 `resources/app` 閲岋紝鎵嶇畻妗岄潰瀹夎銆俉eb銆佺ぞ鍖烘闈€佸畼鏂规闈㈠悇鑷墦鑷繁鐨勫寘銆?- **#43**锛氬幓鎺?Web 鍥涗釜鍐呯疆棰勮锛坰tandard銆乸tc銆乧ordis銆乵inimal锛夐噷鐨勮韩浠藉彞銆傛病鍐欎笂鏃讹紝棰勮閲岀殑鍘熻韩浠藉彞浼氱暀鍦ㄦ敞鍏ユ梺杈广€?- **#9**锛氬鎵硅姹傝嚜鍔ㄦ斁琛屻€?- **#15**锛氭矙绠?`confine` 涓嶅啀鍖呬竴灞傦紝鍛戒护鎸夊師鏍锋墽琛屻€?- **#23**锛氬瓙浠ｇ悊榛樿娣卞害浠?1 鎻愬埌 10銆?- **#42**锛氱粰璁剧疆鏈嶅姟琛ュ洖鏃х殑 `register` / `get`锛岃繕鍦ㄨ皟鏃ф帴鍙ｇ殑鎻掍欢鎵嶈兘鍔犺浇銆?- 鏂囦欢鍦ㄣ€佷絾杩欎唤鍘熸枃涓嶅湪褰撳墠鐗堟湰閲屾椂锛屾樉绀鸿烦杩囷紝涓嶅啀鎶婃暣娆″簲鐢ㄥ垽澶辫触銆傚師鏂囪繕鍦ㄦ椂浠嶄細鍐欎笂銆?
## English

- **Fixes required-patch failures #43, #9, #15, #23, and #42.** Apply no longer reports the cleanse as incomplete because of these five. The prompt was already written; the failure made the plugin look dead.
- **Cause**: a parent folder named DeepSeek Harness was treated as the official desktop install, so the Web npm packages were excluded and these five were never written. Install paths are not pinned to a drive letter. A tree counts as the desktop install only when the desktop executable is beside it, or the path is under that install's `resources/app`. Web, community desktop, and official desktop each patch their own packages.
- **#43**: strips the identity sentence from the four built-in Web presets (standard, ptc, cordis, minimal). Left in place, that sentence stays next to the inject.
- **#9**: approval requests are auto-granted.
- **#15**: sandbox `confine` no longer wraps the command.
- **#23**: subagent default depth moves from 1 to 10.
- **#42**: the settings service gets the old `register` / `get` methods back, so plugins that still call them can load.
- When the file exists but this version does not contain that original text, the row shows skipped and Apply still completes. Text that is present is still written.

# 1.1.20

## 涓枃

- **瀹夸富鐗堟湰**锛氬綋鍓嶅鍑?**dsh 0.1.7-rc.2**銆備笂涓€妗?**0.1.7-rc.1**锛堝惈 `0.1.7-rc.1.20260924.1`锛夌殑鏃ч敋鐐逛粛鍙敤銆?- **瀹樻柟妗岄潰鍗囩骇**锛氬凡缁忎笅杞界殑鏂扮増鏈細鍦ㄩ噸鍚紝鎴栧湪搴旂敤閲岀偣瀹夎骞堕噸鍚椂鐪熸瀹夎锛岀劧鍚庤В寮€鏂扮増鏈苟閲嶆柊鎵撹ˉ涓併€傛病鏈夋柊鐗堟湰鏃讹紝閲嶅惎浠嶆槸鍏虫帀鍐嶆墦寮€褰撳墠瀹㈡埛绔€傚畨瑁呯洰褰曚笉鍐欐鐩樼銆?- **琛ヤ竵**锛?14銆?35 璺熶笂 rc.2 鐨勫崌绾у啓娉曪紝涓嶅啀鎶ュ繀闇€琛ヤ竵澶辫触銆?29銆?33銆?36 鐨勬柊鎻愮ず鍙ヤ篃浼氭墦涓娿€?- Web 鍜岀ぞ鍖虹増 DSH Desktop 鐨勫簲鐢ㄣ€侀噸鍚繚鎸佸師鏍枫€?
## English

- **Host version**: current target is **dsh 0.1.7-rc.2**. Anchors for the previous target, **0.1.7-rc.1** (including `0.1.7-rc.1.20260924.1`), still match.
- **Official desktop upgrade**: a downloaded update installs on Restart, or on the in-app install-and-restart action, then the new build is unpacked and patched. With no pending update, Restart still closes and reopens the current client. Install paths are not pinned to a drive letter.
- **Patches**: #14 and #35 match the rc.2 escalation text, so Apply no longer fails those required patches. #29, #33, and #36 follow the new prompt wording.
- Web and community DSH Desktop keep their existing Apply and restart.

# 1.1.19

## 涓枃

- **瀹樻柟妗岄潰 EXE**锛氭敮鎸佸畼鏂?DeepSeek Harness銆傜偣銆屽簲鐢ㄣ€嶈В寮€ `app.asar` 骞惰ˉ涓婂師鐢熸ā鍧楋紝鍐嶇偣銆岄噸鍚€嶏紝瀹㈡埛绔嚜宸卞叧鎺夊苟閲嶆柊鎵撳紑銆俉eb 鍜岀ぞ鍖虹増 DSH Desktop 鐨勫簲鐢ㄣ€侀噸鍚繚鎸佸師鏍枫€?- **閲嶅惎**锛氬畼鏂瑰鎴风閫€鍑轰笉鍐嶈澶栧３褰撴垚宕╂簝锛屼篃涓嶄細鐣欎笅鍚庡彴 PowerShell銆傞噸鍚剼鏈笉鍐嶈皟鐢?Windows 鑴氭湰瀹夸富娌℃湁鐨?`toISOString`锛岄伩鍏嶅脊鍑鸿繍琛屾椂閿欒銆傛柊杩涚▼涓嶅啀缁ф壙 `ELECTRON_RUN_AS_NODE`锛屽惁鍒欎細鍒氭墦寮€灏遍€€鍑恒€?- **鏇存柊**锛氭崲鐗堟湰鎴栧洖閫€鏃讹紝鎸夎惤鍦扮殑閭ｄ竴鐗堣嚜鍔ㄨ繕鍘熷啀搴旂敤锛屼笉蹇呮瘡娆℃墜鍔ㄥ厛杩樺師鍐嶅簲鐢ㄥ啀閲嶅惎銆?- **琛ヤ竵鍒楄〃**锛氬涓诲凡缁忚嚜甯?`dsh-web-fetch-http` 鏃讹紝涓嶅啀鏄剧ず涓€鏉℃案杩滆烦杩囩殑 #20銆傚畨瑁呯洰褰曚笉鍐嶅啓姝荤洏绗︺€?
## English

- **Official desktop EXE**: Apply on official DeepSeek Harness unpacks `app.asar`, restores native modules, then Restart closes the client and opens it again. Web and community DSH Desktop keep their existing Apply and restart.
- **Restart**: exiting the official host is no longer treated as a crash, and no PowerShell process is left behind. The helper no longer calls `toISOString`, which made Windows Script Host pop a runtime error. The new process does not inherit `ELECTRON_RUN_AS_NODE`, which made it exit immediately.
- **Updates**: switching or rolling back a version restores and reapplies that version's patches without a manual revert first.
- **Patch list**: hosts that already depend on `dsh-web-fetch-http` no longer show a permanently skipped #20. Install paths are not pinned to a drive letter.

# 1.1.18

## 涓枃

- **閲嶅惎**锛氱偣銆岄噸鍚€嶅悗鏃ч〉闈㈢殑 token 浼氬け鏁堬紝鍙埛鏂扮瓑浜庢墦涓嶅紑銆傜幇鍦ㄤ細绛夌鍙ｉ噴鏀撅紙蹇呰鏃剁粨鏉熸棫杩涚▼锛夛紝骞舵寜鏂拌繘绋嬫墦鍗扮殑鍦板潃鎵撳紑娴忚鍣ㄣ€傝鐢ㄦ柊鎵撳紑鐨勯〉闈紝鍐嶆柊寮€涓€杞璇濄€?- **璁剧疆**锛?.1.17 涔嬪墠鑻ュ凡鎶?`legacyApplyPath` 鍙犺繘 `dsh-settings`锛岀偣銆屽簲鐢ㄣ€嶄細鏀舵垚涓€浠斤紝鎻愪緵鍟嗙洰褰曟墠鑳借捣鏉ャ€傛敹濂戒箣鍚庡啀閲嶅惎涓€娆°€?
## English

- **Restart**: the old page token dies with the process, so a refresh looks like restart did nothing. Restart now frees the port and opens the browser at the new `dsh web:` URL. Use that page and start a new chat.
- **Settings**: Apply collapses duplicate `legacyApplyPath` left by earlier 1.1.17 patches so `dsh-settings` can load. Restart once after that apply.

# 1.1.17

## 涓枃

- **绋冲畾鎬?*锛氫慨澶嶈缃ˉ涓?#42 鍦?dsh 0.1.7 涓婇噸澶嶆彃鍏?`legacyApplyPath` 鐨勯棶棰樸€傛鍓嶄細瀵艰嚧 `@deepseek-ai/dsh-settings` 鏃犳硶鍔犺浇銆佹彁渚涘晢鐩綍鎶ラ敊銆乵nemon 绛夋彃浠惰繛閿?pending銆傜幇鏀逛负 `skipIfMarked`锛屼笖涓嶅啀涓庡畼鏂瑰凡鑷甫鐨?`legacyApplyPath` 鍙犲啓銆?- **宸ヤ綔鍖哄己鎸囦护**锛?1/#2 鍚屾椂璇嗗埆 `WORKSPACE_*` 涓?`AGENT_*` 甯搁噺鍚嶏紝閬垮厤銆屽叏灞€/鏇挎崲寮忓厤璐ｃ€嶅湪鏃у涓讳笂鏄剧ず璺宠繃銆佸簲鐢ㄦ棤鏁堛€?- **鎷掔瓟涓庤蒋鎷?*锛氬畼鏂?`agent-instructions` 寮烘寚浠よˉ鍏呮湰鏈烘巿鏉冭瘎娴嬩笌鍙嶈蒋鎷掕瘽鏈紱鎻掍欢澧炲姞鍥哄畾 `mantis:rules` 娈碉紙涓庢墽琛岃鍒欎竴鑷达級銆?*鏂板紑浼氳瘽骞堕噸鍚?dsh 鍚?*鐢熸晥銆?
## English

- **Stability**: patch #42 no longer stacks duplicate `legacyApplyPath` on dsh 0.1.7, which broke `@deepseek-ai/dsh-settings`, provider catalog loading, and downstream plugins. Uses `skipIfMarked` and does not re-insert the helper the official package already ships.
- **Workspace intros**: patches #1/#2 match both `WORKSPACE_*` and `AGENT_*` constant names so rows no longer show Skipped on older installs.
- **Refusal / soft refusal**: stronger official workspace intros plus a fixed `mantis:rules` section. **Restart dsh and start a new chat** for prompt changes.

# 1.1.16

## 涓枃

- 瀵瑰噯 **dsh 0.1.7-rc.1**銆傚伐浣滃尯璇存槑甯搁噺鏀瑰悕涓?`AGENT_INSTRUCTIONS_INTRO`锛屽彞瀛愭病鍙橈紝琛ヤ竵璺熺潃鏀广€?- 娌欑 `confine()` 宸叉槸 `async confine(argv, policy, signal)`锛岃ˉ涓佹寜鏂板嚱鏁板啓銆傜洿閫氳涓轰笌涓婁竴鐗堢浉鍚屻€?- 瀛愪唬鐞嗘繁搴︽敼鍒?`dsh-subagent`锛岄粯璁や粠 1 鎻愬埌 10銆傛繁搴︽鏌ヨ繕鍦ㄣ€?- 璁剧疆鏈嶅姟琛ュ洖鏃х殑 `register` / `get`銆俙dsh-mnemon`銆乣dsh-better-reasoning-effort` 杩欑被杩樺湪璋冩棫鎺ュ彛鐨勬彃浠跺彲浠ョ户缁敤銆傚畼鏂?`describe` / `update` 涓嶅姩銆傝ˉ涓佸彧鎵撲竴娆★紝涓嶄細鍦ㄥ惎鍔ㄦ椂閲嶅鎻掑叆銆?- 鍒犳帀 0.1.7 閲屽凡缁忓涓嶄笂鐨勬棫鏉℃枃锛屽寘鎷崟鐙粰 `dsh-base` 琛?`dsh-web-fetch-http` 渚濊禆鐨勯偅鏉°€傚畼鏂瑰寘宸茬粡鑷甫銆?- Web 鍥涗釜鍐呯疆棰勮锛坰tandard銆乸tc銆乧ordis銆乵inimal锛夊彧娓呯┖韬唤鍙ャ€傚伐浣滅洰褰曘€佸伐鍏峰垪琛ㄣ€乣ptc` 妯″紡锛屼互鍙?minimal 鐨?`complete: true` 鍜?`includeRuntimeContext: false` 涓嶅姩銆?- `complete: true` 鏃讹紝`prompt-inject.md` 浠嶆帴鍦ㄨ繖娈靛墠闈€傛崲瀹夸富鐗堟湰鎴栨棫閽╁瓙鍒犳涔嬪悗锛屾敞鍏ヤ笉浼氫涪銆傜偣銆屽簲鐢ㄣ€嶄箣鍚庝粛瑕佸啀鐐广€岄噸鍚€嶏紝鏂板紑涓€杞璇濇墠杩涘綋鍓嶄細璇濄€?- `dsh-compaction-instant` 缃戦〉绔粠宸插垹闄ょ殑 `settingsScope` 鏀瑰埌 `configForms`锛岄〉闈笉鍐嶅仠鍦?Failed to load plugins銆?- 鍥為€€鍦?0.1.7 涓婁細寤哄嚭鏂颁細璇濓紝浣嗙晫闈粛鍋滃湪鏃у璇濓紝鐪嬭捣鏉ュ儚娌″弽搴斻€?.1.7 宸叉病鏈?`sessions.open`銆傜幇鍦ㄦ敼鐢?`uiWorkspace.openSession` 鍒囧埌鏂颁細璇濓紝骞舵妸涓婁竴鍙ュ～鍥炶緭鍏ユ銆傚け璐ュ師鍥犳樉绀哄湪鎸夐挳涓娿€?- README 鐨勮禐璧忓尯鎹㈡垚闈炵泩鍒╁０鏄庯細涓ョ鍟嗕笟鍞崠銆佷粯璐瑰€掑崠鎴栭粦鐏颁骇鐗熷埄锛屼粎渚涙妧鏈弬鑰冦€?
## English

- Aligned with **dsh 0.1.7-rc.1**. The workspace-instruction constant is now `AGENT_INSTRUCTIONS_INTRO`. The sentence is unchanged, and the patch follows it.
- Sandbox `confine()` is now `async confine(argv, policy, signal)`, and the patch matches that function. Passthrough behavior is the same as the previous release.
- Subagent depth lives on `dsh-subagent`. The default moves from 1 to 10. The depth check remains.
- The settings service again exposes the old `register` / `get` methods, so plugins such as `dsh-mnemon` and `dsh-better-reasoning-effort` keep working. Official `describe` / `update` stay. The patch applies once and does not insert itself again on startup.
- Patch text that no longer exists in 0.1.7 is removed, including the extra `dsh-web-fetch-http` dependency on `dsh-base`. The official package already depends on it.
- The four built-in Web presets (standard, ptc, cordis, minimal) lose only the identity sentence. The working-directory suffix, tool lists, `ptc` mode, and minimal's `complete: true` plus `includeRuntimeContext: false` stay.
- When `complete: true`, `prompt-inject.md` is still prepended to that section. A host upgrade or an older hook that drops the section does not drop the inject. After Apply you still click Restart and start a new chat before it enters the session.
- The `dsh-compaction-instant` web client uses `configForms` instead of the removed `settingsScope`, so the page no longer stops on Failed to load plugins.
- Rewind on 0.1.7 created the new session and left the UI on the old chat, so the click looked dead. 0.1.7 has no `sessions.open`. The button now opens the new session with `uiWorkspace.openSession` and puts the previous user line back in the composer. A failure shows on the button.
- The README sponsor block is now a non-profit notice: no commercial resale and no gray-market profit; technical reference only.
