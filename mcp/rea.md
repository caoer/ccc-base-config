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
  "args": ["-y", "rea-agents@6.5.0", "mcp"],
  "env": {"JAVA_HOME": "/nix/store/ljhp4g36iax57hiqf5abr5d9g2bhzj9c-zulu-ca-jdk-21.0.11", "REA_IDA_MCP_CONFIG": "/Users/caoer115/.local/share/ucc/config/mcp/ida-mcp.json"}
}
```

JAVA_HOME serves the native lane: Ghidra (nix, 12.1.2) needs a 64-bit JDK
21+ and the login shell exports Zulu 17. The value is a nix store path — it
goes stale on the next nix upgrade that rebuilds the JDK; when that happens
the Ghidra provider is rejected with `unsupported_version` and the path needs
re-pointing.

REA_IDA_MCP_CONFIG serves the IDA lane (zmax only): it points at
`mcp/ida-mcp.json`, a headless database-supervisor registration of
mrexodia/ida-pro-mcp (`idalib-mcp --stdio`, upstream pinned at c133c385)
against IDA Pro 9.4 (`/Applications/IDA Pro 9.4`). The upstream lives as a
clone + uv venv at `~/.local/share/ucc/tools/ida-pro-mcp` (idalib activated
into that venv); refresh it with `git pull && uv sync && uv run
"/Applications/IDA Pro 9.4/IDA Professional 9.4.app/Contents/MacOS/idalib/python/py-activate-idalib.py"`.
`timeoutMs: 3600000` gives idb_open room for very large targets. The lane is
opt-in — `REA_ANALYSIS_PROVIDER` stays unset, so agents select IDA per call
with `open_binary.provider_id: "ida"`; the default provider is unchanged.
