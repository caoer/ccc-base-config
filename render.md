---
md-render: "[[render#^render]]"
md-render-params: "model, profile, project, output"
---

# Launch Config Renderer

Composes aspect-layered launch config into rendered `claude` CLI params. Rendering only —
this doc never execs a launcher; callers (ccc-tmux spawn-agent, scripts, humans) take the
argv and launch however they like.

## Usage

```
md run '{"file":"~/.local/share/ucc/config/render.md","name":"render","format":"json",
         "model":"claude-opus-4-8-xhigh","profile":"blusher-83savvy","project":"/Users/Shared/projects/caoer/meridian"}'
```

(`md run` expands a leading `~` in `file` since meridian 0099f64; older builds need an absolute path.)

- All params optional — each absent param skips its layers; none → `shared.md` only.
- `model` is a **selection id** (ccc-models convention: no dots, optional `-{effort}` suffix).
  It names the layer files; the actual `--model` value comes from a layer's `model:` key.
- `project` takes a real path (flattened internally: every non-alphanumeric → `-`,
  Claude Code's own projects-dir convention) or an already-flattened name.
- `output: shell` prints one shell-quoted line instead of JSON — for copy-paste.

JSON result (in the md run envelope's `data.stdout`):

```json
{ "argv": ["--model", "..."], "layers": ["shared.md", "..."], "model_matched": true, "warnings": [] }
```

`model_matched` is true when a layer set a real, non-empty `model:` (so the rendered argv
carries a real `--model`) — callers that pass a selection id as `--model` should drop their
own `--model` flag when it's true. A model-layer file that matches but sets no `model:` does
NOT set it true: the caller's `--model` passes through unchanged (with a warning), so a
per-model layer can add only tools/prompt/effort without hijacking the model.

## Layers

Least → most specific; most specific wins. `any.md` in a scope dir = that scope, any model.

| # | File | Scope |
|---|------|-------|
| 0 | `shared.md` | global base — every launch |
| 1 | `models/<selection-id>.md` | one model |
| 2 | `profiles/<profile>/any.md` | one profile, any model |
| 3 | `profiles/<profile>/models/<selection-id>.md` | one profile, one model |
| 4 | `projects/<flattened-path>/any.md` | one project, any model |
| 5 | `projects/<flattened-path>/<selection-id>.md` | one project, one model |

## Aspect file format

Frontmatter = claude CLI options (long names, no `--`). Body = system-prompt append text.

| Keys | Merge rule |
|------|-----------|
| `model` `effort` `name` `agent` `tools` `settings` `verbose` `prompt-suggestions` `allow-dangerously-skip-permissions` | scalar — most specific layer wins |
| `add-dir` `allowed-tools` `mcp-config` | list — union across layers (scalar values allowed, coerced to one-element lists) |
| `extra-args` | list — plain concatenation, emitted verbatim at the end (escape hatch for flags the renderer doesn't know) |
| `agents` | map — merge by agent name; later layer replaces same-named agent |
| `system-prompt` / `system-prompt-file` | one unit, override — most specific layer wins; always emitted as `--system-prompt-file` (inline text is written under `.rendered/`) |
| `append-system-prompt` / `append-system-prompt-file` + **body** | append stream — concatenates in layer order; emitted as one `--append-system-prompt-file` (single-file streams pass the file through untouched) |

Semantics notes:

- `system-prompt` **replaces** the base prompt (claude's own semantic) → override across
  layers. `append-system-prompt` **appends** → concatenation across layers is the faithful
  lift. Both are first-class at every layer.
- Only `-file` flag forms are ever emitted for prompts: ucc launchers check flag presence
  to decide default injection, so rendered flags suppress the shared defaults cleanly.
- Paths: `~` expands to `$HOME`; relative paths resolve against this config repo root.
- Referenced files that don't exist **fail loud** (exit 1) — a typo'd path must not
  silently shrink the prompt. Unknown frontmatter keys are warnings, not errors.
- `verbose` / `allow-dangerously-skip-permissions` must be YAML booleans; `false` in a more
  specific layer undoes a broader `true` (flag omitted).
- `.rendered/` holds content-hashed render outputs — gitignored, safe to delete anytime.

```ts
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

const HOME = process.env.HOME ?? "";
const ROOT = process.cwd(); // md run guarantees: this config repo's toplevel

const P = {
  model: process.env.MD_PARAM_MODEL,
  profile: process.env.MD_PARAM_PROFILE,
  project: process.env.MD_PARAM_PROJECT,
  output: process.env.MD_PARAM_OUTPUT ?? "json",
};

const warnings: string[] = [];
const fail = (msg: string): never => {
  console.error(`render: ${msg}`);
  process.exit(1);
};
if (P.output !== "json" && P.output !== "shell") fail(`output must be json or shell, got '${P.output}'`);

const flat = (p: string) => p.replace(/[^a-zA-Z0-9]/g, "-");
const project = P.project ? (P.project.includes("/") ? flat(P.project) : P.project) : undefined;

const candidates: string[] = ["shared.md"];
if (P.model) candidates.push(`models/${P.model}.md`);
if (P.profile) candidates.push(`profiles/${P.profile}/any.md`);
if (P.profile && P.model) candidates.push(`profiles/${P.profile}/models/${P.model}.md`);
if (project) candidates.push(`projects/${project}/any.md`);
if (project && P.model) candidates.push(`projects/${project}/${P.model}.md`);
const modelLayerSet = new Set(
  P.model
    ? [
        `models/${P.model}.md`,
        P.profile ? `profiles/${P.profile}/models/${P.model}.md` : "",
        project ? `projects/${project}/${P.model}.md` : "",
      ].filter(Boolean)
    : [],
);

type Layer = { path: string; fm: Record<string, unknown>; body: string };
const parseDoc = (path: string, raw: string): Layer => {
  let fm: Record<string, unknown> = {};
  let body = raw;
  // The inner `\n` before the closing `---` is optional so an empty-frontmatter
  // file (`---\n---`) matches to fm="" instead of failing the match and leaking
  // the literal `---\n---` as body into the append-system-prompt stream.
  const m = raw.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---(\r?\n|$)/);
  if (m) {
    body = raw.slice(m[0].length);
    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(m[1]);
    } catch (e) {
      fail(`${path}: invalid YAML frontmatter — ${e}`);
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) fail(`${path}: frontmatter must be a YAML map`);
      fm = parsed as Record<string, unknown>;
    }
  }
  return { path, fm, body: body.trim() };
};

const SCALARS = new Set(["model", "effort", "name", "agent", "tools", "settings", "verbose", "prompt-suggestions", "allow-dangerously-skip-permissions"]);
const LISTS = new Set(["add-dir", "allowed-tools", "mcp-config", "extra-args"]);
const KNOWN = new Set([...SCALARS, ...LISTS, "agents", "system-prompt", "system-prompt-file", "append-system-prompt", "append-system-prompt-file"]);

const expandPath = (v: string): string => {
  let p = v;
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = HOME + p.slice(1);
  if (!isAbsolute(p)) p = resolve(ROOT, p);
  return p;
};
const dedupe = (xs: string[]) => [...new Set(xs)];
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

const layers: string[] = [];
const scalars = new Map<string, unknown>();
const lists = new Map<string, unknown[]>();
let agents: Record<string, unknown> = {};
let agentsSet = false;
let sysPrompt: { kind: "file" | "inline"; value: string } | undefined;
type Piece = { kind: "file"; path: string; layer: string } | { kind: "text"; text: string; layer: string };
const appendStream: Piece[] = [];

for (const rel of candidates) {
  const abs = resolve(ROOT, rel);
  if (!existsSync(abs)) continue;
  const layer = parseDoc(rel, readFileSync(abs, "utf8"));
  layers.push(rel);
  for (const [k, v] of Object.entries(layer.fm)) {
    if (!KNOWN.has(k)) {
      warnings.push(`${rel}: unknown key '${k}' ignored — use extra-args for flags the renderer doesn't know`);
      continue;
    }
    if (v === null || v === undefined) {
      warnings.push(`${rel}: key '${k}' has no value — ignored`);
      continue;
    }
    if (k === "verbose" || k === "allow-dangerously-skip-permissions") {
      if (typeof v !== "boolean") fail(`${rel}: ${k} must be true or false`);
      scalars.set(k, v);
    } else if (SCALARS.has(k)) {
      scalars.set(k, v);
    } else if (LISTS.has(k)) {
      lists.set(k, [...(lists.get(k) ?? []), ...asArray(v)]);
    } else if (k === "agents") {
      if (typeof v !== "object" || Array.isArray(v)) fail(`${rel}: agents must be a map`);
      agents = { ...agents, ...(v as Record<string, unknown>) };
      agentsSet = true;
    } else if (k === "system-prompt") {
      sysPrompt = { kind: "inline", value: String(v) };
    } else if (k === "system-prompt-file") {
      sysPrompt = { kind: "file", value: expandPath(String(v)) };
    } else if (k === "append-system-prompt") {
      appendStream.push({ kind: "text", text: String(v), layer: rel });
    } else if (k === "append-system-prompt-file") {
      appendStream.push({ kind: "file", path: expandPath(String(v)), layer: rel });
    }
  }
  if (layer.body) appendStream.push({ kind: "text", text: layer.body, layer: rel });
}

// `model_matched` is the caller's drop-your-`--model` signal: true ONLY when a
// layer set a real, non-empty model:. A model-layer FILE merely existing is not
// enough — a per-model layer may legitimately add only tools/prompt/effort and
// inherit the model from a broader layer, or leave the caller's explicit --model
// (a real id like `sonnet`) in place. So a matched file without model: passes the
// caller's --model through (with a warning) instead of failing the whole render.
const modelFileMatched = layers.some((l) => modelLayerSet.has(l));
const modelVal = scalars.has("model") ? String(scalars.get("model")).trim() : "";
if (scalars.has("model") && modelVal === "")
  fail(`a matched layer set an empty model: value — give a real model id or remove the key`);
const modelEmitted = modelVal !== "";
if (modelFileMatched && !modelEmitted)
  warnings.push(`a model layer for '${P.model}' matched but set no model: — the caller's --model '${P.model}' passes through unchanged`);

const renderedDir = resolve(ROOT, ".rendered");
const writeRendered = (prefix: string, content: string): string => {
  mkdirSync(renderedDir, { recursive: true });
  const h = new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 12);
  const p = resolve(renderedDir, `${prefix}-${h}.md`);
  writeFileSync(p, content);
  return p;
};

