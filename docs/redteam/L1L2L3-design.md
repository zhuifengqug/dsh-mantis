# 拒斧三缺口设计契约（L1 / L2 / L3）

> **读者分工**：后端实现者读 §1（L2 代理启停）、§2（L3 流量隔离）、§3.5（预设安装循环化）；前端实现者读 §1.4（按钮状态机）、§1.6（返回字段）、§2.6（面板不改造点）；验收者读 §4、§5。
> **依据**：本文件全部落点对齐当前仓库实现（`lib/redteam/*.js`、`presets/redteam/*`、`package.json`），行号为撰写时的实测行号。
> **硬边界**：本文件只写设计与落点，不改实现。**插件绝不自动写系统/浏览器信任库**——CA 只生成、只导出文件，信任安装一律由用户手动执行（`lib/redteam/ca.js:499 guideText()` 的每一步都写明「以上命令由你手动执行」）。
> **术语**：靶标 = engagement，`id` 为其目录名（`slugify(name)`），数据根 `root = $DSH_HOME/redteam`（`lib/redteam/store.js resolveRoot`），每靶标一个独立 SQLite 库 `engagements/<id>/assets.db`。

---

## 0. 全局约定

| 约定 | 内容 |
|---|---|
| 面板唯一入口 | `POST /redteam/api` → `lib/redteam/ui.js:1204` `await dispatchAsync(store, request)`；新 op 只要加进 `dispatch` / `dispatchAsync` 就自动可路由，**`ui.js` 不用改** |
| 同步 vs 异步 | `dispatch(store,req)` 在 `lib/redteam/store-core.js:819` 起，包在 `try/catch` 里，异常统一转 `{ok:false,error}`（`:1041-1044`）；`dispatchAsync(store,req)` 在 `:1051`，只特判需要真实网络/异步的 op，其余转发 `dispatch` |
| 靶标解析 | `:884-885` `let id = req.engagement.trim() || store.activeEngagementId()`；无 id 时写类 op 返回「请先在顶部选择或创建一个靶标」（`:901`） |
| op 命名 | 与既有面板 op 一致用 camelCase（`trafficList` / `mitmCaInfo`），新增 `proxyStart` / `proxyStop` / `proxyStatus` |
| 落点格式 | `文件:行号`，行号为实测值；实现时以函数名为准（行号会漂移） |
| 兼容基线 | 旧库必须能直接打开（不重建表）；旧 spool 必须能入库；旧预设目录必须不被破坏 |
| 安全红线 | 代理只监听 `127.0.0.1`（`lib/redteam/proxy.js:441` `bindHost = options.host || '127.0.0.1'`）；CA/证书全部落 `caDirOf(root)`；任何路径都不写系统信任库 |
| 「缺失的两个名字」 | 任务文字里的 `update_finding_report` 工具与 `finding_retests` 表**在仓库中不存在**。真实对应：报告 = `lib/redteam/ops.js:108 reportBuild()` + `lib/redteam/tools-ops.js` 的 `redteam_report_build`；复测 = `lib/redteam/schema.js:506` 的 `retest` 表 + `redteam_retest_request/list/conclude`。本文件按真实实现落点。 |

---

## 1. L2：面板「开始 / 停止录制」按钮

### 1.1 现状与缺口

| 已有能力 | 位置 | 说明 |
|---|---|---|
| `startMitmProxy(options)` | `lib/redteam/proxy.js:438` | 异步启动；`options={root,dir,db,agent,tool,port,portMax,recordBodyMax,filter,host,caDir,sessionKey,spoolDir,intercept}` |
| `proxy.status()` | `lib/redteam/proxy.js:509` | 返回 `{running,port,host,session_id,session_key,spool_dir,dir,filter,flows,ca_dir,ca_ready,errors,started_at,proxy}` |
| `proxy.stop()` | `lib/redteam/proxy.js:532` | flush → 关 socket → `finishTrafficSession(status:'stopped')` → `RUNNING.delete` → `writeState{running:false}` |
| `proxyStatus(root)` | `lib/redteam/proxy.js:593` | 读 `mitm/state.json`；`session_key` 在 `RUNNING` 则返回活句柄 `status()`，否则 `{running:false,...state}` |
| `stopMitmProxy(target)` | `lib/redteam/proxy.js:564` | 可传句柄，或 `{root}` 按 state 里 `session_key` 找活的 |
| `stopAllProxies()` / `listRunningProxies()` | `lib/redteam/proxy.js:578/588` | 收尾/列举 |
| 面板证书页 | `lib/redteam/client.js:4562 CaPane` | `mitmCaInfo` / `mitmCaExport`，已有「信任安装指引」 |
| 面板流量页 | `lib/redteam/client.js:4256 FlowPane` | 空态文案 `:4358`「没有流量。先拉起 MITM 录制（智能体工具 redteam_traffic_* / 代理启停）…」——**文案承诺了「代理启停」，但界面没有按钮** |

缺口：`proxy.js` 能力齐备，但 `store-core.js` 的 dispatch 表（`:949-994` 只有 `trafficSessions/trafficList/trafficGet/trafficBind/trafficBindings/mitmCaInfo/mitmCaExport`）**没有任何 `proxyStart/proxyStop/proxyStatus` op**，`store-core.js` 也**没有 import proxy 模块**（全库只有 `lib/redteam/index.js:16` 引入 `stopAllProxies`，用于 `:705 dispose` 收尾）。因此面板点不到、也调不到启停。

### 1.2 op 契约

| op | 同步/异步 | 落点 | 入参 | 出参 |
|---|---|---|---|---|
| `proxyStatus` | 同步 `dispatch` | `lib/redteam/store-core.js` 在 `:994 mitmCaExport` 之后新增分支 | `{engagement?}`（缺省走 `activeEngagementId`） | `{ok:true, running, port, mode, caPath, caReady, flows, host, filter, sessionKey, spoolDir, dir, proxyUrl, startedAt, errors}` |
| `proxyStart` | 异步 `dispatchAsync` | `lib/redteam/store-core.js:1051` 内新增分支 | `{engagement?, port?, portMax?, recordBodyMax?, filter?, host?, mode?}` | 同 `proxyStatus` 成功视图 |
| `proxyStop` | 异步 `dispatchAsync` | `lib/redteam/store-core.js:1051` 内新增分支 | `{engagement?}` | `{ok:true, running:false, port, flows, stopped_at}` |

失败统一 `{ok:false, error, code?}`，`code` 透传 Node 错误码（`EADDRINUSE` / `EACCES` / `ENOENT`），前端据此给文案。

统一视图函数（新增，`store-core.js` 顶部与 `caDirOf/caPathsOf` 同批 import）：

