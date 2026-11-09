[简体中文](README.zh-CN.md) | **English**

# iReq

A lightweight, cross-platform HTTP(S) **capture / Mock / replay** tool. One `npm install`, one command to start the server, and you work in the browser.

> Positioning: the thing to reach for when you want to debug one API and don't want to fire up the whole Charles / Reqable suite. Cross macOS / Windows / Linux,
> pure Node core with no native dependencies; the optional desktop app wraps the same core in an Electron window.

## What it can do

| Capability | Description |
| --- | --- |
| HTTPS decryption | Self-generates a root CA on first run, dynamically issues leaf certificates per domain (397-day validity + SAN, meeting Apple's requirements) |
| Capture | Full records of plaintext HTTP and decrypted HTTPS: method, URL, headers, body, status, duration, size |
| Live view | Console pushes via SSE; a request appears in the list the moment it completes. New flows insert a single row instead of re-rendering the whole list |
| Grouped sidebar | Automatically aggregates **device / app / domain / API structure**; one click filters; bookmark frequently used filters |
| Mock | Matches by method + URL (contains / wildcard / regex) + domain, returns custom status code, headers, body; add delay to simulate a slow network |
| Replay | Edit method / URL / header / body and resend; the result is enqueued as a new request and linked to the original |
| Exclude specific domains | Add certificate-pinned apps to "skip decryption domains" and pass them through as a raw tunnel |
| Decrypt only 443 | **By default only port 443 is decrypted**; other ports pass through untouched (MQTT / IMAP / private binary protocols won't break); add ports in Settings |
| Connection diagnostics | Domains with repeated TLS handshake failures are listed, with one-click "add to skip decryption" — the most common cause of an app "not connecting" |
| Persistence | Today's traffic is written to `data/flows/flows-YYYY-MM-DD.jsonl`; the most recent 300 entries can be reviewed after restart |
| Export | One-click **HAR 1.2** export of the current filter (full headers / bodies + iReq app / device metadata); raw JSON available at `/api/export/json` |
| Instant settings | Settings save automatically as you type (short debounce); closing the dialog flushes pending edits — no Save button to remember |
| Bilingual UI | Defaults to your system language; switch between English and Simplified Chinese from the top bar or Settings — the choice is remembered |
| Merged title bar (macOS) | The native title bar is hidden: the red/yellow/green buttons sit inside the app top bar, which also acts as the window drag handle. Windows and Linux keep the system title bar |

## Quick start

```bash
git clone https://github.com/myafer/iReq.git
cd iReq
npm install          # only one dependency: node-forge
npm start            # proxy 9090, console http://127.0.0.1:9091
```

Don't want to install Node? Download the single-file executable for your platform from [Releases](https://github.com/myafer/iReq/releases)
(macOS arm64/x64, Linux x64/arm64, Windows x64; CI auto-packages on a `v*` tag push), and run it to start the server.

The first run generates the root CA under `data/ca/`, then:

**macOS (local debugging)**

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain data/ca/reqlite-ca.pem
```

**iOS**

1. Point the phone's Wi-Fi proxy to `<Mac's LAN IP>:9090`
2. Open **`http://<Mac's LAN IP>:9090/`** in Safari (note it's `http`, a trailing slash is enough)
   - This page is the install page served by the proxy port itself, giving a download button and per-platform steps; **it works even with the proxy already configured** (the request comes back to the proxy itself, no loop error)
   - Tap "Download certificate (.cer)" → allow the profile download
3. Settings › Downloaded Profile › Install
4. Settings › General › About › Certificate Trust Settings, turn on **iReq Root CA** (many people get stuck here)

> If the browser jumps the address to `https://`, you'll see a "certificate error" — that's caused by **the certificate not being installed yet**, not a wrong address.
> Two fixes: manually change the address bar back to `http://`; or temporarily turn the Wi-Fi proxy off and on. If all else fails, AirDrop / email
> `data/ca/reqlite-ca.pem` to the phone and tap to install it.

**Android**: download the certificate the same way → Settings › Security › Encryption & credentials › Install a certificate › CA certificate.
On Android 7+ apps trust only system certificates by default; to capture your own app, use a debug build with `networkSecurityConfig`.

**Windows / Linux**

```powershell
certutil -addstore -user Root reqlite-ca.pem          # Windows
```
```bash
sudo cp reqlite-ca.pem /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

Command-line arguments:

```bash
iReq start [-p 9090] [-u 9091] [-b 0.0.0.0] [--ui-host 127.0.0.1]
              [-d ./data] [--no-persist] [--no-ui] [--passthrough a.com,b.com] [--max-flows 2000]
iReq ca            # print root CA path
iReq ca --print    # output PEM
iReq local status  # show local system proxy
iReq local on|off  # take over / release local system proxy
```

## Proxy address: the `IP:port` string in the top bar

Next to "Listening" in the top bar is the **LAN IP** (e.g. `192.168.1.23:9090`), not `127.0.0.1` — entering `127.0.0.1` on a phone points to the phone itself and will never reach the proxy on the Mac.

```
[ 192.168.1.23 ] : [ 9090 ] │ ▾  ⧉
   ↑ tap to copy IP  ↑ tap to copy port   ↑ switch  ↑ copy whole string
```

- **Copy separately**: when setting a Wi-Fi proxy on iOS / Android you fill in "Server" and "Port" separately; just tap the IP or port inside the pill, no need to pick them out of one whole string.
- **Copy all**: tap `⧉` on the right to get `192.168.1.23:9090`.
- **Switch address**: tap `▾` to open a menu listing each interface's LAN address (with the interface name, e.g. `LAN · en1`) and `127.0.0.1 (loopback)`; the menu also has three clearly labeled "Copy IP / Copy port / Copy full address" buttons. Pick the LAN IP to capture a phone, `127.0.0.1` to capture this Mac itself. The choice is stored in localStorage and persists across reloads.
- The top bar, the empty-state hint, the install-page address in the certificate dialog, and the settings panel all share the same address source — switch once and everything syncs.
- On narrow screens (< 900px) the top-bar pill is hidden, but "Settings › Proxy address" still has the same three copy buttons.
- The server's `GET /api/status` returns `lan` (array of IPs) and `lanInfo` (including the `iface` interface name, private ranges first), ready to use in scripts.

## Capturing local machine traffic (different from a phone)

**An HTTP proxy is not transparent**: a phone is captured once the Wi-Fi proxy is set, but local browsers / desktop apps connect directly by default,
so you must point the "system proxy" at iReq, otherwise the console will only show requests from external devices such as phones.
The `HTTP_PROXY` environment variable only affects command-line programs like curl / node and has no effect on Safari, Chrome, or desktop apps
— that's exactly why "the list is full of other IPs but never `127.0.0.1`".

Easiest: in the console's top-right "Settings › Local capture" click **Take over local**, or click the `Local traffic not captured` shortcut in the top bar.
Equivalent command-line operations:

```bash
iReq local status     # show where the current system proxy points
iReq local on         # take over
iReq local off        # release, restore the original config exactly
```

Enabling points both the Web / Secure Web proxy at `127.0.0.1:9090` and adds
`localhost / 127.0.0.1 / ::1 / *.local` to the bypass list (otherwise the console's own requests loop back into the proxy).
The original config is backed up in `data/system-proxy-backup.json` and **restored automatically on a clean exit**; if the process is killed, run
`iReq local off` manually. macOS uses `networksetup` (tested to need no sudo); Windows / Linux don't change system settings automatically —
copiable commands are in the settings panel.

To capture HTTPS you also need to **add the root CA to the local Keychain and set it to "Always Trust"** — this step is easier to miss than it looks; see the next section.
If you still see nothing, expand "Manual setup / Still nothing?" in the settings panel: Chrome's QUIC(HTTP/3) bypasses the proxy,
certificate-pinned apps fail the handshake, and command-line programs need an explicit `HTTP_PROXY / HTTPS_PROXY=http://127.0.0.1:9090`.

## Troubleshooting: Chrome says "Your connection is not private" / the list stays empty

These two symptoms often appear together but have different root causes:

| Symptom | Cause |
| --- | --- |
| After taking over local, all HTTPS sites report a certificate error | The machine **does not trust iReq's root CA**; the browser receives a self-signed certificate dynamically issued by iReq |
| No error anymore, but not a single request in the list | System proxy is off / the service isn't running / "safe mode" passed HTTPS through untouched |

**"Installed the certificate" ≠ "trusted the certificate"**. Double-clicking a `.pem` to import it into the Keychain is only "install" —
the trust setting is still the default "Use System Defaults", and Chrome still rejects it. Having installed Reqable / Proxyman's CA doesn't help either —
their public keys aren't the same certificate as iReq's. Do install + trust in one go (user domain, usually no sudo):

```bash
security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "/absolute/path/iReq/data/ca/reqlite-ca.pem"
```

The console's "Settings › Local capture" shows the real status and this command (with the path filled in); click "Copy trust command" to grab it;
after running it click "Re-check". Command-line verification (exit code 0 means it's really trusted):

```bash
security verify-cert -c /absolute/path/iReq/data/ca/reqlite-ca.pem -p basic -L; echo $?
security dump-trust-settings | grep -A2 'iReq'
```

⚠️ **Don't add `-p ssl` to `add-trusted-cert`**: that creates a restricted "SSL-only policy" trust
(`Number of trust settings : 1 / Policy OID: SSL`); `verify-cert` still reports untrusted and the browser still errors.
Reqable CA's `Number of trust settings : 0` (no policy constraint) is the correct one.

**Safe mode**: on startup the tool uses `verify-cert` to check trust status. If it finds "untrusted + the system proxy is taken over by this tool",
port 443 on the local loopback address is **automatically passed through untouched** instead of being decrypted — sites open normally, you just don't see HTTPS plaintext;
the list keeps one CONNECT record with a "passthrough" marker and repair instructions, so it doesn't turn into an empty list that makes you think the tool is broken.
After trusting the root CA, click "Re-check" to resume decryption automatically, no restart needed. This protection applies only to "local + system proxy taken over":
remote devices such as phones, and development / self-check traffic using an explicit `--proxy`, are decrypted as usual.

Other common "nothing shows up" cases: `HTTPEnable/HTTPSEnable` is 0 in `scutil --proxy` (proxy off, click "Take over local"),
no output from `lsof -nP -iTCP:9090 -sTCP:LISTEN` (service not running, `node bin/ireq.js start`),
a filter left active in the console, or Chrome bypassing the proxy via QUIC.

## Where app names come from

Originally the "App" column was guessed only from the User-Agent: a UA like `demo-app/2.0.0 (iPhone; iOS 17.0)` is readable,
but generic libraries such as `okhttp/4.9` or `CFNetwork` leave only "OkHttp 4", which looks like it wasn't recognized. Now three sources are tried in order:

| Source | Applies to | Result | Marker |
| --- | --- | --- | --- |
| **Real local process** | Connections originating from this machine on macOS | `Google Chrome` / `DingTalk` / `Music App` / `curl`, independent of UA | Green dot in sidebar, details show PID + executable path |
| **UA alias** | Remote devices such as phones, or when process detection is off | A business name you write yourself, e.g. `MyApp` | Yellow dot in sidebar |
| **UA inference** | Fallback | `demo-app 2.0.0`, `OkHttp 4` | No dot |

The local one is the core: the other end of the connection is on the same machine, so `lsof -nP -iTCP -F pcn` can look up the PID and process name from the client **TCP source port**,
then read the `.app` name from the executable (Chrome Helper / WebKit.WebContent are folded into the main app).
After HTTPS decryption `req.socket` becomes a `TLSSocket`, so the original socket's port is recorded at CONNECT time and carried all the way through.
Association happens only when `clientIp` is a loopback address, so **phone traffic is never mislabeled as a local app**.

The `lsof` snapshot is async (~40–60ms): the first request may briefly show the UA-inferred name, then automatically switch to the real process name via an SSE
`flow-update` a few dozen milliseconds later; the backfill appends a lightweight JSONL patch, so it won't degrade back to "OkHttp 4" after a restart.

**Why do phones still have no app name?** An HTTP proxy only sees the device IP, not the peer's process / package name — a protocol-level limitation
(Reqable in phone-proxy mode likewise can only rely on UA, or on a device-side VPN). The fix is to write a mapping in
**Settings › App identification › UA → App name**, one per line:

```
demo-app/2.0=MyApp
okhttp=Sample App
CFNetwork=My iOS Client
```

Keywords are matched as substrings (case-insensitive); aliases take priority over built-in inference and apply only to newly captured requests.
If you don't want local process lookup, uncheck "Identify real local processes" in the same panel — equivalent to
`PUT /api/config {"processMap": false}`. Non-macOS systems have no process association and use only UA inference + aliases.

## Where app icons come from

Every item in the sidebar's "App" group, the second line of the request list, and the "App / Device" row in details carry an icon, with three fallback layers:

| Layer | Source | Examples |
| --- | --- | --- |
| **Real app icon** | On macOS, find the `.app` by app name, read the icon file from `Info.plist`, convert it to a 128px PNG using the built-in `plutil` + `sips`, cached in `data/app-icons/` | Chrome, WeChat, DingTalk, Safari, VS Code, Playwright's Chrome for Testing |
| **Built-in SVG** | The frontend ships common app / platform icons, purely local, works offline | Chrome, Firefox, Safari, Edge, WeChat, WeCom, DingTalk, Postman, Figma, Flutter, OkHttp, Alamofire, CFNetwork, curl, Node, iOS / Android / Windows… |
| **Default icon** | All other names: a theme-neutral initial-letter color block (light gray on dark / dark gray on light, adapts to light/dark theme, no more random colors) | `demo-app 2.0.0`, `reader 3.2.1`, and phone apps when no package name is available |

- Icons are batch-resolved via `GET /api/app-icons?names=A,B`, converted only once (cache files hashed by bundle path, different names of the same app reuse one image),
  served by `/app-icon/<hash>.png`; the filename is validated against a whitelist and path traversal is rejected.
- Apps not under the standard `/Applications` directory (e.g. Playwright's bundled browser) are registered from the **executable path** recorded in the traffic;
  when async detection lands after first paint, the frontend auto-retries up to 3 times every 12 seconds, and the icon switches from the default to the real one automatically.
- **Icons don't flicker when selecting / filtering**: once a real icon's URL is resolved, subsequent renders (selection, sidebar filter, SSE redraw)
  inline the `<img>` directly when building the DOM — there's no two-stage "color block first, then swap in the real image".
- Device groups also have icons: a computer for local, a phone for phones, a globe for other IPs, with a unified theme-neutral base color (`--ic-device`),
  the shape distinguishing device type; hover a sidebar item to see the app-name source (local process / UA alias / UA inference).
- Non-macOS systems, command-line tools, and phone apps can't get local icons and fall back to built-in / default icons, **no broken images**;
  if a real image fails to load it falls back to the original. Hover an icon to see whether it's a "local app icon" or a "default icon".

## Console

- **Top-bar proxy address**: LAN IP by default, IP / port / whole string each copiable, ▾ switches multiple interfaces and local loopback (see above)
- **List**: method, path, domain, status, duration; `MOCK` / `REPLAY` / `WS` / `Passthrough` badges distinguish the source
- **Details**: four tabs — Overview / Request / Response / Raw — with auto-formatted, syntax-highlighted JSON;
  both request and response bodies have a "Structured / Raw / Expand all / Collapse all / Copy" toolbar: the structured view merges
  formatting and tree into one — expanded shows indented, colored JSON, clicking ▸ collapses a level into a `{ … N keys }` summary;
  the structured view has line numbers (re-numbered after collapsing), and the body block can go fullscreen with one click (Esc to exit)
- **Binary body**: images (png / jpeg / gif / webp / bmp / ico, sniffed by magic number, not trusting Content-Type) render a **preview** directly;
  other binaries get a **full Base64 text** (no longer just the first 4KB) and a **Hex dump** (first 4KB, offset + hex + ASCII) as two views,
  both copiable / **downloadable** (filename taken from the path with an extension added by type)
- **Header block**: request / response headers highlight on hover line by line, **click a line to copy** `name: value`; key headers (host / content-type / authorization / cookie, etc.) are color-hinted; the block toolbar has "Copy all" (one `name: value` per line) / "Copy JSON" (the whole header object)
- **Raw tab**: request / response messages with **line numbers**, click any line to copy it; toolbar "Copy all" (incl. body) / "Status line and headers only"; binary bodies are omitted in raw view with a hint pointing elsewhere
- **Actions**: replay, Mock this request, copy cURL, copy response body
- **Export** (top bar): downloads the currently filtered flows as a HAR 1.2 file, including complete request / response headers and bodies; no filter means all in-memory flows. Dialogs keep keyboard focus inside them and restore it on close.
- **Rules**: rich editor (see below) — add / edit / delete, enable / disable, reorder, search, copy, JSON import / export
- **JSON editor**: built-in **Monaco Editor 0.52.2** (the same engine as VS Code), vendored locally with no CDN dependency,
  works offline; syntax highlighting, error squiggles (real JSON worker validation), bracket matching, code folding, autocomplete,
  format / minify / fullscreen, light/dark theme and UI font size in sync; falls back to a native textarea on load failure with no feature loss
- **Grouped sidebar** (left): device, app (real process name locally, UA / alias remotely, see above), domain, API structure
  (a normalized path like `GET /api/v1/lesson/:id/card`, multi-segment ids collapsed to `*`). Click an item to filter, groups are collapsible;
  app / device both have icons (real app icon → built-in SVG → default color block, see "Where app icons come from");
  **bookmarks store "filter conditions", not a specific request** — a bookmark still works after the request is pushed out of memory
- **Device grouping**: loopback `127.0.0.1` / `::1` and all local interface IPs (including VPN virtual interfaces) are merged into one **"Local"**,
  no longer split into two devices; the label is determined by IP, independent of UA, so it won't flicker between
  `iOS 127.0.0.1` / `Unknown 127.0.0.1` as new requests arrive. Remote devices are grouped by IP individually,
  the platform name is the most frequent one seen for that device, and with no UA only the IP is shown (no "Unknown").
  Clicking "Local" filters all local sources; details show "Local · original IP", and specific IPs in old bookmarks still work
- **Search**: URL / method / status code / app / device IP / "Local"; filters: errors, JSON, Mock
- **Font size**: top-bar `A− / A+` steps by 5% (85%–160%), click the middle percentage to reset to 100%, choice stored in localStorage
- **Column widths**: the two vertical dividers between the grouped sidebar / request list / details can both be dragged left/right (turn blue on hover with a visible grip),
  double-click to reset, after focusing use `← →` to nudge 16px (Shift 48px), `Home` to reset; widths stored in localStorage,
  with upper/lower bounds, re-clamped when the window shrinks, handles auto-hidden in the stacked layout on narrow screens
- Shortcuts: `⌘K` search, `↑ ↓` switch requests, `Esc` close dialogs; light/dark toggle in the top-right

## Mock rule editor

Click "Rules" → "+ New rule" in the top bar, or click "Mock this request" in request details (which pre-fills the real response body).

| Tab | What it does |
| --- | --- |
| ① Match conditions | Name / note; method; three match modes — contains / wildcard / regex — with an optional domain restriction; the **match tester** is collapsed by default, expand it and enter a real URL to see live why it hits or misses (which step — method / domain / expression — failed) |
| ② Response settings | Preset chips and a slider for common status code + delay values; Content-Type dropdown; a **visual response header table** (add/remove rows, one-click CORS, two-way sync with raw text) |
| ③ Response body | Monaco editor with a toolbar for format / minify / validate / copy / import file / clear / fullscreen; a bottom status bar shows whether the JSON is valid, the error line number, byte count, cursor line/column; below the editor is a "My Templates" popover: save / select / delete **custom templates** (persisted in localStorage, same-name overwrite), one click replaces the response body and syncs the status code |
| ④ Preview / test | A preview of the actual HTTP message the client receives (status line + headers + colored body), a collapsible JSON structure tree, expand all / collapse all |

`note` and `bodyType` are stored with the rule in `data/rules.json`.

- The response body **doesn't have to be valid JSON**: switch to "Plain text / HTML / XML" to skip validation and save any content; in JSON mode a syntax error blocks saving and jumps to the error line.
- The rule list supports search, duplicate, move up / down to change priority, enable / disable, edit, delete; **Export JSON** can be copied / downloaded,
  **Import JSON** pastes a rule array and requires two confirmations before overwriting (to avoid accidents).
- Shortcuts: `⌘⇧F` format in the response body, `⌘F` find; in fullscreen `Esc` exits fullscreen first.
- "Save as copy" and "Delete rule" appear only when editing an existing rule; rules opened via "Mock this request" default to path-contains matching.

## Some design trade-offs

- **Capture toggle decoupled from Mock**: turning off "capture" only stops recording, rules still apply — handy when you care about behavior, not logs.
- **2MB body cap**: larger bodies are truncated and flagged, so one big file response can't eat all the memory.
- **Upstream certificates not verified by default** (`rejectUnauthorized: false`): corporate proxies and self-signed test environments just work, at the cost of the tool not being a security boundary.
- **ALPN negotiates `http/1.1` only**: Node's built-in http server doesn't parse h2 frames, so clients fall back to 1.1. **Services that force h2 (gRPC, some HTTP/2-only services) won't connect** — a known gap vs Reqable.
- **Decrypt 443 only (configurable)**: other ports use a raw tunnel. Decrypting non-HTTP protocols too (MQTT 8883, IMAP 993…) would make apps fail to connect — the classic "Reqable works, iReq doesn't" cause.
- **Streaming request bodies**: forwarded as they arrive, so an 8MB chunked upload won't stall; recorded on the side at the same time (up to 2MB).
- **Keep-alive 65s**: Node's default is 5s; apps reusing connections tend to hit a just-closed socket, showing up as "occasionally can't connect".
- **Self-loop protection**: if the target points at the proxy itself, `GET /`, `/ca.pem`, `/ca.cer` are served as the local install page;
  other requests return `508 Loop Detected` to prevent infinite self-forwarding. Opening the proxy port with `https://` returns a clear 403 telling you to use `http://`.
- **WebSocket**: the handshake is detected and recorded, frames pass through as a raw tunnel, no decryption.
- **Console listens on localhost only by default** (127.0.0.1), while the proxy listens on 0.0.0.0 so phones can connect. The console has no auth — don't change it to 0.0.0.0 on a public network.
- **Clear also archives today's capture**: clicking "Clear" doesn't just clear memory, it also renames the day's `flows-YYYY-MM-DD.jsonl` to
  `.cleared-<timestamp>`. Otherwise restoring history on restart would "resurrect" everything you just cleared. Archived files aren't auto-loaded,
  open them manually to look back later; if you don't want them, just delete them.
- **Taking over the local system proxy means the exit must restore it exactly**: just setting the proxy state to off isn't enough — macOS keeps
  `Server/Port` even when off, plus the bypass domains we added — so the next time the user manually enables the proxy it connects to an already-stopped iReq.
  So a full snapshot is saved to disk before enabling, and on release the host/port and bypass domains are written back together; `localhost / 127.0.0.1 / ::1 / *.local`
  must be bypassed, otherwise the console's own requests loop back into the proxy.

## Directory structure

```
bin/iReq.js      CLI entry / arg parsing / startup banner
src/ca.js            Root CA and per-domain leaf certificate issuance (node-forge)
src/ca-trust.js     macOS root CA trust detection + sudo-free trust command (verify-cert / Keychain)
src/proxy.js        MITM core: CONNECT, TLS handshake, forwarding, recording, Mock responses
src/derive.js       Derives device, app, API structure from UA / path; UA aliases and source-port extraction
src/process-map.js  macOS: TCP source port → PID → real app name (lsof snapshot + cache)
src/app-icon.js     macOS: app name → .app → real icon PNG (plutil + sips, cache + path whitelist)
src/local-address.js Local address normalization (loopback / ::ffff: / all interface IPs → local)
src/bookmarks.js    Bookmark storage (data/bookmarks.json)
src/rules.js        Mock rule matching engine (data/rules.json)
src/store.js        Traffic storage (in-memory ring + JSONL persistence + SSE events)
src/replay.js       Replay
src/server.js       REST API + static pages
src/system-proxy.js Local system proxy takeover (status/on-off/backup-restore, macOS networksetup)
public/             Console (vanilla JS, no framework); app-icons.js built-in SVG icons + real icon backfill
tools/              Dev self-check scripts (_seed.js generates test traffic, see "Development self-checks")
```

## API (for scripting)

```
GET    /api/status            includes lan: ["192.168.1.23"], lanInfo: [{ip, iface}], proxyPort, caTrust, safeMode
GET    /api/flows?q=&method=&status=error|ok|json&mocked=1&host=&ip=&app=&route=&limit=
GET    /api/export/har?...      Same filters → HAR 1.2 download (Content-Disposition + X-Flow-Count)
GET    /api/export/json?...     Same filters → raw flow array with headers / bodies
GET    /api/facets              { flows, hosts, apps, devices, routes }
GET    /api/app-icons?names=A,B   Batch-find real icons by app name → { "A": {url, bundle}, "B": null }
GET    /app-icon/<hash>.png      Icon file (only hash filenames inside data/app-icons/)
GET    /api/diagnostics         { tlsFailures: [{host, count, error}], tunneled, stats }
GET    /api/system-proxy        Local system proxy status + copiable on/off commands + caTrust/safeMode
POST   /api/system-proxy        { enabled: true|false, service? } take over / release
GET    /api/ca-trust            Local root CA trust status + copiable trust command (with 30s cache)
POST   /api/ca-trust            Force re-check and sync to proxy (resumes HTTPS decryption after trust)
GET    /api/bookmarks           POST /api/bookmarks { label, filter }   DELETE /api/bookmarks/:id
GET    /api/flows/:id
DELETE /api/flows
POST   /api/flows/:id/replay      { method, url, headers, body }
GET    /api/rules
POST   /api/rules                 { name, method, urlMatch, matchMode, host, status, delayMs, headers, body }
PUT    /api/rules/:id
POST   /api/rules/reorder         { ids: [] }
DELETE /api/rules/:id
GET    /api/config  PUT /api/config   { capture, passthrough: [], mitmPorts: [443], maxFlows,
                                        processMap: true, uaAppMapText: "okhttp=MyApp" }
GET    /api/events                SSE: flow / flow-update / clear
                                  (flow-update is the async local process name backfill, only app/appSource/process change)
GET    /ca.pem                    Root CA (served by both the console and the proxy port)
```

Example: create a 500 Mock from a script

```bash
curl -X POST http://127.0.0.1:9091/api/rules -H 'content-type: application/json' -d '{
  "name": "Server error", "method": "GET", "urlMatch": "/api/v1/home", "status": 500,
  "headers": {"content-type":"application/json"}, "body": "{\"code\":500}"
}'
```

## Development self-checks

With the service running (`node bin/ireq.js start`) you can run these directly. UI scripts all generate test traffic through the proxy themselves via `tools/_seed.js`,
so they don't depend on the console happening to have data; each script prints a per-item ✅/❌ at the end.

`npm run check` runs the read-only suites in sequence and prints a summary. All scripts take their addresses from
`tools/_env.js`, so point them at a specific instance with `REQLITE_UI_PORT=9294 REQLITE_PROXY_PORT=9293 npm run check`
(defaults: 9091 / 9090) — this avoids a stale service producing a false green.

```bash
npm run check                   # one-shot summary (excludes suites that change the macOS system proxy)
node tools/check-i18n.js        # English dictionary: orphan keys / uncovered Chinese UI text (no service needed)
node tools/check-store.js        # persistence / restart recovery / clear doesn't resurrect (pure unit, temp dir)
node tools/check-proxy.js        # plaintext forwarding, non-443 passthrough, 8MB streaming upload, keep-alive reuse, MITM, pinning diagnostics, capture toggle
node tools/check-dom.js          # statically check that every #id referenced by app.js exists
node tools/check-empty-state.js  # empty state show/hide, list/detail font size, header alignment
node tools/check-scale.js        # 85%–160% zoom, bounds, persists on reload, clipping and overflow
node tools/check-sidebar.js      # five sidebar groups, filtering, bookmarks, collapse, narrow-screen drawer
node tools/check-splitters.js    # two vertical splitters: drag / hit area / clamping / persistence / reset / keyboard (30 items)
node tools/check-device.js       # 127 + local interface IPs merged into "Local" / label doesn't flicker / filter matches details (40 items)
node tools/check-mock-editor.js  # Monaco loading / JSON worker validation / rich rule form / real Mock hit / import-export / detail coloring (60 items)
node tools/check-scrollbar.js    # light/dark scrollbars (white-bar regression)
node tools/verify-ui.js          # top-bar buttons / dialogs / certificate address
node tools/check-local-proxy.js  # system proxy on/restore round-trip (scutil verifies it really takes effect)
node tools/check-local-ui.js     # console "Local capture" button click round-trip
node tools/check-local-traffic.js# end-to-end: local browser requests really enter the list (clientIp=127.0.0.1)
node tools/check-app-name.js     # real local process name / HTTPS decryption / UA alias / remote not mislabeled / async backfill
node tools/check-app-icon.js     # local .app icon extraction / PNG cache / API / three-layer fallback / rendering / no flicker on select (56 items)
node tools/check-ca-trust.js     # trust detection / safe mode branch / passthrough trace / guidance UI (42 items)
node tools/check-address.js      # top-bar default LAN IP / three copy ways / switch persistence / sync everywhere / dark and narrow screens (35 items)
```

`check-proxy.js` temporarily changes `passthrough` / `mitmPorts` and restores them itself; `check-empty-state.js` performs one clear;
`check-app-name.js` temporarily disables process detection and writes a UA alias, restoring them in a finally block.
`check-ca-trust.js` doesn't change system settings or touch the real `data/`: it spins up a separate proxy in a temp dir to verify safe mode.
`check-address.js` only reads server state; the empty state is triggered via the page's in-memory `S.flows`, without touching real traffic data.
`check-splitters.js` only changes browser localStorage (an isolated context, so it won't pollute your own console settings) and leaves the proxy state alone.
`check-device.js` sends one real request using a local interface IP as the TCP source address; the unit part uses a temp dir.
`check-mock-editor.js` creates a test rule, copies / reorders / toggles it, generates a set of self-check traffic, and verifies
Mock hits with a real proxy request; in a finally block it deletes the test rule, restores the original rule order, and clears test traffic (archive kept).
The unit part of `check-app-icon.js` generates icons in a temp dir and deletes them at the end; the API / UI parts only generate and clear test traffic,
and the real service's `data/app-icons/` cache is kept (generated on first resolution of an app, reused afterwards).
⚠️ `check-local-proxy.js` / `check-local-ui.js` **require the system proxy to be off before running** (they turn it on and restore it exactly themselves);
if the console is currently "Taking over local", first release with `POST /api/system-proxy {"enabled":false}`, then re-take over with
`POST /api/system-proxy {"enabled":true}` after the run, otherwise it'll be judged as a wrong precondition.
The three `check-local-*.js` will **briefly switch the system proxy to 9090** (about 1–3 seconds) and restore it exactly in a finally block;
make sure the iReq service is listening before running, and don't kill the script midway.

## Installation notes (first launch on macOS)

iReq is currently not signed / notarized with an Apple Developer certificate, so the macOS package downloaded from GitHub Releases will show
**"iReq" is damaged and can't be opened** on first launch — Gatekeeper's quarantine flag on an unnotarized app; the app itself is fine.
After dragging the app into "Applications", run this once in a terminal:

```bash
xattr -cr /Applications/iReq.app
```

It will then open normally. Windows (SmartScreen) and Linux AppImage may show similar prompts; just allow it to run the same way.

## Known limitations

- The persisted JSONL includes request/response bodies (up to 2MB each), so files grow quickly under heavy traffic; use `--no-persist` to disable persistence.
- Long-lived streaming responses (SSE / chunked) are forwarded in real time, but only recorded after the response ends.
- HTTP/2 is not deframed; it falls back to 1.1.
- No WebSocket frame-level decryption, no HAR export (can be added if needed).
- **Remote devices such as phones have no process / package name** — only UA inference or UA aliases (see "Where app names come from").
- Local process detection is macOS-only; Linux / Windows would each need `netstat + /proc` / `GetExtendedTcpTable`.
  Very short connections that close immediately may miss the `lsof` snapshot and keep the UA-inferred app name.

## License

MIT