const argv: string[] = [];
const sv = (k: string) => String(scalars.get(k));
if (modelEmitted) argv.push("--model", modelVal);
if (scalars.has("effort")) argv.push("--effort", sv("effort"));
if (scalars.has("name")) argv.push("--name", sv("name"));
if (scalars.has("agent")) argv.push("--agent", sv("agent"));
if (scalars.has("tools")) {
  const v = scalars.get("tools");
  argv.push("--tools", Array.isArray(v) ? v.map(String).join(",") : String(v));
}
if (lists.has("allowed-tools")) argv.push("--allowed-tools", dedupe(lists.get("allowed-tools")!.map(String)).join(","));
if (lists.has("add-dir")) argv.push("--add-dir", ...dedupe(lists.get("add-dir")!.map((x) => expandPath(String(x)))));
if (lists.has("mcp-config"))
  argv.push(
    "--mcp-config",
    ...dedupe(
      lists.get("mcp-config")!.map((x) =>
        typeof x === "object" && x !== null
          ? JSON.stringify(x) // inline map → JSON string (mirror settings), not `<root>/[object Object]`
          : String(x).trimStart().startsWith("{")
            ? String(x)
            : expandPath(String(x)),
      ),
    ),
  );
if (scalars.has("settings")) {
  const v = scalars.get("settings");
  argv.push("--settings", typeof v === "object" ? JSON.stringify(v) : String(v).trimStart().startsWith("{") ? String(v) : expandPath(String(v)));
}
if (agentsSet) argv.push("--agents", JSON.stringify(agents));
if (sysPrompt) {
  if (sysPrompt.kind === "file") {
    if (!existsSync(sysPrompt.value)) fail(`system-prompt-file not found: ${sysPrompt.value}`);
    argv.push("--system-prompt-file", sysPrompt.value);
  } else {
    argv.push("--system-prompt-file", writeRendered("system-prompt", sysPrompt.value + "\n"));
  }
}
if (appendStream.length === 1 && appendStream[0].kind === "file") {
  const only = appendStream[0] as { kind: "file"; path: string; layer: string };
  if (!existsSync(only.path)) fail(`append-system-prompt-file not found: ${only.path} (${only.layer})`);
  argv.push("--append-system-prompt-file", only.path);
} else if (appendStream.length > 0) {
  const parts = appendStream.map((pc) => {
    if (pc.kind === "text") return pc.text;
    if (!existsSync(pc.path)) fail(`append-system-prompt-file not found: ${pc.path} (${pc.layer})`);
    return readFileSync(pc.path, "utf8").trim();
  });
  argv.push("--append-system-prompt-file", writeRendered("append", parts.filter(Boolean).join("\n\n") + "\n"));
}
if (scalars.get("verbose") === true) argv.push("--verbose");
if (scalars.has("prompt-suggestions")) argv.push("--prompt-suggestions", sv("prompt-suggestions"));
if (scalars.get("allow-dangerously-skip-permissions") === true) argv.push("--allow-dangerously-skip-permissions");
if (lists.has("extra-args")) argv.push(...lists.get("extra-args")!.map(String));

if (P.output === "shell") {
  const q = (a: string) => (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  console.log(argv.map(q).join(" "));
  for (const w of warnings) console.error(`warn: ${w}`);
} else {
  console.log(JSON.stringify({ argv, layers, model_matched: modelEmitted, warnings }, null, 2));
}
```

^render

## Limitations

- Frontmatter values must not contain a line that is exactly `---` (block scalars with
  markdown hrules) — keep such prompt text in files, not inline.
- Selection-id filenames never parse into model/effort — the layer's `model:`/`effort:`
  keys are the source of truth; scaffold new model files from
  `ccc-models/matrix/selection-matrix.csv`.
