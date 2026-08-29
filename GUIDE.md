# Launch config — guide

This directory decides what every `ucc-*` launch gets: which model, which
system prompt, which flags. Two files do the work.

| File | What it is |
|---|---|
| `rules.ts` | **The config.** Pure data — tables you edit. Nothing in it runs. Ships in the UCC package, so nothing user-specific goes here. |
| `launch.ts` | The engine. Reads the tables, answers them against the machine, prints flags. You rarely open it. |
| `prompts/*.md` | The system prompts. Written elsewhere; only pointed at from `rules.ts`. |
| `pools.local.json` | **Per-user pool members** (e.g. which accounts are fable-spent). Local to the machine, gitignored, never touched by the installer. |

Everything else is generated or supporting: `matrix.golden.txt` (a rendered
snapshot of the whole config), `matrix-viewer.html` (the debug page template),
`launch.test.ts`, `.rendered/` (gitignored scratch).

## How one launch is decided

Three steps, always in this order:

1. **defaults** — effort `xhigh`, verbose off, and the fleet-wide
   `disallowedTools` list (an array; every launch drops those tools).
2. **the router** — the first matching route in `routes` wins and names an
   **arm**. An arm is a `(model, prompt)` pair.
3. **layers** — every matching layer applies, in order, on top.

Then two rules run over the result:

- **Every claude id carries `[1m]`.** Without it the session reports a 200k
  context window. The router strips the postfix before matching, so a route
  says `claude-opus-5` and both spellings reach it.
- **A non-Anthropic `ANTHROPIC_BASE_URL` gets no fleet `--model` — none, no
  matter what.** The seat points at someone else's API, which serves its own
  ids, so anything we default — the route arm, or a saved `settings.json`
  `model` — would likely be wrong. The profile's own `ANTHROPIC_MODEL`
  applies, and a TUI `/model` pick still sticks across restarts because the
  harness reads `settings.json` `model` natively when no `--model` flag
  arrives. A URL containing `anthropic.com` counts as Anthropic's own API
  and keeps the fleet rules. Arm effort is dropped with the model (so
  settings `effortLevel` sticks); layers like minimax may still set effort.
  A `pin`ned arm is the exception — pinning states that we know that
  endpoint's id and always send it.
- **The engine judges the seat's env, not the renderer's.** A profile's
  `.env` is sourced over the caller's env at launch, so `render`/`explain`
  overlay the profile `.env` on the caller env before answering env probes.
  A ccc-tmux pre-render from a claude-account shell therefore still sees a
  GLM seat's endpoint and splices no model into it — and a wrapper render,
  which already ran with `.env` sourced, renders identically.

`layers` carries only functional config (the shared `.mcp.json`, the
ccc-statusd MCP, the MiniMax MCP) — each gated by `requires` probes against
the real machine. A role gets a whole prompt, not a base plus an overlay, so
no layer writes prompt text. The old shared-`SYSTEM_PROMPT.md` convention is
gone: the engine owns ALL launch config, and the bash wrappers inject
nothing of their own.

## What the fleet does now

| Launch | Model | Prompt |
|---|---|---|
| advisor | `claude-fable-5[1m]` | `fable-5-ownership.advisor.md` |
| leader | `claude-opus-5[1m]` | `opus-5-ownership.leader.md` |
| worker | `claude-opus-5[1m]` | `opus-5-ownership.worker.md` |
| no role | `claude-opus-5[1m]` | `opus-5-ownership.md` |
| `codex` / `grok` / `kimi-k3-moonshot` | their own pinned id | the fable prompts |
| the other 27 endpoint profiles | none — `ANTHROPIC_MODEL` applies | the opus-5 prompts |

## See what renders

Never guess. The same engine that launches also prints.

```bash
bun launch.ts explain --role worker --profile dewiest_gulp
```
One launch: the rules that fired, in order, then the argv. Reach for this
first when a launch surprises you.

```bash
bun launch.ts --role worker --output shell     # just the flags
bun launch.ts --role worker                    # the JSON the launchers consume
```

```bash
bun launch.ts matrix                     # the profiles rules.ts names
bun launch.ts matrix --all-profiles      # every installed profile (44 today)
bun launch.ts matrix --roles worker      # narrow one axis
bun launch.ts matrix --models ",claude-opus-5,sonnet"
bun launch.ts matrix --cwds "/Users/Shared/projects/caoer/ccc-statusd"
```

Axis flags take a comma list. A leading comma includes the empty case
(no model / no cwd / no profile). Add `--output json` for the raw rows.

```bash
bun launch.ts matrix --all-profiles --html /tmp/m.html && open /tmp/m.html
```
A single self-contained page — no server, no build, no dependencies. Filter
any column, click a row for its argv and full trace, or collapse to distinct
launches. It is a snapshot: edit `rules.ts`, re-run the command.

Each profile in the matrix renders against **its own** `.env`, so
`ANTHROPIC_*` is never inherited from the shell you invoke it from. Rows with
no profile can only reflect your current shell; the table says so in a header
line when that shell is itself an endpoint session.

## Common edits

