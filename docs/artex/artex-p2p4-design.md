# ARTEX P2–P4 设计与接口契约

> 虫珀·拒斧（dsh-mantis）对 ARTEX 后续吸收的设计文档。
> **读者分工**：P2 = 本队后续实施票；P3 = 施工图，交「代理·隧」；P4 = 逐项独立票。
> **依据**：`ARTEX-absorption-plan.md`（吸收方案）+ P1 已落地的数据层（`lib/redteam/exploration.js`、`lib/redteam/schema.js` 五表、`RedteamStore.exploration(id)`，commit 81093ae）。
> **硬边界不变**：ARTEX 是 AGPL-3.0，本文档只写拒斧自有的接口与实现，不搬运其代码与文案；文中出现的 `redteam_*` / `traffic_*` 工具名均为拒斧侧命名。

---

## 0. 全局约定

所有阶段共用，不再重复声明。

| 约定 | 内容 |
|---|---|
| 数据根 `root` | `ctx.redteam.root` = `$DSH_HOME/redteam`（`settings.json`、`intercept.json`、`mitm/` 都在这层） |
| 靶标目录 | `RedteamStore.dirOf(id)` = `<root>/engagements/<id>/`，库文件 `assets.db`，元数据 `engagement.yaml`（`metaPathOf`，store-core.js:986） |
| 句柄 | 一切读写走 `this.db(id)` 的 `DatabaseSync` 句柄（store-core.js:996），按靶标隔离；新表/新列一律进 `schema.js` 的 DDL 或 `migrate(db)`（schema.js:513） |
| 工具注册 | `ctx.tools.register(withStructuredErrors(withIntercept(defineTool({...}))))`；`defineTool` 的 `parameters` 里凡 `type:'object'` 必须显式写 `additionalProperties:false`，否则整份红队预设加载失败（tools.js:104-131） |
| 结构化错误 | 失败一律返回 `{ok:false, error, error_kind:'bad_input'|'failed'|'approval_required'|'archived', hint}`（`withStructuredErrors`，tools.js:386） |
| 靶标解析 | 工具 `execute` 第一行 `const id = resolveEngagement(store, exec, args.engagement)`（tools.js:230）；面板/CLI 走 `dispatch(store, req)`（store-core.js:768），写 op 未绑靶标时返回「请先在顶部选择或创建一个靶标」 |
| 会话标识 | `bindingKeyOf(exec)` → `{rootId, sessionId, chain}`（tools.js:215-218）；`owner = rootId ?? sessionId`（tools.js:783-784 已有同款用法） |
| 引擎开关 | `settings.json` 键 `redteam_engine: 'commander' | 'frontier'`，**默认 `commander`**（Phase 2 要求：frontier 与现有指挥官模式并存） |
| 常驻进程 | **三阶段全部不引入常驻引擎/轮询循环**。P2 靠事件回声（wake）；P3 的 MITM 代理是按需起停的录制进程（人在录制期间才活着）；P4 全部工具触发 |
| 测试模式 | `node:test` + `DatabaseSync(':memory:')` + `exec(DDL)`，照 `test/exploration-graph.test.mjs` |

---

## 1. P2 —— 探索引擎与工具层

### 1.1 被动驱动模型（无常驻进程）

ARTEX 的引擎是 Go 常驻循环（debounce 唤醒 planner）。拒斧改成**回声驱动**：引擎逻辑不独立存在，它寄生在「工具返回值」里——每次写图都会在返回值里附一段 `wake`，告诉指挥（commander）**现在该做什么**；指挥照做，下一次调用又产生新的回声。闭环不需要任何定时器。

**三个触发源**（仅此三个，无第四个）：

1. **工具调用写图**：`redteam_explore_*` 写类工具成功后，返回值带 `wake` 字段 → 指挥看到 `wake.planner === true` 就跑一轮 planner（1.2）。
2. **子会话收尾**：`ctx.on('subagent/end')`（tools.js:434 已挂，现用于释放并发预留）追加一步——把该子会话遗留的 `running` intent 重开（1.3.4），防止孤儿节点把 frontier 卡死。
3. **面板/CLI 手动**：`dispatch` 的只读 op（1.6.2）供探索图面板随时刷新；`redteam_explore_plan {action:'begin'}` 也可由人让指挥显式开一轮。

`wake` 协议（所有写类工具的返回值附加段）：

```ts
type Wake = {
  planner: true,            // 需要跑一轮 planner
  reason: 'frontier_changed' | 'intent_state_changed' | 'fact_recorded'
        | 'finding_recorded' | 'graph_changed' | 'scheduled_due',
  frontier_open: number,    // 还有几个 open intent
  running: number,          // 正在执行的 intent
  findings: number,         // 已确认 finding 数
  scheduled_due?: number,   // P4：到期未执行的调度条数（>0 时 reason='scheduled_due'）
}
```

**附带规则**：读类工具不带 `wake`；`commander` 引擎下 `wake` 照常返回（无害），但 persona 不指导循环（1.6.4）；`frontier` 引擎下 persona 要求「凡工具返回 `wake.planner=true`，下一轮先跑 `redteam_explore_plan`，不许先干别的」。

### 1.2 planner 契约

planner 不是独立进程，是**指挥会话里的一个固定轮次协议**。一轮 planner 的完整动作序列：

```
① redteam_explore_plan {action:'begin'}
     服务端：round_no + 1，返回 briefing（overview + frontier + 约束 + todolist + decision）
② 按 decision 行动：
   decision='dispatch' → 写新 intent（redteam_explore_intent_add，去重），
                          逐条交给子会话（redteam_explore_intent_brief 取任务书 → subagent 派发）
   decision='wait'     → 不派活（有 running），等子会话回报
   decision='prove'    → 复核 findings 后 redteam_explore_prove {verdict:'achieved'}
   decision='replan'   → frontier 空、findings 为 0：必须派生新 intent 或收官（不许空转）
③ 子会话回报 → 返回值里带 wake → 回到 ①
```

`decision` 由服务端确定性计算（不是模型拍脑袋），`redteam_explore_plan` 内部：

```ts
decisionOf(stats, cap):   // stats = wakeStats(db, eid)，cap = maxAgentsOf(root)
  if (stats.frontier_open > 0)                    → 'dispatch'
  if (stats.running > 0 && stats.running < cap)   → 'dispatch'   // frontier 空但有容量 → 指挥派生新 intent
  if (stats.running > 0)                          → 'wait'
  if (stats.findings > 0)                         → 'prove'
  else                                            → 'replan'
// 附加：stats.stale_running = [intent ids]（running 且 updated_at 超 30 分钟）→ briefing 里
// 列出，指挥按 worker 契约处置（redteam_explore_intent_update {state:'open'} 重开或询问用户）
```

**共享 todolist**：按探索持久化，存成一个 `kind:'digest'` 节点（`origin:'todolist'`，payload JSON = 数组），**不加表**。指挥与子会话通过 `redteam_explore_todolist` 读写同一份，作为「进度互见」的唯一渠道；planner 每轮 briefing 里带回它。

**收官守卫**：`redteam_explore_prove` 服务端校验——存在 `open`/`running` intent 时拒绝 `verdict:'achieved'`（返回被卡的节点清单），除非 `force:true` + `reason`；`failed`/`stopped` 直接放行但要 `reason`。

