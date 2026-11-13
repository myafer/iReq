# Development and internals

[← Back to README](../README.md) · [简体中文](development.zh-CN.md)

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
- **Clear leaves a history entry**: clicking "Clear" doesn't just clear memory, it renames the day's `flows-YYYY-MM-DD.jsonl` to
  `.cleared-<timestamp>` and registers an entry in `data/history.json` (named after the moment you cleared). Otherwise restoring
  history on restart would "resurrect" everything you just cleared.
  - **Those archives are never auto-deleted**: they are the "History" entries in the sidebar, and deleting them is the user's call —
    auto-pruning would silently erase something they can see. Disk usage shows at the bottom of the sidebar group and in Settings.
  - **Replay reads backwards from the end of the file in 64KB chunks**: archives reach hundreds of MB, and reading the whole file
    into memory before slicing it makes every click stall. The cursor is a byte offset, not a line number — line numbers mean
    counting from the top, which gets slower the further back you go.
  - The count is computed on the first open (honouring the active filters) and cached in the index.
- **Only daily files are capped**: `flows-YYYY-MM-DD.jsonl` is invisible to users, so keep the last 7 within 200MB, oldest dropped
  first (also checked on startup). Uncapped, a few hundred MB a day adds up to gigabytes within a week.
  Settings › Advanced shows the current data folder size and file count.
- **Taking over the local system proxy means the exit must restore it exactly**: just setting the proxy state to off isn't enough — macOS keeps
  `Server/Port` even when off, plus the bypass domains we added — so the next time the user manually enables the proxy it connects to an already-stopped iReq.
  So a full snapshot is saved to disk before enabling, and on release the host/port and bypass domains are written back together; `localhost / 127.0.0.1 / ::1 / *.local`
  must be bypassed, otherwise the console's own requests loop back into the proxy.

## Development self-checks

With the service running (`node bin/ireq.js start`) you can run these directly. UI scripts all generate test traffic through the proxy themselves via `tools/_seed.js`,
so they don't depend on the console happening to have data; each script prints a per-item ✅/❌ at the end.

`npm run check` runs the read-only suites in sequence and prints a summary. All scripts take their addresses from
`tools/_env.js`, so point them at a specific instance with `REQLITE_UI_PORT=9294 REQLITE_PROXY_PORT=9293 npm run check`
(defaults: 9091 / 9090) — this avoids a stale service producing a false green.

```bash
npm run check                   # one-shot summary (excludes suites that change the macOS system proxy)
node tools/check-repo-meta.js    # Repo metadata: issue form structure / blank issues off / triage holds issues-only permission (22 items, no service)
node tools/check-onboard.js       # First-run guide: shows once / three steps / feedback link / dismissed state persisted (16 items, spins its own throwaway instance)
node tools/check-i18n.js        # English dictionary: orphan keys / uncovered Chinese UI text (no service needed)
node tools/check-store.js        # persistence / restart recovery / clear doesn't resurrect (pure unit, temp dir)
node tools/check-proxy.js        # plaintext forwarding, non-443 passthrough, 8MB streaming upload, keep-alive reuse, MITM, pinning diagnostics, capture toggle
node tools/check-dom.js          # statically check that every #id referenced by app.js exists
node tools/check-empty-state.js  # empty state show/hide, list/detail font size, header alignment
node tools/check-scale.js        # 85%–160% zoom, bounds, persists on reload, clipping and overflow
node tools/check-sidebar.js      # five sidebar groups, filtering, bookmarks, collapse, narrow-screen drawer
node tools/check-app-cascade.js  # checkbox-style multi-select apps (green check): domain / API cascade, upper groups collapse, legacy bookmarks (27 items)
node tools/check-instant.js      # in-flight records + sidebar sync, in-place completion, same-frame clear, no revive (36 items)
node tools/check-http2.js        # h2 negotiation / multiplexed per-stream records / pseudo-header stripping / mock·offline·slow / filters / protocol version in details / fallback off switch (22 items)
node tools/check-splitters.js    # two vertical splitters: drag / hit area / clamping / persistence / reset / keyboard (30 items)
node tools/check-device.js       # 127 + local interface IPs merged into "Local" / label doesn't flicker / filter matches details (40 items)
node tools/check-mock-editor.js  # Monaco loading / JSON worker validation / rich rule form / real Mock hit / import-export / detail coloring (83 items)
node tools/check-rule-workspace.js # activity bar / explorer / multi-tab / unsaved snapshots / shortcuts / breadcrumb / status bar / English UI (28 items)
node tools/check-ca-persist.js   # CA archive self-heal / legacy migration / .p12 round-trip / install command / verdict persistence / shield UI (57 items)
node tools/check-dock.js         # Dock: mock master switch end-to-end bypass / badge counts / pause sync / right-click shortcuts / English UI (28 items)
node tools/check-filterbar.js    # Filter bar: matchStatus semantics / 12 content types through real traffic / UI single-select row counts / flyout not clipped / English UI (62 items)
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
node tools/check-tree-fs.js     # file tree as a file manager: inline create / double-click rename / copy-paste / absolute path / reveal (28 items)
node tools/check-mcp.js         # MCP: 403 when off / hashed tokens / handshake / 15 tools / filters / scopes / revoke / Origin / stdio bridge (84 items)
node tools/check-history.js     # history & paging: cursor paging / disk fallback / clear leaves an entry / replay / rename / delete (34 items)
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
