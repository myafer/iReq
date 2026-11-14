[简体中文](README.zh-CN.md) | **English**

# iReq

[![Releases](https://img.shields.io/github/v/release/myafer/iReq?include_prereleases&sort=semver)](https://github.com/myafer/iReq/releases) [![Issues](https://img.shields.io/github/issues/myafer/iReq)](https://github.com/myafer/iReq/issues) [![License](https://img.shields.io/github/license/myafer/iReq)](LICENSE)

A lightweight, cross-platform HTTP(S) **capture / Mock / replay** tool. One `npm install`, one command to start the server, and you work in the browser.

> Positioning: the thing to reach for when you want to debug one API and don't want to fire up a full-featured suite. Cross macOS / Windows / Linux,
> pure Node core with no native dependencies; the optional desktop app wraps the same core in an Electron window.

Going deeper: [API and SSE events](docs/api.md) · [MCP access](docs/mcp.md) · [Development and internals](docs/development.md)

**Hit a problem or have an idea?** [Open an issue](https://github.com/myafer/iReq/issues/new/choose) — bugs, feature wishes, and "this feels awkward" feedback are all welcome, no formal write-up needed. The in-app path is **More ⋯ → Feedback & ideas**.

## What it can do

| Capability | Description |
| --- | --- |
| HTTPS decryption | Root CA pinned to `~/.ireq/ca` (generated once, reused across upgrades), dynamically issues leaf certificates per domain (397-day validity + SAN, meeting Apple's requirements) |
| Capture | Full records of plaintext HTTP and decrypted HTTPS: method, URL, headers, body, status, duration, size |
| Live view | Console pushes via SSE; **the moment a request starts** it appears in both the list and the sidebar (status column shows `…`). The response fills status / duration / body into that same row. New flows insert a single row instead of re-rendering the whole list; "Clear" empties the list and sidebar groups in the same frame |
| Grouped sidebar | Automatically aggregates **device / app / domain / API structure**; one click filters; bookmark frequently used filters |
| Mock | Matches by method + URL (contains / wildcard / regex) + domain, returns custom status code, headers, body; add delay to simulate a slow network |
| Replay | Edit method / URL / header / body and resend; the result is enqueued as a new request and linked to the original |
| Replay diff | Replayed requests get a "Compare" tab: status / duration / size / response headers / body side by side. JSON is compared structurally (`list[2].id: 3 → 4`), plain text line by line |
| Compare any two | No replay relationship needed: set any request as the compare base and every other request can diff against it (handy for "same endpoint before/after login"). The base sits above the list and can be cleared anytime |
| Domain mapping | Point a whole domain somewhere else: `api.example.com → 127.0.0.1:8080`, with no client or hosts changes. URL, Host header and certificate stay on the original domain; supports `*` wildcards and path-prefix rewriting, and persists across restarts |
| Import HAR | Drop a HAR onto the window (or "⋯ More → Import HAR") and it becomes a snapshot in the sidebar — replay, export and diff it like your own traffic |
| Body download | Save request/response bodies as raw bytes; images render inline, and a wrong upstream content-type is corrected by sniffing the magic bytes |
| Breakpoints | Hold a request or response by URL, edit method / URL / headers / body / status, then release — or "Return now" without touching upstream. Auto-releases after 60s; bodies over 2MB can only be passed through unchanged |
| Search bodies | Flip the `body` switch next to the search box to scan request and response bodies too (or type `body:keyword`). Off by default — each body can be 2MB and scanning all of them slows the live list |
| Sort | Click the Status / Time column headers to sort (descending → ascending → back to newest first); "Sort" under the ⋯ menu also offers response size. Live list only |
| Exclude specific domains | Add certificate-pinned apps to the "skip decryption" allowlist and pass them through as a raw tunnel. The allowlist has its own manager (source / added time / pass-through hit count), supports add / search / rename / remove / clear / bulk import, and persists across restarts |
| Decrypt only 443 | **By default only port 443 is decrypted**; other ports pass through untouched (MQTT / IMAP / private binary protocols won't break); add ports in Settings |
| HTTP/2 | Negotiates h2 via ALPN, so **endpoints that only offer h2 can be decrypted too** (Apple ID auth, gRPC gateways, some CDNs); multiplexed streams are captured individually and filterable |
| Connection diagnostics | Domains that keep failing the handshake are listed with a cause (untrusted cert / HTTP/2-only / reset / non-HTTP); one click sends them to "skip decryption" and the row disappears |
| Persistence | Today's traffic is written to `data/flows/flows-YYYY-MM-DD.jsonl`; the most recent 300 entries can be reviewed after restart |
| Export | One-click **HAR 1.2** export of the current filter ("⋯ More → Export HAR", or ⌘K → "export"); full headers / bodies + iReq app / device metadata; raw JSON at `/api/export/json` |
| Instant settings | Settings save automatically as you type (short debounce); closing the dialog flushes pending edits — no Save button to remember |
| Bilingual UI | Defaults to your system language; switch between English and Simplified Chinese under "⋯ More → Appearance" (or Advanced settings) — the choice is remembered |
| Merged title bar (macOS) | The native title bar is hidden: the red/yellow/green buttons sit inside the app top bar, which also acts as the window drag handle. Windows and Linux keep the system title bar |
| Streamlined interaction | Only Capture / Rules / Clear / ⋯ More stay in the top bar; low-frequency tools live in "⋯ More", actions appear next to the selected request (right-click / Network ▾), and ⌘K finds both requests and commands |
| VSCode-style rule workspace | Activity bar + explorer + multi-tab editor + breadcrumb + status bar; clicking a rule opens a tab instead of a modal, several rules can stay open, unsaved edits survive tab switches, with ⌘S / ⌘W / ⌘1..9 |
| MCP access (AI clients) | Optional: use iReq as an **MCP server** so an AI client can read traffic, mock responses and tune network simulation. **Off by default, token-authenticated** (hashes only, shown once, revocable, read vs read+write). [How to connect](docs/mcp.md) |
| History | Every "Clear" leaves one entry — open it in the sidebar to replay that batch (double-click to rename, ✕ to delete). The list **keeps loading as you scroll**: memory holds only the configured count, older requests come from today's on-disk file |

## Quick start

```bash
git clone https://github.com/myafer/iReq.git
cd iReq
npm install          # only one dependency: node-forge
npm start            # proxy 9090, console http://127.0.0.1:9091
```

Don't want to install Node? Download the single-file executable for your platform from [Releases](https://github.com/myafer/iReq/releases)
(macOS arm64/x64, Linux x64/arm64, Windows x64; CI auto-packages on a `v*` tag push), and run it to start the server.

The root CA and private key are generated once and then **pinned to `~/.ireq/ca/`**:
`ca-archive.json` is the fingerprinted archive, while `reqlite-ca.pem` / `.key` are kept for downloads and manual installs.
The desktop build, the single-file CLI and the source build all share the same CA, so **reinstalling, upgrading or switching
distributions never changes the certificate and never requires trusting it again**. CAs left in the old `data/ca/` are migrated on first launch.

**macOS (local debugging)**: the easiest path is "⋯ More → Certificate & connection", step 2, **Install & trust now** —
macOS asks for authorization once and the shield turns green. If that fails, expand "Trust command & status" and run:

```bash
security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.ireq/ca/reqlite-ca.pem"
```

To back up, migrate, or share one CA across machines: click **Export .p12 backup** on the same page (contains the private key;
the import password is shown), then **Import .p12** on the other machine — no need to reinstall the certificate on phones.

**iOS**

1. Point the phone's Wi-Fi proxy to `<Mac's LAN IP>:9090`
2. Open **`http://<Mac's LAN IP>:9090/`** in Safari (note it's `http`, a trailing slash is enough)
   - This page is the install page served by the proxy port itself, giving a download button and per-platform steps; **it works even with the proxy already configured** (the request comes back to the proxy itself, no loop error)
   - Tap "Download certificate (.cer)" → allow the profile download
3. Settings › Downloaded Profile › Install
4. Settings › General › About › Certificate Trust Settings, turn on **iReq Root CA** (many people get stuck here)

> If the browser jumps the address to `https://`, you'll see a "certificate error" — that's caused by **the certificate not being installed yet**, not a wrong address.
> Two fixes: manually change the address bar back to `http://`; or temporarily turn the Wi-Fi proxy off and on. If all else fails, AirDrop / email
> `~/.ireq/ca/reqlite-ca.pem` to the phone and tap to install it.

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
              [-d ./data] [--ca-dir ~/.ireq/ca] [--no-persist] [--no-ui] [--passthrough a.com,b.com] [--max-flows 2000]
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
- The top bar, the empty-state hint, the install-page address in the connection guide, and step 1 of the guide all share the same address source — switch once and everything syncs.
- On narrow screens (< 900px) the top-bar pill is hidden, but step 1 of the connection guide still has the same three copy buttons.
- The server's `GET /api/status` returns `lan` (array of IPs) and `lanInfo` (including the `iface` interface name, private ranges first), ready to use in scripts.

## Capturing local machine traffic (different from a phone)

**An HTTP proxy is not transparent**: a phone is captured once the Wi-Fi proxy is set, but local browsers / desktop apps connect directly by default,
so you must point the "system proxy" at iReq, otherwise the console will only show requests from external devices such as phones.
The `HTTP_PROXY` environment variable only affects command-line programs like curl / node and has no effect on Safari, Chrome, or desktop apps
— that's exactly why "the list is full of other IPs but never `127.0.0.1`".

Easiest: open "⋯ More → Certificate & connection" and click **Enable local capture** in step 3, or click the `Local traffic not captured` shortcut in the top bar.
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

To capture HTTPS you also need to **add the root CA to the local Keychain and set it to "Always Trust"** — one click on "Install & trust now" under "Certificate & connection" does it; see the next section.
If you still see nothing, expand "Manual setup / Still nothing?" in the settings panel: Chrome's QUIC(HTTP/3) bypasses the proxy,
certificate-pinned apps fail the handshake, and command-line programs need an explicit `HTTP_PROXY / HTTPS_PROXY=http://127.0.0.1:9090`.

## Troubleshooting: Chrome says "Your connection is not private" / the list stays empty

These two symptoms often appear together but have different root causes:

| Symptom | Cause |
| --- | --- |
| After taking over local, all HTTPS sites report a certificate error | The machine **does not trust iReq's root CA**; the browser receives a self-signed certificate dynamically issued by iReq |
| No error anymore, but not a single request in the list | System proxy is off / the service isn't running / "safe mode" passed HTTPS through untouched |

**"Installed the certificate" ≠ "trusted the certificate"**. Double-clicking a `.pem` to import it into the Keychain is only "install" —
the trust setting is still the default "Use System Defaults", and Chrome still rejects it. Having installed another proxy tool's CA doesn't help either —
their public keys aren't the same certificate as iReq's. **Install & trust now** on the "Certificate & connection" page does
both steps automatically (user domain, usually no sudo, one authorization prompt). Only if that fails, run manually:

```bash
security add-trusted-cert -r trustRoot \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  "$HOME/.ireq/ca/reqlite-ca.pem"
```

The shield shows trusted / untrusted, the CA fingerprint and the archive path. "Settings › Local capture" shows the same status
and the command with the path filled in — click "Copy trust command", run it, then "Re-check".
The verdict is persisted per CA fingerprint in `~/.ireq/ca/trust-state.json` and reused on startup, so a Keychain hiccup
won't make you reinstall the certificate. Command-line verification (exit code 0 means it's really trusted):

```bash
security verify-cert -c "$HOME/.ireq/ca/reqlite-ca.pem" -p basic -L; echo $?
security dump-trust-settings | grep -A2 'iReq'
```

⚠️ **Don't add `-p ssl` to `add-trusted-cert`**: that creates a restricted "SSL-only policy" trust
(`Number of trust settings : 1 / Policy OID: SSL`); `verify-cert` still reports untrusted and the browser still errors.
A properly trusted CA's `Number of trust settings : 0` (no policy constraint) is the correct one.

**Safe mode**: on startup the tool uses `verify-cert` to check trust status. If it finds "untrusted + the system proxy is taken over by this tool",
port 443 on the local loopback address is **automatically passed through untouched** instead of being decrypted — sites open normally, you just don't see HTTPS plaintext;
the list keeps one CONNECT record with a "passthrough" marker and repair instructions, so it doesn't turn into an empty list that makes you think the tool is broken.
After trusting the root CA, click "Re-check" to resume decryption automatically, no restart needed. This protection applies only to "local + system proxy taken over":
remote devices such as phones, and development / self-check traffic using an explicit `--proxy`, are decrypted as usual.

Other common "nothing shows up" cases: `HTTPEnable/HTTPSEnable` is 0 in `scutil --proxy` (proxy off, click "Take over local"),
no output from `lsof -nP -iTCP:9090 -sTCP:LISTEN` (service not running, `node bin/ireq.js start`),
a filter left active in the console, or Chrome bypassing the proxy via QUIC.

## Console

- **Top bar**: only "Capture / Rules / Clear / ⋯ More" stay visible; certificates, settings, export, network simulation, **skip-decryption manager**, theme, language and font size live in "⋯ More" (the manager shows a badge with the number of rules). The address pill shows the LAN IP by default, with IP / port / full-string copy and ▾ to switch interfaces (see above)
- **Dock** (a permanent strip at the bottom): on the left, the **system proxy takeover state** (● green = taking over `IP:port`, yellow = taking over but HTTPS passing through, gray = not taken over) — click to toggle takeover/release, ✎ opens the connection wizard; on the right, quick toggles: the **Mock master switch** (bypasses all rules at once without touching their content; badge = enabled rule count, right-click opens the rules workspace), **Slow** and **Offline** one-click toggles (a click immediately adds a `*` rule for all traffic, another click removes it; Offline goes red, Slow goes green, right-click opens the detailed settings; badge = active rule count), **Pause / Resume** capture (same state source as the top-bar "Capture" switch) and **Clear**
- **List**: method, path, domain, status, duration; in-flight requests show a neutral grey `…` (subtle pulse, never mistaken for the red error state) and turn into the real status code in place; `MOCK` / `REPLAY` / `WS` / `Passthrough` badges distinguish the source
- **Handshake failures**: when a client rejects the root CA (certificate pinning) or the port is not HTTP, that host appears as a red diagnostic row at the top of the list in real time — aggregated per host with a failure count, so retries never flood the list. The "More ▾ → Handshake failures" filter isolates them; opening a row shows the **classified cause** (plus the raw TLS error, SNI and ALPN) and a one-click "Skip decryption" action, and the ✕ on the row dismisses just that one. Rows stay pinned only while the problem is unresolved: **adding the host to "Skip decryption for hosts" (detail button / context menu / Settings textarea) immediately removes that host and all its subdomains from the backend and every open window**. A later successful handshake clears it too, and a late error from a connection opened before the allowlist cannot bring it back. These are connection-level events, not flows: they stay out of HAR exports and are cleared together with the list.
- **Skip-decryption manager** ("⋯ More → Skip decryption", or "Manage list" under Settings › Advanced / right-click a TLS diagnostic row): every allowlisted host lives in one list showing its **source** (diagnostics / manual / settings / suggestion / existing config), **added time**, **pass-through hit count** and recently matched hosts. Bulk-add from one input (space / comma / newline separated), search, rename in place, remove one, clear all, copy all, plus quick chips for pending failed hosts and a few common system services. Rules match the host and all subdomains, apply immediately, sync to every window over SSE, and are **written to `data/config.json` so they survive a restart**. Adding a rule also drops existing connections that are still being decrypted, so the client reconnects through a raw tunnel. Clicking "Skip decryption" on a diagnostic row opens this manager with the new rule highlighted — hosts no longer vanish after being added.
- **Network simulation** ("⋯ More → Network Simulation", or the sidebar app dot / "Network ▾" in details / right-click a row): match by app / host / IP (or `*` for everything) and apply **Offline** (connection reset at CONNECT / request time), **Timeout** (no response until the deadline), or **Slow** (extra latency + response throttled to a target KB/s; passthrough tunnels throttled at the byte level). Rules are session-only — never written to disk, cleared on restart. Clicking the dot next to a sidebar app switches Normal / Slow / Offline / Timeout in place; the badge shows the active rule count, and changes sync to every window over SSE. Simulated requests are recorded as flows with a mode badge. **A rule change immediately drops affected long-lived connections** (keep-alive / CONNECT tunnels), so the client reconnects under the new rules — no more "Offline is on but the app still works because it reuses an old tunnel". Connections that do not match are left alone. The status strip at the top of the panel shows the current global mode, how many requests were simulated, and how many existing connections the last change dropped.
- **Details**: four tabs — Overview / Request / Response / Raw — with auto-formatted, syntax-highlighted JSON;
  both request and response bodies have a "Structured / Raw / Expand all / Collapse all / Copy" toolbar: the structured view merges
  formatting and tree into one — expanded shows indented, colored JSON, clicking ▸ collapses a level into a `{ … N keys }` summary;
  the structured view has line numbers (re-numbered after collapsing), and the body block can go fullscreen with one click (Esc to exit)
- **Binary body**: images (png / jpeg / gif / webp / bmp / ico, sniffed by magic number, not trusting Content-Type) render a **preview** directly;
  other binaries get a **full Base64 text** (no longer just the first 4KB) and a **Hex dump** (first 4KB, offset + hex + ASCII) as two views,
  both copiable / **downloadable** (filename taken from the path with an extension added by type)
- **Header block**: request / response headers highlight on hover line by line, **click a line to copy** `name: value`; key headers (host / content-type / authorization / cookie, etc.) are color-hinted; the block toolbar has "Copy all" (one `name: value` per line) / "Copy JSON" (the whole header object)
- **Raw tab**: request / response messages with **line numbers**, click any line to copy it; toolbar "Copy all" (incl. body) / "Status line and headers only"; binary bodies are omitted in raw view with a hint pointing elsewhere
- **Actions**: the detail bar has Replay / Mock this request / Network ▾ / Bookmark / Copy cURL; right-clicking a list row opens the same menu, and TLS diagnostic rows offer "Skip decryption".
- **Export** ("⋯ More → Export HAR", or ⌘K → "export"): downloads the currently filtered flows as a HAR 1.2 file, including complete request / response headers and bodies; no filter means all in-memory flows. Dialogs keep keyboard focus inside them and restore it on close.
- **Rules**: the top-bar "Rules" button opens a **VSCode-style full-screen workspace** (folder tree on the left, multi-tab editor on the right); "Mock this request" opens **Quick Mock** first (name / status / delay / body) and "Full editor" for the rich editor below — add / edit / delete, enable / disable, search, copy, JSON import / export, several tabs open at once
- **JSON editor**: built-in **Monaco Editor 0.52.2** (the same engine as VS Code), vendored locally with no CDN dependency,
  works offline; syntax highlighting, error squiggles (real JSON worker validation), bracket matching, code folding, autocomplete,
  format / minify / fullscreen, light/dark theme and UI font size in sync; falls back to a native textarea on load failure with no feature loss
- **Grouped sidebar** (left): device, app (real process name locally, UA / alias remotely, see above), domain, API structure
  (a normalized path like `GET /api/v1/lesson/:id/card`, multi-segment ids collapsed to `*`). Click an item to filter, groups are collapsible;
  app / device both have icons (real app icon → built-in SVG → default color block, see [Where app icons come from](docs/development.md#where-app-icons-come-from));
  **bookmarks store "filter conditions", not a specific request** — a bookmark still works after the request is pushed out of memory;
  **apps are checkbox-style multi-select** (a green check replaces highlight and count). Once any app is checked, the
  bookmark / device groups above collapse, leaving only "app × domain × API structure" combined filtering: the app list always
  shows all apps, domains show only those under the checked apps, and API structures likewise show only what is still in the list
  (cascaded aggregation, refreshed immediately on change)
- **Device grouping**: loopback `127.0.0.1` / `::1` and all local interface IPs (including VPN virtual interfaces) are merged into one **"Local"**,
  no longer split into two devices; the label is determined by IP, independent of UA, so it won't flicker between
  `iOS 127.0.0.1` / `Unknown 127.0.0.1` as new requests arrive. Remote devices are grouped by IP individually,
  the platform name is the most frequent one seen for that device, and with no UA only the IP is shown (no "Unknown").
  Clicking "Local" filters all local sources; details show "Local · original IP", and specific IPs in old bookmarks still work
- **Search**: URL / method / status code / app / device IP / "Local"; below the search box sits a **filter bar** (single-select, groups separated by dividers, scrolls horizontally when narrow):
  **All · HTTP · HTTPS · WebSocket · SSE** ｜ **HTTP1 · HTTP2** ｜ **JSON · XML · Text · HTML · JS · Image · Media · Binary** ｜ **1xx–5xx**;
  Mock, Handshake failures and Error live under "More ▾" (the trigger gets a dot when one is active). Protocol chips use the recorded scheme / httpVersion,
  content chips use the response Content-Type (svg counts as image, event-stream as SSE, missing Content-Type is not binary); frontend and backend share one matcher
- **Font size**: under "⋯ More → Appearance", `A− / A+` steps by 5% (85%–160%), click the middle percentage to reset to 100%, choice stored in localStorage
- **Column widths**: the two vertical dividers between the grouped sidebar / request list / details can both be dragged left/right (turn blue on hover with a visible grip),
  double-click to reset, after focusing use `← →` to nudge 16px (Shift 48px), `Home` to reset; widths stored in localStorage,
  with upper/lower bounds, re-clamped when the window shrinks, handles auto-hidden in the stacked layout on narrow screens
- Shortcuts: `⌘K` opens the **command palette** (search requests and run actions directly, e.g. "offline WeChat", "new rule", "export HAR"), `↑ ↓` switch requests, `Esc` closes overlays; theme / language live under "⋯ More → Appearance"

## VSCode-style rule workspace

Click "Rules" to open a **full-screen workspace** — no more bouncing between a list and a modal dialog:

- **Activity bar** (thin strip on the far left): toggle the explorer, search, new rule, command palette, help.
- **Explorer**: the real `data/rules/` folder tree, a search box, and an "Open Editors" section. Clicking a folder filters the list on the right to that folder (including subfolders) and expands it; search narrows both the tree and the list. `*.body.*` response files are collapsed by default — `≡` in the toolbar reveals them.
- **The tree works like a file manager**: `+ File` / `+ Folder` name things inline right in the tree (no native dialog, identical in the desktop app and the browser); **double-click a file name to rename it in place** (only the label text reacts — double-clicking the icon or the indent still means "open", so renaming never drags a rule tab open); right-click or `⋯` gives **copy / cut / paste here / duplicate / rename / copy path (absolute) / reveal in Finder / delete**, with `⌘C` `⌘X` `⌘V` `⌘D` `F2` `⌫` shortcuts. Copying a rule takes its response body along and assigns a fresh id; repeated pastes auto-number instead of overwriting. "Reveal" opens Finder / Explorer / the Linux file manager depending on the platform.
- **Keyboard**: tree rows accept `↑ ↓` to move, `→ ←` to expand / collapse, `Enter` to open, `F2` to rename, `Delete` to remove.
- **Editor area**: clicking a rule opens a **tab** on the right while the tree stays visible. Multiple tabs can stay open; unsaved edits are kept in memory when you switch, shown as an orange dot, and confirmed before closing. A breadcrumb sits above the editor and a status bar below (rule count / current folder / tab count / save state).
- **Welcome page**: with no tabs open, shows quick actions (new / import / export) and the full rule card list.
- **Shortcuts**: `⌘S` save, `⌘W` close the current tab, `⌘1..9` switch tabs, `⌘K` command palette, `Esc` close the current tab (or leave the workspace when none remain).

Click "+ New rule" or the `＋` on the tab bar for the full editor; "Mock this request" in request details opens **Quick Mock** first (pre-filled with the real response body, only name / status / delay / body), and "Full editor" carries what you typed into the rich interface below. Saving or closing a tab leaves you in the workspace at the same folder.

| Tab | What it does |
| --- | --- |
| ① Match conditions | Name / note; method; three match modes — contains / wildcard / regex — with an optional domain restriction; the **match tester** is collapsed by default, expand it and enter a real URL to see live why it hits or misses (which step — method / domain / expression — failed) |
| ② Response settings | Preset chips and a slider for common status code + delay values; Content-Type dropdown; a **visual response header table** (add/remove rows, one-click CORS, two-way sync with raw text) |
| ③ Response body | Monaco editor with a toolbar for format / minify / validate / copy / import file / clear / fullscreen; a bottom status bar shows whether the JSON is valid, the error line number, byte count, cursor line/column; below the editor is a "My Templates" popover: save / select / delete **custom templates** (persisted in localStorage, same-name overwrite), one click replaces the response body and syncs the status code |
| ④ Preview / test | A preview of the actual HTTP message the client receives (status line + headers + colored body), a collapsible JSON structure tree, expand all / collapse all |

`note` and `bodyType` are stored with the rule in `data/rules/**/*.rule.json`; the response body lives in a matching `*.body.<ext>` file beside it.

- The response body **doesn't have to be valid JSON**: switch to "Plain text / HTML / XML" to skip validation and save any content; in JSON mode a syntax error blocks saving and jumps to the error line.
- The rule workspace supports search, duplicate, enable / disable, edit, delete (all deletes ask for confirmation); **Export JSON** can be copied / downloaded,
  **Import JSON** pastes a rule array and requires two confirmations before overwriting (to avoid accidents). Match priority follows the file tree order (shallow first, then by name), so renaming or moving a file changes it.
- Shortcuts: `⌘⇧F` format in the response body, `⌘F` find; in fullscreen `Esc` exits fullscreen first.
- "Save as copy" and "Delete rule" appear only when editing an existing rule; rules opened via "Mock this request" (Quick Mock → Full editor) default to path-contains matching.

## Installation notes (first launch on macOS)

iReq is currently not signed / notarized with an Apple Developer certificate, so the macOS package downloaded from GitHub Releases will show
**"iReq" is damaged and can't be opened** on first launch — Gatekeeper's quarantine flag on an unnotarized app; the app itself is fine.
After dragging the app into "Applications", run this once in a terminal:

```bash
xattr -cr /Applications/iReq.app
```

It will then open normally. Windows (SmartScreen) and Linux AppImage may show similar prompts; just allow it to run the same way.

> Because the build is unsigned / unnotarized, **each freshly downloaded `.dmg` used to overwrite
> `/Applications/iReq.app` brings `com.apple.quarantine` back**, so `xattr -cr` is needed again.
> System authorizations macOS records against the code-signing identity (Keychain access, Accessibility,
> incoming firewall connections, etc.) also expire when the binary changes and must be approved again.
> **The root CA is unaffected**: it lives in `~/.ireq/ca`, is never regenerated on reinstall, and needs no re-trusting.
> Only an Apple Developer ID signature + notarization fully removes these two categories of prompts.

## Known limitations

- The persisted JSONL includes request/response bodies (up to 2MB each), so files grow quickly under heavy traffic; use `--no-persist` to disable persistence.
- Long-lived streaming responses (SSE / chunked) are forwarded in real time; an in-flight record exists from the moment the request starts and stays "in progress" until the connection ends (exports skip unfinished records).
- HTTP/2 is decrypted via ALPN negotiation (h2 streams are recorded individually and details show "Protocol version: HTTP/2"); upstreams are always forwarded over HTTP/1.1, and extended CONNECT (WebSocket over h2) is not supported yet.
- No WebSocket frame-level decryption. HAR export is supported (**More ⋯ → Export HAR**); unfinished records are skipped.
- **Remote devices such as phones have no process / package name** — only UA inference or UA aliases (see [Where app names come from](docs/development.md#where-app-names-come-from)).
- Local process detection is macOS-only; Linux / Windows would each need `netstat + /proc` / `GetExtendedTcpTable`.
  Very short connections that close immediately may miss the `lsof` snapshot and keep the UA-inferred app name.

## Feedback and contributing

Opening an issue is the most valuable contribution — **you don't need to write code**:

- [Bug report](https://github.com/myafer/iReq/issues/new?template=bug.yml): can't decrypt, empty list, broken UI, crash
- [Feature request](https://github.com/myafer/iReq/issues/new?template=feature.yml): describe the task you were doing and where it got stuck
- Faster in-app: **More ⋯ → Feedback & ideas** goes to the same place

Three ground rules, all to save each other time:

1. **Never paste real cookies, tokens or phone numbers.** Version, platform, the failing host and what you saw is enough to reproduce.
2. **Scenario first, solution second.** "I want status code and delay in one rule" beats "add a combined field to rules".
3. **Every issue gets read.** Labels flow `needs-triage → accepted → shipped`, and release notes say which change came from whose report.

Code contributions are welcome too: open an issue to agree on the approach first, then send a PR. `node tools/check-all.js` must pass — every feature has a matching `tools/check-*.js`.

## Docs

The README only covers "how do I get this running". For deeper material:

- [HTTP API and SSE events](docs/api.md) — scripting, automation, wiring into other tools
- [MCP access](docs/mcp.md) — let an AI client read traffic, mock responses, shape the network
- [Development and internals](docs/development.md) — repo layout, where app names and icons come from, design trade-offs, self-check scripts

## License

MIT