### 1.3 worker 契约

**领取（CAS，防双开）**：worker 子会话自己调 `redteam_explore_intent_claim`，不代领：

- `UPDATE exploration_node SET state='running', owner=? WHERE id=? AND kind='intent' AND state='open'`，`changes===0` 即已被领/不存在 → 返回 `ok:false`，子会话换领下一条。
- `owner = bindingKeyOf(exec).rootId ?? sessionId`；`payload.owner_session = bindingKeyOf(exec).sessionId`（精确到子会话本身，供 1.3.4 修复用）。
- 指挥不预 claim，只把 `intent_id` 写进子会话任务书——**领取动作发生在真正的执行者身上**，这是与 ARTEX「planner 代领」的有意差异（免去 child id 先有先有的鸡生蛋问题）。

**执行期写回义务**（任务书里逐条写死，违者视为回合失败）：

1. 每个关键事实调 `redteam_explore_node_add {kind:'fact', parent_id:intent_id, payload:{provenance:'observed'|'inferred', …}}`——`parent_id` 自动加 `spawns` 边（exploration.js:62-64）。
2. 产出可验证结论时记 `kind:'finding'`，并 `anchor_asset_ids` 落锚到资产图。
3. 离开前**必须**调 `redteam_explore_intent_update` 收尾，终态三选一：
   - `done`——任务书达成；
   - `blocked`——带 `blocked_reason`（等条件/等人），节点留在原地可复查；
   - `exhausted`——此路已探尽（同样带 reason），防止 planner 反复派同一条死路。
4. 未收尾的（崩溃/被打断）由 `subagent/end` 兜底重开（下节）。

**任务书**：`redteam_explore_intent_brief {id}` 返回一段可直接粘贴的文本（目标、约束 allow/deny 清单、intent 正文、锚定资产、todolist、收尾义务），指挥把它拼进 `subagent` 的 prompt（`redteamRole: <code>` 仍放第一行，现有约定不变）。

#### 1.3.4 孤儿修复（subagent/end 扩展）

现有 handler（tools.js:434）释放并发预留之后追加：

```
借 bindings Map（tools.js:140）里 子会话→engagement 的既有映射定位靶标；
store.exploration(id).requeueOrphans(info.id)
  → 该子会话拥有的 state='running' 的 intent 全部回 'open'，
    blocked_reason='worker-exit-unexpected'（保留原 owner 到 payload.prev_owner）
无映射则跳过（不猜靶标）。
```

修复本身不唤醒任何人——指挥正等着 `subagent()` 的返回值，下一轮 `plan` 自然会看到它回到 frontier。

### 1.4 工具签名（P2 全量）

实现文件：`lib/redteam/tools-exploration.js`（见 1.6.1）。所有工具省略号处按 0 节约定；`engagement?` 一律走 `resolveEngagement` 解析；`exploration_id?` 缺省取该靶标**唯一 `status='open'` 的探索**（没有则报 `bad_input` 提示先 `redteam_explore_open`）。

```ts
/* ---- 生命周期与总览 ---- */

redteam_explore_open({
  engagement?: string,
  goal: string,                 // 一句话目标
  note?: string,
})
→ { ok:true, exploration_id, status:'open', round_no:0 }

redteam_explore_plan({          // 一轮 planner（1.2）
  engagement?: string,
  exploration_id?: number,
  action: 'begin' | 'brief',    // begin=round_no+1；brief=只读快照
})
→ { ok:true, round_no, engine:'commander'|'frontier',
    briefing:{
      overview,                 // graphOverview 全量（byKind/byState/findings/open_intents/coverage_pct…）
      frontier,                 // listFrontier 全量（open intent 按 priority DESC）
      running_intents,          // state='running' 的 intent（含 owner、updated_at、stale 标记）
      constraints,              // allow/deny 全量
      todolist,                 // 数组
      decision:'dispatch'|'wait'|'prove'|'replan',
      stale_running: number[],  // 超 30 分钟未动的 running intent
    },
    wake?: Wake }               // brief 不带；begin 带

redteam_explore_status({       // 只读：当前探索 + overview + wake 统计（面板/快速巡检）
  engagement?: string, exploration_id?: number })
→ { ok:true, exploration, overview, wake_stats }

/* ---- goal ---- */

redteam_explore_goal_add({
  engagement?: string, exploration_id?: number,
  title: string, body?: string,        // body = 成功判据
})
→ { ok:true, node_id, wake }

redteam_explore_goal_list({ engagement?: string })
→ { ok:true, items:[{id,title,body,state,created_at}] }

redteam_explore_prove({                 // 收官（1.2 守卫）
  engagement?: string, exploration_id?: number,
  verdict: 'achieved'|'failed'|'stopped',
  reason: string,                       // 必填，写进 goal 节点 payload 与 exploration.status
  force?: boolean,                      // 仅 achieved 且还有 open/running intent 时需要
})
→ { ok:true, status, round_no } | { ok:false, error_kind:'bad_input', blocked_intents:[…], hint }

/* ---- intent（frontier 核心） ---- */

redteam_explore_intent_add({
  engagement?: string, exploration_id?: number,
  parent_id: number,             // 从哪个节点派生（goal/fact/finding/hint）
  title: string,
  body?: string,                 // 任务书正文：做什么、怎么算完成
  priority?: number,             // 默认 0；frontier 按 priority DESC, id ASC
  anchor_asset_ids?: number[],
  dedupe?: boolean,              // 默认 true
})
→ { ok:true, id, deduped:boolean, wake }
// dedupe 规则：title 归一化（trim/小写/去标点）后与同图 kind='intent' 且
// state∈{open,running,done,exhausted} 撞车 → 不新建，返回已有 id 且 deduped:true

redteam_explore_intent_claim({ engagement?: string, id: number })
→ { ok:true, id, owner }                      // CAS open→running（1.3）
→ { ok:false, error_kind:'failed', hint:'已被领取或状态不对' }

redteam_explore_intent_update({
  engagement?: string, id: number,
  state: 'done'|'blocked'|'exhausted'|'stopped'|'open',   // 'open' = 人工重开
  blocked_reason?: string,      // state=blocked 必填
  note?: string,
})
→ { ok:true, id, state, wake }

redteam_explore_intent_list({
  engagement?: string, exploration_id?: number,
  state?: 'open'|'running'|'done'|'blocked'|'exhausted'|'stopped',
})
→ { ok:true, items:[…] }

redteam_explore_intent_brief({ engagement?: string, id: number })
→ { ok:true, brief:string }      // 可直接粘贴进子会话 prompt 的任务书（1.3）

/* ---- 事实 / 发现 / 边 / 锚 ---- */

redteam_explore_node_add({                  // 覆盖 ARTEX 的 fact_record，兼写 finding/hint
  engagement?: string, exploration_id?: number,
  kind: 'fact'|'finding'|'hint',
  parent_id?: number,           // 挂到哪个 intent/goal（自动 spawns 边）
  title?: string, body?: string,
  payload?: {                   // 自由 JSON，约定字段：
    provenance?: 'observed'|'inferred',   // 证据口径，对应 evidence-ledger 的 confidence 族
    evidence?: string,                    // 关联 attack_step/http_evidence/traffic id 或原文摘录
    severity?: 'info'|'low'|'medium'|'high'|'critical',
  },
  anchor_asset_ids?: number[],
  origin?: string,              // 记录来源（工具名/角色）
})
→ { ok:true, node_id, wake }

redteam_explore_node_list({
  engagement?: string, exploration_id?: number,
  kind?: 'goal'|'intent'|'fact'|'finding'|'hint'|'digest',
  state?: string, q?: string, limit?: number,   // 默认 100
})
→ { ok:true, items:[…] }

redteam_explore_edge_add({
  engagement?: string, exploration_id?: number,
  src_id: number, dst_id: number,
  rel: 'spawns'|'derived_from'|'yields'|'proves'|'covers',
})
→ { ok:true, created:boolean }   // UNIQUE 去重，重复给 false 不报错

redteam_explore_anchor({ engagement?: string, node_id:number, asset_id:number })
→ { ok:true, created:boolean, wake }

/* ---- todolist ---- */

redteam_explore_todolist({
  engagement?: string, exploration_id?: number,
  action: 'get'|'append'|'replace'|'clear',
  items?: string[],             // append/replace 用
})
→ { ok:true, items:string[], wake? }   // append/replace 带 wake

/* ---- traces（数据源：attack_step ∪ 探索图，无 activity 表） ---- */

redteam_explore_trace_search({
  engagement?: string,
  q?: string,                   // 匹配 title/detail/tool/result 或 fact/finding 正文
  agent?: string, since?: string, limit?: number,   // 默认 50
})
→ { ok:true, items:[{ ref:'step:<id>'|'node:<id>', at, agent?, tool?, kind, title, snippet }] }
   // 攻击步骤侧字段来自 attack_step（seq,stage,tool,agent,result,recorded_at）；
   // 探索侧取 kind∈{fact,finding} 的节点（owner,origin,created_at）。按时间倒序合并。

redteam_explore_trace_list({ engagement?: string, since?: string, limit?: number })
→ { ok:true, items:[…] }        // 同上，不带关键词

redteam_explore_trace_get({ engagement?: string, ref: string })   // 'step:<id>' | 'node:<id>'
→ { ok:true, trace, linked:{ nodes, edges, attack_step?, http_evidence? } }
   // node:ref 额外带父子链与出边（derived_from/yields/proves），把「这条怎么来的」一次拿全

/* ---- 覆盖率 ---- */

redteam_explore_coverage({ engagement?: string, exploration_id?: number })
→ { ok:true,
    overview,                   // graphOverview：anchored_assets/total_assets/coverage_pct…
    unanchored_assets:[{id,ip,port?,name,test_status}],   // 未落锚资产，最多 50 条
    open_intents, blocked_intents, findings_by_severity:{…} }

/* ---- 约束 ---- */

redteam_explore_constraint_add({
  engagement?: string,
  kind:'allow'|'deny', text:string, origin?:string })
→ { ok:true, id }

redteam_explore_constraint_list({ engagement?: string })
→ { ok:true, items:[{id,kind,text,origin,created_at}] }

/* ---- 引擎开关 ---- */

redteam_engine({ set?: 'commander'|'frontier' })
→ { ok:true, engine, source:'settings'|'default' }   // 不传 set = 只读
```

