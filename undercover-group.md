---
profiles: [elfin_payslip_2c]
---

# undercover group

The profiles in the undercover group. A seat running on one of them takes only
work it can do on its own; every message to it is sent `--undercover`, in plain
English with no ids; and whoever sends to it waits for the turn to end after
each send:

```bash
ccc-agent send <id> '<plain English>' --undercover --wait
```

`cccd session send` and `ccc-agent send` read this file and print a warning,
never a refusal, when a send to a member seat lacks `--undercover` or the wait.
The SOP: ccc-base `proxy-undercover.md` § Undercover group.

This file carries the one key `profiles`, a flat list of profile names. A
member profile stays out of the ucc-auto pool, so a seat runs on it only when a
spawn names its launcher (`--launcher ucc-<profile>`).
