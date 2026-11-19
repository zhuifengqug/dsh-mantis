---
name: asset-deep-scan
description: 单资产深挖：对一个资产逐项完成 surface / web / auth / cve / app 五项检查，产出候选漏洞与未验证假设，避免批量扫描漏细节
whenToUse: 主会话按单个资产派发漏洞发现任务，或需要把“扫过一批”变成“看透一个资产”时
role: vuln-scan
enabled: true
---

# 单资产深挖

> 一次只负责一个资产。批量 nuclei/ffuf 只产生候选；本技能要求把五项检查逐项做完并落库，否则不许收口。
> 本地适配：上游的 `redteam_asset op=coverage/close` 与 `redteam_asset_next` 队列在本机不存在，用 `redteam_asset_get`（读当前面）+ `redteam_asset_test`（写 `surface`/`status`）+ `redteam_unknown_record`（未验证假设）替代。

## 0. 建包

`text
redteam_asset_get asset_id=<id>
redteam_asset_test asset_id=<id> status=testing test="开始五项深挖"
`

先看资产端口/服务/版本/URL/标题/测试状态与 `surface`（还剩什么面）。缺什么补什么。

## 1. surface（端口/服务/版本/指纹）

- 端口、协议、服务、产品、版本、banner、URL、标题；
- 指纹：框架/CMS/中间件/开发语言/云组件；
- 已知组件版本 → 对应 CVE/POC；版本不明就记录“无法确认”，不要猜。

完成后：`redteam_asset_test asset_id=<id> surface="web/auth/cve/app 待做" test="surface 完成：<结论>"`

## 2. web（路径/接口/前端）

- 根路径、robots/sitemap、登录/注册/上传/导出/报表；
- JS 里的 API、Swagger/OpenAPI、GraphQL、actuator、druid；
- 参数与对象：`id/userId/tenantId/orderId`、`pageSize`、`export`；
- 目录爆破只做小字典定点，不跑大字典刷时间。

完成后把 `surface` 里的 web 项划掉；没有 Web 服务则在 `test` 里写 `web=not_applicable`。

## 3. auth（认证面）

- 未授权访问：不带 token/过期 token/低权限 token；
- 默认口令、弱口令（严格限流，不盲爆破）；
- 已有凭据复用；**登录成功才** `redteam_access_add`（host/username/method），拿到 `id` 后账号类计分必须带 `access_id`；
- 越权：普通账号访问管理员接口、替换租户/用户 id。

完成后同上；被锁/被封 `redteam_asset_test status=blocked blocked=true` 并写原因。

## 4. cve（已知漏洞）

- 按组件/版本查 `redteam_poc_search`，优先 P0 RCE/上传/反序列化；
- 用最小验证确认，不直接上破坏性 payload；
- 命中写 `redteam_vuln_add`（status=candidate/confirmed，带 request/response；批量用 `redteam_batch kind=vulns` 自动存 HTTP 证据）；
- 不确认的写 `redteam_unknown_record`（question 写清“还缺什么验证”），不要写成 confirmed。

完成后把 `surface` 里的 cve 项划掉。

## 5. app（业务逻辑/数据接口）

- 上传/下载/导出/批量查询/分页上限；
- IDOR/越权/批量赋值/金额/订单/审批绕过；
- 数据接口字段、条数、是否含三要素；达到 P1（三要素 ≥1 万条）用 `redteam_data_proof op=add` 记字段/条数/样本/接口；
- 只取证明所需样本，不拖全库。

完成后同上；无业务面写 `app=not_applicable`。

## 6. 候选与交接

每个候选写：

`text
redteam_vuln_add {
  asset_id, title, severity, target, evidence,
  status: candidate|confirmed,
  request, response
}
`

- 候选要写“还缺什么验证”，不要为了速度把 candidate 当 confirmed；
- 发现需要利用链/凭据/隧道才能验证，用 `redteam_chain_add stage=exploit` 留痕并交接给 `exploit` 角色；
- 利用失败时反向要求补 web/auth/app 某项，不要直接换资产。

## 7. 收口

五项都在 `test` 里写明 `done / blocked / not_applicable` 后，调 `redteam_asset_test asset_id=<id> status=tested test="五项收口：…"`。

`redteam_asset_test` 只在 `surface` 为空且 `status` 已写时才代表这个资产看完；`redteam_unknown_list` 里还有 open 项就先解决或写清卡点。只剩不可测面时 status 写 `no_surface`。

## 纪律

- 一次只做一个资产；不要在同一任务里批量扫几十个资产；
- 不写“XX红队测试”、队伍标识、假身份、XSS/弹窗/留言等无法获得权限的数据；
- 不把“扫过”当“看透”；没有证据的候选标 candidate；
- 不删除/加密/重启/批量改密/清日志。
