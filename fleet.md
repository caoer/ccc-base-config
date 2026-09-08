---
disallowedTools: [TaskOutput, Artifact, ReportFindings, ListAgents, ScheduleWakeup]
---

# fleet

The fleet-wide deny list: every launch on every profile drops these built-in
tools, as one `--disallowedTools` flag. Add a name here to take a tool away from
every agent on every machine; a single agent's own extra denials belong on its
page instead.

This file carries that one key and nothing else — `launch.mjs check` refuses
any other.
