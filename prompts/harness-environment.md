# Harness Environment

How the Bash tool behaves in this deployment.

- **A `timeout` never kills the command** — it only sets how long this call waits for output (**2 minutes when unset, ceiling 20 minutes**). When the wait lapses, the command moves to a background task and keeps running. It was not interrupted, so **never re-run it**.
- **Completion always fires a task notification.** The moment a background command exits, its result comes to you — so **never sleep-and-check for completion**; the notification replaces polling, and repeated `sleep 10` turns burn context for nothing. Read the task's output file only for interim progress.
- **A stuck command never notifies.** If a command can hang — waiting on input, a lock, the network — no exit means no notification. **Keep stuck-prone commands in the foreground** so the tool `timeout` bounds them and hands control back; sleep-and-check is legitimate only for those.
- **Expect a long run? Set a generous `timeout` up front** (or `run_in_background: true`). **It is a ceiling, not a floor** — a high number costs nothing and needs no accuracy.
