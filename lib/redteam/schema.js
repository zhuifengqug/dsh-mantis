import { DatabaseSync } from 'node:sqlite'
/* 计分/判定规则的唯一实现在 score-rules.js；本文件只留 DDL 与迁移。
   migrate() 里用到的 parseTargetPort 也从那里取，不再保留副本。 */
import { parseTargetPort } from './score-rules.js'

/**
 * 事实库 schema 与增量迁移（零依赖）。
 *
 * 从 core.js 抽出来的模块：**DDL 与迁移是"数据形状"的唯一定义处**，
 * 与"怎么用这些数据"（RedteamStore 的方法）分开之后，
 * 看 schema 不用翻过 500 行计分逻辑，改表结构也不会误碰业务代码。
 *
 * 两处迁移遵循同一条纪律：**先查 PRAGMA 再 ADD COLUMN**，可重复执行、老库不用重建。
 * 读不到表结构一律按"没有这一列"处理（返回 false），交给 ensure 去尝试 ALTER；
 * 反过来当成"列已存在"会让迁移被静默跳过，故障点从"迁移失败"漂到远端 SQL 执行处。
 */

/* ------------------------------------------------------------------ FTS5 能力检测 */

/**
 * 本机 `node:sqlite` 是否带 FTS5。
 *
 * **必须检测**：FTS5 是编译期选项，不同 Node 构建并不一致 ——
 * Node 22.14 的 `node:sqlite` 没有（`no such module: fts5`），22.23 有。
 * 因此不能假定它存在：CI 与本地 Node 版本不一致时，整个 DDL 都建不起来。
 * 语义：只有 FTS5 缺席时才降级成 LIKE 检索 —— 装了 FTS5 的机器行为完全不变。
 *
 * `REDTEAM_NO_FTS5=1` 可强制走降级路径：CI 的 Node 一旦换了带 FTS5 的版本，
 * 降级分支就再没人执行了，得留一个能主动触发它的开关（见 test/fts-fallback.test.mjs）。
 */
export const HAS_FTS5 = (() => {
  if (process.env.REDTEAM_NO_FTS5 === '1') return false
  try {
    const probe = new DatabaseSync(':memory:')
    try {
      probe.exec('CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)')
      return true
    } finally {
      probe.close()
    }
  } catch {
    return false
  }
})()

/* ------------------------------------------------------------------ FTS 虚拟表 DDL */

/**
 * 两张全文检索虚拟表。**单独导出**，因为它们依赖 FTS5：
 * FTS5 缺席的构建上建表会抛 `no such module: fts5`，把整份 DDL 一起带崩。
 * 调用方按 `HAS_FTS5` 决定是否拼进 DDL（见 core.js 的 db() / kb()）。
 */
export const ASSET_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS asset_fts USING fts5(
  asset_id UNINDEXED, ip, names, banners, titles, fingerprints
);
`

export const POC_FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS poc_fts USING fts5(
  poc_id UNINDEXED, title, cve, component, versions, tags, description, content
);
`

/* ------------------------------------------------------------------ 靶标库 schema */

export const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS scan_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT, tool TEXT, argv TEXT,
  started_at TEXT, finished_at TEXT, status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS segment (
  cidr TEXT PRIMARY KEY, ip_start TEXT, ip_end TEXT,
  org TEXT, asn TEXT, country TEXT, city TEXT,
  source TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS asset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_cidr TEXT NOT NULL, ip TEXT NOT NULL, ip_int INTEGER,
  state TEXT DEFAULT 'unknown', primary_name TEXT, confidence REAL,
  first_seen TEXT, last_seen TEXT, discovered_at TEXT,
  test_status TEXT DEFAULT 'untested', test_notes TEXT, test_surface TEXT,
  test_updated_at TEXT, test_updated_by TEXT, blocked_count INTEGER DEFAULT 0,
  priority TEXT, potential TEXT, assess_reason TEXT, assessed_at TEXT, assessed_by TEXT,
  UNIQUE(segment_cidr, ip)
);

CREATE TABLE IF NOT EXISTS asset_name (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, name, kind)
);

CREATE TABLE IF NOT EXISTS port (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, proto TEXT DEFAULT 'tcp', port INTEGER NOT NULL,
  state TEXT DEFAULT 'open', provenance TEXT, tool TEXT, banner TEXT,
  url TEXT, title TEXT,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(asset_id, proto, port)
);

CREATE TABLE IF NOT EXISTS service (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  port_id INTEGER NOT NULL, name TEXT, product TEXT, version TEXT, cpe TEXT,
  provenance TEXT, tool TEXT, first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS fingerprint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL, port_id INTEGER,
  category TEXT, vendor TEXT, product TEXT, version TEXT,
  evidence TEXT, confidence REAL, provenance TEXT, tool TEXT,
  first_seen TEXT, last_seen TEXT
);

CREATE TABLE IF NOT EXISTS observation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL,
  attr TEXT, value TEXT, provenance TEXT, tool TEXT,
  scan_run_id INTEGER, collected_at TEXT, raw_ref TEXT
);

CREATE TABLE IF NOT EXISTS edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src_kind TEXT NOT NULL, src_id TEXT NOT NULL,
  dst_kind TEXT NOT NULL, dst_id TEXT NOT NULL,
  relation TEXT NOT NULL, confidence REAL, scan_run_id INTEGER,
  first_seen TEXT, last_seen TEXT,
  UNIQUE(src_kind, src_id, dst_kind, dst_id, relation)
);

CREATE TABLE IF NOT EXISTS tag (
  entity_kind TEXT NOT NULL, entity_id INTEGER NOT NULL, tag TEXT NOT NULL,
  note TEXT, created_by TEXT, created_at TEXT,
  PRIMARY KEY (entity_kind, entity_id, tag)
);