**wake 附带矩阵**（哪些工具返回 `wake`）：

| 返回 wake | 不返回 |
|---|---|
| `intent_add/claim/update`、`node_add`、`anchor`、`goal_add`、`todolist(append/replace)`、`plan(action:'begin')` | 全部 `*_list`、`*_get`、`*_search`、`coverage`、`status`、`brief`、`engine`、`constraint_*`、`edge_add`（边只是补关系，不改 frontier） |

### 1.5 数据层新增（`lib/redteam/exploration.js`，纯函数、接 DatabaseSync 句柄）

现有导出保持不动，追加：

```ts
/** 当前唯一 open 探索；没有返回 null。 */
export function getActiveExploration(db)

/** frontier 统计：{frontier_open, running, findings}（wake/decision 共用）。 */
export function wakeStats(db, explorationId)

/** intent 领取 CAS：state='open' 才成功。返回 {claimed, owner}。 */
export function claimIntent(db, intentId, owner, ownerSession)

/** round_no 自增，返回新值。 */
export function bumpRound(db, explorationId)

/** 通用节点查询（1.4 node_list 用）。 */
export function listNodes(db, explorationId, { kind, state, q, limit } = {})

/** todolist：digest 节点（origin='todolist'）读写，替换式保存。返回完整数组。 */
export function getTodolist(db, explorationId)
export function setTodolist(db, explorationId, items)

/** 孤儿修复（1.3.4）：owner_session=sessionId 且 running 的 intent 回 open。返回改动数。 */
export function requeueOrphans(db, ownerSessionId, reason)

/** 超时巡检：running 且 updated_at 早于 now-staleMs（默认 30min）的 intent id。 */
export function staleRunning(db, explorationId, staleMs)

/** traces 合并查询（1.4 trace_*）：attack_step ∪ kind∈{fact,finding} 节点。 */
export function searchTraces(db, { q, agent, since, limit })
export function getTrace(db, ref)   // 'step:<id>' | 'node:<id>'，含 linked 结构
```

约束：与现有函数同风格——无 Cordis 依赖、不抛业务文案以外的错、payload 自动 JSON 化；枚举校验复用 `assertEnum`。

### 1.6 接线点

#### 1.6.1 `lib/redteam/tools.js`

1. **导出共享 helper**（现为模块私有，P2/P3/P4 文件要用）：`defineTool`、`resolveEngagement`、`withStructuredErrors`、`AGENT_PARAM`、`text()`、`bindingKeyOf`、`sessionOwnerOf(exec)`（新增小函数 = `bindingKeyOf(exec).rootId ?? sessionId`，收敛 :784 的内联写法）。
2. **apply() 末尾接三句注册**：
   ```js
   registerExplorationTools(ctx, store)   // tools-exploration.js（P2）
   registerTrafficTools(ctx, store)       // tools-traffic.js（P3）
   registerOpsTools(ctx, store)           // tools-ops.js（P4）
   ```
3. **`withIntercept` 包装器**（P3 审批门，2.4）：新增导出 `withIntercept(tool)`，组合顺序 `withStructuredErrors(withIntercept(defineTool(…)))`；未命中规则/放行时直接透传内层 execute，命中未批时**直接返回** `{ok:false, error_kind:'approval_required', approval_id, hint}`（不抛异常）。
4. **subagent/end 扩展**（1.3.4）：:434 的 handler 里释放预留后追加 `requeueOrphans`，engagement 从 bindings Map（:140）取，无映射跳过。
5. 分节注释沿用 `/* ==== … ====` 风格；新文件自带同款头部注释。

#### 1.6.2 `lib/redteam/store-core.js`

1. **`exploration(id, options)`（:1018-1033）追加绑定方法**（形状与现有一致，全部薄封装）：
   ```js
   active: () => getActiveExploration(db),
   claim: (nid, owner, ownerSession) => claimIntent(db, nid, owner, ownerSession),
   bumpRound: (eid) => bumpRound(db, eid),
   nodes: (eid, opts) => listNodes(db, eid, opts),
   todolist: (eid) => getTodolist(db, eid),
   setTodolist: (eid, items) => setTodolist(db, eid, items),
   wakeStats: (eid) => wakeStats(db, eid),
   staleRunning: (eid, ms) => staleRunning(db, eid, ms),
   requeueOrphans: (session, reason) => requeueOrphans(db, session, reason),
   traces: (opts) => searchTraces(db, opts),
   trace: (ref) => getTrace(db, ref),
   ```
