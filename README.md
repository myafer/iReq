[简体中文](README.zh-CN.md) | **English**

# iReq

A lightweight, cross-platform HTTP(S) **capture / Mock / replay** tool. One `npm install`, one command to start the server, and you work in the browser.

> Positioning: the thing to reach for when you want to debug one API and don't want to fire up a full-featured suite. Cross macOS / Windows / Linux,
> pure Node core with no native dependencies; the optional desktop app wraps the same core in an Electron window.

## What it can do

| Capability | Description |
| --- | --- |
| HTTPS decryption | Root CA pinned to `~/.ireq/ca` (generated once, reused across upgrades), dynamically issues leaf certificates per domain (397-day validity + SAN, meeting Apple's requirements) |
| Capture | Full records of plaintext HTTP and decrypted HTTPS: method, URL, headers, body, status, duration, size |
| Live view | Console pushes via SSE; **the moment a request starts** it appears in both the list and the sidebar (status column shows `…`). The response fills status / duration / body into that same row. New flows insert a single row instead of re-rendering the whole list; "Clear" empties the list and sidebar groups in the same frame |
| Grouped sidebar | Automatically aggregates **device / app / domain / API structure**; one click filters; bookmark frequently used filters |
| Mock | Matches by method + URL (contains / wildcard / regex) + domain, returns custom status code, headers, body; add delay to simulate a slow network |
| Replay | Edit method / URL / header / body and resend; the result is enqueued as a new request and linked to the original |
| Exclude specific domains | Add certificate-pinned apps to the "skip decryption" allowlist and pass them through as a raw tunnel. The allowlist has its own manager (source / added time / pass-through hit count), supports add / search / rename / remove / clear / bulk import, and persists across restarts |
| Decrypt only 443 | **By default only port 443 is decrypted**; other ports pass through untouched (MQTT / IMAP / private binary protocols won't break); add ports in Settings |
| HTTP/2 | The decryption tunnel negotiates h2 via ALPN: **endpoints that only offer h2 (Apple ID auth, gRPC gateways, some CDNs) can now be decrypted**. Traffic is recorded as HTTP/2.0 with multiplexed streams captured individually and filterable; disable in Settings to fall back to HTTP/1.1 |
| Connection diagnostics | Domains with repeated TLS handshake failures are listed (filter under "More ▾"); one-click "add to skip decryption" opens the manager. Details show the classified cause (untrusted cert / HTTP/2-only / reset during handshake / non-HTTP port) plus the raw TLS error, SNI and ALPN. Once a host is allowlisted, its diagnostic row disappears immediately instead of sticking to the top of the list |
| Persistence | Today's traffic is written to `data/flows/flows-YYYY-MM-DD.jsonl`; the most recent 300 entries can be reviewed after restart |
| Export | One-click **HAR 1.2** export of the current filter ("⋯ More → Export HAR", or ⌘K → "export"); full headers / bodies + iReq app / device metadata; raw JSON at `/api/export/json` |
| Instant settings | Settings save automatically as you type (short debounce); closing the dialog flushes pending edits — no Save button to remember |
| Bilingual UI | Defaults to your system language; switch between English and Simplified Chinese under "⋯ More → Appearance" (or Advanced settings) — the choice is remembered |
| Merged title bar (macOS) | The native title bar is hidden: the red/yellow/green buttons sit inside the app top bar, which also acts as the window drag handle. Windows and Linux keep the system title bar |
| Streamlined interaction | Only Capture / Rules / Clear / ⋯ More stay in the top bar; low-frequency tools live in "⋯ More", actions appear next to the selected request (right-click / Network ▾), and ⌘K finds both requests and commands |
| VSCode-style rule workspace | Activity bar + explorer + multi-tab editor + breadcrumb + status bar; clicking a rule opens a tab instead of a modal, several rules can stay open, unsaved edits survive tab switches, with ⌘S / ⌘W / ⌘1..9 |

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
(Other desktop proxies likewise can only rely on UA, or on a device-side VPN). The fix is to write a mapping in
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
  app / device both have icons (real app icon → built-in SVG → default color block, see "Where app icons come from");
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
- **Explorer**: the real `data/rules/` folder tree, a search box, and an "Open Editors" section. Clicking a folder filters the list on the right to that folder (including subfolders); search narrows both the tree and the list. `*.body.*` response files are collapsed by default — `≡` in the toolbar reveals them. Tree rows are keyboard-accessible (`↑ ↓` / `→ ←` / `Enter` / `F2` / `Delete`); right-click or the row's `⋯` opens a context menu (new rule / subfolder here, rename, copy path, delete).
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

## Some design trade-offs

- **Capture toggle decoupled from Mock**: turning off "capture" only stops recording, rules still apply — handy when you care about behavior, not logs.
- **2MB body cap**: larger bodies are truncated and flagged, so one big file response can't eat all the memory.
- **Upstream certificates not verified by default** (`rejectUnauthorized: false`): corporate proxies and self-signed test environments just work, at the cost of the tool not being a security boundary.
- **HTTP/2 via negotiation**: the decryption tunnel uses `http2.createSecureServer`; h2 clients get h2 decryption (streams recorded individually, pseudo/ connection headers stripped, mock / offline / slow applied per stream), and h2-only endpoints no longer fail the handshake. Upstreams are always forwarded over HTTP/1.1 (a clear plaintext boundary). Disable in Settings for pure 1.1. Extended CONNECT (WebSocket over h2) is not supported yet; h2 clients fall back to a 1.1 upgrade automatically.
- **Decrypt 443 only (configurable)**: other ports use a raw tunnel. Decrypting non-HTTP protocols too (MQTT 8883, IMAP 993…) would make apps fail to connect — the classic "other proxies work, iReq doesn't" cause.
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
src/ca.js            Root CA archive (fingerprint check / migration / .p12 import-export) and per-domain leaf issuance (node-forge)
src/ca-dirs.js       Pinned CA dir ~/.ireq/ca + legacy candidate directories
src/ca-trust.js     macOS trust detection / persisted verdict / one-click install (verify-cert / Keychain)
src/proxy.js        MITM core: CONNECT, TLS handshake, forwarding, recording, Mock responses
src/derive.js       Derives device, app, API structure from UA / path; UA aliases and source-port extraction
src/process-map.js  macOS: TCP source port → PID → real app name (lsof snapshot + cache)
src/app-icon.js     macOS: app name → .app → real icon PNG (plutil + sips, cache + path whitelist)
src/local-address.js Local address normalization (loopback / ::ffff: / all interface IPs → local)
src/bookmarks.js    Bookmark storage (data/bookmarks.json)
src/rules.js        Mock rule matching engine (data/rules/**/*.rule.json + *.body.*)
src/network-sim.js  Network simulation: rule normalize/match + byte-rate throttling Transform
src/store.js        Traffic storage (in-memory ring + JSONL persistence + SSE events)
src/replay.js       Replay
src/server.js       REST API + static pages
src/system-proxy.js Local system proxy takeover (status/on-off/backup-restore, macOS networksetup)
public/             Console (vanilla JS, no framework); app-icons.js built-in SVG icons + real icon backfill
tools/              Dev self-check scripts (_seed.js generates test traffic, see "Development self-checks")
```

## API (for scripting)

```
GET    /api/status            includes lan: ["192.168.1.23"], lanInfo: [{ip, iface}], proxyPort, caTrust, caInfo, dataDir, safeMode
GET    /api/flows?q=&method=&status=error|ok|json&mocked=1&host=&ip=&app=&route=&limit=
GET    /api/export/har?...      Same filters → HAR 1.2 download (Content-Disposition + X-Flow-Count)
GET    /api/export/json?...     Same filters → raw flow array with headers / bodies
GET    /api/facets              { flows, hosts, apps, devices, routes }
GET    /api/app-icons?names=A,B   Batch-find real icons by app name → { "A": {url, bundle}, "B": null }
GET    /app-icon/<hash>.png      Icon file (only hash filenames inside data/app-icons/)
GET    /api/diagnostics         { tlsFailures: [{host, count, error, reason, detail}], tunneled, stats, passthrough }
DELETE /api/diagnostics         Clear recorded handshake failures; with ?host=xxx dismiss only that host (and its subdomains)
GET    /api/passthrough         Allowlist manager: { rules: [{rule, source, addedAt, hits, lastHitAt, hosts}], totalHits }
POST   /api/passthrough         { rules: ["a.com", "*.b.com"], source } append (normalize / dedupe / clear diagnostics / drop live MITM connections)
PUT    /api/passthrough         { rules, source } replace all (rename / import)
DELETE /api/passthrough?rule=a.com  remove one; without the parameter, remove all
GET    /api/system-proxy        Local system proxy status + copiable on/off commands + caTrust/safeMode
POST   /api/system-proxy        { enabled: true|false, service? } take over / release
GET    /api/ca-trust            Local root CA trust status + copiable trust command (30s cache; verdict persisted by fingerprint)
POST   /api/ca-trust            { action: "check"|"install" } re-check / one-click install (verifies with verify-cert)
GET    /api/ca/archive           CA archive metadata (fingerprint / path / source) + stale CAs left in the Keychain
GET    /api/ca/p12               Export .p12 backup (with private key; password in x-ireq-p12-password header)
POST   /api/ca/import            { p12: "<base64>", password? } import .p12 and re-check trust
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
                                        processMap: true, uaAppMapText: "okhttp=MyApp",
                                        networkSim: { enabled, latencyMs, kbps, timeoutMs, rules: [{match, mode}] } }
GET    /api/events                SSE: flow / flow-update / clear / tls-failure / tls-remove / tls-clear /
                                  network-sim / passthrough
                                  (flow = in-flight placeholder emitted when the request starts; flow-update = response
                                   completion in place, plus async local process name backfill; clear = list + sidebar reset;
                                   tls-remove = resolved handshake failures after allowlisting / a successful handshake;
                                   passthrough = allowlist change, with rules and the number of dropped connections)
GET    /ca.pem                    Root CA (served by both the console and the proxy port)
GET    /ca.cer                    DER form of the same root CA (for iOS / Android installs)
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
node tools/check-app-cascade.js  # checkbox-style multi-select apps (green check): domain / API cascade, upper groups collapse, legacy bookmarks (27 items)
node tools/check-instant.js      # in-flight records + sidebar sync, in-place completion, same-frame clear, no revive (36 items)
node tools/check-http2.js        # h2 negotiation / multiplexed per-stream records / pseudo-header stripping / mock·offline·slow / filters / fallback off switch (19 items)
node tools/check-splitters.js    # two vertical splitters: drag / hit area / clamping / persistence / reset / keyboard (30 items)
node tools/check-device.js       # 127 + local interface IPs merged into "Local" / label doesn't flicker / filter matches details (40 items)
node tools/check-mock-editor.js  # Monaco loading / JSON worker validation / rich rule form / real Mock hit / import-export / detail coloring (83 items)
node tools/check-rule-workspace.js # activity bar / explorer / multi-tab / unsaved snapshots / shortcuts / breadcrumb / status bar / English UI (28 items)
node tools/check-ca-persist.js   # CA archive self-heal / legacy migration / .p12 round-trip / install command / verdict persistence / shield UI (57 items)
node tools/check-dock.js         # Dock: mock master switch end-to-end bypass / badge counts / pause sync / right-click shortcuts / English UI (28 items)
node tools/check-filterbar.js    # Filter bar: matchStatus semantics / 12 content types through real traffic / UI single-select row counts / English UI (57 items)
node tools/check-scrollbar.js    # light/dark scrollbars (white-bar regression)
node tools/verify-ui.js          # top-bar buttons / dialogs / connection guide address
node tools/check-local-proxy.js  # system proxy on/restore round-trip (scutil verifies it really takes effect)
node tools/check-local-ui.js     # console "Local capture" button click round-trip
node tools/check-local-traffic.js# end-to-end: local browser requests really enter the list (clientIp=127.0.0.1)
node tools/check-app-name.js     # real local process name / HTTPS decryption / UA alias / remote not mislabeled / async backfill
node tools/check-app-icon.js     # local .app icon extraction / PNG cache / API / three-layer fallback / rendering / no flicker on select (56 items)
node tools/check-ca-trust.js     # trust detection / safe mode branch / passthrough trace / guidance UI (42 items)
node tools/check-address.js      # top-bar default LAN IP / three copy ways / switch persistence / sync everywhere / dark and narrow screens (35 items)
node tools/check-tls-list.js     # handshake failures in the main list: SSE / aggregation / filter / cleared after passthrough / EN mode (19 items)
node tools/check-tls-clear.js    # clearing resolved rows: subdomain cascade / Settings save / dismiss / no resurrection / SSE (30 items)
node tools/check-passthrough-manager.js # allowlist manager: normalization / reason classification / persistence / hit counting / live connection drops / UI / EN mode (49 items)
node tools/check-network-sim.js  # offline / slow / timeout on HTTP + CONNECT, rule matching, panel, sidebar mode switch, SSE, EN mode (33 items)
node tools/check-net-live.js     # one-click offline/slow really works + rule change drops live tunnels + no false positives + status strip (23 items)
node tools/check-simple-ui.js    # top-bar More / filter More / connection guide / Quick Mock / ⌘K palette / context menus (26 items)
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

> Because the build is unsigned / unnotarized, **each freshly downloaded `.dmg` used to overwrite
> `/Applications/iReq.app` brings `com.apple.quarantine` back**, so `xattr -cr` is needed again.
> System authorizations macOS records against the code-signing identity (Keychain access, Accessibility,
> incoming firewall connections, etc.) also expire when the binary changes and must be approved again.
> **The root CA is unaffected**: it lives in `~/.ireq/ca`, is never regenerated on reinstall, and needs no re-trusting.
> Only an Apple Developer ID signature + notarization fully removes these two categories of prompts.

## Known limitations

- The persisted JSONL includes request/response bodies (up to 2MB each), so files grow quickly under heavy traffic; use `--no-persist` to disable persistence.
- Long-lived streaming responses (SSE / chunked) are forwarded in real time; an in-flight record exists from the moment the request starts and stays "in progress" until the connection ends (exports skip unfinished records).
- HTTP/2 is not deframed; it falls back to 1.1.
- No WebSocket frame-level decryption, no HAR export (can be added if needed).
- **Remote devices such as phones have no process / package name** — only UA inference or UA aliases (see "Where app names come from").
- Local process detection is macOS-only; Linux / Windows would each need `netstat + /proc` / `GetExtendedTcpTable`.
  Very short connections that close immediately may miss the `lsof` snapshot and keep the UA-inferred app name.

## License

MIT
