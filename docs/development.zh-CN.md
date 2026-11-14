# 开发与实现细节

[← 返回 README](../README.zh-CN.md) · [English](development.md)

## 目录结构

```
bin/iReq.js      CLI 入口 / 参数解析 / 启动横幅
src/ca.js           根证书档案（指纹校验 / 迁移 / .p12 导入导出）与按域名签发叶子证书（node-forge）
src/ca-dirs.js      固定 CA 目录 ~/.ireq/ca 与旧版候选目录解析
src/ca-trust.js     macOS 信任状态检测 / 结果落盘 / 一键安装（verify-cert / 钥匙串）
src/proxy.js        MITM 核心：CONNECT、TLS 握手、转发、录制、Mock 响应
src/derive.js       从 UA / 路径派生 设备、应用、接口结构；UA 别名与源端口提取
src/process-map.js  macOS：TCP 源端口 → PID → 真实应用名（lsof 快照 + 缓存）
src/app-icon.js     macOS：应用名 → .app → 真实图标 PNG（plutil + sips，缓存 + 路径白名单）
src/local-address.js 本机地址归一（回环 / ::ffff: / 所有网卡 IP → local）
src/bookmarks.js    收藏（书签）存储（data/bookmarks.json）
src/rules.js        Mock 规则匹配引擎（data/rules/**/*.rule.json + *.body.*）
src/network-sim.js  网络模拟：规则归一化 / 匹配 + 按字节率限速的 Transform 流
src/store.js        流量存储（内存环形 + JSONL 落盘 + SSE 事件）
src/replay.js       重放
src/server.js       REST API + 静态页面
src/system-proxy.js 本机系统代理接管（状态/开关/备份恢复，macOS networksetup）
public/             控制台（原生 JS，无框架）；app-icons.js 内置 SVG 图标 + 真实图标回填
tools/              开发自检脚本（_seed.js 负责造测试流量，见[开发自检](#开发自检)）
```

## 应用名是怎么来的

早期「应用」一列只靠 User-Agent 猜：UA 是 `demo-app/2.0.0 (iPhone; iOS 17.0)` 还看得懂，
换成 `okhttp/4.9`、`CFNetwork` 这类通用库就只剩「OkHttp 4」，看着像没识别到。现在按三种来源依次取：

| 来源 | 适用范围 | 结果 | 标记 |
| --- | --- | --- | --- |
| **本机真实进程** | macOS 上从本机发起的连接 | `Google Chrome` / `DingTalk` / `汽水音乐` / `curl`，与 UA 无关 | 侧栏绿点，详情显示 PID + 可执行路径 |
| **UA 别名** | 手机等远程设备、或关掉进程识别时 | 用户自己写的业务名，如 `我的App` | 侧栏黄点 |
| **UA 推断** | 兜底 | `demo-app 2.0.0`、`OkHttp 4` | 无点 |

本机那条是核心：连接的另一端就在同一台机器上，`lsof -nP -iTCP -F pcn` 能按客户端 **TCP 源端口**
查到 PID 和进程名，再从可执行文件里取 `.app` 名（Chrome Helper / WebKit.WebContent 会归到主应用）。
HTTPS 解密后 `req.socket` 变成 `TLSSocket`，所以 CONNECT 时把原始 socket 的端口记下来一路传递。
只有 `clientIp` 是回环地址时才做关联，**手机流量绝不会被误标成本机的 App**。

`lsof` 快照是异步的（约 40–60ms）：第一条请求可能先显示 UA 推断的名字，几十毫秒后通过 SSE
`flow-update` 自动换成真实进程名；回填会追加一条轻量 JSONL patch，重启后不会退化成「OkHttp 4」。

**手机为什么还是没有 App 名？** HTTP 代理只看得到设备 IP，拿不到对端的进程/包名，这是协议层面的限制
（其他桌面代理在手机代理模式下同样只能靠 UA，或靠设备端 VPN 配合）。解决办法是在
**设置 › 应用识别 › UA → 应用名** 里写映射，每行一条：

```
demo-app/2.0=我的App
okhttp=示例 App
CFNetwork=我的 iOS 客户端
```

关键词按子串匹配（不区分大小写），别名优先于内置推断，只对新抓到的请求生效。
不想查本机进程也可以在同一面板取消勾选「识别本机真实进程」，等价于
`PUT /api/config {"processMap": false}`。非 macOS 系统不提供进程关联，只走 UA 推断 + 别名。

## 应用图标是怎么来的

侧栏「应用」每一项、请求列表第二行、详情「应用 / 设备」行都会带图标，按三层依次兜底：