2. **`dispatch(store, req)`（:768）追加只读 op**（探索图面板用，全部照 :772 起的既有形状）：
   ```js
   if (op === 'exploreStatus')   // {exploration, overview, wake_stats, engine}
   if (op === 'exploreNodes')    // 支持 kind/state/q 分页
   if (op === 'exploreFrontier') // open+running intent
   if (op === 'exploreCoverage')
   if (op === 'exploreTodolist')
   if (op === 'exploreTraces')
   ```
   写操作**不进 dispatch**（面板的图编辑走工具/后续单独 op，本轮面板只读）。
3. `listEngagements` 输出补 `engine`（settings 读取，面板全局显示）。

#### 1.6.3 `lib/redteam/settings.js`

追加（沿用 `readSettings/writeSettings` 合并写，绝不抛）：

```ts
export function engineOf(root, env)          // settings.redteam_engine，非法值回落 'commander'
export function saveEngine(root, value)      // 只收 'commander'|'frontier'
```

#### 1.6.4 `presets/redteam/agent.cordis.yml`（persona prefix）

新增一节「探索图引擎（frontier 模式）」，静态文案、按开关生效（工具返回里带 `engine`，persona 写「`engine==='frontier'` 时遵守本节，commander 模式忽略 wake」）：

1. 凡工具返回 `wake.planner=true` → 下一轮第一动作必须是 `redteam_explore_plan {action:'begin'}`；
2. 按 `decision` 行动（1.2 序列），`dispatch` 时用 `intent_brief` 拼子会话任务书；
3. 子会话任务书必须含写回义务四条（1.3）；
4. `prove` 前自行核对 findings 与 goal 判据，`replan` 不许连续两轮空转（第二轮仍 replan → 停下问人）；
5. 现有指挥红线（只计划不动手、并发≤3、claimed→observed 核对）**原样高于本节**。

执行角色稿（六角色 prompt）不改职责，只在 1.4 的 `intent_brief` 输出里追加写回义务——义务随任务书走，不散进每份角色稿。

#### 1.6.5 测试

`test/exploration-engine.test.mjs`（照 `test/exploration-graph.test.mjs` 模式，纯数据层 + `:memory:`）：

1. `claimIntent` CAS：二次领取失败；`requeueOrphans` 后可再领；
2. `wakeStats/decisionOf` 四分支（dispatch/wait/prove/replan）+ `staleRunning` 阈值；
3. todolist 替换/追加幂等（重复 origin='todolist' 只有一份）；
4. `searchTraces` 合并排序与 `getTrace('node:…')` linked 结构；
5. dedupe：同名 intent 第二次 `deduped:true` 不新建；
6. prove 守卫：有 open intent 时 achieved 被拒、`force:true` 放行。

---

## 2. P3 —— 流量记录与审批门（施工图 · 交「代理·隧」）

G 已拍板：**方案 (a) 内建 MITM 代理 + 自签 CA**。本章即接口契约；实现文件独立成组，不与 P2 抢改动面。

### 2.1 总览与进程模型

```
浏览器/测试工具 ──HTTP──▶ mitm-proxy.mjs（子进程，按需起）
                    │        │  HTTPS：CONNECT → 自签叶证书解密 → 上游重加密
                    │        ▼
                    │   <root>/mitm/spool/<sessionKey>/flows.jsonl + blobs/<sha256>
                    ▼（录制期间只写文件，不开数据库）
宿主插件（tools.js 进程）─ traffic_ingest（幂等）→ <dirOf(id)>/assets.db 的 traffic_flow
                                                 + blob 搬进 <dirOf(id)>/traffic/blobs/
```

- **没有常驻**：代理是 `spawn` 出来的**录制会话进程**，`traffic_proxy_stop` / 插件卸载 / 宿主退出即停；起停审计记 `traffic_session` 表。
- **为什么走 spool 而不是子进程直写 SQLite**：`DatabaseSync` 持有在宿主进程，跨进程写同一 `assets.db` 会撞锁（SQLITE_BUSY）；JSONL 落盘 + 宿主侧幂等入库把两个写者彻底错开，也让「代理崩了不丢已录流量」成立。
- **模块布局**：

```
lib/redteam/mitm/
  ca.js         — ensureCa/ensureLeaf/exportCa/guideText（2.3）
  proxy.mjs     — 子进程入口：HTTP 转发 + CONNECT 拦截 + TLS MITM + spool 写入
  spool.js      — JSONL 追加、blob 落盘、flow_key 计算（宿主与子进程共用）
  ingest.js     — spool → assets.db（幂等、blob 搬家）
  intercept.js  — 规则匹配 + 审批队列（2.4）
lib/redteam/tools-traffic.js — 下述 traffic_* / approval_* 工具注册
```

零外部依赖：TLS/HTTP 用 `node:http`、`node:https`、`node:net`、`node:tls`、`node:crypto`。

### 2.2 MITM 录制代理

#### 2.2.1 端口分配与状态

- settings 键：`mitm = { port: 18081, portMax: 18099, recordBodyMax: 2097152, filter: null }`（默认端口避开常见开发口 8080/8081）。
- 起动顺序：从 `port` 起逐个 bind，`EADDRINUSE` → +1，到 `portMax` 仍占用 → `failed`（带 `hint`）；**实际端口写回运行时状态**。
- 运行时状态文件：`<root>/mitm/state.json` = `{ port, pid, sessionKey, spoolDir, started_at, filter }`（原子写，复用 `atomic-write.js`）；宿主与面板用它判断「在不在录」。
- 起动同时插一行 `traffic_session(status:'running')`，stop/崩溃收敛为 `stopped|crashed` 并补 `stopped_at`。

#### 2.2.2 拦截行为

- **HTTP**：常规转发，完整记录请求行/头/body 与响应。
- **HTTPS**：应答 `CONNECT` → 与客户端完成 TLS 握手（叶证书由 `ca.js` 按 SNI 现签）→ 上游重建 TLS → 双向泵流并解析记录。
- **过滤**：`filter`（子串/通配，启动参数 `filterHost` 覆盖）命中的 host 才解密录制；未命中的 CONNECT **直接管道透传**（不解密、不录制、不签证书）——避免无关流量被 CA 波及，也控制录制体量。
- 限制：body 只记前 `recordBodyMax` 字节（超出记 `truncated:true` + 真实总长）；`recordBodyMax:0` = 只记头。响应 `Content-Type` 属 `image/*|video/*|font/*` 时默认只记元数据（可启动参数关掉）。

#### 2.2.3 新表（DDL 进 `schema.js` 主 DDL；索引进尾部索引区）