```js
// store-core.js —— 归一化 proxy 状态给面板
function proxyView(st, root) {
  const caDir = caDirOf(String(root))
  const paths = caPathsOf(caDir)
  return {
    running: st.running === true,
    port: st.port ?? null,
    mode: 'mitm',                       // 固定：本插件是 MITM 录制，不接管系统代理
    caPath: paths.crt,                  // 供面板「去安装信任」跳转
    caReady: st.ca_ready === true || existsSync(paths.crt),
    flows: Number(st.flows) || 0,
    host: st.host || '127.0.0.1',
    filter: st.filter || '',
    sessionKey: st.session_key || null,
    spoolDir: st.spool_dir || null,
    dir: st.dir || null,
    proxyUrl: st.proxy || null,
    startedAt: st.started_at || null,
    errors: st.errors || [],
  }
}
```

同步分支：

```js
// store-core.js dispatch —— 紧接 :994 mitmCaExport 之后
if (op === 'proxyStatus') {
  return Object.assign({ ok: true }, proxyView(proxyStatus(String(store.root)), store.root))
}
```

异步分支（注意 `db` 必须 `create:false`，靶标库不存在就报错，绝不因点「开始录制」而建库）：

```js
// store-core.js dispatchAsync —— 紧接 :1062 probeSessions 分支之后
if (req.op === 'proxyStart' || req.op === 'proxyStop') {
  try {
    const id = (typeof req.engagement === 'string' && req.engagement.trim())
      || (typeof store.activeEngagementId === 'function' ? store.activeEngagementId() : '')
    if (!id) return { ok: false, error: '请先在顶部选择或创建一个靶标', code: 'NO_ENGAGEMENT' }
    if (req.op === 'proxyStop') {
      // stopMitmProxy 只认活句柄或 {root}（见 proxy.js:564），按 root 从 state.json 找活的
      const res = await stopMitmProxy({ root: String(store.root) })
      return Object.assign({ ok: true }, proxyView(Object.assign({}, res, { running: false }), store.root))
    }
    const db = store.db(id, { create: false })           // 不建库
    const dir = store.dirOf(id)
    // 靶标名走 listEngagements()（默认不带 stats，廉价）；或用新增的 store.targetNameOf(id)
    const targetName = (store.listEngagements().find((e) => e.id === id) || {}).name || id
    const proxy = await startMitmProxy({
      root: String(store.root), dir, db,
      engagementId: id, targetName,                            // 供 L3 spool 归属，见 §2.4
      port: req.port, portMax: req.portMax,
      recordBodyMax: req.recordBodyMax, filter: req.filter, host: req.host,
    })
    return Object.assign({ ok: true }, proxyView(proxy.status(), store.root))
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error), code: error && error.code }
  }
}
```

`store-core.js` 顶部 import 追加：`import { startMitmProxy, stopMitmProxy, proxyStatus } from './proxy.js'`（现有 `caDirOf/caPathsOf/certDigest/exportCa/guideText` 已经从 `./ca.js` 引入，同批）。

### 1.3 `mode` 的语义（写死为 `'mitm'`）

本插件**不设置系统代理**、**不改 `HTTP_PROXY` 环境变量**、**不劫持浏览器**。它只是在 `127.0.0.1:<port>` 起一个 MITM 代理，等待「人把目标流量指过来」（浏览器/工具/移动端填代理地址，或被测程序自身走代理）。这一点是安全边界的一部分：插件不会静默接管整机流量。`mode` 字段存在的意义是给未来留扩展位（例如 `'mitm'` / `'passive'`），当前只有 `'mitm'` 一个合法值，前端不展示切换。

### 1.4 按钮状态机与失败提示（前端契约）

状态枚举 `idle | starting | running | stopping | error`，只在 `FlowPane`（`lib/redteam/client.js:4256`）顶部控制条使用，与 `CaPane`（`:4562`）联动。

| 当前态 | 触发 | 下一态 | 动作 |
|---|---|---|---|
| idle | 点「开始录制」 | starting | `api({op:'proxyStart', engagement:eng})` |
| starting | 返回 `ok:true, running:true` | running | 记 `port/caPath/caReady/flows`，清错误 |
| starting | 返回 `ok:false` | error | 按 `code` 给文案（下表），按钮回到「重试」 |
| running | 点「停止录制」 | stopping | `api({op:'proxyStop', engagement:eng})` |
| stopping | 返回 `ok:true, running:false` | idle | 清 flows 显示，触发一次 `trafficList` 刷新 |
| running | 轮询 `proxyStatus` 发现 `running:false`（外部/进程崩溃） | idle | 提示「录制已停止」 |
| error | 点「重试」 | starting | 重发 `proxyStart` |

轮询：`running` 时每 1.5s 调一次 `proxyStatus` 更新 `flows` 计数；`starting/stopping` 期间禁用按钮；切靶标（`useLoadSeq` `:699` 已有）丢弃旧响应。

失败文案（`code → 提示`）：

| 情况 | 判定 | 提示文案 |
|---|---|---|
| 端口被占 | `code==='EADDRINUSE'`（`listen()` 从 `port` 到 `portMax` 全部 `EADDRINUSE`，见 `lib/redteam/proxy.js:410`） | 「端口 {port}-{portMax} 全被占用。到『平台设置 → MITM』把起始端口改开，再重试。」 |
| 无权限绑端口 | `code==='EACCES'` | 「无权限绑定该端口，换一个 >1024 的端口。」 |
| CA 未生成 | `caReady:false`（`running:true` 但证书文件缺失，极少见） | 「代理已启动，但 CA 未就绪。去『证书』页导出并手动安装后重试。」 |
| 信任未装（HTTPS 解密失败） | 代理本身 `running:true`，但首次 HTTPS 流量在 `errors`/上游报证书告警 | 「HTTPS 解密需要先装 CA：去『证书』页按指引手动安装（插件不会改你的信任库）。」 |
| 已有其它靶标在录 | 见 §1.7 单活跃约束 | 「靶标 {other} 正在录制，请先停止它。」 |

**关键区分**：`caReady` 表示「CA 证书文件已生成」，不代表「系统已信任」。`startMitmProxy` 内部会 `ensureCa()` 自动生成自签 CA（`lib/redteam/ca.js:326`），所以启动通常不会因「CA 未装」失败；「未装信任」表现为 HTTPS 站点报证书错，属于运行期提示，不是启动失败。**插件在任何路径都不执行 `certutil -addstore` / `security add-trusted-cert` / `update-ca-certificates`**——这些只出现在 `lib/redteam/ca.js:499 guideText()` 的文本里，交给人手动跑。

### 1.5 落点表（L2）