| 层级 | 来源 | 例子 |
| --- | --- | --- |
| **真实 App 图标** | macOS 上按应用名找到 `.app`，读 `Info.plist` 的图标文件，用系统自带 `plutil` + `sips` 转成 128px PNG，缓存在 `data/app-icons/` | Chrome、微信、钉钉、Safari、VS Code、Playwright 的 Chrome for Testing |
| **内置 SVG** | 前端自带常见应用 / 平台图标，纯本地、离线可用 | Chrome、Firefox、Safari、Edge、微信、企业微信、钉钉、Postman、Figma、Flutter、OkHttp、Alamofire、CFNetwork、curl、Node、iOS / Android / Windows… |
| **默认图标** | 其它所有名字：主题中性色的首字母色块（浅灰底深灰字 / 深灰底浅灰字，深浅主题自适应，不再随机彩色） | `demo-app 2.0.0`、`reader 3.2.1`，以及手机 App 拿不到包名时 |

- 图标走 `GET /api/app-icons?names=A,B` 批量解析，只转一次（缓存文件按 bundle 路径哈希，同一 App 的不同名字复用一张图），
  生成的文件由 `/app-icon/<hash>.png` 提供，文件名有白名单校验，不接受路径穿越。
- 不在 `/Applications` 标准目录里的 App（例如 Playwright 自带浏览器），会从流量里记录的**可执行文件路径**补登记；
  异步识别晚于首屏时，前端每 12 秒自动重试最多 3 次，图标会从默认图自动换成真实图。
- **选中 / 筛选时图标不闪动**：真实图标的 URL 一旦解析过，后续渲染（点击选中、侧栏筛选、SSE 重绘）
  都在生成 DOM 时直接内联 `<img>`，不存在「先色块、再换真图」的两段式替换。
- 设备分组也带图标：本机用电脑、手机用手机、其它 IP 用地球，底色统一走主题中性色（`--ic-device`），
  形状区分设备类型；应用名来源（本机进程 / UA 别名 / UA 推断）悬停侧栏条目即可看到。
- 非 macOS、命令行工具、手机 App 都拿不到本机图标，自动落到内置 / 默认图标，**不会显示破图**；
  真实图片加载失败也会退回原图。鼠标悬停图标可看到它是「本机应用图标」还是「默认图标」。

## 一些设计取舍

- **抓包开关与 Mock 解耦**：关掉「抓包」只是不记录，规则照样生效，方便只看行为不看日志。
- **Body 上限 2MB**：超出截断并打标，避免一条大文件响应把内存吃穿。
- **上游证书默认不校验**（`rejectUnauthorized: false`）：企业代理、自签名测试环境能直接抓，代价是工具本身不能当作安全边界。
- **HTTP/2 按协商支持**：解密隧道走 `http2.createSecureServer`，客户端提 h2 就按 h2 解密（多路复用逐条记录、伪首部与连接级头剥除、Mock / 断网 / 弱网逐 stream 生效），只提 h2 的端点不再握手失败；上游始终按 HTTP/1.1 转发（明文边界清晰）。设置里可关闭退回纯 1.1。扩展 CONNECT（h2 上的 WebSocket）暂不支持，h2 客户端会自动退回 1.1 升级。
- **只解密 443（可配）**：其它端口走裸隧道。把非 HTTP 协议（MQTT 8883、IMAP 993…）也解密会让 App 直接连不上，这是"别的工具能用、iReq 不能用"的典型原因。
- **请求体流式转发**：边收边转，8MB chunked 上传也不会卡住；同时旁路记录（最多 2MB）。
- **保活 65s**：Node 默认 5s，App 复用连接时容易撞上刚被关掉的 socket，表现为"偶发连不上"。
- **自环保护**：目标地址若指向代理自己，`GET /`、`/ca.pem`、`/ca.cer` 会作为本机安装页应答；
  其它请求返回 `508 Loop Detected`，防止无限自我转发。用 `https://` 打开代理端口会明确回 403 并提示改用 `http://`。
- **WebSocket**：识别并记录建连，帧内容做裸隧道透传，不解密。
- **默认只监听本机控制台**（127.0.0.1），代理监听 0.0.0.0 以便手机连。控制台无鉴权，公用网络下别改成 0.0.0.0。
- **清空 = 留一条历史记录**：点「清空」不只清内存，还会把当天的 `flows-YYYY-MM-DD.jsonl` 改名为
  `.cleared-<时间戳>`，同时往 `data/history.json` 里登记一条（默认名是清空时刻）。否则重启时恢复
  历史会把刚清掉的记录全部「复活」。
  - **这些归档不自动删**：它们就是界面上「历史记录」里的条目，删不删由用户决定，自动清理等于
    把用户看得到的东西悄悄抹掉。磁盘占用在侧栏分组底部和设置页都能看到。
  - **回看是从文件尾部倒序分块读**（64KB 一块）：归档能到几百 MB，整份读进内存再切片，
    点一次卡一次。游标是字节偏移，不是行号 —— 行号得从头数，越往后越慢。
  - 条数在第一次打开这条记录时整份数一遍（带当前筛选条件），结果写回索引，之后不再重复扫。
  - **导出**走 `GET /api/history/:id/export`（默认 HAR，`format=json` 给原始记录）：同样是倒序读、
    按 id 去重取最终状态，再用 `toHar` 转 HAR 1.2。HAR 是一个 JSON 对象只能整体序列化，所以
    单次封顶 5 万条，超了置 `X-Export-Truncated: 1`；文件名用记录名（中文走 RFC 5987 `filename*`）。
