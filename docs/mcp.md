# MCP access (for AI clients)

[← Back to README](../README.md) · [简体中文](mcp.zh-CN.md)

iReq can act as an **MCP (Model Context Protocol) server**: an AI client can read captured traffic, turn a real
response into a mock, and adjust network simulation without you clicking through the UI. **It is off by default, and
even when on it requires a token** — an unauthenticated local port would let any local process (including scripts in a
web page) read your captured traffic.

**Step 1: enable it and create a token**

Console → "Settings › MCP access" → turn on "Allow AI clients" → name the token → pick a scope → create.
The token looks like `ireq_mcp_xxxxxxxx`, is **shown only once**, and only its sha256 hash is stored; revoking kills it
immediately.

**Step 2: connect the client (either way)**

Clients that support Streamable HTTP point straight at the endpoint shown in the panel:

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

stdio-only clients use the bundled bridge (it forwards JSON-RPC verbatim and still authenticates with the token):

```json
{
  "mcpServers": {
    "ireq": { "command": "ireq", "args": ["mcp", "--url", "http://127.0.0.1:9091/mcp", "--token", "ireq_mcp_xxxxxxxx"] }
  }
}
```

You can also put the token in `IREQ_MCP_TOKEN` to keep it out of the config file.

**Two scopes**

| Token | What it can do |
| --- | --- |
| `read` | State, traffic list, flow detail, rule list, settings |
| `readwrite` | All of the above plus create / update / delete rules, mock from a flow, replay, clear flows, network simulation, passthrough allowlist |

A read-only token does not even see write tools in `tools/list`, and calls are rejected by JSON-RPC (`-32003`).

**Tools**

| Tool | Purpose |
| --- | --- |
| `ireq_status` | Proxy / console ports, LAN addresses, flow and rule counts, CA trust, safe mode |
| `list_hosts` | See the big picture first: host / app / device / route counts, largest first |
| `list_flows` / `get_flow` | Filter traffic by host, app, client IP, route, method, status, keyword or time window; read one flow with bodies |
| `list_rules` / `get_rule` | List rules (optionally per folder) and read a single rule with its body |
| `get_settings` | Capture, decryption ports, allowlist, UA aliases, network-sim parameters |
| `create_rule` / `update_rule` / `delete_rule` | Manage mock rules (contains / wildcard / regex matching) |
| `mock_flow` | Turn a captured request into a mock rule — the "Mock this request" action, scripted |
| `replay_flow` | Replay with a different URL / method / headers / body; the result lands as a new flow |
| `set_network_sim` | Weak network, offline, timeout, with per-app / host / IP rules |
| `set_passthrough` | Read / change the "skip decryption" list (the UI now skips automatically after repeated handshake failures; the tool stays for bulk fixes and cleanup) |
| `clear_flows` | Clear the in-memory flow list |
| `perf_summary` | Aggregate by route / host: P50 / P95 / avg / max / error rate / bytes, plus the slowest requests |
| `list_breakpoints` / `set_breakpoints` | Read / write breakpoint rules (URL contains, method, phase, timeout) |
| `list_scripts` / `save_scripts` | Read / write sandbox script rules (`onRequest` / `onResponse`), compiled before saving |
| `list_alerts` / `set_alerts` | Read / write conditional alerts (status / host / URL / body / latency) |
| `get_hostmap` / `set_hostmap` | Read / write host mapping: only the target machine changes, URL / Host / cert stay |
| `get_redact` / `set_redact` | Read / write redaction (exports, MCP output and `redact=1` only; UI always shows raw) |
| `get_columns` / `set_columns` | Read / write derived columns (up to 4, recomputed immediately) |
| `annotate_flow` | Note / color / pin a flow (merge semantics; all empty clears it) |

When the capture has thousands of flows, don't make the model page through them. Two steps:

1. `list_hosts` (optionally narrowed by `app` / `ip` / `since_seconds`) returns counts for hosts, apps, devices and routes.
2. Then filter precisely with `list_flows`: `host`, `app` (comma-separated), `ip` (client IP, `local` for this machine), `route` (e.g. `GET /api/user`), `method`, `status` (`2xx` / `404` / `error` / `json` …), `query`, `since_seconds` (last N seconds, `0` for no limit), `only_mocked`.

`list_flows` returns both `total` (all matches) and `returned` (this page); `has_more: true` means there are more — narrow the filters or raise `limit` (max 200).

**Security notes**

- Plaintext exists only in the create response; `config.json`, `/api/config` and `/api/mcp` never expose hashes or salts
- Constant-time comparison; invalid, revoked and expired tokens all return the same 401
- 240 calls per token per minute, then 429
- Requests carrying a non-local `Origin` are rejected with 403 (DNS-rebinding protection)
- Every call, including failures, is audited with time, token, tool and duration
- Turning MCP off makes `/mcp` return 403 immediately and invalidates all tokens