| 文件 | 位置（函数） | 动作 |
|---|---|---|
| `lib/redteam/store-core.js` | 顶部 import 区 | 增 `import { startMitmProxy, stopMitmProxy, proxyStatus } from './proxy.js'` |
| `lib/redteam/store-core.js` | 新函数 `proxyView(st, root)` | 归一化返回字段（§1.2） |
| `lib/redteam/store-core.js` | `dispatch`，`:994` 之后 | 增同步 `proxyStatus` 分支 |
| `lib/redteam/store-core.js` | `dispatchAsync`，`:1062` 之后 | 增异步 `proxyStart` / `proxyStop` 分支 |
| `lib/redteam/proxy.js` | `startMitmProxy` `:438` | 已支持 `port/portMax/filter/host`；本期只加读 `options.engagementId/targetName` 存到 proxy 对象（§2.4 用） |
| `lib/redteam/proxy.js` | `status()` `:509` | 无需改（`ca_ready`/`flows`/`port` 已有） |
| `lib/redteam/client.js` | `FlowPane` `:4256`，控制条插入到筛选行上方；空态文案 `:4358` 可保留 | 加「开始/停止/重试」按钮 + 状态徽标 + `proxyStatus` 轮询 |
| `lib/redteam/client.js` | `CaPane` `:4562` | 从 `mitmCaInfo` 已有数据里读 `caPath`，与录制条联动展示「信任未装」提示 |
| `lib/redteam/ui.js` | — | 不改（`:1204 dispatchAsync` 出口自动覆盖） |
| `scripts/build-client.mjs` | — | 改完 `lib/redteam/client.js` 后执行 `pnpm build:client` 重新生成根 `client.js`（`__MANTIS_DRILL_BEGIN/END` 内嵌副本） |

### 1.6 兼容与风险（L2）

1. **state 文件单槽**：`statePath(root)=root/mitm/state.json`（`lib/redteam/proxy.js:121`）只存一份。多靶标同时录制会互相覆盖 → **本期约定「单活跃录制」**：`proxyStart` 前先 `proxyStatus(root)`，若 `running:true` 且属于别的靶标，返回 `{ok:false, code:'ALREADY_RECORDING', error:'靶标 X 正在录制…'}`。state 升级为 v2 map（`{sessions:{key:state}}`）列为后续项，不在本期。
2. **`recordBodyMax`**：默认 `2097152`（`lib/redteam/platform-config.js:73`）。面板可只读展示，修改走「平台设置」，不在录制条里改。
3. **上游 TLS 校验放宽**：`lib/redteam/proxy.js` 头部声明上游 `rejectUnauthorized:false`。前端在「开始录制」旁给一行小字「仅用于授权测试环境；上游证书校验已放宽」，不阻断。
4. **启动不自动**：应用启动不会自动开代理（保持现状）。`proxyStart` 是唯一启动入口。
5. **`db(create:false)`**：靶标未建库时报「靶标不存在」，不会顺手建库造成空靶标。
6. **dispose 已兜底**：`lib/redteam/index.js:705` 在插件卸载时 `stopAllProxies()`，无需重复。

---

## 2. L3：`traffic_flow` 按靶标隔离

### 2.1 缺口复述

| 现状 | 位置 | 问题 |
|---|---|---|
| `traffic_flow` DDL 无靶标列 | `lib/redteam/schema.js:419-445` | 单库内无法区分来源靶标 |
| `store.traffic(id)` 的 `spoolRoot` 是全局 `<root>/mitm/spool` | `lib/redteam/store-core.js:1230` | 写入端不按靶标分目录 |
| `ingest()` 遍历**所有** spool 子目录灌进**当前** id 的库 | `lib/redteam/store-core.js:1238-1251` | A 靶标录的流量会落进 B 靶标库 |
| 代理写 spool 用 `sessionKey` 做目录名 | `lib/redteam/proxy.js:142 record()` → `writeFlowToSpool(spoolDir,flow)` | spool 行里没有靶标字段 |

后果：多靶标并行时，检索/面板把别的靶标流量当本靶标数据展示，报告串数据。这是「多会话串写」在流量层的同构问题（工具层已在 `lib/redteam/tools.js:142 resolveEngagement` 处理，流量层还没处理）。

### 2.2 列契约

`traffic_flow` 新增两列（`lib/redteam/schema.js:419-445` DDL 内，新库直接建；旧库走 §2.3 迁移）：

```sql
engagement_id TEXT NOT NULL DEFAULT '',   -- 机读：靶标 id（目录名）
target        TEXT NOT NULL DEFAULT ''    -- 人读：engagement.yaml 的 target_name
```

新索引（新旧库都要有，放 `migrate()` 里 `CREATE INDEX IF NOT EXISTS`）：

```sql
CREATE INDEX IF NOT EXISTS ix_traffic_engagement ON traffic_flow(engagement_id, id)
```

**为什么两列而不是一列**：`engagement_id` 是唯一主键（slug，供过滤/校验/join 目录）；`target` 是给人看的靶标名（报告、跨库导出、审计日志要人读名，不想每次回读 `engagement.yaml`）。`target` 冗余但廉价，且在「跨靶标显式查询」（§2.6）里用来回答「这条流量属于哪个靶标」而无需再开目录。

### 2.3 迁移（复用既有 `migrate` 模式，兼容旧库）

`lib/redteam/schema.js:628 export function migrate(db)` 已有成熟模式：`has(table,col)` 用 `PRAGMA table_info(...)`（`:629-638`）、`ensure(table,col,ddl)` 用 `ALTER TABLE ADD COLUMN` 并吞并发错误（`:639-643`）。L3 迁移直接追加：

```js
// lib/redteam/schema.js migrate()，紧接 :643 ensure/ensure 定义之后、既有 ensure('vuln',...) 之前
ensure('traffic_flow', 'engagement_id', "TEXT NOT NULL DEFAULT ''")
ensure('traffic_flow', 'target', "TEXT NOT NULL DEFAULT ''")
try { db.exec('CREATE INDEX IF NOT EXISTS ix_traffic_engagement ON traffic_flow(engagement_id, id)') } catch { /* 旧库并发迁移忽略 */ }
```

**旧行回填**：`ALTER TABLE ... NOT NULL DEFAULT ''` 会把历史行填成 `''`。回填放在 `RedteamStore.db(id)` —— `lib/redteam/store-core.js:1145`，`migrate(handle)`（`:1157`）之后、`this.handles.set`（`:1158`）之前，每个 handle 只跑一次：

```js
// store-core.js db(id, options) 内，migrate(handle) 之后
try {
  const meta = readMeta(this.metaPathOf(id)) || {}
  handle.prepare("UPDATE traffic_flow SET engagement_id = ? WHERE engagement_id = '' OR engagement_id IS NULL").run(String(id))
  handle.prepare("UPDATE traffic_flow SET target = ? WHERE target = '' OR target IS NULL").run(String(meta.target_name || id))
} catch { /* 旧库无该列（迁移失败）时不阻断打开 */ }
```

注意 ALTER 只在一张已存在的空表/有表上执行一次；**新旧库都建索引**（新库 DDL 里也可写 `CREATE INDEX`，但旧库 DDL 不会再跑，所以 `CREATE INDEX IF NOT EXISTS` 必须进 `migrate`）。

