# API (for scripting)

[← Back to README](../README.md) · [简体中文](api.zh-CN.md)

This is the same API the console uses, so scripts can drive it directly. Console on `127.0.0.1:9091`, proxy on `9090` by default.
For the MCP endpoints (`/mcp` and `/api/mcp*`) see [MCP access](mcp.md).

```
GET    /api/status            includes lan: ["192.168.1.23"], lanInfo: [{ip, iface}], proxyPort, caTrust, caInfo, dataDir, safeMode
GET    /api/flows?q=&method=&status=error|ok|json&mocked=1&host=&ip=&app=&route=&limit=
GET    /api/flows/page?...      Paged version: same filters + cursor → { flows, nextCursor, hasMore, total, fromDisk }
                                When memory runs out it continues from today's on-disk file (cursor is opaque)
GET    /api/history             History list { items: [{id, name, file, count, bytes, createdAt}], stats }
PATCH  /api/history/:id         { name } rename (trimmed, max 60 chars)
DELETE /api/history/:id         Delete one entry (file goes too)
DELETE /api/history             Clear all history
GET    /api/history/:id/flows?...  Replay: same filters + cursor (byte offset), newest first
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
                                  network-sim / passthrough / rules-changed / history-changed
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
