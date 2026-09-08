---
requires: ["exec:${HOME}/.local/bin/ccc-statusd", "env:CCC_STATUSD_MCP_TOKEN"]
---

# ccc-statusd

The record and tool surface every CCC protocol skill runs on: `read`, `put`,
`sql`, `sub` over the session tree, served by the local daemon over streamable
HTTP.

THE GATE IS THE DAEMON, NOTHING ELSE — the binary exists and its minted token
is exported. The token export is installer-owned (`templates/default-env.sh`)
precisely so it is not one machine's hand-edited `user-env.sh`: a launcher whose
shell lacks it launches an agent with no read/put/sql/sub at all, silently.

```json
{
  "type": "http",
  "url": "http://localhost:${CCC_STATUSD_MCP_PORT:-19223}/mcp",
  "headers": {
    "Authorization": "Bearer ${CCC_STATUSD_MCP_TOKEN}"
  },
  "timeout": 86400000
}
```