### 2.4 写入端：spool 如何带靶标

三层叠加，任一层缺省都能兜底：

1. **flow 行内带**（主路径）：`startMitmProxy` 接收 `engagementId/targetName`（§1.2 传入），存进 proxy 对象；`lib/redteam/proxy.js:142 record(proxy, flow)` 组装 flow 时写 `flow.engagement_id = proxy.engagement_id`、`flow.target = proxy.target_name`。
2. **`buildRow` 输出**：`lib/redteam/traffic.js:129 buildRow(flow)` 增两字段 `engagement_id: flow.engagement_id || ''`、`target: flow.target || ''`。`writeFlowToSpool`（`:103`）签名不变——它把 `buildRow` 结果 append 进 `flows.jsonl`，故 spool 的 JSONL 里天然多两个键；blob 不动。
3. **spool 目录 owner.json**（兜底，供 ingest 归属判定）：`startMitmProxy` 启动时在 `spoolDir` 写一个 `owner.json`：
   ```json
   { "engagement_id": "<id>", "target": "<target_name>", "session_key": "<key>", "created_at": "<iso>" }
   ```
   因为 `spoolDir` 默认是 `join(root,'mitm','spool',sessionKey)`（`lib/redteam/proxy.js:445` 附近），目录名是 sessionKey，**不含靶标**；owner.json 让 ingest 端无需解析行就能知道这批 spool 归谁。

`lib/redteam/traffic.js` 新增两个小函数（同文件，靠近 `spoolPathsOf`；需补 `import { atomicWriteFileSync } from './atomic-write.js'`，`readFileSync/mkdirSync/join` 该文件已引入）：

```js
export function spoolOwnerPath(spoolDir) { return join(spoolDir, 'owner.json') }
export function writeSpoolOwner(spoolDir, owner) {
  try { mkdirSync(spoolDir, { recursive: true }); atomicWriteFileSync(spoolOwnerPath(spoolDir), JSON.stringify(owner, null, 2)) } catch { /* 归属文件写失败不阻断录制 */ }
}
export function readSpoolOwner(spoolDir) {
  try { return JSON.parse(readFileSync(spoolOwnerPath(spoolDir), 'utf8')) } catch { return null }
}
```

（`atomicWriteFileSync` 已由 `lib/redteam/atomic-write.js` 提供，`platform-config.js:15` 已在用。）

### 2.5 ingest 落列与只灌本靶标

`lib/redteam/store-core.js:1227 store.traffic(id)` 两处改造：

```js
// 原 :1230-1237 spoolDirs() —— 改为只返回归属本靶标的 spool
const tname = (() => { try { return (this.listEngagements().find((e) => e.id === id) || {}).name || id } catch { return id } })()
const ownSpoolDirs = () => {
  const out = []
  let entries = []
  try { entries = readdirSync(spoolRoot, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const spoolDir = join(spoolRoot, e.name)
    const owner = readSpoolOwner(spoolDir)           // 来自 traffic.js
    if (owner && owner.engagement_id && owner.engagement_id !== String(id)) continue  // 明确属于别人 → 跳过
    if (!owner) {
      // 旧 spool（无 owner.json）：首次被某靶标 ingest 时认领，写 owner 防止另一库再抢
      writeSpoolOwner(spoolDir, { engagement_id: String(id), target: String(tname), legacy: true, claimed_at: nowIso() })
    }
    out.push(spoolDir)
  }
  return out
}
const ingest = (opts = {}) => {
  const total = { ok: true, ingested: 0, dup_skipped: 0, blobs_moved: 0, remaining: 0, errors: [], spools: 0 }
  for (const spoolDir of ownSpoolDirs()) {
    const owner = readSpoolOwner(spoolDir) || {}
    const result = ingestSpool(db, {
      spoolDir, dir, limit: opts.limit,
      engagementId: String(id), targetName: owner.target || String(tname),
    })
    // …累计同原 :1242-1248
  }
  return total
}
```

`lib/redteam/traffic.js:231 ingestSpool(db,{spoolDir,dir,limit,engagementId,targetName})` 增三参：逐行 `JSON.parse` 后，若行内 `engagement_id` 为空则用 `engagementId` 填（旧 spool 行补齐），`insertFlowRow`（`:196` 动态列）自然带上两列；`moveBlob`（`:205`）不变。

`pending()`（`store-core.js:1252`）同样改用 `ownSpoolDirs()`，只统计本靶标 spool 的未消费行。

### 2.6 读取端过滤 + 跨靶标显式放行

| 读取点 | 位置 | 契约 |
|---|---|---|
| `store.traffic(id).search(filters)` | `lib/redteam/store-core.js:1268` → `searchFlows` `lib/redteam/traffic.js:338` | `store.traffic(id)` 内注入 `filters.engagement_id = String(id)`（除非 `filters.cross_engagement===true`）；`searchFlows` 的 WHERE 追加 `engagement_id = ?`。**`searchFlows` 本身语义不变**，过滤在 store 层注入，保证所有调用方（面板/工具）默认安全 |
| `store.traffic(id).get(flowId)` | `store-core.js:1273` → `getFlow` `traffic.js:370` | 取到行后校验 `row.engagement_id === String(id)`，否则抛 `流量不属于当前靶标（属于 {row.target||row.engagement_id}）`；`opts.cross===true` 时放行 |
| `store.traffic(id).blob(flowId, which, opts)` | `store-core.js:1276` → `readFlowBlob` `traffic.js:496` | 先按 `get` 的同一规则校验归属（`readFlowBlob` 内部已 `getFlow`，在此加归属校验），跨靶标需 `opts.cross` |
| `store.traffic(id).bind(flowId, targets)` | `store-core.js:1274` → `bindFlow` `traffic.js:418` | 绑定前同样校验归属，防止把 A 靶标流量绑到 B 靶标的 finding |
| 面板 `trafficList/trafficGet/trafficBind` | `store-core.js:950-972` | 走 `store.traffic(id)`，自动带 `engagement_id`，**前端零改** |
| 工具 `redteam_traffic_search/get/blob/bind` | `lib/redteam/tools-traffic.js:69/115/139/160` | 走 `store.traffic(resolveEngagement(...))`，默认安全 |

跨靶标显式查询放行：只给工具开一个口子——`redteam_traffic_search` 增参数 `all_targets:boolean`（默认 `false`），为 `true` 时置 `filters.cross_engagement=true` 并在返回里带 `cross:true`、每条 item 带 `engagement_id/target`。面板不给该开关（人读面板按当前靶标），避免误操作。

### 2.7 落点表（L3）

