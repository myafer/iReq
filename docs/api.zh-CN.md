# API（脚本化时可用）

[← 返回 README](../README.zh-CN.md) · [English](api.md)

控制台用的就是这套接口，脚本可以直接调。默认控制台在 `127.0.0.1:9091`、代理在 `9090`。
MCP 相关端点（`/mcp` 与 `/api/mcp*`）的用法见 [MCP 接入](mcp.zh-CN.md)。

```
GET    /api/status            含 lan: ["192.168.1.23"]、lanInfo: [{ip, iface}]、proxyPort、caTrust、caInfo、dataDir、safeMode
GET    /api/flows?q=&method=&status=error|ok|json&mocked=1&host=&ip=&app=&route=&limit=
GET    /api/flows/page?...      分页版：同上筛选 + cursor，回 { flows, nextCursor, hasMore, total, fromDisk }
                                内存翻完会自动接着读当天落盘文件（cursor 传回来即可，格式不透明）
  额外参数：
    body=1                      搜索范围扩到请求体 / 响应体（默认只搜 URL / 方法 / 状态 / 应用 / IP / 进程）
    q=body:关键词               等价于「只搜正文」，不需要 body=1
    sort=duration|size|status   排序（默认时间倒序）。排序结果一次给全：hasMore=false、nextCursor=""、
                                回包里带 sorted=true。磁盘阶段不支持排序（跨块排序得整份读进内存）
    dir=asc|desc                排序方向，默认 desc；缺值（进行中还没有耗时）永远沉底
GET    /api/breakpoints         断点配置与队列 { enabled, timeoutMs, rules, pending: [{id, phase, method, url, status, headers, bodyPreview, editable, at}] }
PUT    /api/breakpoints         { enabled, rules: [{id, phase: request|response|both, match, method}], timeoutMs? }
                                match 是 URL 包含匹配，含 * 当通配符，留空 = 全部；关掉 enabled 会立刻放行所有挂起项
GET    /api/breakpoints/:id     单条待处理（含 body 全文）
POST   /api/breakpoints/:id     放行：{ type:"resume", method?, url?, headers?, body?, status? }
                                或直接返回：{ type:"abort", status, statusText?, headers?, body? }
                                已经放行过的 id 回 404
POST   /api/breakpoints/release-all   全部原样放行
GET    /api/hostmap             域名映射 { enabled, rules: [{ id, from, to, enabled }] }
PUT    /api/hostmap             { enabled, rules } 整体替换并落盘（重启保留）
                                from 是原域名，可含 * 通配、可带路径前缀；to 是 host:port 或完整 URL
                                （写了 http:// 会把 https 降成明文，写了路径会替换前缀）
POST   /api/har?name=xxx        导入 HAR：请求体是文件原文（不是 JSON 包装），最多 64MB / 5000 条
                                回 { id, file, count, bytes, skipped, total, truncated, name }
                                导入结果直接成为一条历史记录（/api/history/:id 可回看 / 重放 / 导出）
GET    /api/flows/:id/body      正文原始字节：side=req|res（默认 res），dl=1 强制下载
                                图片 / 音视频内联（content-disposition: inline），其余一律 attachment；
                                content-type 缺失或写成 octet-stream 时按魔数纠正
GET    /api/history/:id/flows/:flowId/body   同上，读归档里的那条
GET    /api/history             历史记录列表 { items: [{id, name, file, count, bytes, createdAt}], stats }
PATCH  /api/history/:id         { name } 改名（去空白，最长 60 字）
DELETE /api/history/:id         删掉一条（文件也删）
DELETE /api/history             清空全部历史
GET    /api/history/:id/flows?...  回看：同上筛选 + cursor（字节游标），倒序分页
GET    /api/history/:id/export?format=har|json  导出整条历史（默认 HAR）
                                → 附件下载，带 X-Flow-Count / X-Export-Truncated；单次上限 5 万条
GET    /api/export/har?...      同上的筛选条件 → HAR 1.2 下载（带 Content-Disposition / X-Flow-Count）
GET    /api/export/json?...     同上的筛选条件 → 含 headers / body 的原始记录数组
GET    /api/facets              { flows, hosts, apps, devices, routes }
GET    /api/app-icons?names=A,B   按应用名批量找真实图标 → { "A": {url, bundle}, "B": null }
GET    /app-icon/<hash>.png      图标文件（仅 data/app-icons/ 里的 hash 文件名）
GET    /api/diagnostics         { tlsFailures: [{host, count, error, reason, detail}], tunneled, stats, passthrough }
DELETE /api/diagnostics         清空已记录的握手失败域名；带 ?host=xxx 只忽略这一个域名（含子域）
GET    /api/passthrough         跳过解密管理列表：{ rules: [{rule, source, addedAt, hits, lastHitAt, hosts}], totalHits }
POST   /api/passthrough         { rules: ["a.com", "*.b.com"], source } 追加（归一化去重、记来源、清诊断、切断存量解密连接）
PUT    /api/passthrough         { rules, source } 全量替换（改名 / 导入用）
DELETE /api/passthrough?rule=a.com  移除单条；不带参数 = 清空全部
GET    /api/system-proxy        本机系统代理状态 + 可复制的 on/off 命令 + caTrust/safeMode
POST   /api/system-proxy        { enabled: true|false, service? } 接管 / 释放
GET    /api/ca-trust            本机根证书信任状态 + 可复制的信任命令（带 30s 缓存，结果按指纹落盘）
POST   /api/ca-trust            { action: "check"|"install" } 重新检测 / 一键安装并信任（回读 verify-cert）
GET    /api/ca/archive           证书档案元信息（指纹 / 路径 / 来源）+ 钥匙串里遗留的旧 CA
GET    /api/ca/p12               导出 .p12 备份（含私钥，密码在 x-ireq-p12-password 响应头）
POST   /api/ca/import             { p12: "<base64>", password? } 导入 .p12 并重新检测信任
GET    /api/bookmarks           POST /api/bookmarks { label, filter }   DELETE /api/bookmarks/:id
GET    /api/flows/:id
DELETE /api/flows
POST   /api/flows/:id/replay      { method, url, headers, body }
GET    /api/rules
POST   /api/rules                 { name, method, urlMatch, matchMode, host, status, delayMs, headers, body }
PUT    /api/rules/:id
POST   /api/rules/reorder         { ids: [] }
DELETE /api/rules/:id
GET    /api/rules/tree            文件树（文件夹 / 规则 / 响应体三类节点，带 rootAbs）
GET    /api/rules/file?path=a/b.rule.json      读单个文件
PUT    /api/rules/file?path=a/b.body.json      { text } 或 { base64 } 写响应体
POST   /api/rules/fs              { type: 'dir'|'rule', dir, name }
POST   /api/rules/move            { from, toDir?, newName? }   只给 newName = 就地改名
POST   /api/rules/copy            { from, toDir, newName? }    规则连带响应体，换新 id
POST   /api/rules/reveal          { path, dryRun? }            在访达 / 资源管理器 / 文件管理器中显示
DELETE /api/rules/file?path=...    删除文件或文件夹（递归）
GET    /api/config  PUT /api/config   { capture, mockEnabled, h2Enabled, passthrough: [], mitmPorts: [443], maxFlows,
                                        processMap: true, uaAppMapText: "okhttp=我的App",
                                        networkSim: { enabled, latencyMs, kbps, timeoutMs, rules: [{match, mode}] } }
GET    /api/events                SSE：flow / flow-update / clear / tls-failure / tls-remove / tls-clear /
                                  network-sim / passthrough / rules-changed / history-changed
                                  （flow = 请求发起时的进行中占位记录；flow-update = 响应完成就地补完，
                                   以及本机进程名异步回填；clear = 列表与侧栏同步清空；
                                   tls-remove = 加入跳过解密 / 握手成功后撤掉已解决的诊断行；
                                   passthrough = 白名单变更，带最新规则与本次切断的连接数）
GET    /api/mcp                   MCP 状态 + 工具清单 + 令牌列表（只给掩码）+ 最近审计
PUT    /api/mcp                   { enabled } 开关（默认关）
POST   /api/mcp/tokens            { name, scopes: 'read'|'readwrite' } 生成令牌（明文只返回这一次）
DELETE /api/mcp/tokens/:id        撤销令牌（立即失效）
DELETE /api/mcp/audit             清空调用审计
POST   /mcp                       MCP 端点（JSON-RPC 2.0，需 Authorization: Bearer <令牌>）
GET    /ca.pem                    根证书（控制台与代理端口都提供）
GET    /ca.cer                    同一张根证书的 DER 版（iOS / Android 安装用）
```

例：从脚本里造一条 500 的 Mock

```bash
curl -X POST http://127.0.0.1:9091/api/rules -H 'content-type: application/json' -d '{
  "name": "服务端异常", "method": "GET", "urlMatch": "/api/v1/home", "status": 500,
  "headers": {"content-type":"application/json"}, "body": "{\"code\":500}"
}'
```
