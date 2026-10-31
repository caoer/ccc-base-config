---
requires: ["env:SURGE_MCP_KEY"]
---

# surge

Surge's own MCP endpoint: status, policies and groups, rules and rule match,
DNS, requests, logs, profile sections, policy tests, diagnostics — the same
surface `surge-cli` drives, as MCP tools (`mcp__surge__get_status`, …). The
key grants full control of Surge, `stop_surge` and `restart_engine` included.

No page lists it: `surge-cli` drives the same commands and its output can be
filtered in the shell, while every MCP result lands in context. Add `surge` to
a page's `mcpServers` to opt in.

THE GATE IS THE KEY. Only a host running Surge exports `SURGE_MCP_KEY` — on
zmax `user-env.sh` reads it from the active profile's `http-api =` line — so
every other host drops the server. The profile must carry `http-api` and
`http-api-mcp = true` in `[General]`; the endpoint is `/v1/mcp` on the
`http-api` port. `SURGE_MCP_PORT` overrides the port when a profile moves it.

```json
{
  "type": "http",
  "url": "http://127.0.0.1:${SURGE_MCP_PORT:-6155}/v1/mcp",
  "headers": {
    "X-Key": "${SURGE_MCP_KEY}"
  }
}
```