| 文件 | 位置（函数） | 动作 |
|---|---|---|
| `lib/redteam/schema.js` | `traffic_flow` DDL `:419-445` | 新库增 `engagement_id`、`target` 两列 |
| `lib/redteam/schema.js` | `migrate()` `:628`，`:643` 后 | `ensure` 两列 + `CREATE INDEX IF NOT EXISTS ix_traffic_engagement` |
| `lib/redteam/store-core.js` | `db(id, options)` `:1145`，`migrate(handle)` 后 | 回填旧行 `engagement_id/target` |
| `lib/redteam/store-core.js` | 顶部 import | 从 `./traffic.js` 补 `readSpoolOwner`（如未导入） |
| `lib/redteam/traffic.js` | 新 `spoolOwnerPath/writeSpoolOwner/readSpoolOwner`（`spoolPathsOf` 附近） | owner.json 读写 |
| `lib/redteam/traffic.js` | `buildRow(flow)` `:129` | 增 `engagement_id/target` 输出 |
| `lib/redteam/traffic.js` | `ingestSpool(...)` `:231` | 增 `engagementId/targetName` 参，行补齐两列 |
| `lib/redteam/traffic.js` | `searchFlows` `:338` / `getFlow` `:370` / `readFlowBlob` `:496` / `bindFlow` `:418` | 支持 `engagement_id` 过滤；get/blob/bind 校验归属（或由 store 层包装校验） |
| `lib/redteam/store-core.js` | `traffic(id)` `:1227-1280` | `spoolDirs→ownSpoolDirs`；`ingest/pending` 只取本靶标；`search/get/blob/bind` 注入 id 与 `cross` 放行 |
| `lib/redteam/proxy.js` | `startMitmProxy` `:438`；`record` `:142` | 读 `options.engagementId/targetName` 存 proxy；record 写 flow 两字段；启动时 `writeSpoolOwner` |
| `lib/redteam/tools-traffic.js` | `redteam_traffic_search` `:69` | 增 `all_targets` 参数，透传 `cross_engagement` |
| `test/traffic-mitm.test.mjs` | — | 增「两靶标 spool 互不串库」「旧库 ALTER 后列存在且回填」两用例（§4） |

### 2.8 兼容与风险（L3）

1. **历史串库数据不可自动拆分**：旧库若历史上已把别的靶标流量灌进来，`ALTER` 只会整体回填成当前 id，无法追溯真实归属。文档给一条手工修正模板，让用户按 `session_id`/时间窗自行更正：
   ```sql
   -- 例：把某次录制（按 session_id）改判给另一靶标
   UPDATE traffic_flow SET engagement_id='other-target', target='Other Target'
   WHERE session_id='<sessionKey>' ;
   ```
2. **旧 spool 认领＝先到先得**：无 `owner.json` 的老 spool，第一个 ingest 它的靶标会认领（写 `legacy:true` 的 owner）。若真实归属是别的靶标，会误领 → 用 `owner.json` 手工改写 `engagement_id` 后再 ingest，或走上面的 SQL 修正。
3. **`NOT NULL DEFAULT ''` 在 ALTER 上合法**：SQLite 允许对已有表 `ADD COLUMN x TEXT NOT NULL DEFAULT ''`（常量默认）。但**不能加 `CHECK`/非常量默认**——所以用 `''` 哨兵而不是 `NULL`，配合回填。
4. **并发 ingest 与写入**：owner.json 用 `atomicWriteFileSync`；`flows.jsonl` 的消费仍按 `ingestSpool` 原有「读—入库—写 `.done`—回写剩余」流程（`traffic.js:231`），本期不改并发模型（多进程直写仍被「宿主唯一写者」原则排除）。
5. **索引成本**：`ix_traffic_engagement(engagement_id, id)` 对旧库首次创建会扫全表，流量表大时有一次开销；可接受（单机演练库）。
6. **`cross_engagement` 只开给工具**：面板不开，避免人在面板里误看别的靶标数据；工具里也默认 `false`，需显式 `all_targets:true`。

---

## 3. L1：reporter / retester 独立预设

### 3.1 决策：两个独立预设，不是「一个预设两角色」

理由（逐条落点）：

1. **工具面无法靠提示词切换**：工具在插件行注册（`presets/redteam/agent.cordis.yml` 的 `redteam-tools` / `redteam-tools-traffic` 行），提示词换了工具还在。要让报告员/复测员「只拿该拿的工具」，只能按预设给不同插件行/config。
2. **门禁语义**：`lib/redteam/ui.js:1091-1108` 的 env-adapt 门禁按 `preset==='redteam'` 字面量判断（turn<=1&&step<=1 时环境未 ready 就 reject）。报告员/复测员不需要「打点前先探环境」，独立预设只要 **id 不是 `'redteam'`** 就天然跳过该门禁（也正是我们想要的）。
3. **安装器改造一次到位**：`lib/redteam/index.js` 目前单预设硬编码（`REDTEAM_PRESET_ID='redteam'` `:25`；`installPreset` `:449` 固定 `target=join(userPresetRoot(),'redteam')`；`apply` `:533` 单次；`buildDefinition` `:601` 单 id；`registerOnce` `:611`），要加预设本来就得循环化，一次做三个最省。
4. **可并存、按需选**：三预设并列注册，人在新建会话时选，互不干扰。

**目录结构（重要）**：仓库的预设模型是「**一目录一预设**」——`readPresetDefinition(id, dir)`（`lib/redteam/preset-composition.js:389`）读的是目录里的 `preset.yml` + `agent.cordis.yml`，`installPreset`（`index.js:449`）复制的是 `paths.presetDir` 顶层文件。因此**不是** `presets/redteam/reporter.cordis.yml`，而是：

```
presets/redteam/            # 既有主预设（不动）
presets/redteam-reporter/   # 新
  preset.yml
  agent.cordis.yml
presets/redteam-retester/   # 新
  preset.yml
  agent.cordis.yml
```

任务文字里「`presets/redteam/reporter.cordis.yml + retester.cordis.yml`」是待定写法，实际必须落成上面两个目录，否则 `readPresetMetadata`/`readCompositionRows` 解析不到。

### 3.2 `preset.yml` 契约

| 目录（=预设 id） | `name` | `description`（单行） | `order` |
|---|---|---|---|
| `presets/redteam`（既有） | 红队模式 | 主会话 + 五角色（信息收集/资产梳理/漏洞发现/漏洞利用/内网渗透），并发≤3 | 10 |
| `presets/redteam-reporter` | 红队·报告员 | 只读靶标事实，产出计分/发现/覆盖度/最终报告，不发起扫描与利用 | 11 |
| `presets/redteam-retester` | 红队·复测员 | 对已登记漏洞逐条复测，落复测结论（reproduced/fixed/inconclusive），不新增资产 | 12 |

`readPresetMetadata` 只接受**单行字符串** `name/description` 与 **number** `order`（`preset-composition.js`），description 不能换行。