CREATE TABLE IF NOT EXISTS vuln (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, port_id INTEGER, cve TEXT, title TEXT, severity TEXT,
  source TEXT, confidence REAL, status TEXT, evidence TEXT, target TEXT,
  found_by_agent TEXT, found_at TEXT, gained TEXT, agent TEXT
);

/* 得分点：来自攻防演练得分规则，用户可编辑（分值、启用、分类） */
CREATE TABLE IF NOT EXISTS score_point (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT,
  points INTEGER DEFAULT 0,
  max_hits INTEGER DEFAULT 1,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT,
  /* ── 按《突破入侵类得分规则》新增的判定字段（v0.11.0）────────────────────
     rule：规则号（RULE 1…25）；**同一 rule 的得分点共用该规则的得分上限**
     tier：同规则内的档位（普通权限/管理员权限/加成分…），面板与报告按它分组展示
     cap：该 rule 的累计得分上限（0 = 不设上限）
     dedup_scope：计分口径 service(同资产同端口只算最高一条) / system(同系统只算最高权限一次)
                  / target(整个目标只算一次) / none(按台卡节点数累加)
     legacy：1 = 旧版得分点（迁移后保留但停用，只作历史参照，不参与新口径计分） */
  /* src：《突破入侵类得分规则（合并版）》里的原序号（合并行写首个原序号），仅用于与原表对账 */
  src INTEGER,
  rule INTEGER,
  tier TEXT,
  cap INTEGER DEFAULT 0,
  dedup_scope TEXT DEFAULT 'service',
  legacy INTEGER DEFAULT 0,
  /* builtin：1 = 随《突破入侵类得分规则》分发的内置得分点（分值/上限/口径由规则锁定，
     用户只能改「启用/停用」）；0 = 用户自建点（可任意编辑，且不会被播种逻辑清掉）。
     判定内置**必须看这个标志位**，不能用 code 名单：用户自建的得分点一旦被判成旧体系残留，
     会在下次读取得分面板时连同命中一起删掉，而写入侧仍返回成功。 */
  builtin INTEGER DEFAULT 0
);

/* 得分记录：某个得分点在某个目标上被拿下 */
/* 作战阶段：全链路攻击路径图的五个阶段（内容可编辑） */
CREATE TABLE IF NOT EXISTS stage (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subtitle TEXT,
  color TEXT,
  goal TEXT,
  sections TEXT,
  tools TEXT,
  transition TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS score_hit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER NOT NULL,
  asset_id INTEGER, vuln_id INTEGER, step_id INTEGER, target TEXT,
  evidence TEXT, note TEXT,
  self_created INTEGER DEFAULT 0,
  port INTEGER,
  recorded_by TEXT, recorded_at TEXT,
  /* 本次命中的实际分值（NULL = 用得分点的默认 points）。
     《合并版》把同一项的多个档位合并成一条（如服务器主机权限"普通 10 / 管理员 50"、
     域名控制"一级 50 / 二级 20"），**档位差异只能落在每一条命中上**，
     否则"权限取高只计一次"无从表达。 */
  points INTEGER,
  /* 倍率：G5 数据规模翻倍（×2）/ G6 IPv6 成果 ×3。**作用在权限分上**，
     与 points 相乘后再参与上限累计。存下来是为了让面板与报告能解释"这条为什么是 200 分"，
     而不是让读者以为分值算错了。 */
  multiplier REAL DEFAULT 1
);

/* 凭据：secret_value 存明文口令/密钥（面板直接显示，便于随时复用），secret_ref 指向 runs/ 下的证据文件。
   注意：本库只在本机，禁止把库文件或导出内容提交到任何仓库。 */
CREATE TABLE IF NOT EXISTS credential (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, secret_type TEXT,
  secret_value TEXT, secret_ref TEXT,
  privilege TEXT, source TEXT, tool TEXT, note TEXT,
  found_by_agent TEXT, found_at TEXT, agent TEXT,
  UNIQUE(host, username, secret_type)
);

/* 访问会话：拿到入口后的一次可控访问记录（横向移动的起点） */
CREATE TABLE IF NOT EXISTS access_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, host TEXT, username TEXT, method TEXT, privilege TEXT,
  session_ref TEXT, note TEXT, found_by_agent TEXT, obtained_at TEXT
);

/* WebShell：已经上线的可控入口。智能体随时可以复用，避免"打到最后忘了还有 webshell" */
CREATE TABLE IF NOT EXISTS webshell (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, url TEXT NOT NULL, shell_type TEXT, pass_key TEXT,
  secret_ref TEXT, privilege TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT,
  UNIQUE(url, pass_key)
);

/* 内网隧道：suo5 / socks5 / ssh -R / frp 等。记录入口、监听地址与可达网段 */
CREATE TABLE IF NOT EXISTS tunnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER, webshell_id INTEGER, kind TEXT, listen TEXT,
  entry TEXT, reach TEXT,
  entry_kind TEXT,
  status TEXT DEFAULT 'unknown', last_check TEXT, check_note TEXT, latency_ms INTEGER,
  pid TEXT, command TEXT, note TEXT, found_by_agent TEXT, created_at TEXT, updated_at TEXT, agent TEXT
);

/* HTTP 证据：原始请求/响应，可直接粘贴进 Burp Suite / Yakit 复现 */
CREATE TABLE IF NOT EXISTS http_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vuln_id INTEGER, asset_id INTEGER, label TEXT,
  method TEXT, url TEXT, status INTEGER,
  request TEXT, response TEXT, note TEXT,
  captured_by TEXT, captured_at TEXT
);

/* 攻击文件：针对某个目标实际生效的脚本/POC/EXP（只收录验证有效的） */
CREATE TABLE IF NOT EXISTS attack_file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL, target_kind TEXT, name TEXT NOT NULL, kind TEXT,
  path TEXT NOT NULL, description TEXT, evidence TEXT,
  asset_id INTEGER, vuln_id INTEGER, created_by TEXT, created_at TEXT,
  UNIQUE(target, name)
);

