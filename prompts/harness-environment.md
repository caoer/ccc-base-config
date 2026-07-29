# Harness Environment

How the Bash tool behaves in this deployment.

- The Bash tool never kills a command. A `timeout` only sets how long the call waits for output; when it lapses, the command moves to a background task and keeps running — the result arrives as a task notification.
- With no `timeout`, the wait is 2 minutes. When it lapses, the command is still running: never re-run it, and never burn turns polling with `sleep`. Read the task's output file, or wait for the notification.
- For a command you expect to run long, set a generous `timeout` up front (ceiling 20 minutes) or start it with `run_in_background: true`. The timeout is a ceiling, not a floor — it does not need to be accurate.