**身份识别兼容**：`lib/redteam/identity.js:515 isRedteamPresetId(value)` 命中条件为 `text==='redteam'` 或 `/^red[\s_-]*team$/i` 或 **`label` 含「红队」**（排除「不是红队/非红队」）。`redteam-reporter` 不匹配前两条，**但 `name: 红队·报告员` 含「红队」→ 命中**。命中后：`lib/identity.js:1000` 提示词装配、`lib/index.js:523/582/649` 红队签名、`lib/redteam/role-section.js:55` 子智能体角色稿注入都照常生效。**因此 `name` 必须保留「红队」二字**，这是硬约束。

### 3.3 `agent.cordis.yml` 与 tools 契约

**报告员（reporter）工具面**：报告需要「读事实 + 写报告」。

- 读：`redteam_asset_query/asset_get/vuln_query/vuln_get/score_list/score_report/report_targets/poc_list/poc_get/asset_timeline`
- 写报告：`redteam_report_build`（`lib/redteam/ops.js:108`）、`redteam_template_list/apply`、`redteam_notify_send`（可选）
- 不给：`asset_add/vuln_add/credential_add/webshell_add/tunnel_add/asset_test/poc_use/score_hit/…` 等「改变事实」的写类工具

**复测员（retester）工具面**：

- 读：`redteam_vuln_query/vuln_get/asset_timeline/evidence_record`（证据只读引用）
- 写复测：`redteam_retest_request/retest_list/retest_conclude`（`lib/redteam/ops.js:140/162/176`）
- `redteam_vuln_update`：**只允许改 `status/note`**（`retestConclude` 内部即按 `fixed→vuln.status='fixed'`、`reproduced→'open'`，`ops.js:176`），不允许改证据字段
- 不给：扫描/利用/新增类

**任务里两个名字的映射（必须写清）**：

| 任务文字 | 仓库真实实现 | 结论 |
|---|---|---|
| `update_finding_report` 工具 | 不存在。等价的「产出/更新报告」= `lib/redteam/ops.js:108 reportBuild(db,{kind,findingId,reportsDir,createdBy})`，工具入口 `redteam_report_build`（`lib/redteam/tools-ops.js` SPECS）；kind ∈ `['score','finding','coverage','final']`（`ops.js:37`） | 用 `redteam_report_build` 出报告；若确需「只改某条 finding 的报告叙事」，作为**可选增量**在 `ops.js` 新增 `updateFindingReport(db,{findingId,patch})`（写 `exploration_node.kind='finding'` 的报告字段）并加一条 SPECS —— 本期不做，先记设计 |
| `finding_retests` 表 | 不存在。真实是 `lib/redteam/schema.js:506` 的 `retest` 表（列 `id,vuln_id,target,status,conclusion,reason,requested_by,requested_at,started_at,finished_at,evidence_ref,note`） | `finding_retests ≡ retest`；工具 `redteam_retest_request/list/conclude` 已落此表 |

**`tools-ops.js` 当前不能挂载**：`lib/redteam/tools-ops.js` 目前只导出 `registerOpsTools(ctx,store,{...})`（`:189`），**没有 `name/inject/apply` 导出**，`package.json exports` 也没有 `./redteam/tools-ops`。要把它作为 reporter/retester 预设的插件行，必须先补：

```js
// lib/redteam/tools-ops.js 顶部新增（registerOpsTools 已存在）
export const name = 'mantis-redteam-ops-tools'
export const inject = ['tools']
export function apply(ctx) {
  let store = ctx.redteam
  if (!store) { try { store = ctx.get('redteam') } catch { store = undefined } }
  if (!store) { ctx.logger?.warn?.('redteam-ops-tools: host ctx.redteam unavailable'); return }
  // 依赖 tools.js 的 resolveEngagement / bindingKeyOf / archivedGuard：
  // 由 tools.js 导出或在 ops 内本地复刻（推荐 export 复用，见 §3.5 风险 2）
  registerOpsTools(ctx, store, { /* resolveEngagement, bindingKeyOf, db, root, reportsDir, archivedGuard */ })
}
```

`package.json exports` 追加：`"./redteam/tools-ops": "./lib/redteam/tools-ops.js"`（发布面变更，见 §3.7）。`presets/*/agent.cordis.yml` 里插件行写 `name: "@zhuifengqug/dsh-mantis/redteam/tools-ops"`。

**按 profile 过滤工具（方案 B，最小版）**：`lib/redteam/tools.js apply(ctx)`（`:290`）增第二参 `config`，把 64 处 `ctx.tools.register(...)` 收口成本地 `register(def)`，按 `config.profile` 白名单决定是否注册：

```js
// tools.js apply(ctx, config = {}) —— 收口
const profile = config.profile || 'full'
const allow = profile === 'full' ? null : new Set(PROFILE_TOOLS[profile])
const register = (def) => { if (!allow || allow.has(def.name)) ctx.tools.register(def) }
// 之后所有 ctx.tools.register(x) → register(x)
```

`PROFILE_TOOLS = { reporter:[...§3.3 读+报告...], retester:[...读+复测...] }`。**`full` 保持原样（零回归）**，只有 reporter/retester 生效。这是本期唯一「大改」点（64 处 register），风险见 §3.8；退路是方案 A（零改 tools.js，只靠提示词禁令），但工具仍可见。

### 3.4 提示词契约（persona prefix）

- **reporter**：只读靶标事实（资产/漏洞/计分/证据/流量），产出 `redteam_report_build`（`score/finding/coverage/final` 四类），引用证据用 `asset_timeline/evidence_record/poc_get`；**不新增资产、不发起扫描或利用、不改漏洞状态**；报告落 `engagements/<id>/reports/`（`openEngagement` 已建 `reports` 子目录，`store-core.js:1359`）。
- **retester**：从 `vuln_query` 取 `open` 状态的漏洞，逐条复测；结论只取 `reproduced/fixed/inconclusive`（`ops.js:38`）；调 `redteam_retest_conclude` 落 `retest` 表并联动 `vuln.status`；证据用 `evidence_ref` 引用既有证据，不伪造；不新增资产。
- 两者都挂：`tool-fs` / `tool-fs-search` / `tool-jobs` / `tool-web`（读证据、读模板）、`tool-skill` + `skill-filesystem`（`customSkillDirs: dshHomePath('redteam/skills')`，读报告/复测剧本）、`tool-ask-user` / `tool-todo` / `command-goal` / `tool-goal`（长任务）。
- 两者都不挂：`delegation` 组（叶子，不派活）、`planning` 组（除需要 goal 规划时可选）、`anchor-gate`（报告员/复测员是短任务，不搞首轮 bootstrap 门禁；主预设保留）。若确需 anchor-gate，`maxBootstrapSteps:1`。

### 3.5 `installPreset` 改造契约（循环化三预设）

`lib/redteam/index.js` 由单预设改多预设：