```sql
/* 一次录制会话（代理起停审计） */
CREATE TABLE IF NOT EXISTS traffic_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  port INTEGER, pid TEXT, status TEXT DEFAULT 'running',   -- running|stopped|crashed
  filter TEXT, ca_sha256 TEXT,
  spool_dir TEXT, started_at TEXT, stopped_at TEXT,
  flows INTEGER DEFAULT 0, note TEXT
);

/* MITM 录制到的 HTTP/HTTPS 事务（body 走磁盘，不进 SQLite） */
CREATE TABLE IF NOT EXISTS traffic_flow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_key TEXT UNIQUE,             -- sha256(sessionKey + idx + method + url + started_at)：入库幂等键
  session_id INTEGER,
  method TEXT, url TEXT, host TEXT, scheme TEXT, path TEXT,
  status INTEGER,
  req_headers TEXT,                 -- JSON：原始头
  req_body_file TEXT,               -- 相对 dirOf(id)，如 traffic/blobs/ab/ab34…（超限/无 body 为 NULL）
  req_body_bytes INTEGER, req_body_sha256 TEXT, req_body_truncated INTEGER DEFAULT 0,
  resp_headers TEXT,
  resp_body_file TEXT, resp_body_bytes INTEGER, resp_body_sha256 TEXT, resp_body_truncated INTEGER DEFAULT 0,
  resp_content_type TEXT,
  started_at TEXT, duration_ms INTEGER,
  asset_id INTEGER,                 -- 可选绑定（口径同 http_evidence）
  vuln_id INTEGER,                  -- 可选：绑到漏洞
  finding_id INTEGER,               -- 可选：绑到探索图 finding 节点（exploration_node.id）
  step_id INTEGER,                  -- 可选：绑到 attack_step
  source TEXT DEFAULT 'mitm',       -- mitm|import
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_traffic_host ON traffic_flow(host);
CREATE INDEX IF NOT EXISTS ix_traffic_url  ON traffic_flow(url);
CREATE INDEX IF NOT EXISTS ix_traffic_vuln ON traffic_flow(vuln_id);
CREATE INDEX IF NOT EXISTS ix_traffic_finding ON traffic_flow(finding_id);
CREATE INDEX IF NOT EXISTS ix_traffic_sess ON traffic_flow(session_id);
```

- **与 `http_evidence` 的边界**：`http_evidence` 保持原样（手工粘贴的单条复现证据，request/response 内联文本）；`traffic_flow` 是批量录制流水，body 走文件。两者都可挂 `vuln_id`，报告侧并读，**不合并、不迁移**。
- **blob 落盘**：spool 里先写 `<spool>/blobs/<sha256>`；入库时 `rename`（跨盘退化 `copyFile`）到 `<dirOf(id)>/traffic/blobs/<sha256[0:2]>/<sha256>`，DB 只存相对路径。
- **入库（`ingest.js`）**：逐行读 `flows.jsonl` → `INSERT OR IGNORE`（靠 `flow_key`）→ 已入库行的 blob 移走 → 更新 `traffic_session.flows` → 消费掉的 spool 行归档为 `flows.jsonl.done`。**幂等**：跑多少遍结果一致；`traffic_search` 每次调用前自动先 ingest（未消费行 ≤ 500 时），`traffic_ingest` 工具用于显式批量。

#### 2.2.4 工具签名（`tools-traffic.js`）

```ts
redteam_traffic_proxy_start({
  engagement?: string,
  port?: number,               // 覆盖 settings.mitm.port
  filterHost?: string,         // 只解密该子串命中的 host；缺省用 settings.mitm.filter
  recordBodyMax?: number,
})
→ { ok:true, session_id, port, pid, spool_dir, ca_path, filter, started_at }
→ { ok:false, error_kind:'failed', hint }            // 端口耗尽/openssl 缺失等
// 注：本工具在 2.4 默认 intercept 规则内（开监听器属高危），先批后起

redteam_traffic_proxy_stop({ engagement?: string })
→ { ok:true, session_id, flows, stopped_at }

redteam_traffic_proxy_status({ engagement?: string })
→ { ok:true,
    running:boolean, port?, pid?, started_at?, spool_pending:number,
    ca:{ path, sha256, exists }, sessions:[{id,port,status,flows,started_at,stopped_at}] }

redteam_traffic_ingest({ engagement?: string, limit?: number })   // 显式批量入库
→ { ok:true, ingested, dup_skipped, blobs_moved, remaining }

redteam_traffic_search({
  engagement?: string,
  q?: string,                  // 匹配 url/host/path/头
  host?: string, url?: string, method?: string, status?: number,
  vuln_id?: number, finding_id?: number,
  since?: string, until?: string,
  limit?: number,              // 默认 50
})
→ { ok:true, total, items:[{
      id, method, url, host, status, started_at, duration_ms,
      req_body_bytes, resp_body_bytes, resp_content_type,
      vuln_id?, finding_id?, step_id?, asset_id? }] }
// 调用前自动 ingest（见上）

redteam_traffic_get({ engagement?: string, id: number })
→ { ok:true, flow:{ /* traffic_flow 全列，头为解析后 JSON */ },
    req_preview:string, resp_preview:string,   // 各前 4096 字符，截断标记
    bound:{ vuln?, finding?, step?, asset? } }

redteam_traffic_blob({
  engagement?: string, id: number,
  which: 'req'|'resp',
  maxInline?: number,          // 默认 65536：小于它且文本类 → inline 给原文
})
→ { ok:true, path, bytes, sha256, mime, truncated, inline?:string }
→ { ok:false, error_kind:'bad_input', hint:'该方向没有 body' }

redteam_traffic_bind({                    // 与 finding/vuln/步骤绑定（录制后人工/智能体补挂）
  engagement?: string, id: number,
  finding_id?: number, vuln_id?: number, step_id?: number, asset_id?: number,
})
→ { ok:true, flow }                       // 至少给一个绑定目标，全空报 bad_input
```

### 2.3 自签 CA 管理

**存放路径**（全部在 `root` 下，不碰系统目录）：

```
<root>/mitm/ca/ca.key        私钥（文件权限 0600；绝不经工具返回原文）
<root>/mitm/ca/ca.crt        自签 CA 证书
<root>/mitm/ca/ca.srl        序列号
<root>/mitm/ca/leafs/<host>.{crt,key}   叶证书缓存（可选，按需现签也行）
```

**生成策略 `ensureCa(dir)`**（`ca.js`）：

1. 已存在且未过期 → 直接返回；
2. `openssl` 可用（`spawnSync('openssl', ['version'])` 成功）→
   `openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 3650 -subj "/CN=ChongPo MITM CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"`；
3. 无 openssl → `node:crypto.generateKeyPairSync('rsa', {modulusLength:2048})` + 自写 ASN.1/DER 签名模块（`ca.js` 内实现，零依赖）签发同参数 CA；
4. 叶证书：按 SNI host 现签（SAN=DNS:host），RSA-2048，缓存于内存 + `leafs/`。

**接口契约**：

```ts
// ca.js（模块 API）
ensureCa(dir):      { path, sha256, not_after, generated:boolean }
ensureLeaf(dir, host): { crt, key }            // SAN=DNS:<host>
exportCa(dir, to):  { path }                   // 拷贝 ca.crt 到导出位置
guideText(platform): { platform, steps:string[], ca_path }
   // platform ∈ 'windows'|'macos'|'linux'|'auto'（auto 按 process.platform）

// 工具
redteam_traffic_ca({
  engagement?: string,
  action: 'status'|'ensure'|'export'|'guide',
  to?: string,                 // export：导出目标路径（必须在 root 或用户目录内，拦 ..）
  platform?: 'windows'|'macos'|'linux',
})
→ status/ensure: { ok:true, ca:{path, sha256, not_after, generated} }
→ export:        { ok:true, path }
→ guide:         { ok:true, platform, ca_path, steps:[string] }
```

