# Launch config — guide

This directory decides what every `ucc-*` launch gets: which model, which
system prompt, which flags. Two files do the work.

| File | What it is |
|---|---|
| `rules.ts` | **The config.** Pure data — tables you edit. Nothing in it runs. |
| `launch.ts` | The engine. Reads the tables, answers them against the machine, prints flags. You rarely open it. |
| `prompts/*.md` | The system prompts. Written elsewhere; only pointed at from `rules.ts`. |

Everything else is generated or supporting: `matrix.golden.txt` (a rendered
snapshot of the whole config), `matrix-viewer.html` (the debug page template),
`launch.test.ts`, `.rendered/` (gitignored scratch).

## How one launch is decided

Three steps, always in this order:

1. **defaults** — effort `xhigh`, verbose off.
2. **the router** — the first matching route in `routes` wins and names an
   **arm**. An arm is a `(model, prompt)` pair.
3. **layers** — every matching layer applies, in order, on top.

Then two rules run over the result:

- **Every claude id carries `[1m]`.** Without it the session reports a 200k
  context window. The router strips the postfix before matching, so a route
  says `claude-opus-5` and both spellings reach it.
- **A profile with `ANTHROPIC_BASE_URL` gets no `--model` at all.** It points
  at someone else's API, which serves its own models. The profile's own
  `ANTHROPIC_MODEL` applies instead. A `pin`ned arm is the exception — pinning
  states that we know that endpoint's id.

`layers` is empty today. A role gets a whole prompt, not a base plus an
overlay, so nothing needs to apply on top of an arm.

## What the fleet does now

| Launch | Model | Prompt |
|---|---|---|
| advisor | `claude-fable-5[1m]` | `fable-5-calibration.advisor.md` |
| leader | `claude-opus-5[1m]` | `opus-5-stance.leader.md` |
| worker | `claude-opus-5[1m]` | `opus-5-stance.worker.md` |
| no role | `claude-opus-5[1m]` | `opus-5-stance.md` |
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
pool. A pool keeps the account list in one place instead of inline in routes.

```ts
export const pools = { FABLE_SPENT: ["does_bannock_6u"] };
```

**Add an endpoint that speaks its own ids.** Give the arm `pin: true`, which
means the requested model is ignored and this id is always sent.

## Who calls this

Two callers, one contract. Both pass a JSON object and read back
`{ argv, model_matched, trace, warnings }`.

- **`ucc-<profile>`** (the bash wrapper) sends `harness`, `project`, `profile`,
  `model`. It never sends `role`. It runs the shared node.
- **`ccc-tmux spawn-agent`** sends the same plus `role`. It runs bun.

`model_matched` tells the caller whether our argv carries a real `--model`, so
it knows to drop its own. When we emit none — an endpoint profile — the
caller's own `--model` survives, which is what makes an explicit override work.

If this script fails, the wrapper launches without rendered config and says so
on stderr. `ccc-tmux` refuses to spawn a fleet agent rather than launch one
with the wrong model.

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

`matrix.golden.txt` is the whole config rendered. Any rules change shows up as
a readable diff there, so regenerate it in the same commit:

```bash
bun launch.ts matrix --models ",claude-opus-5,claude-opus-4-8[200k],sonnet" > matrix.golden.txt
```

## Pending: the bash cutover

`rules.ts` carries a `launcherDefaults` table — the shared system prompt, the
`.mcp.json`, the ccc-statusd and MiniMax MCP configs, and
`--disallowedTools=WebSearch`. The bash wrappers still inject all of that
today, so the table is **off** (`OWN_LAUNCHER_DEFAULTS = false`). Turning it on
before the bash is cut over would double every `--mcp-config`.

Preview the flipped state without flipping it:

```bash
bun launch.ts explain --own-defaults --role worker
bun launch.ts matrix  --own-defaults
```

The cutover order is written at the top of that table in `rules.ts`.
