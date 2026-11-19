# MCP 接入（给 AI 客户端用）

[← 返回 README](../README.zh-CN.md) · [English](mcp.md)

iReq 本身可以当一个 **MCP（Model Context Protocol）服务**：AI 客户端能读抓到的流量、按流量生成 Mock、改弱网参数，
不用你手动点界面。**默认关闭，而且开了也必须带令牌**——本地端口不设防的话，任何本机进程（包括网页里的脚本）
都能翻你的抓包内容。

**第一步：开开关、拿令牌**

控制台 →「设置 › MCP 接入」→ 打开「允许 AI 客户端接入」→ 填个名字（如「我的 AI 助手」）→ 选权限 → 生成令牌。
令牌形如 `ireq_mcp_xxxxxxxx`，**只显示一次**，落盘只存 sha256 哈希，撤销后立即失效。

**第二步：二选一接进去**

支持 Streamable HTTP 的客户端直接配（地址就在面板里）：

```json
{
  "mcpServers": {
    "ireq": {
      "type": "http",
      "url": "http://127.0.0.1:9091/mcp",
      "headers": { "Authorization": "Bearer ireq_mcp_xxxxxxxx" }
    }
  }
}
```

只支持 stdio 的客户端用自带桥（它把 stdio 上的 JSON-RPC 原样转发到上面的端点，令牌照样要带）：

```json
{
  "mcpServers": {
    "ireq": { "command": "ireq", "args": ["mcp", "--url", "http://127.0.0.1:9091/mcp", "--token", "ireq_mcp_xxxxxxxx"] }
  }
}
```

令牌也可以放环境变量 `IREQ_MCP_TOKEN`，省得写在配置里。

**权限分两档**

| 令牌 | 能做什么 |
| --- | --- |
| 只读 `read` | 看状态、查流量、读详情、列规则、读配置 |
| 读写 `readwrite` | 以上全部 + 建 / 改 / 删规则、由流量生成 Mock、重放、清空列表、改弱网 / 跳过解密、断点、脚本、告警、域名映射、脱敏、派生列、标注 |

只读令牌连 `tools/list` 都看不到写工具，调用会被 JSON-RPC 拒（`-32003`）。

**工具清单**

| 工具 | 作用 |
| --- | --- |
| `ireq_status` | 代理 / 控制台端口、局域网地址、流量与规则数量、证书信任、安全模式 |
| `list_hosts` | 先看清全局：域名 / 应用 / 设备 / 接口各有多少条，按条数排序 |
| `list_flows` / `get_flow` | 按域名、应用、设备 IP、接口、方法、状态码、关键词、时间窗筛流量；按 id 读完整请求响应与正文 |
| `list_rules` / `get_rule` | 列规则（可按文件夹）、按 id 或路径读单条规则含响应体 |
| `get_settings` | 抓包开关、解密端口、白名单、UA 别名、弱网参数 |
| `create_rule` / `update_rule` / `delete_rule` | 增删改 Mock 规则（匹配方式 contains / wildcard / regex） |
| `mock_flow` | 拿一条真实请求当模板直接生成 Mock（等于界面里的「Mock 此请求」） |
| `replay_flow` | 改 URL / 方法 / 头 / 体重放，结果作为新流量入库 |
| `set_network_sim` | 开弱网、断网、超时，按应用 / 域名 / IP 加规则 |
| `set_passthrough` | 读 / 改「跳过解密的域名」（界面上已改为握手连续失败自动跳过，这个工具留给 AI 做批量调整与善后） |
| `clear_flows` | 清空内存里的流量列表 |
| `perf_summary` | 按接口 / 域名聚合 P50 / P95 / 平均 / 最大 / 错误率 / 传输量 + 最慢请求 |
| `list_breakpoints` / `set_breakpoints` | 读 / 写断点规则（URL 包含、方法、阶段、超时）；命中会挂起等人放行 |
| `list_scripts` / `save_scripts` | 读 / 写沙箱脚本规则（`onRequest` / `onResponse`），保存前逐条编译，语法错不落盘 |
| `list_alerts` / `set_alerts` | 读 / 写条件告警（状态码 / 域名 / URL / 正文 / 耗时组合匹配，带冷却与限速） |
| `get_hostmap` / `set_hostmap` | 读 / 写域名映射：只改「连哪台机器」，URL / Host / 证书仍是原域名 |
| `get_redact` / `set_redact` | 读 / 写脱敏开关（只作用于导出、MCP 输出与 `redact=1`，界面永远原值） |
| `get_columns` / `set_columns` | 读 / 写派生列（把响应字段提成列表一列，最多 4 列，改完立即重算） |
| `annotate_flow` | 给某条请求加备注 / 颜色 / 重点标记（合并语义，三个字段都空等于清掉） |

流量攒到几千条时，别让 AI 从第一页开始翻。推荐两步：

1. `list_hosts`（可加 `app` / `ip` / `since_seconds` 收窄）拿到域名、应用、设备、接口各自的条数；
2. 挑中之后再 `list_flows` 精确筛：`host`（域名）、`app`（应用，逗号分隔多个）、`ip`（客户端 IP，`local` 表示本机）、`route`（接口，如 `GET /api/user`）、`method`、`status`（`2xx` / `404` / `error` / `json` 等）、`query`（关键词）、`since_seconds`（最近 N 秒，`0` 不限）、`only_mocked`。

`list_flows` 会同时返回 `total`（匹配总数）与 `returned`（本次返回条数）；`has_more: true` 说明还有更多，要么缩小条件、要么把 `limit` 调大（上限 200）。

**安全上做了这些**

- 令牌明文只出现一次；`config.json`、`/api/config`、`/api/mcp` 都拿不到哈希以外的凭据
- 校验用常量时间比较；令牌无效 / 已撤销 / 过期一律同一个 401，不给出区分线索
- 每个令牌 60 秒最多 240 次调用，超了 429
- 带 `Origin` 且不是本机地址的请求直接 403（防 DNS rebinding 借浏览器打本地端口）
- 每次调用（含失败的）都进审计，面板里能看到时间、令牌、工具名、耗时
- 关闭 MCP 后 `/mcp` 立刻 403，所有令牌一起失效
