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
  "env": {"JAVA_HOME": "/nix/store/ljhp4g36iax57hiqf5abr5d9g2bhzj9c-zulu-ca-jdk-21.0.11"}
}
```

JAVA_HOME serves the native lane: Ghidra (nix, 12.1.2) needs a 64-bit JDK
21+ and the login shell exports Zulu 17. The value is a nix store path — it
goes stale on the next nix upgrade that rebuilds the JDK; when that happens
the Ghidra provider is rejected with `unsupported_version` and the path needs
re-pointing.
