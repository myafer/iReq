**简体中文** | [English](README.md)

# iReq

[![Releases](https://img.shields.io/github/v/release/myafer/iReq?include_prereleases&sort=semver)](https://github.com/myafer/iReq/releases) [![Issues](https://img.shields.io/github/issues/myafer/iReq)](https://github.com/myafer/iReq/issues) [![License](https://img.shields.io/github/license/myafer/iReq)](LICENSE)

轻量、跨平台的 HTTP(S) **抓包 / Mock / 重放** 工具。一个 `npm install`，一条命令起服务，浏览器里操作。

> 定位：不想为了调一个接口去开全家桶工具时用的东西。跨 macOS / Windows / Linux，
> 内核纯 Node 实现、无原生依赖；可选桌面版用 Electron 把同一内核装进窗口。

**遇到问题或有想法？** [提个 issue](https://github.com/myafer/iReq/issues/new/choose) —— bug、想要的功能够用着别扭的地方都可以，不用写得很正式。应用内「更多 ⋯ → 反馈与建议」是同一个入口。

## 能做什么

| 能力 | 说明 |
| --- | --- |
| HTTPS 解密 | 根证书固定在 `~/.ireq/ca`（首次生成后跨版本复用），按域名动态签发叶子证书（397 天有效期 + SAN，符合 Apple 要求） |
| 抓包 | 明文 HTTP 与解密后的 HTTPS 全量记录：方法、URL、头、body、状态、耗时、大小 |
| 实时看 | 控制台走 SSE 推送，**请求一发起**就同时出现在列表和侧栏（状态列显示 `…`），响应回来后同一行原地补上状态码 / 耗时 / 响应体；新请求只插入一行，不整表重绘；点「清空」列表与侧栏分组同帧消失 |
| 分组边栏 | 自动聚合 **设备 / 应用 / 域名 / 接口结构**，点一下即筛选；可收藏常用筛选为书签 |
| Mock | 按 方法 + URL（包含 / 通配 / 正则）+ 域名 匹配，返回自定义状态码、头、body，可加延迟模拟弱网 |
| 重放 | 改 method / URL / header / body 重新发送，结果作为新请求入列并与原请求关联 |
| 排除指定域名 | 证书固定（pinning）的 App 加进「跳过解密」白名单，走裸隧道透传；白名单有独立管理列表（来源 / 加入时间 / 已透传次数），增删改查、批量导入、重启保留 |
| 只解密 HTTP | **默认只解密 443**，其它端口原样透传（MQTT / IMAP / 私有二进制协议不会被破坏）；设置里可加端口 |
| HTTP/2 | 解密隧道按 ALPN 协商 h2：**客户端只提 h2 的端点（Apple 账号认证、gRPC 网关、部分 CDN）也能解密**，流量记为 HTTP/2.0 且多路复用逐条入库，筛选条可单独过滤；设置里可关闭退回 HTTP/1.1 |
| 连接诊断 | 反复 TLS 握手失败的域名会列出来，「更多 ▾」里可单独筛选，一键「加入跳过解密」后自动打开管理列表；详情给出原因判定（证书不被信任 / 只接受 HTTP/2 / 握手被重置 / 非 HTTP 协议）与底层报错、SNI、ALPN；加入白名单后诊断行立即撤掉，不会再顶在列表顶部 |
| 落盘 | 当天流量写 `data/flows/flows-YYYY-MM-DD.jsonl`，重启可回看最近 300 条 |
| 导出 | 「⋯ 更多 → 导出 HAR」或 ⌘K 输入「导出」，一键把当前筛选结果导出为 **HAR 1.2**（完整头 / body + iReq 应用、设备扩展字段）；原始 JSON 用 `/api/export/json` |
| 设置自动保存 | 输入停顿即保存，关闭弹窗会兜底 flush，不用记着点「保存」 |
| 中英双语界面 | 默认跟随系统语言；「⋯ 更多 → 外观」或「高级设置」里可切换 English / 简体中文，选择会被记住 |
| 融合标题栏（macOS） | 隐藏系统标题栏，红黄绿按钮浮在应用顶栏内，顶栏同时承担窗口拖拽；Windows / Linux 保留系统标题栏 |
| 精简交互 | 顶栏常驻只有「抓包 / 规则 / 清空 / ⋯ 更多」；低频工具收进「⋯ 更多」，动作跟着选中请求走（右键 / 网络 ▾），⌘K 既能搜请求也能直接执行命令 |
| VSCode 式规则工作区 | 活动栏 + 资源管理器 + 多标签编辑区 + 面包屑 + 状态栏；点规则在右侧开标签而不是弹窗，多条规则可同时编辑，未保存内容切标签不丢，⌘S / ⌘W / ⌘1..9 齐备 |

## 快速开始

```bash
git clone https://github.com/myafer/iReq.git
cd iReq
npm install          # 只有 node-forge 一个依赖
npm start            # 代理 9090，控制台 http://127.0.0.1:9091
```

不想装 Node？到 [Releases](https://github.com/myafer/iReq/releases) 下载对应平台的单文件可执行程序
（macOS arm64/x64、Linux x64/arm64、Windows x64，推送 `v*` tag 时 CI 自动打包），运行即起服务。

根证书与私钥首次运行时生成，之后**固定存放在 `~/.ireq/ca/`**：`ca-archive.json` 是带 SHA-1 指纹的档案，
`reqlite-ca.pem` / `.key` 是兼容下载与手动安装的散文件。桌面版、CLI 单文件版、源码版共用同一份，
**覆盖安装、升级、换形态都不会换证书，也就不用重新信任**；旧版放在 `data/ca/` 的证书会在首次启动时自动迁移过来。

**macOS（本机调试）**：最省事的是打开「⋯ 更多 → 证书与连接」，在第 2 步点 **一键安装并信任**，
系统会弹一次授权确认，装完盾牌变绿。自动安装失败时展开「本机信任命令与状态」手动执行：

```bash
security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.ireq/ca/reqlite-ca.pem"
```

需要备份 / 迁移 / 让多台机器共用同一张 CA：在同一页点 **导出 .p12 备份**（含私钥，页面会显示导入密码），
换机器后点 **导入 .p12** 即可，不用重新给手机装证书。

**iOS**

1. 手机 Wi-Fi 代理指向 `<Mac 的局域网 IP>:9090`
2. Safari 打开 **`http://<Mac 的局域网 IP>:9090/`**（注意是 `http`，末尾斜杠即可）
   - 这个页面是代理端口自己应答的安装页，给下载按钮和分平台步骤；**已经配了代理也能打开**（请求会回到代理自身，不会绕圈报错）
   - 点「下载证书（.cer）」→ 允许下载描述文件
3. 设置 › 已下载描述文件 › 安装
4. 设置 › 通用 › 关于本机 › 证书信任设置，打开 **iReq Root CA**（很多人卡在这一步）

> 如果浏览器把地址跳成了 `https://`，会看到「证书错误」——那是**还没装证书**导致的，不是地址写错。
> 两种解法：手动把地址栏改回 `http://`；或临时关掉 Wi-Fi 代理再打开。实在不行把
> `~/.ireq/ca/reqlite-ca.pem` 隔空投送 / 邮件发到手机上点开安装。

**Android**：同样下载证书 → 设置 › 安全 › 加密与凭据 › 安装证书 › CA 证书。
Android 7+ 的 App 默认只信任系统证书，抓自家 App 请用 debug 包配 `networkSecurityConfig`。

**Windows / Linux**

```powershell
certutil -addstore -user Root reqlite-ca.pem          # Windows
```
```bash
sudo cp reqlite-ca.pem /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

命令行参数：

```bash
iReq start [-p 9090] [-u 9091] [-b 0.0.0.0] [--ui-host 127.0.0.1]
              [-d ./data] [--ca-dir ~/.ireq/ca] [--no-persist] [--no-ui] [--passthrough a.com,b.com] [--max-flows 2000]
iReq ca            # 打印根证书路径
iReq ca --print    # 输出 PEM
iReq local status  # 查看本机系统代理
iReq local on|off  # 接管 / 释放本机系统代理
```

## 代理地址：顶栏那串 `IP:端口`

顶栏「监听中」旁边显示的是**局域网 IP**（例如 `192.168.1.23:9090`），不是 `127.0.0.1` —— 手机填 `127.0.0.1` 指的是手机自己，永远连不到 Mac 上的代理。

```
[ 192.168.1.23 ] : [ 9090 ] │ ▾  ⧉
   ↑ 点一下复制 IP  ↑ 点一下复制端口   ↑ 切换  ↑ 复制整串
```

- **分开复制**：iOS / Android 配 Wi-Fi 代理时要分别填「服务器」和「端口」，直接点胶囊里的 IP 或端口即可，不用再从一整串里挑。
- **全部复制**：点右侧 `⧉`，得到 `192.168.1.23:9090`。
- **切换地址**：点 `▾` 打开菜单，会列出每个网卡的局域网地址（带网卡名，如 `局域网 · en1`）和 `127.0.0.1（本机回环）`；菜单里还有三个文字明确的「复制 IP / 复制端口 / 复制完整地址」按钮。抓手机选局域网 IP，抓这台 Mac 自己选 `127.0.0.1`。选择记在 localStorage，刷新后保持。
- 顶栏、空状态提示、连接向导的安装页地址与第 1 步共用同一个地址源，切一次全部同步。
- 窄屏（< 900px）顶栏胶囊会隐藏，但连接向导第 1 步里仍有同样三个复制按钮。
- 服务端 `GET /api/status` 返回 `lan`（IP 数组）和 `lanInfo`（含 `iface` 网卡名，私有网段排前面），脚本化时可直接使用。

## 抓本机的流量（和手机不一样）

**HTTP 代理不是透明的**：手机填了 Wi-Fi 代理就能抓，但本机浏览器 / 桌面 App 默认直连，
必须把「系统代理」指向 iReq，否则控制台里只会出现手机等外部设备的请求。
环境变量 `HTTP_PROXY` 只影响 curl / node 这类命令行程序，对 Safari、Chrome、桌面 App 无效
——「列表里全是别的 IP、就是没有 `127.0.0.1`」就是这个原因。

最省事：打开「⋯ 更多 → 证书与连接」，在第 3 步点 **接管本机**，或点顶栏的 `本机未接管` 快捷入口。
命令行等价操作：

```bash
iReq local status     # 看当前系统代理指向哪里
iReq local on         # 接管
iReq local off        # 释放，精确还原原始配置
```

开启时会把 Web / 安全 Web 代理都指向 `127.0.0.1:9090`，并把
`localhost / 127.0.0.1 / ::1 / *.local` 加进绕过列表（否则控制台自己的请求会绕回代理形成自环）。
原始配置备份在 `data/system-proxy-backup.json`，**服务正常退出时自动还原**；进程被强杀就手动执行
`iReq local off`。macOS 走 `networksetup`（实测无需 sudo）；Windows / Linux 不自动改系统设置，
在设置面板里有可复制的命令。

抓 HTTPS 还要把根证书**加进本机钥匙串并设为「始终信任」**，桌面版「证书与连接」里点一次「一键安装并信任」即可，这一步比看上去容易漏，见下一节。
仍看不到就展开设置面板里的「手动设置 / 还是看不到？」：Chrome 的 QUIC(HTTP/3) 会绕过代理、
证书固定的 App 会握手失败、命令行程序需显式设 `HTTP_PROXY / HTTPS_PROXY=http://127.0.0.1:9090`。

## 排障：Chrome 报「您的连接不是私密连接」/ 列表一直是空的

这两个症状经常连着出现，但根因不同：

| 症状 | 原因 |
| --- | --- |
| 接管本机后所有 HTTPS 站点报证书错误 | 本机**没有信任 iReq 的根证书**，浏览器收到的是 iReq 动态签发的自签证书 |
| 不报错了，但列表里一条请求都没有 | 系统代理没开 / 服务没在跑 / 或命中了「安全模式」把 HTTPS 原样透传了 |

**「装了证书」不等于「信任了证书」**。双击 `.pem` 导入钥匙串只是「安装」，
信任设置仍是默认的「使用系统默认值」，Chrome 照样不认。装过其他抓包工具的 CA 也没用 ——
它们的公钥和 iReq 不是同一张证书。桌面版「证书与连接」里的 **一键安装并信任** 会把这一步自动做完
（用户域，通常免 sudo，系统弹一次授权确认）；失败时才需要手动执行：

```bash
security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.ireq/ca/reqlite-ca.pem"
```

状态卡的盾牌会显示「已信任 / 未信任」、CA 指纹与档案路径；「设置 › 本机抓包」也会显示同样的状态
和这条命令（路径已填好），点「复制信任命令」即可，执行完点「重新检测」。
信任结论会按 CA 指纹落盘到 `~/.ireq/ca/trust-state.json`，启动时沿用，不会因为一次钥匙串抖动
就让你重装证书。命令行核验（退出码 0 才是真的被信任）：

```bash
security verify-cert -c "$HOME/.ireq/ca/reqlite-ca.pem" -p basic -L; echo $?
security dump-trust-settings | grep -A2 'iReq'
```

⚠️ **别给 `add-trusted-cert` 加 `-p ssl`**：那会生成「仅 SSL 策略」的受限信任
（`Number of trust settings : 1 / Policy OID: SSL`），`verify-cert` 仍判未信任，浏览器照样报错。
正确安装的 CA 那种 `Number of trust settings : 0`（无策略约束）才是对的。

**安全模式**：工具启动时用 `verify-cert` 检测信任状态。如果发现「未信任 + 系统代理由本工具接管」，
本机回环地址的 443 会**自动原样透传**而不是解密 —— 网站照常打开，只是看不到 HTTPS 明文；
列表里会留下一条带「透传」标记的 CONNECT 记录和修复说明，不会变成空列表让人以为工具坏了。
信任根证书后点「重新检测」即自动恢复解密，无需重启。这个保护只作用于「本机 + 系统代理接管」：
手机等远程设备、以及显式 `--proxy` 的开发/自检流量照常解密。

其它常见「看不到」：`scutil --proxy` 里 `HTTPEnable/HTTPSEnable` 是 0（代理没开，点「接管本机」）、
`lsof -nP -iTCP:9090 -sTCP:LISTEN` 无输出（服务没在跑，`node bin/ireq.js start`）、
控制台有筛选条件没清、Chrome 走 QUIC 绕过代理。

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

## 控制台

- **顶栏**：常驻只有「抓包 / 规则 / 清空 / ⋯ 更多」；证书、设置、导出、网络模拟、**跳过解密管理**、主题、语言、字号都收在「⋯ 更多」里（跳过解密带已加入条数角标）。地址胶囊默认局域网 IP，IP / 端口 / 整串分别可复制，▾ 切换多网卡与本机回环（见上节）
- **控制坞**（底部常驻一条）：左侧是**系统代理接管状态**（● 绿 = 已接管 `IP:端口`，黄 = 接管但 HTTPS 透传中，灰 = 未接管），单击切换接管 / 释放，✎ 打开连接向导；右侧快捷开关：**Mock 总开关**（一键旁路所有规则，规则内容不动；徽章 = 已启用规则数，右键直达规则工作区）、**弱网**和**断网**两个一键开关（单击直接给全部流量落一条 `*` 规则、再点撤销；断网红、弱网绿，右键打开详细设置；徽章 = 生效规则数）、**暂停 / 继续**抓包（与顶栏「抓包」开关同一状态源）和**清空**
- **列表**：方法、路径、域名、状态、耗时；进行中的请求状态列是中性灰 `…`（轻微呼吸，不会误看成红色的错误态），完成后原地变成真实状态码；`MOCK` / `REPLAY` / `WS` / `透传` 角标区分来源
- **握手失败域名**：客户端不认根证书（证书固定）或端口不是 HTTP 时，域名会实时以红色诊断行出现在列表顶部，按域名聚合并显示失败次数（重试不会刷屏）；「更多 ▾ → 握手失败」筛选可单独查看，点开详情能看到**原因判定**（证书不被信任 / 只接受 HTTP/2 / 握手被重置 / 非 HTTP 协议）、底层 TLS 报错、SNI 与 ALPN，并一键「加入跳过解密」，行右侧 ✕ 可单独忽略。诊断行只在问题未解决时置顶：**加入「跳过解密的域名」（详情按钮 / 右键 / 设置页手填都算）后，该域名及其子域的记录立即从服务端和所有窗口一起撤掉**；后续握手成功也会自动撤掉，加白名单前残留的旧连接报错不会把它顶回来。这类行属于连接层事件，不算 flow、不进 HAR 导出，清空列表时一起清掉。
- **跳过解密管理列表**（「⋯ 更多 → 跳过解密」，或设置 › 高级设置里的「管理列表」/ TLS 诊断行右键）：所有加过的域名集中在一个列表里，显示**来源**（诊断一键 / 手动 / 设置页 / 建议 / 原有配置）、**加入时间**、**已透传次数**与最近命中的域名；支持输入框批量添加（空格、逗号、换行）、搜索、就地改名、单条移除、一键清空、复制全部，还有「待处理」失败域名与少量常见系统服务的快捷入口。规则匹配自身与所有子域，改动立即生效、通过 SSE 同步到所有窗口，并**写入 `data/config.json`，重启不丢**；新增规则会立刻切断还在解密的存量连接，客户端重连即走裸隧道。诊断行点「加入跳过解密」后会直接打开这个列表并高亮刚加的那条，不会再出现「加完就找不着了」。
- **网络模拟**（「⋯ 更多 → 网络模拟」，或侧栏应用小圆点 / 详情「网络 ▾」/ 列表右键）：按应用名 / 域名 / IP（或 `*` 全部）匹配，可设 **断网**（CONNECT / 请求进来即重置连接）、**超时**（挂起不响应直到时限）、**弱网**（附加延迟 + 按目标 KB/s 限速响应体；透传隧道在字节层限速）。规则是会话级、不落盘、重启自动清空。点侧栏应用旁的小圆点可就地切 正常 / 弱网 / 断网 / 超时，顶栏角标显示生效条数，改动通过 SSE 同步到所有窗口；被模拟的请求会记成带模式角标的 flow。**规则变更会立即切断受影响的存量长连接**（keep-alive / CONNECT 隧道），客户端重连后按新规则走，不会出现「已经开着断网，App 复用旧连接却照样通」；不匹配的连接不受影响。面板顶部状态条显示当前全局模式、已模拟条数与最近切断的连接数。
- **详情**：概览 / 请求 / 响应 / 原始四个页签，JSON 自动格式化 + 语法着色，
  请求体和响应体都有「结构化 / 原始 / 展开全部 / 折叠全部 / 复制」工具条：结构化视图把
  格式化和树合为一体——展开时是带缩进和着色的格式化 JSON，点 ▸ 收起某层显示 `{ … N 键 }` 摘要；
  结构化视图带行号（折叠后自动重排），body 区块可一键全屏（Esc 退出）
- **二进制 body**：图片（png / jpeg / gif / webp / bmp / ico，按魔数嗅探，不信任 Content-Type）直接渲染**预览**；
  其它二进制给**完整 Base64 文本**（不再只截前 4KB）与 **Hex dump**（前 4KB，offset + hex + ASCII）两种视图，
  均可复制 / **下载**（文件名取自路径并按类型补扩展名）
- **头区块**：请求头 / 响应头逐行 hover 高亮，**点行即复制** `name: value`；关键头（host / content-type / authorization / cookie 等）着色提示；区块工具条「复制全部」（每行 `name: value`）/「复制 JSON」（整个头对象）
- **原文页签**：请求 / 响应报文带**行号**，点任意行复制该行；工具条「复制全部」（含 body）/「仅状态行和头」；二进制 body 在原文中省略并给出指引提示
- **操作**：详情动作条有 重放 / Mock 此请求 / 网络 ▾ / 收藏 / 复制 cURL；列表行右键是同一套菜单，TLS 诊断行给「加入跳过解密」。
- **导出**（「⋯ 更多 → 导出 HAR」或 ⌘K 输入「导出」）：把当前筛选的请求下载成 HAR 1.2，含完整请求 / 响应头与 body；没有筛选时导出内存中全部记录。弹窗会把键盘焦点锁在内部，关闭后还原到原来的位置。
- **规则**：点顶栏「规则」进 **VSCode 式全屏工作区**（左侧文件夹树 + 右侧多标签编辑区）；「Mock 此请求」先进**快速 Mock**（名称 / 状态码 / 延迟 / 响应体四格），需要更多再点「完整编辑器」。增删改、启停、搜索、复制、JSON 导入导出、多标签同时编辑
- **JSON 编辑器**：内置 **Monaco Editor 0.52.2**（VS Code 同款内核），本地 vendor 化不依赖 CDN，
  断网可用；语法高亮、错误红线（真 JSON worker 校验）、括号匹配、代码折叠、自动补全、
  格式化 / 压缩 / 全屏，深浅主题和界面字号同步；加载失败自动退回原生 textarea，功能不丢
- **分组边栏**（左侧）：设备、应用（本机显示真实进程名，远程按 UA / 别名，见上节）、域名、接口结构
  （`GET /api/v1/lesson/:id/card` 这种归一化路径，多段 id 会压成 `*`）。点条目即筛选，可折叠分组；
  应用 / 设备都带图标（真实 App 图标 → 内置 SVG → 默认色块，见「应用图标是怎么来的」）；
  **收藏**存的是"筛选条件"而不是某条请求，请求被挤出内存后书签照样能用；
  **应用是勾选式多选**（绿色对钩替代高亮与计数），勾选后边栏上面的收藏 / 设备分组收起，
  只留「应用 × 域名 × 接口结构」组合筛选：应用列表始终显示全部应用，域名只显示勾选应用下的域名，
  接口结构同域名一样只显示还在列表中的接口（级联聚合，勾选变化即时刷新）
- **设备分组**：回环 `127.0.0.1` / `::1` 和本机所有网卡 IP（含 VPN 虚拟网卡）合并成一个 **「本机」**，
  不再拆成两台设备；标签由 IP 判定、与 UA 无关，所以不会随新请求在
  `iOS 127.0.0.1` / `未知 127.0.0.1` 之间闪跳。远程设备按 IP 单独成组，
  平台名取该设备出现最多的一种，没有 UA 就只显示 IP（不写「未知」）。
  点「本机」会筛出所有本机来源；详情显示「本机 · 原始 IP」，老书签里的具体 IP 仍然可用
- **搜索**：URL / 方法 / 状态码 / 应用 / 设备 IP / 「本机」；搜索框下方有一条**筛选条**（单选，分组用竖线隔开，超出横向滚动）：
  **全部 · HTTP · HTTPS · WebSocket · SSE** ｜ **HTTP1 · HTTP2** ｜ **JSON · XML · 文本 · HTML · JS · 图片 · 媒体 · 二进制** ｜ **1xx–5xx**；
  Mock、握手失败、错误收在「更多 ▾」（选中时触发按钮带蓝点）。协议按记录的 scheme / httpVersion 判定，
  内容类型按响应 Content-Type 判定（svg 归图片、event-stream 归 SSE、无 Content-Type 不算二进制），前后端共用同一套判断
- **字号**：「⋯ 更多 → 外观」里 `A− / A+` 按 5% 步进（85%–160%），点中间的百分比一键回 100%，选择记在 localStorage
- **栏宽**：分组边栏 / 请求列表 / 详情之间的两根竖线都能左右拖（悬停变蓝并可看到握把），
  双击复位，聚焦后 `← →` 微调 16px（Shift 48px）、`Home` 复位；宽度记在 localStorage，
  有上下限保护，窗口变小时会重新夹紧，窄屏改上下布局时自动隐藏手柄
- 快捷键：`⌘K` 开**命令面板**（搜请求 + 直接执行命令，如「断网 微信」「新建规则」「导出 HAR」），`↑ ↓` 切请求，`Esc` 关浮层；主题 / 语言在「⋯ 更多 → 外观」

## VSCode 式规则工作区

点顶栏「规则」打开**全屏工作区**，不再是「列表 + 弹窗」来回切：

- **活动栏**（最左细条）：资源管理器显隐、搜索、新建规则、命令面板、帮助。
- **资源管理器**：`data/rules/` 的真实文件夹树 + 侧栏搜索框 + 「打开的编辑器」列表。点文件夹把右侧列表筛到该目录（含子目录）；搜索同时收敛树和列表。`.body.*` 响应体文件默认收起，工具栏 `≡` 可展开。树行支持键盘（`↑ ↓` / `→ ←` / `Enter` / `F2` / `Delete`），右键或行尾 `⋯` 打开就近菜单（在此新建规则 / 子文件夹、重命名、复制路径、删除）。
- **编辑区**：点规则直接在右侧开一个**标签页**，左侧树始终可见；可以同时开多条，切换时未保存内容留在内存里，标签出现橙色圆点，关闭前二次确认。顶部是文件面包屑，底部是状态栏（规则数 / 当前目录 / 标签数 / 保存状态）。
- **欢迎页**：没有标签时显示快捷入口（新建 / 导入 / 导出）和全部规则卡片列表。
- **快捷键**：`⌘S` 保存、`⌘W` 关当前标签、`⌘1..9` 切标签、`⌘K` 命令面板、`Esc` 关当前标签（无标签时退出工作区）。

点「+ 新建规则」或标签条 `＋` 进完整编辑器；在请求详情点「Mock 此请求」会先打开**快速 Mock**（自动带入真实响应体，只填名称 / 状态码 / 延迟 / 响应体），点「完整编辑器」可带着已填内容切到下面这套富版界面。保存或关闭标签后仍留在工作区原来的文件夹位置。

| 标签页 | 能做什么 |
| --- | --- |
| ① 匹配条件 | 名称 / 备注；方法、包含 / 通配符 / 正则三种匹配方式、限定域名；**匹配测试器**默认收起，点开展开后输入真实 URL 实时显示命中与不命中的原因（方法 / 域名 / 表达式哪一步没过） |
| ② 响应设置 | 状态码 + 延迟的常用预设 chip 与滑块；Content-Type 下拉；**可视化响应头表格**（增删行、一键 CORS、原始文本双向同步） |
| ③ 响应体 | Monaco 编辑器，工具栏有格式化 / 压缩 / 校验 / 复制 / 导入文件 / 清空 / 全屏；底部状态条显示 JSON 是否有效、错误行号、字节数、光标行列；编辑器下方「我的模板」浮层：**自定义模板**的存 / 选 / 删（localStorage 持久化、同名覆盖），点一下替换响应体并联动状态码 |
| ④ 预览 / 测试 | 客户端实际收到的 HTTP 报文预览（状态行 + 头 + 着色 body）、可折叠 JSON 结构树、全部展开 / 折叠 |

`note` 和 `bodyType` 会随规则一起存进 `data/rules/**/*.rule.json`，响应体另存为同目录下的 `*.body.<ext>`。

- 响应体**不强制合法 JSON**：切到「纯文本 / HTML / XML」就跳过校验，写任意内容都能存；JSON 模式下语法错会拦下保存并跳转到错误行。
- 规则工作区支持搜索、复制副本、启停、编辑、删除（删除统一二次确认）；**导出 JSON** 可复制 / 下载，
  **导入 JSON** 粘贴规则数组，需点两次确认才覆盖（避免误操作）。匹配优先级 = 文件树排序（浅层在前、同层按名称），调整目录 / 文件名即可改顺序。
- 快捷键：响应体里 `⌘⇧F` 格式化、`⌘F` 查找；全屏时 `Esc` 先退出全屏。
- 「另存为副本」「删除规则」只在编辑已有规则时出现；「Mock 此请求」（快速 Mock → 完整编辑器）进来的规则默认按路径包含匹配。

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
- **清空会归档当日抓包**：点「清空」不只清内存，还会把当天的 `flows-YYYY-MM-DD.jsonl` 改名为
  `.cleared-<时间戳>`。否则重启时恢复历史会把刚清掉的记录全部「复活」。归档文件不会被自动加载，
  要事后翻查可以手动打开；不想要的话直接删掉即可。
- **接管本机系统代理，退出必须精确还原**：只把代理 state 置 off 是不够的，macOS 关闭态下仍会保留
  `Server/Port`，以及我们加的绕过域名 —— 用户下次手动开代理就会连到已经停掉的 iReq。
  所以开启前把完整快照存盘，释放时连 host/port、绕过域名一起写回；`localhost / 127.0.0.1 / ::1 / *.local`
  必须绕过，否则控制台自己的请求会绕回代理形成自环。

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
tools/              开发自检脚本（_seed.js 负责造测试流量，见「开发自检」）
```

## API（脚本化时可用）

```
GET    /api/status            含 lan: ["192.168.1.23"]、lanInfo: [{ip, iface}]、proxyPort、caTrust、caInfo、dataDir、safeMode
GET    /api/flows?q=&method=&status=error|ok|json&mocked=1&host=&ip=&app=&route=&limit=
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
GET    /api/config  PUT /api/config   { capture, mockEnabled, h2Enabled, passthrough: [], mitmPorts: [443], maxFlows,
                                        processMap: true, uaAppMapText: "okhttp=我的App",
                                        networkSim: { enabled, latencyMs, kbps, timeoutMs, rules: [{match, mode}] } }
GET    /api/events                SSE：flow / flow-update / clear / tls-failure / tls-remove / tls-clear /
                                  network-sim / passthrough
                                  （flow = 请求发起时的进行中占位记录；flow-update = 响应完成就地补完，
                                   以及本机进程名异步回填；clear = 列表与侧栏同步清空；
                                   tls-remove = 加入跳过解密 / 握手成功后撤掉已解决的诊断行；
                                   passthrough = 白名单变更，带最新规则与本次切断的连接数）
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

## 开发自检

服务起来后（`node bin/ireq.js start`）可直接跑。UI 类脚本都通过 `tools/_seed.js` 自己经代理造测试流量，
不依赖控制台里恰好有数据，脚本末尾会打印逐条 ✅/❌。

`npm run check` 会顺序跑只读类自检并汇总。所有脚本统一从 `tools/_env.js` 取地址，
用 `REQLITE_UI_PORT=9294 REQLITE_PROXY_PORT=9293 npm run check` 指向指定实例
（默认 9091 / 9090），避免连到旧服务「假绿」。

```bash
npm run check                   # 一键汇总（不含会改动 macOS 系统代理的脚本）
node tools/check-repo-meta.js    # 仓库元数据：issue 模板结构 / 空白 issue 关闭 / 分流 workflow 只拿 issues 权限（22 项，无需服务）
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

## 安装说明（macOS 首次打开）

iReq 目前没有苹果开发者证书签名 / 公证，从 GitHub Releases 下载的 macOS 包首次打开会提示
**「“iReq”已损坏，无法打开」**——这是 Gatekeeper 对未公证应用的拦截，应用本身没问题。
把 app 拖进「应用程序」后在终端执行一次：

```bash
xattr -cr /Applications/iReq.app
```

之后即可正常打开。Windows（SmartScreen）与 Linux AppImage 如有类似提示，同理允许运行即可。

> 因为产物未签名 / 未公证，**每次用新下载的 `.dmg` 覆盖 `/Applications/iReq.app` 都会重新带上
> `com.apple.quarantine`**，需要再执行一次 `xattr -cr`；macOS 按代码签名身份记录的系统授权
> （钥匙串访问、辅助功能、防火墙传入连接等）也会在换包后失效，需要重新点一次允许。
> **根证书不受影响**：它固定在 `~/.ireq/ca`，覆盖安装不会重新生成，也不需要重新信任。
> 只有彻底根治这两类授权弹窗才需要 Apple Developer ID 签名 + 公证。

## 已知限制

- 落盘的 JSONL 含请求/响应体（单条最多 2MB），大流量场景文件增长较快；`--no-persist` 可关掉落盘。
- 长连接流式响应（SSE / chunked）会实时转发；请求发起时就有一条「进行中」记录，连接结束前一直保持该状态（导出会跳过未完成的记录）。
- HTTP/2 已按 ALPN 协商解密（h2 流量逐 stream 入库，详情标「协议版本 HTTP/2」）；上游一律按 HTTP/1.1 转发，扩展 CONNECT（h2 上的 WebSocket）暂不支持。
- 不做 WebSocket 帧级解密。HAR 导出已支持（「更多 ⋯ → 导出 HAR」），未完成的记录会被跳过。
- **手机等远程设备拿不到进程/包名**，只能按 UA 推断或用 UA 别名标注（见「应用名是怎么来的」）。
- 本机进程识别只在 macOS 有；Linux / Windows 需要各自实现 `netstat + /proc` / `GetExtendedTcpTable`。
  建立后立刻关闭的极短连接可能赶不上 `lsof` 快照，会保持 UA 推断的应用名。

## 反馈与贡献

提 issue 是最有价值的贡献方式，**不需要你会写代码**：

- [Bug 报告](https://github.com/myafer/iReq/issues/new?template=bug.yml)：解不开、列表空的、界面不对、崩溃
- [功能建议](https://github.com/myafer/iReq/issues/new?template=feature.yml)：说清「你在做什么事、卡在哪」比列方案有用
- 应用内更快：「更多 ⋯ → 反馈与建议」直接跳到同一个入口

三条约定，都是为了别浪费你我的时间：

1. **不要贴真实的 Cookie / Token / 手机号**。只说版本、平台、失败域名和现象就够了，我按场景复现。
2. **先说场景，再说方案**。你说「想一次配好状态码和延迟」，比说「给规则加个组合字段」更容易被我做对。
3. **提了就会有人看**。标签流转 `needs-triage → accepted → shipped`，发版说明里会写清哪条来自谁的反馈。

代码贡献同样欢迎：先开 issue 对齐方案再提 PR，`node tools/check-all.js` 全套自检必须通过。仓库里每个功能都配了对应的 `tools/check-*.js`，改哪儿跑哪儿。

## License

MIT
