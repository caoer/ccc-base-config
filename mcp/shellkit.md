---
requires: ["exec:${HOME}/.local/bin/shellkit", "env:SHELLKIT_MCP_TOKEN"]
---

# shellkit

The fleet's remote-execution surface — the `ssh` tool: step scripts, fan-out,
file transfer, tmux.

THE GATE IS THE BINARY AND THE TOKEN, NOTHING ELSE — deliberately not the Nix
inventory. Most fleet hosts carry none, and shellkit serves with zero inventory
hosts and still resolves raw user@host targets and `~/.ssh/config` aliases, so
gating on an inventory would delete the server from every host but one. The
release bundles the binary (`.shellkit-pin`, `install_shellkit`); `shellkit mcp
start` is what mints the token.

```json
{
  "type": "http",
  "url": "http://localhost:${SHELLKIT_MCP_PORT:-19222}/mcp",
  "headers": {
    "Authorization": "Bearer ${SHELLKIT_MCP_TOKEN}"
  },
  "timeout": 86400000
}
```
