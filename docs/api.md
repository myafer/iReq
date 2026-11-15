# API (for scripting)

[← Back to README](../README.md) · [简体中文](api.zh-CN.md)

This is the same API the console uses, so scripts can drive it directly. Console on `127.0.0.1:9091`, proxy on `9090` by default.
For the MCP endpoints (`/mcp` and `/api/mcp*`) see [MCP access](mcp.md).

```
GET    /api/status            includes lan: ["192.168.1.23"], lanInfo: [{ip, iface}], proxyPort, caTrust, caInfo, dataDir, safeMode
GET    /api/flows?q=&method=&status=error|ok|json&mocked=1&host=&ip=&app=&route=&limit=
GET    /api/flows/page?...      Paged version: same filters + cursor → { flows, nextCursor, hasMore, total, fromDisk }
                                When memory runs out it continues from today's on-disk file (cursor is opaque)
  Extra params:
    body=1                      Also search request / response bodies (default covers URL / method / status / app / IP / process)
    q=body:keyword              Shorthand for "bodies only" — no need for body=1
    sort=duration|size|status   Sort (default is newest first). Sorted results come back in one shot:
                                hasMore=false, nextCursor="" and sorted=true. Not supported while reading from disk
    dir=asc|desc                Sort direction, default desc; missing values (in-flight requests) always sink to the bottom
GET    /api/breakpoints         Config + queue { enabled, timeoutMs, rules, pending: [{id, phase, method, url, status, headers, bodyPreview, editable, at}] }
PUT    /api/breakpoints         { enabled, rules: [{id, phase: request|response|both, match, method}], timeoutMs? }
                                match is "URL contains", * acts as a wildcard, empty matches everything; disabling releases everything held
GET    /api/breakpoints/:id     One held item, full body included
POST   /api/breakpoints/:id     Release: { type:"resume", method?, url?, headers?, body?, status? }
                                Or answer directly: { type:"abort", status, statusText?, headers?, body? }
                                Already-released ids return 404
POST   /api/breakpoints/release-all   Release everything unchanged
GET    /api/hostmap            Domain mapping { enabled, rules: [{ id, from, to, enabled }] }
PUT    /api/hostmap            { enabled, rules } replaced wholesale and persisted across restarts
                               from is the original domain (* wildcard and a path prefix allowed);
                               to is host:port or a full URL (http:// downgrades TLS, a path replaces the prefix)
POST   /api/har?name=xxx       Import a HAR: raw file body (not JSON-wrapped), 64MB / 5000 entries max
                               → { id, file, count, bytes, skipped, total, truncated, name }
                               The import becomes one history snapshot (view / replay / export via /api/history/:id)
GET    /api/flows/:id/body     Raw body bytes: side=req|res (default res), dl=1 forces download
                               ?redact=1 masks textual bodies (binary is left untouched)
GET    /api/flows/:id/messages  WebSocket frames / SSE messages:
                                { id, contentType, pending,
                                  ws: { live, frames: [{seq, dir, op, size, at, fin, masked, compressed, preview, truncated}],
                                        count, dropped, bytes, compressed, protocol, extensions, closedAt } | null,
                                  sse: { live, messages: [{i, at, event, id, retry, size, preview, truncated}],
                                         count, comments, dropped } | null }
                                While a session is still open the data comes from memory (live=true);
                                once it ends it is read from the stored flow
                               Images and A/V are inlined (content-disposition: inline), everything else is an
                               attachment; a missing or octet-stream content-type is corrected by magic-byte sniffing
GET    /api/history/:id/flows/:flowId/body   Same, for a snapshot entry
GET    /api/history             History list { items: [{id, name, file, count, bytes, createdAt}], stats }
PATCH  /api/history/:id         { name } rename (trimmed, max 60 chars)
DELETE /api/history/:id         Delete one entry (file goes too)
DELETE /api/history             Clear all history
GET    /api/history/:id/flows?...  Replay: same filters + cursor (byte offset), newest first
GET    /api/history/:id/export?format=har|json  Export a whole snapshot (HAR by default)
                                → attachment download with X-Flow-Count / X-Export-Truncated; capped at 50k flows
GET    /api/export/har?...      Same filters → HAR 1.2 download (Content-Disposition + X-Flow-Count).
                                With redaction on the content is masked: log.comment states the count and the
                                x-ireq-redacted response header carries the number
GET    /api/export/json?...     Same filters → raw flow array with headers / bodies
GET    /api/facets              { flows, hosts, apps, devices, routes }
GET    /api/annotations         Annotation stats { total, pinned, noted, colors }
PUT    /api/flows/:id/annotation  { note, color, pinned } merge update (only the fields sent);
                                color is red/orange/yellow/green/blue/purple, empty string clears it
DELETE /api/flows/:id/annotation Remove the annotation
GET    /api/reverse             Reverse proxy status { enabled, port, target, ready, running, url, error }
PUT    /api/reverse             { enabled, port, target } full replace; 400 + error when the port is taken
GET    /api/scripts/templates   Script templates [{ id, name, nameEn, phase, desc, code }]
GET    /api/redact              Redaction { enabled, headers, query, body, pii, extraHeaders, extraFields,
                                 parts, placeholder, effective: {headers, fields, query}, defaults }
PUT    /api/redact              { enabled, headers, query, body, pii, extraHeaderText, extraFieldText } full replace
GET    /api/redact/preview      ?id=<flowId> before/after comparison plus a count;
                                ?draft=1&enabled=1&headers=1… evaluates an unsaved draft
GET    /api/columns             Derived columns { columns: [{id, name, path}] }
PUT    /api/columns             { columns } full replace (max 4; existing traffic is recomputed immediately)
                                path syntax: a.b[0].c / $.a.b / req.body.x / h:header-name
GET    /api/alerts              Conditional alerts { enabled, rules: [...], muted, mutedUntil }
PUT    /api/alerts              { enabled, rules } full replace (max 20 rules)
POST   /api/alerts/mute         { minutes } mute for a while (0 cancels)
GET    /api/scripts             Script rules { enabled, rules: [{id, name, enabled, phase, host, url, method, code, timeoutMs}] }
PUT    /api/scripts             { enabled, rules } full replace; compiles first and returns 400 + errors on syntax errors
POST   /api/scripts/check       { code } compile only → { ok, error, logs, hooks }
GET    /api/perf?by=route|host&same filters as /api/flows    Performance aggregation (per endpoint / host)
GET    /api/overview?same filters as /api/flows    Session overview: counts / duration / bytes / span /
                                                  status / hosts / routes / slowest / largest / errors / contentTypes
GET    /api/overview/report.md?same filters        The same data as a Markdown report (text/markdown +
                                                  attachment name). URLs are masked per the redaction
                                                  settings; x-ireq-redacted carries the masked count
                               → { by, groups: [{ key, count, p50, p95, avg, max, errorRate, noResponse,
                                 serverErrors, clientErrors, bytes, methods, slowest }], groupCount, truncated,
                                 slowest: [{ id, method, path, status, duration }], totals, inMemory }
                               errorRate = (no response + 5xx) / completed flows; 4xx counted separately;
                               in-flight requests are excluded. groups sorted by P95 desc,
                               limit via groups= (default 200, max 500), slowest via slowest= (default 8)
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
GET    /api/flows             ?redact=1 masks credentials (default is raw — the UI needs it to debug)
GET    /api/flows/:id         One full flow (?redact=1 masks too), including timings:
                               { total, dns, tcp, tls, wait, download, reused }
                              (milliseconds; unavailable phases are null; reused connections report 0 for
                               DNS/TCP/TLS with reused=true)
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
                                  network-sim / passthrough / rules-changed / history-changed /
                                  columns-changed / alerts-changed / alert / scripts-changed
                                  (flow = in-flight placeholder emitted when the request starts; flow-update = response
                                   completion in place, plus async local process name backfill; clear = list + sidebar reset;
                                   tls-remove = resolved handshake failures after allowlisting / a successful handshake;
                                   passthrough = allowlist change, with rules and the number of dropped connections)
GET    /api/mcp                   MCP state + tool list + tokens (masked) + recent audit
PUT    /api/mcp                   { enabled } toggle (off by default)
POST   /api/mcp/tokens            { name, scopes: 'read'|'readwrite' } create a token (plaintext returned once)
DELETE /api/mcp/tokens/:id        revoke a token (effective immediately)
DELETE /api/mcp/audit             clear the call audit
POST   /mcp                       MCP endpoint (JSON-RPC 2.0, requires Authorization: Bearer <token>)
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