- **日文件才有封顶**：`flows-YYYY-MM-DD.jsonl` 没人看得到，留最近 7 份、总量 ≤ 200MB，
  超出从最旧删（启动时也会检查）。不封顶的话一天几百 MB，一周就是 GB 级。
  设置 › 高级设置里能看到 data 目录当前占用与文件数。
- **接管本机系统代理，退出必须精确还原**：只把代理 state 置 off 是不够的，macOS 关闭态下仍会保留
  `Server/Port`，以及我们加的绕过域名 —— 用户下次手动开代理就会连到已经停掉的 iReq。
  所以开启前把完整快照存盘，释放时连 host/port、绕过域名一起写回；`localhost / 127.0.0.1 / ::1 / *.local`
  必须绕过，否则控制台自己的请求会绕回代理形成自环。

## 开发自检

服务起来后（`node bin/ireq.js start`）可直接跑。UI 类脚本都通过 `tools/_seed.js` 自己经代理造测试流量，
不依赖控制台里恰好有数据，脚本末尾会打印逐条 ✅/❌。

`npm run check` 会顺序跑只读类自检并汇总。所有脚本统一从 `tools/_env.js` 取地址，
用 `REQLITE_UI_PORT=9294 REQLITE_PROXY_PORT=9293 npm run check` 指向指定实例
（默认 9091 / 9090），避免连到旧服务「假绿」。

