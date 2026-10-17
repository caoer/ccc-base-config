---
requires: ["bin:npx"]
---

# rea

REA (`rea-agents`): the reverse-engineering workbench for agents — native
binaries (Hopper/Ghidra/IDA), JS/Electron, websites, .NET, Android APKs,
firmware, EVM bytecode; every finding returns with its evidence. Analysis runs
locally on the seat's host; static JS and .NET need no engine, native binaries
need a disassembler present.

Listed on the GLM security worker pages only — security-wiki work runs on the
GLM cos launchers. The version is pinned; read the changelog before bumping
(6.0.0 changed MCP filesystem inputs to absolute host paths).

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "rea-agents@6.5.0", "mcp"]
}
```
