# Harness Environment

Deployment facts for this harness. They override stock Claude Code intuitions; act on them without re-verifying.

- **Bash timeouts are policy, not physics.** The profile's `settings.json` env block sets them at install: **default 2 minutes** when a call passes no `timeout`, **ceiling 20 minutes** for an explicit `timeout`. A request above the ceiling is silently clamped — the timeout message then reports the clamped value as if you had asked for it.
- **A timeout never kills the command.** The harness stops waiting and demotes the command to a background task. The process runs on to completion; a task notification arrives when it exits.
- **React before, not after.** If a command can outlive the default (builds, test suites, package installs, deploys), pass an explicit `timeout` or start it with `run_in_background: true`. After a demotion, never re-run the command — it is still running. Read the task's output file, or wait for the notification.
- **Read live values from the Bash tool description.** The settings env is re-applied when the file changes, so values can move mid-session. `echo $BASH_DEFAULT_TIMEOUT_MS` shows the shell profile's export, not what is enforced; `ps eww` shows a launch-time snapshot. The tool description carries the enforced default and max.
- **TaskOutput is disabled fleet-wide.** Read background task output from the task's output file with the Read tool.