```bash
npm run check                   # 一键汇总（不含会改动 macOS 系统代理的脚本）
node tools/check-repo-meta.js    # 仓库元数据：issue 模板结构 / 空白 issue 关闭 / 分流 workflow 只拿 issues 权限（22 项，无需服务）
node tools/check-onboard.js       # 首启引导：只弹一次 / 三步内容 / 反馈入口 / 关闭后落盘（16 项，自起临时实例）
node tools/check-i18n.js        # 英文字典：孤儿键 / 未覆盖中文文案（无需服务）
node tools/check-store.js        # 落盘 / 重启恢复 / 清空不复活（纯单元，用临时目录）
node tools/check-proxy.js        # 明文转发、非 443 透传、8MB 流式上传、保活复用、MITM、证书固定诊断、抓包开关
node tools/check-dom.js          # 静态检查 app.js 引用的 #id 是否都存在
node tools/check-empty-state.js  # 空状态显隐、列表/详情字号、表头对齐
node tools/check-scale.js        # 85%–160% 缩放、上下限、刷新保持、裁切与溢出
node tools/check-sidebar.js      # 五组边栏、筛选、收藏书签、折叠、窄屏抽屉
node tools/check-app-cascade.js  # 应用勾选式多选（绿色对钩）：域名 / 接口结构级联 / 上方分组收起 / 老书签归一（27 项）
node tools/check-instant.js      # 请求发起即入库 / 侧栏同步、完成就地更新、清空同帧归零、在途不复活（36 项）
node tools/check-http2.js        # h2 协商 / 多路复用逐条入库 / 伪首部剥离 / Mock·断网·弱网 / 筛选 / 详情协议版本 / 关闭回退（22 项）
node tools/check-splitters.js    # 两根竖分割线：拖拽 / 命中区 / 夹紧 / 持久化 / 复位 / 键盘（30 项）
node tools/check-device.js       # 127 + 本机网卡 IP 合并成「本机」/ 标签不闪跳 / 筛选与详情一致（40 项）
node tools/check-mock-editor.js  # Monaco 加载 / JSON worker 校验 / 富版规则表单 / 真实 Mock 命中 / 导入导出 / 详情着色（83 项）
node tools/check-rule-workspace.js # 活动栏 / 资源管理器 / 多标签 / 未保存快照 / 快捷键 / 面包屑 / 状态栏 / 英文界面（28 项）
node tools/check-ca-persist.js   # CA 档案自愈 / 旧目录迁移 / .p12 往返 / 一键安装命令 / 状态落盘 / 盾牌 UI（57 项）
node tools/check-dock.js         # 控制坞：Mock 总开关端到端旁路 / 徽章口径 / 暂停联动 / 右键直达 / 英文界面（28 项）
node tools/check-filterbar.js    # 筛选条：matchStatus 语义 / 12 种内容类型真实流量过筛选 / UI 单选与行数一致 / 更多菜单不被裁剪 / 英文界面（62 项）
node tools/check-scrollbar.js    # 深浅色滚动条（白条回归）
node tools/verify-ui.js          # 顶栏按钮 / 弹窗 / 连接向导地址
node tools/check-local-proxy.js  # 系统代理开启/恢复往返（scutil 验证真的生效）
node tools/check-local-ui.js     # 控制台「本机抓包」按钮点击往返
node tools/check-local-traffic.js# 端到端：本机浏览器请求真的进列表（clientIp=127.0.0.1）
node tools/check-app-name.js     # 本机真实进程名 / HTTPS 解密 / UA 别名 / 远程不误标 / 异步回填
node tools/check-app-icon.js     # 本机 .app 图标提取 / PNG 缓存 / API / 三层兜底 / 渲染 / 选中不闪动（56 项）
node tools/check-ca-trust.js     # 信任检测 / 安全模式分支 / 透传留痕 / 引导 UI（42 项）
node tools/check-address.js      # 顶栏默认局域网 IP / 三种复制 / 切换持久化 / 各处同步 / 深色与窄屏（35 项）
node tools/check-tls-list.js     # 握手失败进主列表：SSE 实时 / 聚合 / 筛选 / 一键透传后消失 / 英文模式（19 项）
node tools/check-tls-clear.js    # 处理后立即清除：子域规则级联 / 配置手填 / ✕ 忽略 / 不复活 / SSE 同步（30 项）
node tools/check-passthrough-manager.js # 跳过解密管理列表：归一化 / 分类 / 持久化 / 命中统计 / 存量连接切断 / UI / 英文模式（49 项）
node tools/check-network-sim.js  # HTTP/CONNECT 断网 / 弱网 / 超时、规则匹配、面板、侧栏模式切换、SSE、英文模式（33 项）
node tools/check-net-live.js     # 一键断网/弱网真生效 + 规则变更切断存量隧道 + 不误伤 + 状态条（23 项）
node tools/check-simple-ui.js    # 顶栏更多 / 筛选更多 / 连接向导 / 快速 Mock / ⌘K 命令面板 / 就近菜单（26 项）
node tools/check-tree-fs.js     # 文件树当文件管理器：行内新建 / 双击改名 / 复制粘贴 / 绝对路径 / reveal（28 项）
node tools/check-mcp.js         # MCP：未开启 403 / 令牌只存哈希 / 协议握手 / 15 个工具 / 筛选与聚合 / scope / 撤销 / Origin / stdio 桥（84 项）
node tools/check-history.js     # 历史记录与分页：游标翻页 / 内存见底续读磁盘 / 清空留档 / 回看 / 改名 / 导出 / 删除（50 项）
node tools/check-search.js      # 正文搜索与排序：默认不搜 body / body: 前缀 / 大小写 / 正则元字符 / 四列升降序 / 缺值沉底（22 项）
node tools/check-breakpoint.js  # 断点拦截：请求与响应挂起 / 改体改址改码 / 长度重算 / 超时放行 / 大包放弃 / SSE（32 项）
```

`check-proxy.js` 会临时改 `passthrough` / `mitmPorts` 并自行还原；`check-empty-state.js` 会执行一次清空；
`check-app-name.js` 会临时关掉进程识别并写入一条 UA 别名，finally 里还原。
`check-ca-trust.js` 不改系统设置、不动真实 `data/`：临时目录里另起一个独立代理验证安全模式。
`check-address.js` 只读服务端状态，空状态用页面内存里的 `S.flows` 临时触发，不改真实流量数据。
`check-splitters.js` 只改浏览器 localStorage（独立 context，不污染你自己的控制台设置），不动代理状态。
`check-device.js` 会用本机网卡 IP 作为 TCP 源地址打一条真实请求，另外单元部分用临时目录。
`check-mock-editor.js` 会新建测试规则、复制 / 排序 / 启停它、造一组自检流量，并用真实代理请求验证
Mock 命中；finally 里删除测试规则、恢复原有规则顺序、清空测试流量（归档保留）。
`check-app-icon.js` 的单元部分在临时目录里生成图标、结束时删掉；API / UI 部分只造测试流量并清空，
真实服务的 `data/app-icons/` 缓存会保留（首次解析某个 App 时生成，之后直接复用）。
⚠️ `check-local-proxy.js` / `check-local-ui.js` **要求运行前系统代理是关闭态**（它们自己开启再精确还原）；
如果控制台正在「接管本机」，先 `POST /api/system-proxy {"enabled":false}` 释放，跑完再
`POST /api/system-proxy {"enabled":true}` 接管，否则会被判为前置状态不符。
三个 `check-local-*.js` 会**短暂把系统代理切到 9090**（约 1–3 秒）并在 finally 里精确还原，
跑之前确保 iReq 服务在监听，别中途强杀脚本。