**信任边界（写死，不得偏离）**：插件**只生成证书并提供安装说明，绝不自动改系统信任库**——把 CA 装进系统信任库是系统级改动，必须由用户手动执行或明确授权。`guide` 只返回文本，不 spawn 任何安装命令：

- Windows（当前用户）：`certutil -addstore -user Root "<ca_path>"`；管理员域存储另有说明行。
- macOS：`security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db "<ca_path>"`。
- Linux（Debian 系）：`sudo cp "<ca_path>" /usr/local/share/ca-certificates/chongpo-mitm.crt && sudo update-ca-certificates`。
- 每条附「卸载/移除」的逆操作行；guide 文案里明确标注「由你手动执行」。

### 2.4 审批门（intercept 规则 + 待批队列 + 放行/拒绝 + 审批记录）

**规则文件（全局、人工/面板编辑）**：`<root>/intercept.json`（与 `settings.json` 同层）：

```jsonc
{
  "mode": "on",                 // off | on
  "agentDecide": false,         // 默认 false：智能体不可自批，只能面板放行
  "defaultTtlSeconds": 3600,    // 面板放行未指定时的有效期；0 = 仅一次性
  "rules": [
    { "id": "r-webshell", "tool": "redteam_webshell_add", "effect": "require_approval", "note": "写 WebShell" },
    { "id": "r-tunnel",   "tool": "redteam_tunnel_add",   "effect": "require_approval", "note": "开隧道" },
    { "id": "r-access",   "tool": "redteam_access_add",   "effect": "require_approval", "note": "落访问会话" },
    { "id": "r-proxy",    "tool": "redteam_traffic_proxy_start", "effect": "require_approval", "note": "开监听端口" },
    { "id": "r-args",     "tool": "redteam_bash*", "argsIncludes": "rm -rf", "effect": "deny", "note": "直接拒" }
  ]
}
```

- `tool` 支持 glob（`*`）；`argsIncludes` 为可选子串条件（对 canonical JSON 后的参数串匹配）；`effect: 'require_approval'` 进队列，`'deny'` 直接拒绝并记录。
- **出厂默认规则** = 上表前四条（`mode:'off'` 出厂，面板一键打开；打开后默认规则生效）。

**审批记录表（DDL 进 `schema.js`，按靶标隔离——审批发生在某次靶标的工具调用里）**：

```sql
CREATE TABLE IF NOT EXISTS approval (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_key TEXT UNIQUE,      -- sha256(tool + '\n' + canonicalJson(args))：同一调用复用同一行
  tool TEXT, args TEXT,          -- args 存 canonical JSON 原文（供人看要批什么）
  rule_id TEXT, effect TEXT,     -- 命中的规则
  state TEXT DEFAULT 'pending',  -- pending|allowed|denied|expired|consumed|blocked
  requested_by TEXT,             -- bindingKeyOf(exec) 的 owner 口径：谁发起的调用
  requested_at TEXT,
  decided_by TEXT, decided_at TEXT, decision_reason TEXT,   -- 谁批的、何时、理由
  scope TEXT DEFAULT 'once',     -- once|ttl
  expires_at TEXT, consumed_at TEXT,
  session_id TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS ix_approval_state ON approval(state);
```

**拦截流程（`withIntercept`，tools.js 组合链）**：

```
工具调用进入
 ├─ intercept.mode='off' 或未命中任何规则 → 透传执行（零开销分支在前）
 ├─ 命中 effect='deny' → 记 state='blocked' 行 → 返回 {ok:false, error_kind:'approval_required'|'failed', hint:规则 note}
 └─ 命中 require_approval：
      1) 查 approval_key 已有行：
         state='allowed' 且未过期 → 置 'consumed'（scope=once）→ 透传执行
         state='denied'   → 返回 {ok:false, error_kind:'approval_required', hint:'已被拒绝：<reason>'}
      2) 无有效行 → upsert 'pending'（同 key 复用，不重复建）→ 直接返回：
         { ok:false, error_kind:'approval_required',
           approval_id, tool, rule_id,
           hint:'等待人工批准：面板「待审批」放行后原样重试本工具' }
      3) 不执行内层工具、不排队挂起——调用立即失败返回，由指挥去问人，批完**原样重试**（args 必须逐字相同，否则新 key 重新进队）
```

**决策入口（两条，谁批的记录随之不同）**：

1. **面板（主入口，人工）**：`dispatch` 新增 op
   ```js
   if (op === 'approvalList')     // req { state?:'pending'|… } → 薄行列表（靶标、工具、args、命中规则、发起人、时间）
   if (op === 'approvalDecide')   // req { approval_id, decision:'allow'|'deny', reason, ttlSeconds? }
   // decided_by 固定 'panel'；decision_reason 必填（空 → {ok:false}）；写 decided_at=ISO
   // allow 且 ttlSeconds>0 → scope='ttl', expires_at=now+ttl；不给 → scope='once'
   ```
   面板解除归档同理（3.4），**人工动作只走 dispatch，不给智能体工具**。
2. **会话（可选，自批）**：仅当 `intercept.agentDecide=true` 时注册
   ```ts
   redteam_approval_decide({ engagement?: string, approval_id:number,
     decision:'allow'|'deny', reason:string, ttlSeconds?:number })
   → { ok:true, state, decided_by: <bindingKeyOf owner>, decided_at }
   ```
   `agentDecide=false`（默认）时该工具不存在于工具表（不是调用报错，是根本没注册）。

**辅助查询**：

```ts
redteam_approval_status({ engagement?: string, approval_id?: number })
→ { ok:true, items:[{id, tool, state, requested_by, requested_at, decided_by, decided_at,
                     decision_reason, expires_at}] }   // 不给 id 列本靶标 pending
```

**与既有两套授权的关系（边界）**：

| 机制 | 粒度 | 谁决定 | 关系 |
|---|---|---|---|
| host approval 栈（宿主提示） | 沙箱级文件/命令操作 | 人对宿主 | 不动它；P3 不重复实现沙箱审批 |
| `drill-grant`（`$DSH_HOME/mantis/drill-grant.json`） | 演练台**授权开关**（整场演练放没放行） | 人经面板 | 保持独立；grant 未放行时 drill 能力照旧不可用，intercept 管的是**逐工具逐次**，两者同时满足才走得通 |
| P3 intercept | 单次工具调用 | 人经面板（默认） | 本文档新增 |

### 2.5 P3 接线点汇总（代理·隧 施工清单）

