<p align="center">
  <img src="docs/banner.svg" alt="mantis" width="720">
</p>

<h1 align="center">虫珀 · 拒斧（mantis）</h1>

<p align="center"><strong>1.0.10</strong> · 适配 DeepSeek Harness <strong>0.2.2-rc.1</strong>（桌面版 / 官方 <code>dsh web</code>）</p>

拒斧装在你自己的机器上，把 DeepSeek Harness 的提示词、审批、沙箱策略摊开，按需清洗、逐条回滚。只改本机 `@deepseek-ai` 包与本地配置，不碰远端。

## 功能

### 拒斧面板

会话标题旁的「拒斧」按钮打开右侧 dock，两页：

| 页面 | 做什么 |
|---|---|
| **清洗** | 分组显示补丁状态，应用 / 还原 / 卸载，编辑提示词，管理多套规则集 |
| **演练台** | 授权后使用本机资产与环境；本构建只允许本机实验网段，且不随包附带技能库与知识库 |

首次打开演练台要先读须知、等倒计时、读完并勾选三项；清洗不需要这一步。

![清洗页](docs/preview/dock-clean.png)

### 宿主清洗

- **默认文案与策略**：提示词、审批口径、沙箱边界、工具上限一并清洗，官方能力保留，不另造第二身份。
- **启动自检**：每次启动检查并复打；npm 覆盖 `node_modules` 之后不用手改文件。
- **逐条可控**：状态分「已应用 / 待清洗 / 漂移 / 不适用」，漂移项原样保留，不会被盲目改写。
- **只打本机**：目标只有本机已装的官方 `@deepseek-ai/*` 包与 `$DSH_HOME` 下的本地文件。

### 提示词与规则

每一轮的注入来源按顺序决定：

1. 规则库里启用的那一套（写入 `$DSH_HOME/prompt-inject.md`）；
2. 当前目录勾选的 `AGENTS.md` / `CLAUDE.md`；
3. 插件内置的默认提示词。

工作区基线还有 strict / fallback / always 三种取舍，控制是否丢掉宿主自带的 workspace 段落。

### 撤销

- 输入框的「撤销一次」「撤销上一轮」只作用于当前会话，不拉分支；被撤回的那一段重新回到输入框，改完再发。
- 命令面板里 `/mantis-rewind` 等价。

### 回滚与卸载

- 每个被改写的文件在第一次应用前都会留 `<文件>.mantis.bak`。
- **还原**把备份逐字节写回并删除备份；**卸载**先还原，再删注入文件、规则库与插件本体。
- 应用是幂等的，重复点不会叠加改动。

### 命令

```sh
mantis --status      # 逐条补丁状态
mantis --apply       # 应用
mantis --revert      # 还原
mantis --uninstall   # 卸载
mantis --edit        # 打开提示词

/mantis status | apply | revert | uninstall | edit | help
/mantis-rules list | use <id> | create <id> | delete <id> | reset
/mantis-rewind
```

### 边界

- 只面向本机：攻击类任务只允许 loopback 与 RFC1918，域名先解析再判 IP，`.lab` 这类后缀不算白名单。
- 本构建不含技能库与知识库；不提供公网扫描、第三方站点攻击载荷或游戏作弊相关能力。

## 安装

前置：Node.js ≥ 18；`dsh` 在 PATH 上；宿主是 **0.2.2-rc.1**。本版不再承诺 0.2.1 及更早版本。

安装和「应用」是两件事：装完只是让宿主认识这个插件，**应用**才真正改写宿主文件。

### 1. 装进 profile

在仓库目录执行（`desktop` 换成 `web` 就是官方 `dsh web`）：

```powershell
dsh plugin --profile desktop add .
```

或者先打包再装：

```powershell
npm pack
dsh plugin --profile desktop add .\zhuifengqug-dsh-mantis-1.0.10.tgz
```

这一步会做两件事：把包写进该 profile 的 `dependencies`，并把 `@zhuifengqug/dsh-mantis` 追加到 `dsh.profile.bundles`。**只加依赖、不加 bundles，宿主不会加载插件面板。**

手工等价（`$DSH_HOME/profiles/desktop/package.json`，改前先备份）：

```json
{
  "dependencies": {
    "@zhuifengqug/dsh-mantis": "link:D:/path/to/dsh-mantis"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...保留原有项...",
        "@zhuifengqug/dsh-mantis"
      ]
    }
  }
}
```

改完在该 profile 目录跑一次 `pnpm install`，确认 `node_modules/@zhuifengqug/dsh-mantis/package.json` 存在。

### 2. 完全退出并重开宿主

桌面版连托盘一起退，再打开 exe；`dsh web` 停掉进程重新起。只重开窗口不算。

### 3. 应用

打开宿主 → 会话标题旁点「拒斧」→ **清洗** → **应用**。成功后宿主会重启一次；没跑完不会重启。

也可以直接用命令行：

```powershell
node bin\mantis.js --apply
```

### 4. 验证

```powershell
node bin\mantis.js --status
```

或聊天里发 `/mantis status`。输出会打印 `DSH_HOME`、宿主版本和逐条状态；`liangshen` 这类没装的第三方预设显示为 skipped，不阻塞应用。

本机若装了多个 dsh（例如 npx 缓存里的旧包），`--status` 可能选错安装。用环境变量钉死目标：

```powershell
$env:DSH_BASE = "D:\Deepseek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai"
```

桌面版是密封的 `app.asar` 时，状态里的部分条目会显示为缺失——归档内文件无法就地改写，需要先按官方流程解包到 `resources/app` 再应用。

### 卸载

面板 → 清洗 → **卸载**；或 `node bin\mantis.js --uninstall`。会先还原补丁再删插件本体，并把仍指向 `redteam` 预设的默认项改回 `standard`。