All of these are one or two lines in `rules.ts`. Re-run `matrix` afterwards to
see what moved.

**Change what a role gets.** Edit its route in `routes`. Routes are ordered and
the first match wins, so read from the top.

```ts
{ when: { noModel: true, role: "leader" }, use: "opus-5:leader" },
```

**Add a model.** Add an arm, then point routes at it. Role variants are
separate arms — the table is long on purpose, so every case is a row you can
read rather than a rule you have to simulate.

```ts
"opus-6": { model: "claude-opus-6[1m]", prompt: "prompts/opus-6.md" },
"opus-6:worker": { model: "claude-opus-6[1m]", prompt: "prompts/opus-6.worker.md" },
```

**Change a prompt.** Point the arm at a different file. Prompts are written
elsewhere and copied in; this directory never edits or assembles prompt text.

**Route by project directory.** `cwd` matches an absolute path (that directory
and everything below it) or a bare word (substring of the path).

```ts
{ when: { noModel: true, cwd: "/Users/Shared/projects/caoer/ccc-statusd" }, use: "opus-5:worker" },
```

**Give one account different treatment.** Add it to a pool, then match the
pool. `rules.ts` only DECLARES pools; members are per-user and live in
`pools.local.json` next to it:

```json
{ "FABLE_SPENT": ["some_profile_3x"] }
```

The fable case is why this file exists: an account can still have credit
while fable is metered separately and unavailable. Listing the profile there
reroutes only its advisor launches to opus-5.

**Add an endpoint that speaks its own ids.** Give the arm `pin: true`, which
means this id is always sent. An explicit `--model` naming a *different* id is
REFUSED (exit 2) — the endpoint cannot serve it, and silently replacing an
explicit request is the launcher fault the refusal exists to kill. A request
for the pinned id itself is honored, and an effort suffix on it (`k3-max`)
becomes the effort.

## Who calls this

Two callers, one contract. Both pass a JSON object and read back
`{ argv, model_matched, trace, warnings }`.

- **`ucc-<profile>`** (the bash wrapper) sends `harness`, `project`, `profile`
  and its whole raw command line as `argv`. The engine derives the requested
  model and the resume flag from `argv`, and never re-emits a flag family the
  caller already used — that is what makes `--system-prompt "."` on the
  command line suppress the arm prompt instead of clashing with it. It never
  sends `role`. It runs the shared node.
- **`ccc-tmux spawn-agent`** sends `harness`, `project`, `profile`, `model`,
  `role` and no `argv`. It runs bun. A spawn's launch is rendered twice — once
  by ccc-tmux, once by the wrapper — and the second render is idempotent: it
  sees every rendered flag in `argv` and adds nothing but the normalized
  model.

On resume (`-r`/`--resume`/`-c`/`--continue` in `argv`) the engine emits no
`--model` and no `--effort` — the session keeps its own — but still emits the
prompt and mcp config. An explicitly requested model on resume is honored.

`model_matched` tells the caller whether our argv carries a real `--model`, so
it knows to drop its own. When we emit none — an endpoint profile — the
caller's own `--model` survives, which is what makes an explicit override work.

If this script fails, the wrapper launches without rendered config and says so
on stderr. `ccc-tmux` refuses to spawn a fleet agent rather than launch one
with the wrong model.

Exit 2 is different from failure: it is a REFUSAL — an explicit `--model` that
a pinned arm cannot serve. stderr names what the endpoint serves and how to
fix the call. The launching wrapper aborts on exit 2, never degrades: it is
the last gate, and degrading there would land the silently-wrong model the
refusal exists to kill. A pre-spawn renderer (ccc-tmux) surfaces the refusal
and splices no model of its own — the pane wrapper re-renders and enforces,
so no path launches a model the request did not name.

The engine must run under **both** the ucc shared node and **bun**, since the
two callers use different runtimes. It relies on node's native TypeScript
stripping, so keep it free of runtime-specific APIs and of syntax that stripping
rejects — no `enum`, no parameter properties. `bun test` checks that node and
bun render identical argv.

## Tests

```bash
bun test launch.test.ts
```

Four levels: the process contract against this real directory, node-and-bun
agreement, the engine against a made-up world, and the golden matrix.

`matrix.golden.txt` is the whole config rendered — against a PINNED world
(`--pinned`: no env, no disk probes) and without local pools, so the file is
identical on every machine. Any rules change shows up as a readable diff
there, so regenerate it in the same commit:

```bash
bun launch.ts matrix --pinned --pools none --models ",claude-opus-5,claude-opus-4-8[200k],sonnet" > matrix.golden.txt
```

## Distribution

This directory ships in the UCC package: the worker repo vendors it at
`worker/launch-config/`, uploads it to R2 with the other templates, and the
installer extracts it to `$UCC_HOME/config/` on every machine. Two rules keep
that safe:

- **Nothing user-specific in shipped files.** Per-user state is
  `pools.local.json`, which the installer never writes.
- **A git checkout wins.** When `$UCC_HOME/config/.git` exists (this
  development machine), the installer leaves the directory alone entirely.
  Sync the vendored copy from here in the same change that edits the rules.