| 文件 | 改动 |
|---|---|
| `lib/redteam/schema.js` | 主 DDL 追加 `traffic_session`/`traffic_flow`/`approval` 三表 + 索引（2.2.3/2.4）；`migrate` 只在需要补列时挂（DDL 走 `CREATE TABLE IF NOT EXISTS` 无需 migrate） |
| `lib/redteam/settings.js` | 追加 `mitmConfigOf(root)`（默认 18081/18099/2MB）、`interceptOf(root)`（默认 mode off + 出厂四规则）与对应 save 函数 |
| `lib/redteam/mitm/*` | 新目录四模块（2.1.3），零依赖 |
| `lib/redteam/tools.js` | 导出 `withIntercept` 并接入注册链（1.6.1-③）；`apply()` 加 `registerTrafficTools(ctx, store)`；无其他改动 |
| `lib/redteam/tools-traffic.js` | 新文件：`traffic_proxy_*`、`traffic_ingest/search/get/blob/bind`、`traffic_ca`、`approval_status`、（条件注册）`approval_decide`，共 11 个 |
| `lib/redteam/store-core.js` | `dispatch` 追加 `approvalList`/`approvalDecide`（面板）、`trafficList`/`trafficSessions`（面板浏览）；`exploration()` 不动（P3 不依赖探索图，`finding_id` 是普通外键列） |
| `lib/redteam/ui.js` | 面板「流量」「待审批」两页的 op 转发（CSOP 校验复用 :1114-1128 的现有 handler） |
| `lib/index.js` | 插件 dispose/卸载路径：停掉运行中的代理（清 `state.json`、收敛 `traffic_session.status`） |
| `test/traffic-mitm.test.mjs` | 新测试（5.2） |

---

## 3. P4 —— 报告 / 复测 / 通知 / 归档 / 任务模板 / 调度：边界

P4 六项**全部工具触发、无一常驻**；每项先给「不做什么」，再给新对象与触发。

### 3.1 报告（reporter）

**做什么**：新预设子角色 `reporter` + `redteam_report_build`，从既有数据只读聚合出报告。

**边界**：

- **不动** `redteam_score_report`（tools.js:1820，分数链报告，仍是唯一「得分怎么来的」报告）；`redteam_report`/`redteam_report_targets` 已弃用，**不复活**。
- 报告生成**不改业务数据**：只写 `<dirOf(id)>/reports/<kind>-<ts>.md` + 一行 `report_run`；证据引用只读 `evidence-ledger` 的版本号，不回写证据。
- reporter 角色只读 store + 调 `redteam_report_build`，不写图、不派活。

**新对象**：

```sql
CREATE TABLE IF NOT EXISTS report_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,                 -- score|finding|coverage|final
  path TEXT, sections TEXT,  -- md 路径 / 章节清单 JSON
  manifest TEXT,             -- 数据快照摘要（用了哪些表、时间窗）
  created_by TEXT, created_at TEXT
);
```

```ts
redteam_report_build({ engagement?: string,
  kind:'score'|'finding'|'coverage'|'final', finding_id?: number })
→ { ok:true, path, sections:string[] }
// 接线：tools-ops.js 新文件；预设 presets/redteam/reporter.cordis.yml；
// dispatch 追加 reportList 只读 op
```

### 3.2 复测（retester）

**做什么**：新子角色 `retester` + 三态复测闭环。

**边界**：retester **不新建 vuln、不改 score_point/score_hit、不碰探索图**；`conclude` 只写 `retest` 行与 `vuln.status`；复测不产生新分数（`reproduced` 只是确认现状）。

**新对象**：

```sql
CREATE TABLE IF NOT EXISTS retest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vuln_id INTEGER, target TEXT,
  status TEXT DEFAULT 'pending',           -- pending|running|done
  conclusion TEXT,                          -- reproduced|fixed|inconclusive（done 后有值）
  reason TEXT, requested_by TEXT, requested_at TEXT,
  started_at TEXT, finished_at TEXT,
  evidence_ref TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS ix_retest_status ON retest(status);
```

```ts
redteam_retest_request({ engagement?: string, vuln_ids?: number[], all?: boolean, reason:string })
→ { ok:true, retest_ids:number[] }
redteam_retest_list({ engagement?: string, status?: string, vuln_id?: number })
→ { ok:true, items:[…] }
redteam_retest_conclude({ engagement?: string, id:number,
  conclusion:'reproduced'|'fixed'|'inconclusive', evidence_ref?:string, note?:string })
→ { ok:true, retest, vuln_status }   // fixed→vuln.status='fixed'；reproduced→回 'open'
// 触发：仅工具调用（指挥/面板），无定时器；dispatch 追加 retestList
```

### 3.3 通知（notify）

**做什么**：出站 webhook 单向通知，配置进 settings，工具显式触发。

**边界**：

- **URL 只读 `settings.notify.urls`（人工/面板配置），智能体不能临时指定任意 URL**——通知通道不是数据外带口，也顺手封掉 SSRF 面。
- **无常驻派发器、无重试队列**：`redteam_notify_send` 当场 POST，失败即失败（返回错误让调用方决定）。「该通知没通知」写进 reporter/收官的清单文案，不靠后台兜底。
- 出站前红act：`Authorization`/`Cookie`/密码类字段按现有 redaction 口径脱敏；正文长度截断 4KB。

**新对象**：

```ts
// settings.js
settings.notify = { enabled:false, urls:[], events:['score_hit','retest_done','explore_prove',
                                                  'approval_pending','report_built'] }

redteam_notify_send({ engagement?: string,
  event:'score_hit'|'retest_done'|'explore_prove'|'approval_pending'|'report_built',
  text:string, extra?:object })       // event 必须在 settings.notify.events 里
→ { ok:true, delivered:[{url, status}] } | { ok:false, error_kind:'failed', hint:'通知未配置或发送失败' }

redteam_notify_test({}) → { ok:true, delivered:[…] }
// 配置入口：面板 op notifyConfigGet/Save（ui.js 平台配置分支 :293 旁边）
```

### 3.4 归档（archive）

**做什么**：靶标归档 = 状态位 + 写保护，面板分组展示。

**边界**：

- 归档**不删文件、不搬目录、不压缩**；`runs/` 清理是另一个显式人工按钮（本轮不做）。
- 写保护由 `dispatch` 统一执法：归档后所有写类 op 返回 `{ok:false, error_kind:'archived', hint:'在面板解除归档'}`；工具侧 `withIntercept` 之后加同款前置检查（共用 `archivedGuard(id)`，一处实现两处调用）。
- **解除归档只有面板 op**（`archiveSet {archived:false}`），不给智能体工具——归档是人的收尾动作。
- 读 op、报告生成、复测结论一律不受影响（归档后还能出报告）。

**实现**：`engagement.yaml`（`metaPathOf`）追加 `archived: true`、`archived_at`、`archive_note`；`listEngagements` 返回 `archived` 标记供面板分组。

```js
// dispatch 新增
if (op === 'archiveSet')   // { archived:boolean, note? } —— 仅面板（CSRF 校验通道内）
```

### 3.5 任务模板（templates）

**做什么**：把「起一场」固化成声明式模板，一条工具调用带出 goal + 约束 + 计分提示。

**边界**：

- 模板是**纯数据**：不含可执行代码、不注入提示词（goal/constraints 文本进的是数据字段，走与手工创建完全相同的路径）。
- `apply` **不建资产、不建探索图**（资产导入属 ScopeSentry 另项；探索图由 `redteam_explore_open` 按需开）；`force:false`（默认）时不覆盖已有 goal/约束。
- 同名模板：用户目录（`<root>/templates/`）优先于随包（`presets/redteam/templates/`）。

**新对象**：