```js
// index.js —— 新增
export const PRESET_SPECS = [
  { id: 'redteam',          dir: 'redteam' },
  { id: 'redteam-reporter', dir: 'redteam-reporter' },
  { id: 'redteam-retester', dir: 'redteam-retester' },
]
// REDTEAM_PRESET_ID 保持 'redteam' 不变（:25），仅作主预设别名
```

改造点：

1. `installPreset(options)`（`:449`）：外层 `for (const spec of PRESET_SPECS)`，`target=join(userPresetRoot(), spec.id)`、`paths.presetDir=join(paths.presets, spec.dir)`。自愈逻辑（`renderSkillsDir/renderToolsPackage/stripToolFilter/repairDelegation/quoteScopedNames/syncAnchorGate`）按目录各自跑一遍；`force` 时复制该目录顶层文件。返回 `{ action, presets:[{id,action,dir}, ...] }`。
2. `apply(ctx)`（`:533`）：`installPreset` 一次装三；`buildDefinition` 循环三 id；`registerOnce` 循环注册三 definition；`writeStatus` 写 `{ ok, phase, presets:[{id,ok,phase,...}] }`（旧的 `{ok,phase}` 仍可读——向后兼容）。
3. `buildDefinition()`（`:601`）：改为 `buildDefinition(id, dir)`，`readPresetDefinition(id, readyDir)` 按 id 读；缺目录时跳过该预设（不阻断另外两个）。
4. `registerOnce(registry)`（`:611`）：接受 `definition` 参数，逐个 `await registry.register(definition)`；`undeclare` 同理。
5. 安装目标：`$DSH_HOME/.agent-presets/<id>/`（`userPresetRoot()` `:86`）。
6. 兼容：旧用户 `.agent-presets/redteam` 已存在 → 走既有 `force` 分支不变；新目录首次安装；`.agent-presets/` 下其它目录不动。

### 3.6 与主 redteam 预设的关系

- **并存**：三个预设并列出现在预设列表（order 10/11/12），互不覆盖。
- **何时用**：主预设走全流程（指挥 + 五角色 + 并发≤3，`presets/redteam/preset.yml`）；报告员用于收尾出报告（已有 findings/score 之后）；复测员用于修复后逐条回验（对 `open` 漏洞）。
- **数据共享**：三预设共用同一 `RedteamStore` / 同一 `engagements/` 目录（`store.js` 发布进程级 `ctx.redteam`），靶标互通。
- **不自动转场**：从主预设切到 reporter 是**新建会话**，需重新绑定同一靶标（`redteam_session_bind` 或选靶标）。不继承会话上下文——这是有意为之（报告员应从事实库读，不靠主会话记忆）。

### 3.7 落点表（L1）

| 文件 | 位置（函数） | 动作 |
|---|---|---|
| `presets/redteam-reporter/preset.yml` | 新文件 | `name: 红队·报告员`、`description` 单行、`order: 11` |
| `presets/redteam-reporter/agent.cordis.yml` | 新文件 | persona prefix（§3.4）+ `redteam-tools`(profile:reporter) + `redteam-tools-traffic` + `redteam-tools-ops` + fs/jobs/skill/ask/todo/goal |
| `presets/redteam-retester/preset.yml` | 新文件 | `name: 红队·复测员`、`order: 12` |
| `presets/redteam-retester/agent.cordis.yml` | 新文件 | persona prefix（§3.4）+ `redteam-tools`(profile:retester) + `redteam-tools-ops` + fs/jobs/skill/ask/todo/goal |
| `lib/redteam/tools-ops.js` | 顶部 | 增 `name/inject/apply` 导出（`registerOpsTools` `:189` 已存在） |
| `package.json` | `exports` | 增 `"./redteam/tools-ops": "./lib/redteam/tools-ops.js"`；`version` 1.1.0→1.2.0 |
| `lib/redteam/tools.js` | `apply(ctx)` `:290`；64 处 `ctx.tools.register` | 增 `config` 参 + `register` 收口 + `PROFILE_TOOLS` 白名单（方案 B） |
| `lib/redteam/tools-traffic.js` | `apply(ctx)` | 增 `config` 参，可选按 profile 过滤（traffic 工具两角色都可读，默认全给；如要收紧再说） |
| `lib/redteam/index.js` | `:25`、`PRESET_SPECS` 新增、`installPreset` `:449`、`apply` `:533`、`buildDefinition` `:601`、`registerOnce` `:611`、`writeStatus` | 循环化三预设（§3.5） |
| `lib/redteam/identity.js` | `isRedteamPresetId` `:515` | 不改（`name` 含「红队」即命中） |
| `lib/redteam/ui.js` | `:1091-1108` env 门禁 | 不改（reporter/retester id 非 `'redteam'`，自动跳过） |
| `docs/agents/issue-tracker.md` / `GLOSSARY.md` | — | 若新增预设 id 属领域词，按 `AGENTS.md` 的 domain 约定补 `GLOSSARY.md` |

### 3.8 兼容与风险（L1）

1. **`package.json exports` 变更**：新增子路径属发布面变更，按 minor bump（1.1.0→1.2.0）。旧引用不断。
2. **`tools.js` 64 处 register 收口是本期最大改动**：必须逐个核对工具名与 `PROFILE_TOOLS` 是否一致（工具名清单以 `tools.js` 为准），漏一个就少一个工具。**退路**：先落方案 A（零改 tools.js，reporter/retester 仅靠 persona 禁令），把方案 B 作为后续独立改动。
3. **`registerOpsTools` 依赖 `resolveEngagement/bindingKeyOf/archivedGuard`**：这些现在在 `tools.js` 内部（`resolveEngagement` `:142` 已 `export`；`bindingKeyOf` `:125` 未 export；`archivedGuard` 在 `lib/redteam/ops.js:316`）。`tools-ops.js` 作为独立插件行时需从 `tools.js` `export` 出 `bindingKeyOf`（或在 ops 内复刻），并把 `root/reportsDir/db` 从 `store` 取（`store.root`、`store.dirOf(id)`+`reports`）。这是接线细节，实现时必须核对。
4. **`preset-declare.json` 结构升级**：从 `{ok,phase}` 变 `{ok,phase,presets:[...]}`，读方（如有）需兼容旧结构；建议只加字段不改旧字段。
5. **`name` 含「红队」是硬约束**：改掉就丢失红队身份识别（提示词/签名/角色稿全失效）。reporter/retester 的 `name` 必须保留「红队」二字。
6. **不自动转场**：用户从主预设切 reporter 需手动绑定靶标，易漏；在 reporter/retester persona 首段写「若未绑定靶标，先 `redteam_session_bind` 绑定到已有靶标」。
7. **reportsDir**：`openEngagement`（`store-core.js:1359`）已建 `reports` 子目录；`reportBuild` 的 `reportsDir` 传 `join(dirOf(id),'reports')`。