/* 攻击链步骤：人工/智能体记录的链路节点，用于攻击链页面与报告。
   tool/agent/result 三列是"这一步怎么做的"的凭证：报告要写清账号密码怎么来的、
   隧道怎么搭的，靠的就是步骤上的工具与命令原文。 */
CREATE TABLE IF NOT EXISTS attack_step (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seq INTEGER, stage TEXT, title TEXT, detail TEXT,
  asset_id INTEGER, vuln_id INTEGER, access_id INTEGER, point_id INTEGER,
  evidence_ref TEXT, tool TEXT, agent TEXT, result TEXT,
  recorded_by TEXT, recorded_at TEXT
);

/* 证据截图：得分成果的"看得见"的那一份材料。
   落盘位置：<靶标目录>/shots/，库里只存文件名与元数据 —— 图片不进 SQLite。
   kind：screenshot 现场截图；card 由记录生成的证据摘录卡，报告里要分开标注。 */
CREATE TABLE IF NOT EXISTS shot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  point_id INTEGER, hit_id INTEGER, asset_id INTEGER, vuln_id INTEGER,
  target TEXT, label TEXT, note TEXT,
  file TEXT NOT NULL,
  kind TEXT DEFAULT 'screenshot',
  mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT,
  source_ref TEXT, captured_at TEXT, found_by_agent TEXT, agent TEXT, created_at TEXT,
  UNIQUE(file)
);