```jsonc
// presets/redteam/templates/*.json 与 <root>/templates/*.json
{ "schema": 1, "name": "xxx-演练", "description": "…",
  "goal": { "title": "…", "body": "成功判据…" },
  "constraints": [ { "kind": "allow|deny", "text": "…" } ],
  "score_hints": [ { "stage": "…", "point": "…", "hint": "…" } ],
  "roles": ["recon","assess","vuln-scan","exploit","internal"] }

redteam_template_list({})  → { ok:true, items:[{name, source:'bundled'|'user', description}] }
redteam_template_apply({ template:string, engagement?:string, force?:boolean })
→ { ok:true, goal_id, constraints_added, score_hints_added }
redteam_template_save({ name:string, description?:string })   // 从当前靶标反存模板
→ { ok:true, path }
// 接线：tools-ops.js；dispatch 追加 templateList
```

### 3.6 调度（schedule）

**做什么**：一行式「到点提醒」表 + 被动到期提示；执行仍由人/指挥显式调工具。

**边界（本轮明确不做）**：不做 cron 常驻循环、不做跨重启自动执行、不做自动重试——**没有调度器，只有调度记录**。G 若要真·定时执行，另开票（宿主侧 timer 方案另议）。

**新对象**：

```sql
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT,                 -- retest|report|notify
  run_at TEXT, params TEXT,  -- params = 对应工具的参数 JSON
  status TEXT DEFAULT 'due', -- due|done|skipped|cancelled
  created_by TEXT, created_at TEXT, consumed_at TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS ix_schedule_status ON schedule(status);
```

```ts
redteam_schedule_add({ engagement?: string,
  kind:'retest'|'report'|'notify', run_at:string, params:object, note?:string })
→ { ok:true, id }
redteam_schedule_list({ engagement?: string, status?: string })
→ { ok:true, items:[…] }
// 被动提示：redteam_explore_plan / exploreStatus 的 wake 带 scheduled_due 计数
//          （到期未消费条数），面板调度页列 due 行；
// 执行 = 指挥/人调对应工具后，把该行置 done（执行工具内附带 consumeSchedule）
```

---

## 4. 新增对象总表

**工具（45 个，全部 `redteam_` 前缀）**

| 归属 | 文件 | 工具 |
|---|---|---|
| P2（23） | `tools-exploration.js` | `explore_open` `explore_plan` `explore_status` `explore_goal_add` `explore_goal_list` `explore_prove` `explore_intent_add` `explore_intent_claim` `explore_intent_update` `explore_intent_list` `explore_intent_brief` `explore_node_add` `explore_node_list` `explore_edge_add` `explore_anchor` `explore_todolist` `explore_trace_search` `explore_trace_list` `explore_trace_get` `explore_coverage` `explore_constraint_add` `explore_constraint_list` `engine` |
| P3（11） | `tools-traffic.js` | `traffic_proxy_start` `traffic_proxy_stop` `traffic_proxy_status` `traffic_ingest` `traffic_search` `traffic_get` `traffic_blob` `traffic_bind` `traffic_ca` `approval_status` `approval_decide`（条件注册） |
| P4（11） | `tools-ops.js` | `report_build` `retest_request` `retest_list` `retest_conclude` `notify_send` `notify_test` `template_list` `template_apply` `template_save` `schedule_add` `schedule_list` |

**新表（6 张，DDL 全进 `schema.js`）**：`traffic_session` `traffic_flow` `approval` `retest` `report_run` `schedule`。
（P2 **不加表**：todolist 复用 `digest` 节点；traces 复用 `attack_step` ∪ 探索节点。）

**新文件**：`lib/redteam/tools-exploration.js`、`tools-traffic.js`、`tools-ops.js`、`lib/redteam/mitm/{ca,proxy,spool,ingest,intercept}.js(.mjs)`、`presets/redteam/reporter.cordis.yml`、`presets/redteam/templates/*.json`、测试三份（5.x）。

**settings 键（`$DSH_HOME/redteam/settings.json`）**：`redteam_engine`、`mitm{port,portMax,recordBodyMax,filter}`、`notify{enabled,urls,events}`、（规则在独立的 `intercept.json`）。

**dispatch 新 op**：`exploreStatus/Nodes/Frontier/Coverage/Todolist/Traces`（P2 只读）、`approvalList/approvalDecide/trafficList/trafficSessions`（P3）、`reportList/retestList/templateList/archiveSet/notifyConfigGet/notifyConfigSave`（P4）。

---

## 5. 测试与验收

### 5.1 P2 — `test/exploration-engine.test.mjs`（1.6.5 已列六项）

跑法：`pnpm test`（node:test，`DatabaseSync(':memory:')` + DDL）。

### 5.2 P3 — `test/traffic-mitm.test.mjs`

1. `spool` 写两行 JSONL + 一个 blob → `ingest` 两次 → `traffic_flow` 恰好 2 行、blob 只有一份、spool 转 `.done`（幂等）；
2. 端口分配：占用 18081 时自动落到 18082，`state.json` 记实际端口；
3. `intercept`：`mode=on` + 规则命中 → 工具返回 `approval_required` 且插 pending 行 → 面板 `approvalDecide allow` → 原样重试透传执行、行转 `consumed`；`deny` 后重试被拒；`agentDecide=false` 时 `approval_decide` 不在工具表；
4. `ca.ensureCa` 两条路径（有/无 openssl）都能出未过期证书；`guide` 返回文本且**未 spawn 任何安装命令**（断言 spawn 记录只含 openssl/无）；
5. `traffic_search` 自动 ingest + `traffic_bind` 后 `finding_id` 可查。

### 5.3 P4 — `test/ops-p4.test.mjs`

1. `archiveSet` 后写类 dispatch op 返回 `error_kind:'archived'`、读 op 与 `report_build` 正常；
2. `retest_conclude` 三态与 `vuln.status` 联动（fixed→fixed，reproduced→open）；
3. `template_apply` 默认不覆盖已有 goal/约束、`force:true` 覆盖、用户模板遮蔽同名随包模板；
4. `schedule` 到期计数进 `wakeStats` 口径（`scheduled_due`）；执行后行转 `done`；
5. `notify_send` 未配置 urls → `ok:false` 且不发任何请求。

### 5.4 验收核对（本文档任务的验收五点）

| 验收点 | 落处 |
|---|---|
| ① planner/worker 契约（被动驱动、无常驻进程） | 1.1–1.3 |
| ② `redteam_explore_*` 工具签名与 schema | 1.4（23 个可执行签名）+ 1.5（数据层签名） |
| ③ 与 `tools.js` / `store-core.js` 接线点 | 1.6（含 settings/persona/subagent/end/测试） |
| ④ P4 六项边界 | 3.1–3.6（每项「做什么/不做什么/新对象/触发」） |
| ⑤ P3 方案（G 已拍板方案 a：内建 MITM + 自签 CA） | 2.1–2.5（录制代理 / CA / 审批门三块接口契约 + 落点表） |

**施工拆票建议**（给建图用）：P2-1 数据层函数 → P2-2 工具层+dispatch → P2-3 persona/开关/测试；P3-1 ca+spool → P3-2 proxy 进程 → P3-3 ingest+traffic 工具 → P3-4 审批门（intercept/approval/面板）；P4 按 3.1–3.6 各一票（彼此无依赖，可并行）；探索图前端面板单独一票（只依赖 P2-2 的 dispatch 只读 op）。