---

## 4. 验收与测试建议

### 4.1 契约自检清单

| # | 检查项 | 判定 |
|---|---|---|
| L2-1 | `proxyStatus` 在同步 `dispatch` 可调，返回含 `running/port/mode/caPath/caReady/flows` | ☐ |
| L2-2 | `proxyStart` / `proxyStop` 在 `dispatchAsync` 可调，失败返回 `{ok:false,error,code}` | ☐ |
| L2-3 | 端口全占用时返回 `EADDRINUSE` 且前端给「改起始端口」文案 | ☐ |
| L2-4 | `caReady:false`/HTTPS 证书错时给「手动装 CA」文案；全库无 `addstore/add-trusted-cert/update-ca-certificates` 调用 | ☐ |
| L2-5 | 已有其它靶标录制时 `proxyStart` 返回 `ALREADY_RECORDING` | ☐ |
| L3-1 | 旧库打开后 `PRAGMA table_info(traffic_flow)` 含 `engagement_id/target`，旧行已回填 | ☐ |
| L3-2 | 两个靶标各自 spool，`ingest` 后各自库只含自己的流量（不串） | ☐ |
| L3-3 | `trafficList` 默认只回当前靶标；`all_targets:true` 才跨靶标且带 `cross:true` | ☐ |
| L3-4 | `trafficGet/blob/bind` 跨靶标被拒（除非 `cross`） | ☐ |
| L1-1 | `$DSH_HOME/.agent-presets/` 下出现 `redteam`、`redteam-reporter`、`redteam-retester` 三目录 | ☐ |
| L1-2 | 三预设均注册成功，`preset-declare.json` 记 `presets` 数组三 ok | ☐ |
| L1-3 | reporter 只拿读+报告工具；retester 只拿读+复测工具（方案 B） | ☐ |
| L1-4 | `redteam-reporter` 会话被识别为红队（`isRedteamSession` 为 true） | ☐ |

### 4.2 测试落点

- 复用 `test/traffic-mitm.test.mjs` 风格（`DDL` + `DatabaseSync(':memory:')` + `tmpRoot`），新增：
  - 旧库迁移：构造无 `engagement_id` 的旧表 → `migrate(db)` → 断言列存在 + 回填。
  - 双靶标隔离：两个 tmpRoot 子目录各写 spool + owner.json → `store.traffic(A).ingest()` / `store.traffic(B).ingest()` → 断言各自库行数、互不包含。
  - 代理生命周期：`proxyStart` → `proxyStatus.running=true` → `proxyStop` → `running=false`，复用「默认不自启/stop 按 root 兜底」用例。
- 预设：`test/plugin-skills.test.mjs` 风格，断言 `readPresetDefinition('redteam-reporter', dir)` 解析出 `name` 含「红队」。

---

## 5. 风险总表

| 编号 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | state 单槽被多靶标覆盖 | 同时录两会话显示错乱 | §1.7 单活跃录制约束；state v2 列后续 |
| R2 | 旧库历史串库数据无法自动拆分 | 旧流量归属错 | §2.8 手工 SQL 修正模板 |
| R3 | 旧 spool 无 owner 被误认领 | 归属错 | §2.8 改写 owner.json 或 SQL 修正 |
| R4 | `tools.js` 64 处 register 收口漏项 | 少工具 | §3.8 逐个核对；退路方案 A |
| R5 | `tools-ops.js` 接线缺 `bindingKeyOf/archivedGuard` 导出 | 插件行启动失败 | §3.8 补 export 或复刻 |
| R6 | 预设 `name` 丢「红队」 | 身份识别失效 | §3.2/§3.8 硬约束 |
| R7 | `exports` 新增子路径 | 发布面变更 | §3.8 minor bump 1.2.0 |
| R8 | 上游 TLS `rejectUnauthorized:false` | 安全性下降（仅授权环境） | §1.6 前端小字提示，不阻断 |
| R9 | `NOT NULL DEFAULT ''` 哨兵 | 报表出现空 id 行 | 迁移回填 + `get` 归属校验 |
| R10 | 面板未重建 | 按钮不出现 | 改完 `lib/redteam/client.js` 跑 `pnpm build:client` |

---

## 附录 A：落点总表（按文件聚合）

| 文件 | L2 | L3 | L1 |
|---|---|---|---|
| `lib/redteam/schema.js` | — | DDL 两列 `:419-445`；`migrate` ensure+索引 `:628` | — |
| `lib/redteam/store-core.js` | import proxy；`proxyView`；`proxyStatus` 同步分支 `:994` 后；`proxyStart/Stop` 异步分支 `:1051` | `db()` 回填 `:1145`；`traffic()` 隔离 `:1227-1280` | — |
| `lib/redteam/proxy.js` | 已具备启停；`startMitmProxy` 读 `engagementId/targetName` | `record` 写 flow 两字段 `:142`；启动写 owner.json | — |
| `lib/redteam/traffic.js` | — | `spoolOwner*`；`buildRow :129`；`ingestSpool :231`；`search/get/blob/bind` 归属 | — |
| `lib/redteam/tools-traffic.js` | — | `redteam_traffic_search` 加 `all_targets` `:69` | `apply` 可选 config |
| `lib/redteam/tools.js` | — | — | `apply(ctx,config)` 收口 `:290` + `PROFILE_TOOLS` |
| `lib/redteam/tools-ops.js` | — | — | 补 `name/inject/apply` |
| `lib/redteam/index.js` | — | — | `PRESET_SPECS` + 循环化 `:449/:533/:601/:611` |
| `lib/redteam/client.js` | `FlowPane :4256` 录制条；`CaPane :4562` 联动 | — | — |
| `package.json` | — | — | `exports` 增 `./redteam/tools-ops`；version 1.2.0 |
| `presets/redteam-reporter/*` | — | — | 新预设（preset.yml + agent.cordis.yml） |
| `presets/redteam-retester/*` | — | — | 新预设（preset.yml + agent.cordis.yml） |
| `lib/redteam/ui.js` | 不改 | 不改 | 不改（`:1091-1108` 门禁按 id 字面量自动跳过） |

## 附录 B：实现顺序建议（依赖关系）

1. **L3 先行**（数据层是所有上层的基础）：schema 迁移 → traffic.js owner/buildRow/ingest → store.traffic 隔离 → tools-traffic `all_targets`。
2. **L2 依赖 L3 的 `engagementId/targetName`**：proxy 读 owner → store-core proxyView/op → client 录制条 → `pnpm build:client`。
3. **L1 最后**（与 L2/L3 无代码依赖，但依赖 `tools-ops` 可挂载）：tools-ops 导出 → package exports → tools.js 收口 → index.js 循环 → 两个预设目录。
4. 后端（L3→L2）与 L1 可并行；前端（L2 录制条）在 L2 后端 op 就绪后接。
