# Launch config — guide

This directory decides what every `ucc-*` launch gets: system prompt, model,
tools, MCP servers. **The pages are the config**: the launcher builds candidate
filenames from the launch facts and takes the first file that exists, so `ls
launch/` is the whole vocabulary and `explain` prints the list it walked.

| File | What it is |
|---|---|
| `launch/*.md` | One agent definition per launch kind; the body, verbatim, is the system prompt. Symlinks live here too. |
| `mcp/*.md` | One MCP server each: the gate in frontmatter, the server object in the body's first JSON fence. |
| `fleet.md` | The fleet-wide deny list — one key, applied to every launch on every machine. |
| `launch.mjs` | The launcher: `explain`, `check`, and the render the wrappers call. |
| `launch.test.mjs` | `node --test launch.test.mjs` — the same file runs under `bun test`. |

## Quick start

```bash
node launch.mjs check                                    # the whole tree; exit 1 on any error
node launch.mjs explain --role worker --profile <p>      # what one launch gets, and why
node launch.mjs explain --launch heartbeat
ucc-<p> --role leader --launch heartbeat --effort high   # the wrapper reads these
```

## The ladder

Candidates in this order, `X.<role>.md` before `X.md` at each rung; the first
file that exists wins:

1. `<kind>` — only with `--launch NAME`, and then the **only** rung: no file
   for it refuses (exit 2), never falls through;
2. `<model>`, then each shorter dash-prefix (`claude-opus-4-8` →
   `claude-opus-4` → `claude-opus` → `claude`);
3. `@<profile>`;
4. each `<SET>` the profile belongs to — `FABLE_SPENT`, derived from the
   profile's own `ratelimit.json` (a live `7d_oi` window that is refused or
   above 0.9 utilization; the trace line names the reading);
5. `default`.

A name is one condition token plus an optional role: a bare lowercase word is
a kind, `@` prefixes a profile, ALL-CAPS is a set, the last token before `.md`
may be `advisor`, `leader` or `worker`. A name never carries `[1m]`. A page
with an empty body is not a candidate. `ls -l launch/` is the authority for
what exists.

Three consequences of the ladder: a model rung resolves `X.<role>.md` before
`X.md`, so a role gets its own prompt wherever a dash-prefix page has role
variants; an explicit `--model` that no page names runs the `default` page's
prompt with the model asked for — the page carries the fleet MCP servers and
doctrine, plain would lose both; a leader on `--model claude-opus-4-8` runs
that page's roleless prompt, because it has no `.leader` variant.

## A page

```markdown
---
model: claude-sonnet-5[1m]
effort: medium
tools: [Bash, Read, AskUserQuestion]
mcpServers: [ccc-statusd]
---
You are the fleet heartbeat agent: woken, act once, end the turn.
```

Frontmatter is flat — `key: scalar` or `key: [a, b, "c, quoted"]`. Anything
nested, a block list, a multi-line scalar or an anchor is refused with file and
line, by `check` and at launch. The launcher consumes `model`, `effort` and
`mcpServers`; every other key passes into the definition verbatim
(`description`, `tools`, `disallowedTools`, `skills`, `permissionMode`,
`maxTurns`, …). Never write `name`: the definition is named after the resolved
real file's stem, so `agent_type` in a hook payload reads `ucc-launch:<stem>`
and names the page at `$UCC_HOME/config/launch/<stem>.md`.