CREATE INDEX IF NOT EXISTS ix_asset_segment ON asset(segment_cidr);
CREATE INDEX IF NOT EXISTS ix_asset_ip_int ON asset(ip_int);
CREATE INDEX IF NOT EXISTS ix_port_asset ON port(asset_id);
CREATE INDEX IF NOT EXISTS ix_port_port ON port(port);
CREATE INDEX IF NOT EXISTS ix_service_port ON service(port_id);
CREATE INDEX IF NOT EXISTS ix_service_name ON service(name, product, version);
CREATE INDEX IF NOT EXISTS ix_fp_asset ON fingerprint(asset_id);
CREATE INDEX IF NOT EXISTS ix_fp_product ON fingerprint(product, version);
CREATE INDEX IF NOT EXISTS ix_edge_src ON edge(src_kind, src_id);
CREATE INDEX IF NOT EXISTS ix_edge_dst ON edge(dst_kind, dst_id);
CREATE INDEX IF NOT EXISTS ix_obs_entity ON observation(entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS ix_vuln_asset ON vuln(asset_id);
CREATE INDEX IF NOT EXISTS ix_vuln_sev ON vuln(severity, status);
CREATE INDEX IF NOT EXISTS ix_vuln_cve ON vuln(cve);
CREATE INDEX IF NOT EXISTS ix_cred_host ON credential(host);
CREATE INDEX IF NOT EXISTS ix_access_host ON access_session(host);
CREATE INDEX IF NOT EXISTS ix_webshell_status ON webshell(status);
CREATE INDEX IF NOT EXISTS ix_tunnel_status ON tunnel(status);
CREATE INDEX IF NOT EXISTS ix_shot_point ON shot(point_id);
CREATE INDEX IF NOT EXISTS ix_shot_hit ON shot(hit_id);
CREATE INDEX IF NOT EXISTS ix_shot_asset ON shot(asset_id);
CREATE INDEX IF NOT EXISTS ix_http_vuln ON http_evidence(vuln_id);
CREATE INDEX IF NOT EXISTS ix_http_asset ON http_evidence(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_seq ON attack_step(seq, id);
CREATE INDEX IF NOT EXISTS ix_attack_target ON attack_file(target);
CREATE INDEX IF NOT EXISTS ix_score_hit_point ON score_hit(point_id);
/* 报告/攻击链按时间排序取命中（scoreReport 的 ORDER BY h.recorded_at, h.id） */
CREATE INDEX IF NOT EXISTS ix_score_hit_time ON score_hit(recorded_at, id);
/* 报告的"这一步关联了哪些攻击步骤"按 asset_id / vuln_id / step_id 反查 */
CREATE INDEX IF NOT EXISTS ix_score_hit_vuln ON score_hit(vuln_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_step ON score_hit(step_id);
/* 攻击步骤按资产/漏洞反查（报告溯源与 #hitTrace 的兜底归因都走这里） */
CREATE INDEX IF NOT EXISTS ix_step_asset ON attack_step(asset_id);
CREATE INDEX IF NOT EXISTS ix_step_vuln ON attack_step(vuln_id);
CREATE INDEX IF NOT EXISTS ix_step_recorded ON attack_step(recorded_at);
/* 资产按 C 段 + 状态筛（资产测绘左侧点某个 C 段就是这条） */
CREATE INDEX IF NOT EXISTS ix_asset_segment_state ON asset(segment_cidr, state);
/* http 证据按目标 URL 做 LIKE 兜底匹配（scoreReport 找不到显式关联时用） */
CREATE INDEX IF NOT EXISTS ix_http_url ON http_evidence(url);
/* 隧道/马按资产与状态查（会话页与攻击链都要） */
CREATE INDEX IF NOT EXISTS ix_tunnel_asset ON tunnel(asset_id);
CREATE INDEX IF NOT EXISTS ix_webshell_asset ON webshell(asset_id);
CREATE INDEX IF NOT EXISTS ix_credential_asset ON credential(asset_id);
CREATE INDEX IF NOT EXISTS ix_access_asset ON access_session(asset_id);
CREATE INDEX IF NOT EXISTS ix_score_hit_asset ON score_hit(asset_id);

CREATE VIEW IF NOT EXISTS v_asset_summary AS
SELECT a.id, a.ip, a.segment_cidr, a.state, a.primary_name, a.first_seen, a.last_seen,
  (SELECT COUNT(*) FROM port p WHERE p.asset_id = a.id AND p.state = 'open') AS open_ports,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'passive') AS passive_signals,
  (SELECT COUNT(*) FROM observation o WHERE o.entity_kind = 'asset' AND o.entity_id = a.id AND o.provenance = 'active') AS active_signals
FROM asset a;

CREATE VIEW IF NOT EXISTS v_asset_service AS
SELECT p.asset_id, p.port, p.proto, p.provenance AS port_provenance,
       s.name AS service, s.product, s.version, s.provenance AS service_provenance
FROM port p LEFT JOIN service s ON s.port_id = p.id;

/* ── 探索图（吸收 ARTEX）：任务内「目标 → 意图 → 事实/发现」的探索状态机。
   与资产图（asset/port/service/vuln…）分开：资产图是全局事实，探索图是"这一次怎么推进"。
   exploration_anchor 把探索节点挂到资产图的具体资产上，才能算覆盖率、出资产覆盖图。 */
CREATE TABLE IF NOT EXISTS exploration (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | achieved | failed | stopped
  round_no INTEGER NOT NULL DEFAULT 0,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS exploration_node (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exploration_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                        -- begin|goal|intent|fact|finding|hint|digest
  state TEXT NOT NULL DEFAULT 'open',        -- open|running|done|blocked|exhausted|stopped|deleted
  title TEXT, body TEXT, payload TEXT,       -- payload = JSON 文本
  priority INTEGER DEFAULT 0,
  origin TEXT, owner TEXT, parent_id INTEGER,
  blocked_reason TEXT, delete_reason TEXT,
  content_version INTEGER DEFAULT 1,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS exploration_edge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exploration_id INTEGER NOT NULL,
  src_id INTEGER NOT NULL, dst_id INTEGER NOT NULL,
  rel TEXT NOT NULL,                         -- spawns|derived_from|yields|proves|covers
  created_at TEXT,
  UNIQUE(src_id, dst_id, rel)
);
CREATE TABLE IF NOT EXISTS exploration_anchor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL, asset_id INTEGER NOT NULL,
  created_at TEXT, UNIQUE(node_id, asset_id)
);
CREATE TABLE IF NOT EXISTS task_constraint (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target TEXT NOT NULL, kind TEXT NOT NULL,  -- allow | deny
  text TEXT NOT NULL, origin TEXT, created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_expnode_exp ON exploration_node(exploration_id, kind, state);
CREATE INDEX IF NOT EXISTS ix_expnode_state ON exploration_node(exploration_id, state);
CREATE INDEX IF NOT EXISTS ix_expedge_exp ON exploration_edge(exploration_id, src_id);
CREATE INDEX IF NOT EXISTS ix_expanchor_asset ON exploration_anchor(asset_id);
CREATE INDEX IF NOT EXISTS ix_exp_target ON exploration(target, status);

/* ── MITM 录制流量（P3a）：代理进程只写 spool，宿主进程幂等入库（见 traffic.js）。
   traffic_session = 一次代理运行（端口/session/审计）；
   traffic_flow    = 一条请求-响应事务，flow_key 是幂等键（重复 ingest 不重复入库）。 */
CREATE TABLE IF NOT EXISTS traffic_session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  port INTEGER, pid INTEGER,
  status TEXT NOT NULL DEFAULT 'running',    -- running | stopped | error
  filter TEXT, ca_sha256 TEXT, spool_dir TEXT,
  started_at TEXT, stopped_at TEXT,
  flows INTEGER DEFAULT 0, note TEXT
);
CREATE TABLE IF NOT EXISTS traffic_flow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_key TEXT NOT NULL UNIQUE,             -- 幂等键：sha256(session|idx|method|url|started_at)
  session_id INTEGER,
  method TEXT NOT NULL, url TEXT NOT NULL, host TEXT, scheme TEXT, path TEXT,
  status INTEGER,
  req_headers TEXT,                          -- JSON 文本
  req_body TEXT, req_body_file TEXT, req_body_bytes INTEGER DEFAULT 0,
  req_body_sha256 TEXT, req_body_truncated INTEGER DEFAULT 0,
  resp_headers TEXT,
  resp_body TEXT, resp_body_file TEXT, resp_body_bytes INTEGER DEFAULT 0,
  resp_body_sha256 TEXT, resp_body_truncated INTEGER DEFAULT 0,
  resp_content_type TEXT,
  bytes INTEGER DEFAULT 0,
  started_at TEXT, finished_at TEXT, duration_ms INTEGER,
  tool TEXT, agent TEXT,
  asset_id INTEGER, vuln_id INTEGER, finding_id INTEGER, step_id INTEGER,
  /* 靶标归属（P3 隔离）：一条 flow 属于哪个靶标库、原始靶标名是什么。
     每靶标独立 .db，但 spool 落在共享根目录下，靠这两列 + spool 子目录的 owner.json 防串靶标。
     老库无此列，migrate() 补列后由 store-core 打开时整体回填为当前 id。 */
  engagement_id TEXT NOT NULL DEFAULT '',
  target TEXT NOT NULL DEFAULT '',
  source TEXT DEFAULT 'mitm', note TEXT, created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_traffic_flow_key ON traffic_flow(flow_key);
CREATE INDEX IF NOT EXISTS ix_traffic_host ON traffic_flow(host, started_at);
CREATE INDEX IF NOT EXISTS ix_traffic_vuln ON traffic_flow(vuln_id);
CREATE INDEX IF NOT EXISTS ix_traffic_finding ON traffic_flow(finding_id);
CREATE INDEX IF NOT EXISTS ix_traffic_session ON traffic_flow(session_id, id);
CREATE INDEX IF NOT EXISTS ix_traffic_started ON traffic_flow(started_at);
CREATE INDEX IF NOT EXISTS ix_traffic_status ON traffic_flow(status);
CREATE INDEX IF NOT EXISTS ix_traffic_session_status ON traffic_session(status, id);

/* ── 流量 ↔ 证据绑定（P3b）：一条 flow 可以挂到 finding / vuln / 步骤 / 资产上。
   为什么单独一张表而不是只写 traffic_flow 的列：录制是批量的、绑定是事后人工/智能体补挂的，
   同一 flow 可能同时是「某发现的证据」与「某步骤的原始请求」；多对多才不丢关系。
   traffic_flow 上的 finding_id/vuln_id/step_id/asset_id 仍同步写一份（最近一次绑定），
   让 traffic_search 能按 finding_id 直接过滤，而不必每条都 JOIN。 */
CREATE TABLE IF NOT EXISTS traffic_binding (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flow_id INTEGER NOT NULL,
  finding_id INTEGER, vuln_id INTEGER, step_id INTEGER, asset_id INTEGER,
  note TEXT, created_at TEXT,
  UNIQUE (flow_id, finding_id, vuln_id, step_id, asset_id)
);
CREATE INDEX IF NOT EXISTS ix_traffic_binding_flow ON traffic_binding(flow_id);
CREATE INDEX IF NOT EXISTS ix_traffic_binding_finding ON traffic_binding(finding_id);
CREATE INDEX IF NOT EXISTS ix_traffic_binding_vuln ON traffic_binding(vuln_id);

/* ── 审批门（P3c）：规则 + 待批队列。
   intercept_rule 是「靶标内补充规则」；全局规则在 <root>/intercept.json（人工/面板编辑），
   两源在 intercept.js 里合并匹配。规则匹配的是 HTTP 请求形状（method/host/path/风险标签），
   不是工具名 —— 代理看到的就是请求，工具层的门（withIntercept，P2 那条链）另算。
   risk_tags 同时是给人看的标签：请求侧带了 risk 标签时参与交集匹配，否则只作展示。 */
CREATE TABLE IF NOT EXISTS intercept_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_id TEXT NOT NULL UNIQUE,     -- 稳定标识（r-admin-path），文件规则与库规则同命名空间
  method TEXT,                      -- 'GET' / '*' / 具体方法（大写）
  host TEXT,                        -- glob，例如 *.example.com 或 '*'（统一小写比较）
  path TEXT,                        -- glob，对 pathname+search 匹配，例如 */admin*
  risk_tags TEXT,                   -- JSON 数组，例如 ["upload","exec"]
  effect TEXT DEFAULT 'require_approval',   -- require_approval | deny
  note TEXT,                        -- 面板上给人看的一句话
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_intercept_rule_enabled ON intercept_rule(enabled);

/* 每条被挡下的请求一行。pending_key = sha256(rule_id + method + url)：
   人放行后模型原样重试必须命中同一行，否则批一次重试一次又进一次队。 */
CREATE TABLE IF NOT EXISTS intercept_pending (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pending_key TEXT NOT NULL UNIQUE,
  rule_id TEXT, method TEXT, url TEXT, host TEXT, path TEXT,
  state TEXT DEFAULT 'pending',     -- pending | approved | rejected
  requested_by TEXT, requested_at TEXT,
  decided_by TEXT, decided_at TEXT, decision_reason TEXT,
  scope TEXT DEFAULT 'once',        -- once（一次性，用过即失效）| ttl（有效期内反复放行）
  expires_at TEXT,                  -- allow+ttlSeconds>0 时的有效期；NULL = 仅一次性
  consumed_at TEXT, decision_count INTEGER DEFAULT 0,
  flow_id INTEGER, session_id TEXT, risk_tags TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS ix_intercept_pending_state ON intercept_pending(state);
CREATE INDEX IF NOT EXISTS ix_intercept_pending_rule ON intercept_pending(rule_id);
CREATE INDEX IF NOT EXISTS ix_intercept_pending_flow ON intercept_pending(flow_id);

/* ---- ARTEX P4：报告批次 / 复测 / 调度（设计 §3，全部本机 SQLite） ---- */
CREATE TABLE IF NOT EXISTS report_run (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, path TEXT, sections TEXT, manifest TEXT,
  created_by TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS retest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vuln_id INTEGER, target TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  conclusion TEXT, reason TEXT,
  requested_by TEXT, requested_at TEXT, started_at TEXT, finished_at TEXT,
  evidence_ref TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS ix_retest_status ON retest(status);
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, run_at TEXT, params TEXT,
  status TEXT NOT NULL DEFAULT 'due',
  created_by TEXT, created_at TEXT, consumed_at TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS ix_schedule_status ON schedule(status);
`

/* ------------------------------------------------------------------ 知识库 schema */

export const KNOWLEDGE_DDL = `
CREATE TABLE IF NOT EXISTS poc (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,                -- 稳定标识（slug），智能体可直接引用
  title TEXT NOT NULL,
  kind TEXT,                         -- poc | exp | script | template | payload
  category TEXT,                     -- 归类：rce / deserialization / file-upload / sqli / unauthorized / auth-bypass / weak-password / ssrf / xxe / path-traversal / file-read / info-leak / privesc / tunnel / other
  cve TEXT,                          -- CVE / CNVD / 厂商编号
  component TEXT,                    -- 组件/产品（Weblogic、Shiro、泛微 OA…）
  versions TEXT,                     -- 影响版本
  severity TEXT,
  language TEXT,                     -- python | go | java | bash | http | nuclei | js | php
  source TEXT,                       -- web | self | manual | nuclei-template | kb
  source_url TEXT,
  description TEXT,
  usage TEXT,                        -- 用法/命令行示例
  content TEXT,                      -- 正文（脚本 / POC / 原始请求）
  path TEXT,                         -- 落盘位置（pocs/<code>/<file>），便于智能体直接 cat
  verified INTEGER DEFAULT 0,        -- 是否实测验证过
  verified_note TEXT,                -- 验证证据（哪台目标、什么回显）
  hit_count INTEGER DEFAULT 0,       -- 被复用次数
  used_on TEXT,                      -- 最近一次使用在哪个靶标/目标
  -- 来源溯源：这条知识是在哪个靶标、哪台资产上发现/验证出来的（建立时间看 created_at）
  engagement_id TEXT,
  engagement_name TEXT,
  asset_target TEXT,
  found_by_agent TEXT,
  tags TEXT,
  created_by TEXT, created_at TEXT, updated_at TEXT,
  UNIQUE(code)
);
CREATE INDEX IF NOT EXISTS ix_poc_cve ON poc(cve);
CREATE INDEX IF NOT EXISTS ix_poc_component ON poc(component);
CREATE INDEX IF NOT EXISTS ix_poc_kind ON poc(kind, verified);
/* 注意：归类 / 来源靶标两个索引**不能写在这里** —— 老 knowledge.db 的 poc 表还没有
   这两列，CREATE INDEX 会在 exec(DDL) 阶段直接抛
   "no such column: category"，连补列的迁移都跑不到。它们在 migrateKnowledge() 补完列之后再建。 */
`

/* ------------------------------------------------------------------ 知识库归类 */



/**
 * 知识库归类（与得分点/攻击面口径对齐）：智能体回填时必须选一个，
 * 面板按它分组，用户才能"一类一类看"而不是几百条平铺。
 */
const POC_CATEGORIES = [
  { code: 'rce', name: '远程命令执行', hint: '框架/中间件/组件 RCE、表达式注入、模板注入' },
  { code: 'deserialization', name: '反序列化', hint: 'Java/PHP/.NET 反序列化链、fastjson/jackson 等' },
  { code: 'file-upload', name: '文件上传 getshell', hint: '上传绕过、解析漏洞、二次渲染、竞争' },
  { code: 'sqli', name: 'SQL 注入', hint: '注入点验证、拖库、写文件、提权' },
  { code: 'unauthorized', name: '未授权访问', hint: '未鉴权接口/服务（Redis、Docker、Actuator、Swagger 调用）' },
  { code: 'auth-bypass', name: '认证绕过 / 越权', hint: '登录绕过、JWT 缺陷、越权读写、逻辑缺陷' },
  { code: 'weak-password', name: '弱口令 / 口令爆破', hint: '管理端弱口令、数据库弱口令、默认口令' },
  { code: 'ssrf', name: 'SSRF', hint: '服务端请求伪造、云元数据、内网探测跳板' },
  { code: 'xxe', name: 'XXE', hint: 'XML 外部实体读取与 SSRF' },
  { code: 'path-traversal', name: '目录穿越 / 任意文件读取', hint: '路径穿越、任意文件读、源码/配置读取' },
  { code: 'info-leak', name: '信息泄露', hint: '配置/凭据/源码/备份泄露（能升级为得分的那些）' },
  { code: 'privesc', name: '提权 / 横向', hint: '本地提权、凭据复用、Pass-the-Hash、横向工具' },
  { code: 'tunnel', name: '隧道 / 代理', hint: 'suo5、frp、chisel、Neo-ReGeorg、内网代理' },
  { code: 'other', name: '其它', hint: '不属于上面任何一类（写清用途）' },
]
export { POC_CATEGORIES }

/** 归类 code → 中文名（未知值原样返回，允许用户自定义）。 */
export function pocCategoryName(code) {
  const hit = POC_CATEGORIES.find((c) => c.code === String(code || ''))
  return hit ? hit.name : (code ? String(code) : '未归类')
}

/**
 * 老条目的归类推测（迁移时给 category 为空的条目打标）。
 * 依据是 code/title/component 里的关键词 —— 命中就归那一类，都不中才落 `other`。
 * 顺序即优先级：越具体的越靠前（例如"任意文件上传"要压过泛化的"上传"）。
 * 新写入的条目由 `redteam_poc_add` 的 `category` 参数决定，不走这里。
 */
export function guessPocCategory(text) {
  const t = String(text || '').toLowerCase()
  const has = (...words) => words.some((w) => t.includes(w))
  if (has('反序列化', 'deserial', 'shiro', 'fastjson', 'weblogic', 'log4j', 'jackson')) return 'deserialization'
  if (has('文件上传', 'file-upload', 'fileupload', 'upload', 'getshell', 'webshell', '写马')) return 'file-upload'
  if (has('sql 注入', 'sqli', 'sql注入', '注入拖库', 'union select')) return 'sqli'
  if (has('弱口令', '爆破', 'brute', '默认口令', '默认凭据', 'hydra')) return 'weak-password'
  if (has('隧道', 'socks', 'suo5', 'frp', 'chisel', 'regeorg', '代理')) return 'tunnel'
  if (has('未授权', 'unauth', '免认证', '免鉴权', '未鉴权', '无鉴权')) return 'unauthorized'
  if (has('越权', '认证绕过', '鉴权绕过', 'jwt', '逻辑漏洞', '验证码绕过', 'auth-bypass')) return 'auth-bypass'
  if (has('rce', '命令执行', '代码执行', '表达式注入', '模板注入', 'ssti', '命令注入', '远程执行')) return 'rce'
  if (has('ssrf', '服务端请求伪造')) return 'ssrf'
  if (has('xxe', '外部实体')) return 'xxe'
  if (has('任意文件读', '文件读取', '目录穿越', '路径穿越', 'path traversal', 'lfi', '任意文件下载')) return 'path-traversal'
  if (has('提权', '横向', 'pass-the-hash', 'mimikatz', 'impacket', '凭据复用')) return 'privesc'
  if (has('信息泄露', '配置泄露', '敏感信息', '源码泄露', '泄露', 'leak')) return 'info-leak'
  return 'other'
}

/* ------------------------------------------------------------------ 靶标库迁移 */

/**
 * 轻量迁移：给既有库补列。先查 PRAGMA 再 ADD COLUMN，重复执行安全。
 * 只在新增列时执行，因此老靶标库不需要重建。
 */
export function migrate(db) {
  const has = (table, column) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
    } catch {
      /* 读不到表结构必须返回 false（= "没有这一列"），让 ensure 去尝试 ALTER。
         返回 true 会让迁移被静默跳过，代码随后按新列写 SQL，故障表现为远端 SQL 报错
         而不是迁移失败。 */
      return false
    }
  }
  const ensure = (table, column, ddl) => {
    if (has(table, column)) return false
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`) } catch { /* 并发迁移时忽略 */ }
    return true
  }
  ensure('vuln', 'target', 'TEXT')
  ensure('vuln', 'found_by_agent', 'TEXT')
  ensure('vuln', 'found_at', 'TEXT')
  ensure('port', 'url', 'TEXT')
  ensure('port', 'title', 'TEXT')
  ensure('asset', 'test_status', "TEXT DEFAULT 'untested'")
  ensure('asset', 'test_notes', 'TEXT')
  ensure('asset', 'test_surface', 'TEXT')
  ensure('asset', 'test_updated_at', 'TEXT')
  ensure('asset', 'test_updated_by', 'TEXT')
  ensure('asset', 'blocked_count', 'INTEGER DEFAULT 0')
  ensure('asset', 'priority', 'TEXT')
  ensure('asset', 'potential', 'TEXT')
  ensure('asset', 'assess_reason', 'TEXT')
  ensure('asset', 'assessed_at', 'TEXT')
  ensure('asset', 'assessed_by', 'TEXT')
  /* 发现时间：本条资产**第一次进入本库**的时刻（不随重复采集刷新，便于"这条什么时候发现的"）。
     与 first_seen（数据源/工具给出的首次出现时间）不是一回事，两个都留。 */
  ensure('asset', 'discovered_at', 'TEXT')
  /* 产出这条记录的智能体角色（recon/assess/vuln-scan/exploit/internal），
     报告要写清"谁发现的、怎么拿到的" */
  ensure('vuln', 'agent', 'TEXT')
  ensure('credential', 'agent', 'TEXT')
  ensure('webshell', 'agent', 'TEXT')
  ensure('tunnel', 'agent', 'TEXT')
  /* 攻击步骤：用了什么工具/命令、由谁记录。报告里"隧道怎么搭的、马怎么上的"靠这三列说清 */
  ensure('attack_step', 'tool', 'TEXT')
  ensure('attack_step', 'agent', 'TEXT')
  ensure('attack_step', 'result', 'TEXT')
  /* 内外网维度：internal（内网/私网地址）| external（互联网可达）。手工指定优先于自动推导 */
  ensure('asset', 'scope', 'TEXT')
  /* 通过这个漏洞拿到了什么：账号权限 / 服务器权限 / 内网隧道 / 得分点等 */
  ensure('vuln', 'gained', 'TEXT')
  /* 凭据明文：面板要直接显示口令，不再只存引用（库在本机，禁止导出/提交） */
  ensure('credential', 'secret_value', 'TEXT')
  /* 得分点按《突破入侵类得分规则》重构（v0.11.0）：
     rule/tier/cap/dedup_scope 承载"规则号 + 档位 + 该规则上限 + 计分口径"。
     老库补列后由 seedScorePoints() 做一次性迁移（旧默认点转 legacy 停用，新增 25 条规则的得分点），
     用户自建的得分点与全部历史命中一律保留。 */
  ensure('score_point', 'rule', 'INTEGER')
  ensure('score_point', 'tier', 'TEXT')
  ensure('score_point', 'cap', 'INTEGER DEFAULT 0')
  ensure('score_point', 'dedup_scope', "TEXT DEFAULT 'service'")
  ensure('score_point', 'legacy', 'INTEGER DEFAULT 0')
  /* builtin：区分内置点与用户自建点（见 schema 注释）。
     老库先按 0 建列，再由 seedScorePoints 用 DEFAULT_SCORE_POINTS 的 code 名单回填。 */
  ensure('score_point', 'builtin', 'INTEGER DEFAULT 0')
  ensure('score_point', 'src', 'INTEGER')
  /* G5 / G6 倍率（老库补列，默认 1 = 不放大） */
  ensure('score_hit', 'multiplier', 'REAL DEFAULT 1')
  /* 每条命中自带分值（合并版把档位并进一条后必需，见 score_hit 建表注释） */
  ensure('score_hit', 'points', 'INTEGER')
  /* 得分类别不设数量上限（max_hits 列保留只为兼容老库结构，计分不再使用） */
  /* 得分 ↔ 漏洞/步骤 关联：报告取原始请求、流程图连线用 */
  ensure('score_hit', 'vuln_id', 'INTEGER')
  ensure('score_hit', 'step_id', 'INTEGER')
  ensure('attack_step', 'point_id', 'INTEGER')
  /* 攻击链已推倒重来：老的五阶段行整体作废，attck 列移除 */
  try {
    /* 注意：'target' 在新老两版里同名，必须按名称区分，否则第二次打开会把新版阶段删掉 */
    db.prepare("DELETE FROM stage WHERE code IN ('external','foothold','tunnel','privilege')").run()
    db.prepare("DELETE FROM stage WHERE code = 'target' AND name = '靶标系统权限'").run()
    db.prepare("DELETE FROM stage WHERE code NOT IN ('recon','internet','boundary','internal','target')").run()
  } catch { /* 表还不存在，忽略 */ }
  if (has('stage', 'attck')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN attck') } catch { /* 老 SQLite 不支持则保留 */ }
  }
  /* 攻击步骤上的阶段：老值是上一版的阶段 code，清掉以便按 legacy stage 重新映射。
     注意：'target' 在新版里仍是合法阶段（⑤ 靶标权限），不能一起清——否则每次打开
     靶标都会把「显式指定 ⑤」的步骤与得分打回自动推导。 */
  try {
    db.prepare("UPDATE attack_step SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run()
    db.prepare("UPDATE score_hit SET stage_code = NULL WHERE stage_code IN ('external','foothold','tunnel','privilege')").run()
  } catch { /* 忽略 */ }
  /* 阶段归属改为按每条得分自动推导，得分点上的 stage_code 已废弃 */
  if (has('score_point', 'stage_code')) {
    try { db.exec('ALTER TABLE score_point DROP COLUMN stage_code') } catch { /* 忽略 */ }
  }
  /* 蓝队视角已从作战阶段中移除：老库把这一列删掉（失败则忽略，不影响使用） */
  if (has('stage', 'blue_team')) {
    try { db.exec('ALTER TABLE stage DROP COLUMN blue_team') } catch { /* 老 SQLite 不支持则保留 */ }
  }
  /* 阶段归属：得分命中可显式覆盖（默认自动推导）；攻击步骤记录所属阶段 */
  ensure('score_hit', 'stage_code', 'TEXT')
  /* 自建账号标记：自己注册/自己创建的账号不算得分权限，只作过程记录（老数据默认 0） */
  ensure('score_hit', 'self_created', 'INTEGER DEFAULT 0')
  /* 得分落在哪个「服务」上：账号类得分按 (资产, 端口) 封顶，同一服务只算一次最高权限。
     端口在写入时解析（工具传的 port → target 里的端口 → 该资产唯一登记的端口）；老数据打开靶标时按 target 回填一次。 */
  ensure('score_hit', 'port', 'INTEGER')
  try {
    const p = db.prepare("SELECT COUNT(*) AS n FROM score_hit WHERE port IS NULL AND target IS NOT NULL AND target <> ''").get().n
    if (p > 0) {
      const upd = db.prepare('UPDATE score_hit SET port = ? WHERE id = ?')
      for (const row of db.prepare("SELECT id, target FROM score_hit WHERE port IS NULL AND target IS NOT NULL AND target <> ''").all()) {
        const port = parseTargetPort(row.target)
        if (port !== null) upd.run(port, row.id)
      }
    }
  } catch { /* 表还不存在，忽略 */ }
  /* 隧道入口归属：判断这条通道有没有真的跨越靶标边界（self-only 不算突破） */
  ensure('tunnel', 'entry_kind', 'TEXT')
  if (ensure('attack_step', 'stage_code', 'TEXT')) {
    try {
      const stmt = db.prepare('UPDATE attack_step SET stage_code = ? WHERE stage = ?')
      for (const [legacy, code] of Object.entries(LEGACY_STAGE_MAP)) stmt.run(code, legacy)
    } catch { /* 忽略 */ }
  }
  /* 老库回填：按 IP 归属自动区分内外网 */
  try {
    db.exec(`UPDATE asset SET scope = (${SCOPE_SQL}) WHERE scope IS NULL OR scope = ''`)
  } catch { /* 首次建库时表为空，忽略 */ }
  /* 老库回填发现时间：没有 discovered_at 的用 first_seen 顶上（总比空白好） */
  try {
    db.exec("UPDATE asset SET discovered_at = COALESCE(first_seen, last_seen) WHERE discovered_at IS NULL OR discovered_at = ''")
  } catch { /* 忽略 */ }
  /* 流量靶标归属（P3 隔离）：老库补 engagement_id/target 两列 + 建索引，
     不重建丢数据；历史行由 store-core 打开句柄时整体回填为当前 id。 */
  ensure('traffic_flow', 'engagement_id', "TEXT NOT NULL DEFAULT ''")
  ensure('traffic_flow', 'target', "TEXT NOT NULL DEFAULT ''")
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_traffic_engagement ON traffic_flow(engagement_id, id)') } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ 知识库迁移 */

/**
 * 知识库轻量迁移：给既有 knowledge.db 补列（归类 / 来源溯源）。
 * 与靶标库迁移同样先查 PRAGMA 再 ADD COLUMN，重复执行安全、老库不用重建。
 */
export function migrateKnowledge(db) {
  const has = (column) => {
    try {
      return db.prepare('PRAGMA table_info(poc)').all().some((row) => row.name === column)
    } catch { return true }
  }
  const ensure = (column, ddl) => {
    if (has(column)) return
    try { db.exec(`ALTER TABLE poc ADD COLUMN ${column} ${ddl}`) } catch { /* 并发迁移时忽略 */ }
  }
  ensure('category', 'TEXT')
  ensure('engagement_id', 'TEXT')
  ensure('engagement_name', 'TEXT')
  ensure('asset_target', 'TEXT')
  ensure('found_by_agent', 'TEXT')
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_poc_category ON poc(category)') } catch { /* 忽略 */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS ix_poc_engagement ON poc(engagement_id)') } catch { /* 忽略 */ }
  /* 老条目没有归类：按 code/标题/组件的关键词推一个（推测逻辑只有一份，见 guessPocCategory） */
  try {
    const rows = db.prepare("SELECT id, code, title, component FROM poc WHERE COALESCE(category, '') = ''").all()
    const upd = db.prepare('UPDATE poc SET category = ? WHERE id = ?')
    for (const row of rows) {
      upd.run(guessPocCategory([row.code, row.title, row.component].filter(Boolean).join(' ')), row.id)
    }
  } catch { /* 忽略 */ }
}
