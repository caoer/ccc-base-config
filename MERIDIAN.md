---
description: the UCC launch config — the filename ladder of markdown launch pages, their MCP server definitions and the fleet deny list, read by launch.mjs before any hook fires
type: meridian-root
version: 1
name: ucc-config
---

# ucc-config

This root's **self-declaration**: the canonical name this tree answers to in a
cross-root address (`ucc-config:launch/default.worker.md`).

A machine's `~/MERIDIAN.md` **binds** a name to a path; it does not baptize the
root. Binding alone is not enough — a mount whose target carries no
self-declaration stays `grey(undeclared)` and every read of it refuses, so this
file is the half that makes `ucc-config:` resolvable.

Read by meridian-rs `crates/config/src/mount.rs`. Additive: nothing in the
launcher reads it, and removing it only returns this root to
`grey(undeclared)`.

**Machine-local, not shipped.** The launch-config bundle carries the launcher,
the pages, the MCP files, `fleet.md` and `GUIDE.md` — nothing else. This file
and `pools.local.json` are the two things that live only in an installed
`$UCC_HOME/config`. Giving another machine the same root takes both halves
there too: this file, and a `ucc-config` mount block in that machine's
`~/MERIDIAN.md`.