The definition reaches the harness as a file, not as argv prose. The render
writes it to `$UCC_HOME/cache/launch-plugins/<sha256[:12]>/` — a plugin named
`ucc-launch` holding `agents/<stem>.md` — plus `servers.json` beside it for the
page's MCP servers, and emits `--plugin-dir <dir> --agent ucc-launch:<stem>
--mcp-config=<dir>/servers.json`. The servers ride `--mcp-config` because a
plugin agent drops `mcpServers` and a plugin's own `.mcp.json` renames every
server's tools. The dir is content-addressed and written by atomic rename, so
identical launches share it; files are owner-only (`servers.json` carries
bearer tokens); each render touches its dir and removes siblings unused for 7
days. A seat's `ps` line carries no system prompt — only paths, flags and
the spawn prompt.

The definition rides argv as `--agents <json> --agent <stem>` instead when the
dir cannot be written (trace `argv fallback:`) or the page carries
`permissionMode` or `hooks`, which a plugin agent ignores.

An `mcp/<name>.md` gate: `env:NAME`, `env:NAME~text`, `exec:PATH`, `bin:NAME`,
`file:PATH`; `!` negates, ` | ` is OR inside one string, separate strings AND.
`${VAR}`, `${A|B}` and `${A:-text}` expand inside the fence. An unmet gate
drops the server with a trace line; a name with no file is a `check` error and
a launch warning.

`check` prices every page — `launch/x.md: 12224 bytes, 3798 tokens`, the token
column only when `ccc-statusd` is on PATH — and warns when the definition's
JSON passes 128 KB, Linux's per-argv-element limit, which only the argv
fallback can hit.

## What reaches the harness

| Situation | Result | Where you see it |
|---|---|---|
| `--launch NAME` and no `NAME.md` / `NAME.<role>.md` | **refused, exit 2** | stderr `launch-config: no launch kind` |
| `-p` / `--print` and the model (explicit `--model`, else the page's) is Fable — `fable` or `claude-fable-*` | **refused, exit 2** — Fable runs only as a seat; `UCC_FABLE_PRINT=1` in the seat env admits a run the user asked for | stderr `REFUSED — print mode on …` |
| explicit `--model` differs from the profile's `ANTHROPIC_MODEL` | **refused, exit 2** — never a silently replaced model; ask for effort with `--effort` instead | stderr `REFUSED — --model … cannot be served` |
| profile pins `ANTHROPIC_MODEL` | the page's `model` is dropped; the harness reads the pin natively | trace `pin:` |
| `ANTHROPIC_BASE_URL` set and not `anthropic.com` | the page's model and effort are dropped (the profile's `settings.json` effortLevel keeps its own); an explicit `--effort` still wins; no `ANTHROPIC_MODEL` warns `provision one` | trace `foreign endpoint:` |
| explicit claude id without `[1m]` | `[1m]` appended — without it the session reports a 200k window | trace `normalized to` |
| resume (`-r`, `--resume`, `-c`, `--continue`) | the definition is emitted (prompt and tools); the page's model and effort are not, unless asked explicitly. The launchers (`ucc-auto`, `ucc-<profile>`) on `--resume <id>` read the session's launch record on this host and pass its model, effort and role back where the caller named none — the model only when the profile pins no `ANTHROPIC_MODEL` — and resume in its cwd (`ucc-auto` also prefers its profile). The launch kind is not carried, so a resume that must come back as one names it with `--launch`; `-c`/`--continue`, or a session with no record on the host, carries nothing | trace `resume/continue:`; stderr `ucc: resume <id> … restoring …` |
| the rendered model is known and not Fable, and the caller passed no `--settings` | **the seal lifts**: `--settings {"env":{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE":"0","CLAUDE_CODE_FORK_SUBAGENT":"1"}}` undoes the profile wrapper's seal, so children run on their definition's model and the seat can fork | trace `lift:` |
| any other full render — a Fable model, a resume with no `--model`, a pinned or foreign profile, the caller's own `--settings` | **sealed**: the wrapper's environment stands (children on Opus 5.5, no fork), and the one deny flag also carries `Agent(fork)`; a forking skill is refused by the native's fork patch (`CLAUDE_CODE_FORK_SUBAGENT`) | trace `sealed: <reason>` |
| caller already passed `--agent`, `--agents`, `--system-prompt[-file]` | nothing emitted, deny list and lift included — the seat keeps the wrapper's seal; `--effort`, `--disallowedTools` and `--settings` each suppress their own flag only — a sealed seat still gets the five fork denies, as a second `--disallowedTools=` token | trace `caller passed` |
| a full render and `$UCC_HOME/work` exists | `--add-dir=$UCC_HOME/work`: every seat may read every agent's work folder, so a Workflow script staged in its own is admitted (the launch does not know its seat id, so the grant is the root) | trace `work root:` |
| a missing, unreadable or malformed page; no page at all | exit 0, **warns and launches plain**, every caller | stderr `launch-config: …` |
| the render itself broke (any other non-zero) | the wrapper and an adhoc `ccc-agent spawn` launch plain | stderr `launch-config: render failed` |

Exit 2 and a broken render are **fatal for a fleet spawn** (`--session-dir`,
through `ccc-tmux spawn-agent` or the Go launch line): a seat without its
rendered role and model is the silent degrade the refusal exists to kill. The
bash wrapper aborts on exit 2 and launches plain on any other failure.

Both refusals are decided before any degrade: a caller's own `--system-prompt`,
a missing page or a broken one never hides one. Rendered args are prepended, so
caller flags win by position, and `--` ends every option scan — what follows is
the user's, verbatim.

The wire rules read the **seat's** environment: the profile's `.env` laid over
the caller's, with `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`
and `ANTHROPIC_AUTH_TOKEN` taken from that file alone — a pre-render from a
codex seat never routes a claude spawn by the spawner's pin.

`CLAUDE_CODE_EFFORT_LEVEL` overrides a profile's `settings.json` effortLevel
once one is set; the installer drops the variable for every profile whose
effort it provisions. A CLI `--effort` beats both.

## Two composition moves

**A symlink** is the only way one name reuses another page's bytes:

```bash
ln -s claude-opus-5-5.advisor.md launch/FABLE_SPENT.advisor.md
```

The target resolves inside `launch/`, its role suffix matches the link's, and
the definition is named after the target's stem — one page with several
addresses, never a copy that drifts.

**A set** is membership derived from the profile's own state: `FABLE_SPENT`
holds a profile whose `ratelimit.json` shows its `7d_oi` window live and
refused or above 0.9 utilization, and routes it to `FABLE_SPENT.<role>.md` —
the trace line names the reading. There is no membership file, no `+`, no
rules file, no `match:` or `priority:`, and no page any page inherits from.

### Try a prompt on yourself

```bash
cd $UCC_HOME/config/launch
cp default.worker.md @<my-profile>.worker.md   # a copy only you route to
$EDITOR @<my-profile>.worker.md
node ../launch.mjs explain --role worker --profile <my-profile>
ucc-<my-profile>
rm @<my-profile>.worker.md                      # the whole rollback
```

`@<profile>` beats every set and `default`; the same trick with a `<SET>` name
tries a prompt on a group.

## Who calls this

A JSON object in, `{ argv, model_matched, trace, warnings }` out.

- **`ucc-<profile>`** sends `project`, `profile`, `launch`, `role` and its raw
  command line as `argv`; the launcher derives `--model`, `--effort` and the
  resume flag from it. The wrapper captures `--launch` and `--role` (neither is
  a Claude Code flag) and sends them as `params.launch` and `params.role`. It
  runs the shared node.
- **`ccc-tmux spawn-agent` / `ccc-agent spawn`** send `project`, `profile`,
  `model`, `role` and `launch`, no `argv`, under bun. A spawn renders twice —
  before the pane and in the wrapper — and the second render emits nothing.

`model_matched` says whether our argv carries a real `--model`; when we emit
none the caller's own survives, which is how an explicit override reaches a
foreign endpoint.

## Reading the pages as records

`$UCC_HOME/config` is the `ucc-config` root of the ccc-statusd MCP:

```
read ref="ucc-config:launch/default.worker.md"
```

Two halves, both machine-local: a `meridian-mount` block in `~/MERIDIAN.md`
binds the name, and a `MERIDIAN.md` at `$UCC_HOME/config` carrying
`type: meridian-root` and the same `name:` declares it. Either alone leaves the
root `grey(undeclared)` with every read refusing.

## Distribution

The ccc-statusd repo vendors this directory at `worker/launch-config/`; the
installer extracts it to `$UCC_HOME/config/`, symlinks included. Nothing user-
or machine-specific ships — the `MERIDIAN.md` declaration stays local. A git checkout at `$UCC_HOME/config/.git` wins: the
installer leaves it alone, so on such a host you edit the checkout and vendor
it back in the same change:

```bash
node launch.mjs check && node --test launch.test.mjs   # then commit here: the sync names this sha
./sync-launch-config.sh --dry-run                      # name what drifted, change nothing
./sync-launch-config.sh                                # copy the bundle, test there, path-scoped commit
cd /path/to/ccc-statusd/worker && npm run upload:config   # publish templates/launch-config.tar.gz without a release
ucc-cli config update                                  # an installed machine: pages + launcher; checkouts preserved
```

On a host, the **installer runs first and `ucc-cli config update` second**:
endpoint efforts live on the profile plane (`settings.json`), so a host that
takes the pages without the installer runs codex, grok, kimi and deepseek at
the harness default effort. New launches use the updated files; running
sessions keep the prompt they were born with.
