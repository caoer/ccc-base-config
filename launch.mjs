#!/usr/bin/env node
// launch.mjs — the launcher. The pages are the config; GUIDE.md is the contract
// (the ladder, the wire rules, the exit codes, who calls this).
//
//   node launch.mjs '{"role":"worker","profile":"p","project":"/path"}'   # render
//   node launch.mjs explain --role advisor --profile does_bannock_6u
//   node launch.mjs check
//
// Plain JS, Node stdlib only — it runs unchanged on the shared node and on bun.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/** this file's own directory — the config dir: launch/, mcp/, fleet.md */
export const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\/$/, "");

// ═══════════════════════════════════════════════════════════════════════════
// PAGE GRAMMAR — `---` frontmatter, flat, plus a verbatim body. No YAML library
// exists on both runtimes without a dependency. Every refusal names the file
// and the line.
// ═══════════════════════════════════════════════════════════════════════════

export class PageError extends Error {
  constructor(file, line, detail) {
    super(`${file}:${line}: ${detail}`);
    this.name = "PageError";
    this.file = file;
    this.line = line;
    this.detail = detail;
  }
}

const FLAT = "frontmatter is flat: key: scalar or key: [a, b]";

/** `---` … `---` then the body, verbatim from the line after the closing fence. */
export function splitFrontmatter(text, file = "<page>") {
  if (!/^---\r?\n/.test(text)) return { lines: [], offset: 2, body: text };
  const lines = text.split("\n");
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) throw new PageError(file, 1, `frontmatter opened with --- and is never closed`);
  return {
    lines: lines.slice(1, close).map((l) => l.replace(/\r$/, "")),
    offset: 2, // frontmatter line 0 is file line 2
    body: lines.slice(close + 1).join("\n"),
  };
}

/** A page → { front, body }. Throws PageError, always with a line number. */
export function parsePage(text, file = "<page>") {
  const { lines, offset, body } = splitFrontmatter(text, file);
  const front = {};
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = i + offset;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (/^\s/.test(raw)) {
      throw new PageError(file, line, `indented line — a nested map is not allowed, ${FLAT}`);
    }
    if (/^-\s/.test(raw)) {
      throw new PageError(file, line, `block list item — write a flow list instead: key: [a, b]`);
    }
    const cut = raw.indexOf(":");
    if (cut < 0) throw new PageError(file, line, `'${raw.trim()}' is not a key: value pair — ${FLAT}`);
    const key = raw.slice(0, cut).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new PageError(file, line, `'${key}' is not a legal frontmatter key`);
    }
    const value = raw.slice(cut + 1).trim();
    if (value === "") {
      throw new PageError(file, line, `'${key}:' has no value — a nested map or block list is not allowed, ${FLAT}`);
    }
    if (/^[|>]/.test(value)) {
      throw new PageError(file, line, `'${key}:' opens a multi-line scalar — a value is one line, ${FLAT}`);
    }
    front[key] = parseValue(value, file, line, key);
  }
  return { front, body };
}

function parseValue(value, file, line, key) {
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) {
      throw new PageError(file, line, `'${key}:' opens a list that does not close on this line — a value is one line`);
    }
    return splitFlow(value.slice(1, -1), file, line, key).map((item) => scalar(item, file, line, key));
  }
  return scalar(value, file, line, key);
}

/** Split on commas that are not inside quotes, so a quoted item may hold one;
 *  inside double quotes a backslash escapes the next character. */
function splitFlow(inner, file, line, key) {
  const items = [];
  let cur = "";
  let quote = null;
  let escaped = false;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (escaped) escaped = false;
      else if (ch === "\\" && quote === '"') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      items.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) throw new PageError(file, line, `'${key}:' has an unterminated quoted item`);
  items.push(cur);
  return items.map((s) => s.trim()).filter((s) => s !== "");
}

/** A quoted value is text, always. Bare true/false/null and bare numbers are
 *  coerced, so `maxTurns: 12` reaches the harness as a number. Inside single
 *  quotes, a doubled apostrophe is the escape for one literal apostrophe —
 *  written that way rather than spelled here so no formatter can rewrite it.
 *  Every scalar position — a value or a list item — refuses a nested
 *  collection and an anchor or alias. */
function scalar(value, file, line, key) {
  if (/^[{[]/.test(value)) {
    throw new PageError(file, line, `'${key}:' nests a collection — a nested map or list is not allowed, ${FLAT}`);
  }
  if (/^[&*]/.test(value)) {
    throw new PageError(file, line, `'${key}:' uses a YAML anchor or alias — no page reads another page`);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\/])|\\n/g, (m, c) => (c ? c : "\n"));
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    throw new PageError(file, line, `'${key}:' has an unterminated quoted value`);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE LADDER — launch facts → candidate names → the page that wins.
// ═══════════════════════════════════════════════════════════════════════════

export const ROLES = ["advisor", "leader", "worker"];
const ONE_M = "[1m]";

/** A refusal: the launch must NOT proceed. Callers exit 2 and never degrade. */
export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = "Refusal";
    this.exitCode = 2;
  }
}

const isClaude = (model) => model.startsWith("claude-");

/** Every claude id carries [1m]; without it the session reports a 200k context
 *  window. An id that already names a variant is left alone. */
export const withOneM = (model) => (isClaude(model) && !model.includes("[") ? model + ONE_M : model);

/** The id without its [1m] postfix — what a filename spells. */
export const bareId = (model) => (model.endsWith(ONE_M) ? model.slice(0, -ONE_M.length) : model);

/** The Fable family: the alias `fable` or any claude-fable-* id. */
export const isFable = (model) => bareId(model) === "fable" || bareId(model).startsWith("claude-fable");

/** claude-opus-4-8 → claude-opus-4-8, claude-opus-4, claude-opus, claude */
export function modelRungs(id) {
  const parts = bareId(id).split("-");
  const out = [];
  for (let n = parts.length; n >= 1; n--) out.push(parts.slice(0, n).join("-"));
  return out;
}

/** The ordered candidate filenames for one launch. Pure — no disk. */
export function candidateNames({ kind, model, profile, sets = [], role } = {}) {
  const tokens = [];
  if (kind) tokens.push(kind);
  if (model) tokens.push(...modelRungs(model));
  if (profile) tokens.push(`@${profile}`);
  for (const set of sets) tokens.push(set);
  tokens.push("default");

  const names = [];
  for (const token of new Set(tokens)) {
    if (role) names.push(`${token}.${role}.md`);
    names.push(`${token}.md`);
  }
  return [...new Set(names)];
}

/** pools.local.json — per-user set membership the installer never writes. A
 *  malformed file must never break launching: every problem is one warning and
 *  an empty table. */
export function readLocalPools(path, warnings = []) {
  if (!existsSync(path)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warnings.push(`${path} is not valid JSON — no sets (${e.message})`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`${path} must be an object of SET → [profiles] — no sets`);
    return {};
  }
  const out = {};
  for (const [name, members] of Object.entries(parsed)) {
    if (!Array.isArray(members) || members.some((m) => typeof m !== "string")) {
      warnings.push(`${path}: set '${name}' is not an array of profile names — skipped`);
      continue;
    }
    out[name] = members;
  }
  return out;
}

/** The sets this profile belongs to, in the file's key order. */
export function setsFor(profile, pools) {
  if (!profile) return [];
  return Object.entries(pools)
    .filter(([, members]) => members.includes(profile))
    .map(([name]) => name);
}

/** FABLE_SPENT is also DERIVED: a profile whose ratelimit.json reports the
 *  fable meter (7d_oi) spent belongs to the set whatever pools.local.json says.
 *  The predicate is pick-cli's for an 'oi' launch — a window whose reset epoch
 *  has passed is stale and says nothing; a live one is spent on a server
 *  refusal (allowed_warning is a warning, not a refusal) or utilization above
 *  0.9. Returns the reason, or null. A missing or malformed file is silent:
 *  no reading is no signal. */
export function fableSpentReason(path, nowSec = Date.now() / 1000) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object") return null;
  if (!(parseInt(data["7d_oi-reset"] || "0", 10) > nowSec)) return null;
  const status = String(data["7d_oi-status"] ?? "").trim().toLowerCase();
  if (status !== "" && status !== "allowed" && status !== "allowed_warning") return `7d_oi-status=${status}`;
  const util = parseFloat(data["7d_oi-utilization"] || "0");
  return util > 0.9 ? `7d_oi-utilization=${util}` : null;
}

/** One candidate → the real page behind it, or why it is not a candidate.
 *  A symlink is the composition mechanism, so it resolves — but its target
 *  must stay inside launch/, or a page could be served from anywhere. */
export function resolveCandidate(launchDir, name) {
  const path = join(launchDir, name);
  let entryStat;
  try {
    entryStat = lstatSync(path);
  } catch {
    return null; // no such file — the ladder just continues
  }
  let real;
  let root;
  try {
    real = realpathSync(path);
    root = realpathSync(launchDir);
  } catch {
    return { name, error: `${name}: dangling symlink` };
  }
  if (real !== root && !real.startsWith(`${root}/`)) {
    return { name, error: `${name}: resolves outside launch/ (${real})` };
  }
  let text;
  try {
    text = readFileSync(real, "utf8");
  } catch (e) {
    return { name, error: `${name}: ${e.code === "EISDIR" ? "not a file" : "unreadable"}` };
  }
  // The body is the system prompt: an empty one would replace the harness's
  // own prompt with nothing, which is worse than the plain launch it loses to.
  let body = text;
  try {
    ({ body } = splitFrontmatter(text, name));
  } catch {
    /* an unclosed fence is named by parsePage */
  }
  if (body.trim() === "") return { name, error: `${name}: empty body — the body is the system prompt` };
  // `linked` asks whether THIS ENTRY is a symlink, so it is read from the entry's
  // own lstat and never from `real !== path`. Those two differ whenever any
  // ANCESTOR directory is a symlink — which is the normal shape of a macOS
  // temp dir, where /var is a link to /private/var. Under the realpath spelling
  // every page looked linked, `check` skipped every one of them as "checked via
  // its target", and a broken tree reported "is good (0 warnings)" and exit 0.
  return { name, path, real, text, stem: basename(real).replace(/\.md$/, ""), linked: entryStat.isSymbolicLink() };
}

/** Walk the ladder. Returns { pick, candidates }; `pick` is null when nothing
 *  matched (warn and launch plain). `--launch NAME` with no file refuses: the
 *  caller named a kind, so `default` would launch something else under its name. */
export function choosePage(launchDir, ctx, trace = [], warnings = []) {
  const all = candidateNames(ctx);
  const candidates = ctx.kind ? all.filter((n) => n.startsWith(`${ctx.kind}.`)) : all;

  for (const name of candidates) {
    const got = resolveCandidate(launchDir, name);
    if (got === null) {
      trace.push(`candidate ${name}: no file`);
      continue;
    }
    if (got.error) {
      warnings.push(got.error);
      trace.push(`candidate ${name}: skipped — ${got.error}`);
      continue;
    }
    trace.push(`page ${name}${got.linked ? ` → ${basename(got.real)}` : ""} (definition '${got.stem}')`);
    return { pick: got, candidates };
  }

  if (ctx.kind) {
    throw new Refusal(`launch-config: no launch kind '${ctx.kind}' in $UCC_HOME/config/launch/`);
  }
  warnings.push(`no launch page for this launch (tried ${candidates.join(", ")}) — launching plain`);
  return { pick: null, candidates };
}

// ═══════════════════════════════════════════════════════════════════════════
// MCP SERVERS — mcp/<name>.md: a gate in the frontmatter, the server object in
// the body's first json fence. An unmet gate drops the server with a trace
// line; a session boots without it rather than failing.
// ═══════════════════════════════════════════════════════════════════════════

/** ${VAR} from env. ${A|B} takes the first non-empty, ${A:-text} falls back
 *  to a literal. `onEmpty` is called with the chain when nothing answered and
 *  no fallback was written. */
export function expand(text, env = {}, onEmpty = null) {
  return String(text).replace(/\$\{([^}]+)\}/g, (_m, expr) => {
    const cut = expr.indexOf(":-");
    const chain = cut >= 0 ? expr.slice(0, cut) : expr;
    const fallback = cut >= 0 ? expr.slice(cut + 2) : null;
    for (const raw of chain.split("|")) {
      const v = env[raw.trim()];
      if (v) return v;
    }
    if (fallback !== null) return fallback;
    if (onEmpty) onEmpty(chain.trim());
    return "";
  });
}

/** Expand every string inside a structure, keys and leaves alike. Values reach
 *  the definition through JSON.stringify, so an expanded value carrying a quote
 *  is structurally unable to break out of its string. */
export function expandDeep(value, env = {}, onEmpty = null) {
  if (typeof value === "string") return expand(value, env, onEmpty);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, env, onEmpty));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[expand(k, env, onEmpty)] = expandDeep(v, env, onEmpty);
    return out;
  }
  return value;
}

const expandPath = (p, env) => {
  const home = env.HOME ?? "";
  let out = p;
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = home + out.slice(1);
  return isAbsolute(out) ? out : resolvePath(HERE, out);
};

/** " | " is OR within one probe string; a leading ! negates. A probe that
 *  throws (permission, ENOENT) is UNMET, never a failed launch. */
export function probe(expr, env = {}) {
  return String(expr)
    .split(" | ")
    .some((term) => probeOne(term.trim(), env));
}

function probeOne(term, env) {
  if (term.startsWith("!")) return !probeOne(term.slice(1).trim(), env);
  const cut = term.indexOf(":");
  if (cut < 0) return false; // unspellable — `check` names it; a launch treats it as unmet
  const kind = term.slice(0, cut);
  const rest = term.slice(cut + 1);
  if (kind === "env") {
    const tilde = rest.indexOf("~");
    const value = env[(tilde < 0 ? rest : rest.slice(0, tilde)).trim()] ?? "";
    if (tilde < 0) return value !== "";
    return value.includes(expand(rest.slice(tilde + 1), env));
  }
  const path = expand(rest, env).trim();
  if (path === "") return false;
  try {
    if (kind === "file") return existsSync(expandPath(path, env));
    if (kind === "exec") {
      const abs = expandPath(path, env);
      return existsSync(abs) && (statSync(abs).mode & 0o111) !== 0;
    }
    if (kind === "bin") return (env.PATH ?? "").split(":").some((d) => d !== "" && existsSync(join(d, path)));
  } catch {
    return false;
  }
  return false;
}

export const PROBE_KINDS = ["env", "file", "exec", "bin"];

const firstJsonFence = (body) => {
  const m = body.match(/^```json[^\n]*\n([\s\S]*?)\n```/m);
  return m ? m[1] : null;
};

/** mcp/<name>.md → { requires, config } or { error }. Throws PageError only on
 *  a grammar refusal, which the caller degrades to a warning. */
export function readServerFile(mcpDir, name) {
  const rel = `mcp/${name}.md`;
  const path = join(mcpDir, `${name}.md`);
  if (!existsSync(path)) return { name, error: `${rel} does not exist — server '${name}' skipped` };
  const { front, body } = parsePage(readFileSync(path, "utf8"), rel);
  const fence = firstJsonFence(body);
  if (fence === null) return { name, error: `${rel} has no json fence — the first one is the server object` };
  let config;
  try {
    config = JSON.parse(fence);
  } catch (e) {
    return { name, error: `${rel}: the json fence does not parse (${e.message})` };
  }
  const requires = front.requires === undefined ? [] : [].concat(front.requires);
  return { name, path, rel, requires, config };
}

/** Page `mcpServers: [a, b]` → [{a: cfg}, …], gate by gate. */
export function resolveServers(mcpDir, names, env = {}, trace = [], warnings = []) {
  const out = [];
  for (const name of names) {
    let file;
    try {
      file = readServerFile(mcpDir, String(name));
    } catch (e) {
      warnings.push(`mcp server '${name}': ${e.message}`);
      trace.push(`mcp ${name}: skipped — ${e.message}`);
      continue;
    }
    if (file.error) {
      warnings.push(file.error);
      trace.push(`mcp ${name}: skipped — ${file.error}`);
      continue;
    }
    const unmet = file.requires.filter((r) => !probe(r, env));
    if (unmet.length > 0) {
      trace.push(`mcp ${name}: skipped — needs ${unmet.join("; ")}`);
      continue;
    }
    const cfg = expandDeep(file.config, env, (chain) =>
      warnings.push(`mcp ${name}: \${${chain}} is unset — expanded to empty`),
    );
    out.push({ [name]: cfg });
    trace.push(`mcp ${name}: included`);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE WIRE — page + machine → an agent definition and the argv that carries it.
//
// The definition is BUILT, never printed: JSON.stringify is the only writer, so
// a prompt body carrying quotes, backslashes or a ${VAR} cannot break out of
// its string. Every rule that fires says so in `trace` — that is the debugging
// story, and the only place a silent decision could hide.
// ═══════════════════════════════════════════════════════════════════════════

export const FLEET_DENY_KEY = "disallowedTools";

/** Flag families the caller may already have used. Theirs wins; ours is dropped
 *  with a trace line rather than emitted twice. */
const FAMILIES = {
  agents: ["--agent", "--agents", "--system-prompt", "--system-prompt-file"],
  effort: ["--effort"],
  disallowedTools: ["--disallowedTools", "--disallowed-tools"],
  settings: ["--settings"],
};

/** The profile wrapper seals every seat: its children run on Opus 5.5 whatever
 *  is asked, and it cannot fork. A seat this launcher starts on a known model
 *  other than Fable gets the seal lifted by this one settings layer. */
export const LIFT_SETTINGS = JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0", CLAUDE_CODE_FORK_SUBAGENT: "1" } });

/** Denied on a sealed seat: the fork paths the seal's switch does not reach. */
export const SEALED_DENY = ["Agent(fork)"];

/** Print mode: a headless run. -p is a boolean flag, so a bare token is enough. */
const isPrint = (options) => options.some((a) => a === "-p" || a === "--print");

/** Print mode on Fable is refused: Fable runs only as a seat. */
function refuseFablePrint(model, source, env) {
  if (String(env.UCC_FABLE_PRINT ?? "") === "1") return;
  throw new Refusal(
    `print mode on ${model} (${source}): Fable runs only as a seat, never headless. ` +
      `Fix: run the print job on claude-opus-5-5 or claude-sonnet-5-5, start a full seat on Fable, ` +
      `or set UCC_FABLE_PRINT=1 in the seat env for a run the user asked for.`,
  );
}

/** The launch facts from the caller's raw command line — the ONE place that
 *  reads it. The last --model is the requested model and is REMOVED (the
 *  normalized spelling we emit replaces it via model_matched); --launch names
 *  the kind; a resume/continue flag marks a resume. --effort is read and
 *  stays, so it is forwarded exactly once. */
export function siftArgv(raw = []) {
  let model;
  let effort;
  let kind;
  let resume = false;
  const argv = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--") {
      argv.push(...raw.slice(i)); // everything after -- is the user's, verbatim
      break;
    }
    if (a === "--model" && i + 1 < raw.length) {
      model = raw[++i];
      continue;
    }
    if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
      continue;
    }
    if (a === "--launch" && i + 1 < raw.length) {
      kind = raw[++i];
      continue;
    }
    if (a.startsWith("--launch=")) {
      kind = a.slice("--launch=".length);
      continue;
    }
    if (a === "--effort" && i + 1 < raw.length) {
      effort = raw[i + 1];
      argv.push(a, raw[++i]);
      continue;
    }
    if (a.startsWith("--effort=")) effort = a.slice("--effort=".length);
    if (
      a === "-r" || a === "--resume" || a === "-c" || a === "--continue" ||
      a.startsWith("--resume=") || a.startsWith("--continue=")
    ) {
      resume = true;
    }
    argv.push(a);
  }
  return { model, effort, kind, resume, argv };
}

/** fleet.md — one key, one flag, emitted once per launch. */
export function readFleetDeny(dir, warnings = []) {
  const path = join(dir, "fleet.md");
  if (!existsSync(path)) return [];
  try {
    const { front } = parsePage(readFileSync(path, "utf8"), "fleet.md");
    const deny = front[FLEET_DENY_KEY];
    return deny === undefined ? [] : [].concat(deny).map(String);
  } catch (e) {
    warnings.push(e.message);
    return [];
  }
}

/** Keys the launcher consumes itself — everything else reaches the harness. */
const CONSUMED = new Set(["description", "model", "effort", "mcpServers", "name"]);

/** The plugin a definition rides in. Claude Code names a plugin's agent
 *  `<plugin>:<agent>`, so the seat's agent_type reads `ucc-launch:<page stem>`. */
export const LAUNCH_PLUGIN = "ucc-launch";
/** A plugin dir no render has used for this long is swept by the next render. */
export const PLUGIN_TTL_MS = 7 * 24 * 3600 * 1000;
/** Keys a plugin agent ignores; a definition carrying one rides argv as JSON. */
const PLUGIN_IGNORED = ["hooks", "permissionMode"];

/** The definition → the argv that carries it. Given a plugin root, the
 *  definition is written to a content-addressed plugin dir and the argv only
 *  names it, so a seat's ps line holds no prompt prose. The MCP servers go in a
 *  --mcp-config file beside it: a plugin agent drops `mcpServers`, and a
 *  plugin's own .mcp.json would rename every server's tools. With no root, or
 *  a dir that cannot be written, the whole definition rides argv as JSON. */
function definitionArgv(name, agent, root, trace) {
  const inline = () => ["--agents", JSON.stringify({ [name]: agent }), "--agent", name];
  if (root === undefined) return inline();
  const ignored = PLUGIN_IGNORED.filter((k) => k in agent);
  if (ignored.length > 0) {
    trace.push(`argv fallback: a plugin agent ignores ${ignored.join(", ")} — the definition rides argv`);
    return inline();
  }
  const { prompt, mcpServers, ...front } = agent;
  // JSON is YAML: every frontmatter value is written as a JSON scalar or list.
  const head = Object.entries({ name, ...front }).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const files = {
    ".claude-plugin/plugin.json": `${JSON.stringify({ name: LAUNCH_PLUGIN, description: "launch pages rendered by launch.mjs" })}\n`,
    [`agents/${name}.md`]: `---\n${head.join("\n")}\n---\n${prompt}`,
  };
  if (mcpServers !== undefined) files["servers.json"] = `${JSON.stringify({ mcpServers: Object.assign({}, ...mcpServers) })}\n`;
  const hash = createHash("sha256");
  for (const [rel, text] of Object.entries(files)) hash.update(`${rel}\0${text}\0`);
  const target = join(root, hash.digest("hex").slice(0, 12));
  try {
    materialize(root, target, files);
  } catch (e) {
    trace.push(`argv fallback: ${target} could not be written (${e.message}) — the definition rides argv`);
    return inline();
  }
  trace.push(`plugin: ${target}`);
  const argv = ["--plugin-dir", target, "--agent", `${LAUNCH_PLUGIN}:${name}`];
  // --mcp-config is variadic: only the =value form keeps it off the next argument.
  if (mcpServers !== undefined) argv.push(`--mcp-config=${join(target, "servers.json")}`);
  return argv;
}

/** Write `files` into `target` once, through a temp dir renamed into place, so
 *  a concurrent identical launch sees no dir or a whole one. Owner-only modes:
 *  servers.json carries bearer tokens. Touches `target`, then sweeps the
 *  siblings no render has used within PLUGIN_TTL_MS. */
function materialize(root, target, files) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!existsSync(target)) {
    const tmp = mkdtempSync(join(root, ".tmp-"));
    try {
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(tmp, rel, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(join(tmp, rel), text, { mode: 0o600 });
      }
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (!existsSync(target)) throw e; // otherwise a concurrent launch won the rename
    }
  }
  const now = Date.now();
  utimesSync(target, now / 1000, now / 1000);
  try {
    for (const entry of readdirSync(root)) {
      const path = join(root, entry);
      if (path !== target && now - statSync(path).mtimeMs > PLUGIN_TTL_MS) rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // a failed sweep costs disk only; the next render sweeps again
  }
}

/** Render one launch → { argv, model_matched, trace, warnings, … }. Throws
 *  Refusal (exit 2) for an unknown --launch kind or a model the profile's pin
 *  cannot serve; every other failure warns and renders nothing. */
export function render(ctx = {}, world = {}) {
  const dir = world.dir ?? HERE;
  const env = world.env ?? {};
  const trace = [];
  const warnings = [];
  const empty = (candidates = []) => ({ argv: [], model_matched: false, trace, warnings, definition: null, name: null, candidates });

  const sifted = siftArgv(ctx.argv ?? []);
  const given = sifted.argv;
  const explicitModel = ctx.model ?? sifted.model;
  const explicitEffort = ctx.effort ?? sifted.effort;
  const resume = ctx.resume ?? sifted.resume;
  const kind = ctx.kind ?? sifted.kind;

  // ── the refusals — decided before any shortcut or degrade below can hide
  // them: a caller's own --system-prompt, a missing page and a malformed page
  // each return early, and none of them makes a wrong model right. ──────────
  const asked = explicitModel ? withOneM(explicitModel) : undefined;
  if (asked !== undefined && asked !== explicitModel) {
    trace.push(`model ${explicitModel}: normalized to ${asked} (a claude id without [1m] reports 200k)`);
  }
  const pin = String(env.ANTHROPIC_MODEL ?? "").trim();
  const baseUrl = String(env.ANTHROPIC_BASE_URL ?? "").trim();
  const foreign = baseUrl !== "" && !baseUrl.includes("anthropic.com");

  // Pin: the profile's endpoint serves exactly one id. Any other explicitly
  // requested id is REFUSED rather than silently replaced — degrading here
  // would land the wrong model (zt-queue #17).
  if (asked !== undefined && pin !== "" && bareId(asked) !== bareId(pin)) {
    throw new Refusal(
      `--model ${explicitModel} cannot be served: profile '${ctx.profile ?? "?"}' pins ANTHROPIC_MODEL=${pin}, ` +
        `whose endpoint serves only ${pin}. ` +
        `Fix: drop --model to accept ${pin} (request reasoning effort separately with --effort <low|medium|high|xhigh|max>), ` +
        `or launch from a profile that serves ${asked} — for claude ids pick a claude-account profile ` +
        `(e.g. env -u UCC_PROFILE ucc-auto, or a ucc-<claude-profile> wrapper).`,
    );
  }

  const options = given.includes("--") ? given.slice(0, given.indexOf("--")) : given;
  const print = isPrint(options);
  if (print && asked !== undefined && isFable(asked)) refuseFablePrint(asked, "--model", env);

  if (ctx.role && !ROLES.includes(ctx.role)) {
    warnings.push(`role '${ctx.role}' is not one of ${ROLES.join(", ")} — launching with the roleless page`);
  }

  const pools = world.pools ?? readLocalPools(join(dir, "pools.local.json"), warnings);
  const sets = setsFor(ctx.profile, pools);
  if (ctx.profile && !sets.includes("FABLE_SPENT")) {
    const home = env.UCC_HOME ?? `${env.HOME}/.local/share/ucc`;
    const why = fableSpentReason(join(home, "profiles", ctx.profile, "ratelimit.json"));
    if (why) {
      sets.push("FABLE_SPENT");
      trace.push(`set FABLE_SPENT: ratelimit.json ${why}`);
    }
  }
  // An unknown --launch kind refuses here, before the shortcut below.
  const { pick, candidates } = choosePage(
    join(dir, "launch"),
    { kind, model: explicitModel, profile: ctx.profile, sets, role: ctx.role },
    trace,
    warnings,
  );

  const mine = (family) => {
    const clash = FAMILIES[family].find((f) => options.some((a) => a === f || a.startsWith(`${f}=`)));
    if (!clash) return true;
    trace.push(`emit: caller passed ${clash} — the launch config's ${family} is not applied`);
    return false;
  };

  // A caller who already named an agent, a definition or a system prompt owns
  // the whole family — including the fleet deny list.
  if (!mine("agents")) return empty(candidates);
  if (!pick) return empty(candidates);

  let front;
  let body;
  try {
    ({ front, body } = parsePage(pick.text, basename(pick.real)));
  } catch (e) {
    warnings.push(`${e.message} — launching plain`);
    return empty(candidates);
  }

  // ── the wire rules ────────────────────────────────────────────────────────
  let model = asked ?? (front.model === undefined ? undefined : String(front.model));
  let modelIsExplicit = asked !== undefined;
  let effort = front.effort === undefined ? undefined : String(front.effort);

  if (model !== undefined && pin !== "") {
    trace.push(`pin: ANTHROPIC_MODEL=${pin} — the harness reads it natively; no model in the definition`);
    model = undefined;
    modelIsExplicit = false;
  } else if (model !== undefined && foreign) {
    // The endpoint serves its own models, so ours is meaningless there. An
    // explicit request still rides through on the caller's own command line
    // (model_matched stays 0) — the endpoint may serve, reject or ignore it.
    trace.push(`foreign endpoint: ANTHROPIC_BASE_URL=${baseUrl} serves its own models — dropping model ${model}`);
    if (asked !== undefined) {
      warnings.push(
        `explicit --model ${explicitModel} rides through to an endpoint that serves its own models ` +
          `(ANTHROPIC_BASE_URL is set) — the endpoint may serve, reject, or ignore it`,
      );
    }
    model = undefined;
    modelIsExplicit = false;
  }
  if (foreign && pin === "") {
    warnings.push(`profile ${ctx.profile ?? "?"} has no ANTHROPIC_MODEL — provision one`);
  }

  // The profile pins a foreign model, so our effort belongs to a model that is
  // not running. Forcing it makes the TUI's own effortLevel look unsaveable.
  if (effort !== undefined && pin !== "" && foreign && explicitEffort === undefined) {
    trace.push(
      `foreign endpoint: withholding the page effort ${effort} — the endpoint's model is not ours; ` +
        `the profile's settings.json effortLevel keeps its own`,
    );
    effort = undefined;
  }

  // A resumed session keeps its own model and effort: emitting ours would
  // switch a session mid-conversation. Asking explicitly is consent to switch.
  if (resume && asked === undefined && (model !== undefined || effort !== undefined)) {
    trace.push("resume/continue: the session keeps its own model and effort — dropping ours");
    model = undefined;
    effort = undefined;
  }
  // The page's own model, when it survives the rules above, refuses print mode
  // the same way an explicit one did.
  if (print && asked === undefined && model !== undefined && isFable(model)) {
    refuseFablePrint(model, `page ${basename(pick.real)}`, env);
  }
  if (explicitEffort !== undefined) {
    effort = explicitEffort;
    trace.push(`explicit effort: ${explicitEffort}`);
  }

  // ── the definition ────────────────────────────────────────────────────────
  const name = pick.stem;
  const agent = {
    description: front.description === undefined ? `launch page ${name}` : String(front.description),
    prompt: body,
  };
  for (const [k, v] of Object.entries(front)) if (!CONSUMED.has(k)) agent[k] = v;
  if (model !== undefined) agent.model = model;
  if (front.name !== undefined) {
    warnings.push(`${basename(pick.real)} carries 'name' — a definition is named after its file, ignored`);
  }
  if (front.mcpServers !== undefined) {
    const servers = resolveServers(join(dir, "mcp"), [].concat(front.mcpServers).map(String), env, trace, warnings);
    if (servers.length > 0) agent.mcpServers = servers;
  }

  // ── the argv ──────────────────────────────────────────────────────────────
  const argv = definitionArgv(name, agent, world.pluginRoot, trace);
  if (modelIsExplicit && model !== undefined) argv.push("--model", model); // siftArgv removed the caller's own
  if (effort !== undefined && mine("effort")) argv.push("--effort", effort);

  // ── the seal: lifted for a known model outside the Fable family; every other
  // seat keeps the wrapper's seal and denies the fork paths it cannot reach ──
  let sealed;
  if (model === undefined) sealed = resume ? "resume without --model — the session's model is unknown" : "no model";
  else if (isFable(model)) sealed = `model ${model} is Fable`;
  else if (!mine("settings")) sealed = "caller passed --settings";
  if (sealed === undefined) {
    argv.push("--settings", LIFT_SETTINGS);
    trace.push(`lift: model ${model} — --settings turns the subagent force off and the fork on`);
  } else {
    trace.push(`sealed: ${sealed}`);
  }

  // --disallowedTools is declared variadic (<tools...>): a space-separated
  // value swallows every argument that follows, the user's prompt included, so
  // it is always a --flag=value token. The harness adds up repeated tokens.
  const deny = readFleetDeny(dir, warnings);
  if (sealed !== undefined) deny.push(...SEALED_DENY.filter((d) => !deny.includes(d)));
  if (mine("disallowedTools")) {
    if (deny.length > 0) argv.push(`--${FLEET_DENY_KEY}=${deny.join(",")}`);
  } else if (sealed !== undefined) {
    // The caller's own list replaces the fleet's, never the seal's fork denies.
    argv.push(`--${FLEET_DENY_KEY}=${SEALED_DENY.join(",")}`);
    trace.push("sealed: the fork denies ride beside the caller's --disallowedTools");
  }

  return {
    argv,
    model_matched: argv.includes("--model"),
    trace,
    warnings,
    sets,
    definition: { [name]: agent },
    name,
    candidates,
    page: pick,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPLAIN and CHECK — the two verbs that read the tree without launching it.
// ═══════════════════════════════════════════════════════════════════════════

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
/** Linux caps one argv element at 128 KB (MAX_ARG_STRLEN); the --agents JSON is one element. */
export const DEFINITION_CEILING = 128 * 1024;

/** One condition token plus an optional role, and nothing else (R3 § names). */
const LADDER_NAME = /^(@[a-z0-9][a-z0-9._-]*|[A-Z][A-Z0-9_]*|[a-z0-9][a-z0-9.-]*)(\.(advisor|leader|worker))?\.md$/;
const LEGAL_CHARS = /^[A-Za-z0-9._@-]+$/;
const roleOf = (name) => name.match(/\.(advisor|leader|worker)\.md$/)?.[1];

/** The whole tree, judged. Returns { errors, warnings, notes }; the CLI exits
 *  non-zero on any error. Nothing here launches anything. */
export function checkTree(dir = HERE, env = {}) {
  const errors = [];
  const warnings = [];
  const notes = [];
  const launchDir = join(dir, "launch");
  const mcpDir = join(dir, "mcp");

  const fleetPath = join(dir, "fleet.md");
  if (!existsSync(fleetPath)) {
    warnings.push("fleet.md is missing — no fleet deny list is emitted");
  } else {
    try {
      const { front } = parsePage(readFileSync(fleetPath, "utf8"), "fleet.md");
      for (const key of Object.keys(front)) {
        if (key !== FLEET_DENY_KEY) {
          errors.push(`fleet.md carries '${key}' — fleet.md holds ${FLEET_DENY_KEY} and nothing else`);
        }
      }
      if (front[FLEET_DENY_KEY] !== undefined && !Array.isArray(front[FLEET_DENY_KEY])) {
        errors.push(`fleet.md: ${FLEET_DENY_KEY} must be a list — ${FLEET_DENY_KEY}: [A, B]`);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (!existsSync(launchDir)) {
    warnings.push("launch/ does not exist — every launch falls through to a plain one");
  } else {
    const root = realpathSync(launchDir);
    const seen = new Set(); // each real page once, however many names reach it
    for (const entry of readdirSync(launchDir).sort()) {
      if (entry.startsWith(".")) continue;
      if (!entry.endsWith(".md")) {
        warnings.push(`launch/${entry} is not a page — the ladder only ever names *.md`);
        continue;
      }
      if (!LEGAL_CHARS.test(entry)) {
        errors.push(`launch/${entry}: a page name may hold only [A-Za-z0-9._@-]`);
        continue;
      }
      if (entry.includes("[1m]")) {
        errors.push(`launch/${entry}: a page name never carries [1m] — the postfix is the harness's, not the id's`);
        continue;
      }
      if (!LADDER_NAME.test(entry)) {
        errors.push(
          `launch/${entry}: no ladder ever builds this name — one condition token ` +
            `(@profile, SET, a model id, a kind, or default) plus an optional .advisor/.leader/.worker`,
        );
        continue;
      }
      const got = resolveCandidate(launchDir, entry);
      if (got?.error) {
        errors.push(`launch/${got.error}`);
        continue;
      }
      // A link is one page with several addresses: a leader name reaching a
      // worker page would launch the worker prompt under a leader's agent_type.
      if (got.linked && roleOf(entry) !== roleOf(basename(got.real))) {
        errors.push(
          `launch/${entry} → ${basename(got.real)}: a ${roleOf(entry) ?? "roleless"} name linked to a ` +
            `${roleOf(basename(got.real)) ?? "roleless"} page — the role suffixes must match`,
        );
      }
      if (seen.has(got.real)) continue;
      seen.add(got.real);
      checkPage(got, relative(root, got.real), mcpDir, env, errors, warnings, notes);
    }
  }

  if (existsSync(mcpDir)) {
    for (const entry of readdirSync(mcpDir).sort()) {
      if (entry.startsWith(".") || !entry.endsWith(".md")) continue;
      checkServer(mcpDir, entry.replace(/\.md$/, ""), errors);
    }
  }

  return { errors, warnings, notes };
}

function checkPage({ real: path, text }, entry, mcpDir, env, errors, warnings, notes) {
  let front;
  let body;
  try {
    ({ front, body } = parsePage(text, `launch/${entry}`));
  } catch (e) {
    errors.push(e.message);
    return;
  }
  if (front.name !== undefined) {
    errors.push(`launch/${entry} carries 'name' — a definition is named after the file it came from`);
  }
  if (front.model !== undefined) {
    const model = String(front.model);
    if (model.startsWith("claude-") && !model.includes("[1m]")) {
      errors.push(`launch/${entry}: model '${model}' is a claude id without [1m] — the session would report a 200k window`);
    }
  }
  if (front.effort !== undefined && !EFFORTS.includes(String(front.effort))) {
    errors.push(`launch/${entry}: effort '${front.effort}' is not one of ${EFFORTS.join(", ")}`);
  }
  if (front.mcpServers !== undefined) {
    for (const name of [].concat(front.mcpServers).map(String)) {
      checkServer(mcpDir, name, errors, `launch/${entry}: `);
    }
  }
  const size = JSON.stringify({ ...front, prompt: body }).length;
  if (size > DEFINITION_CEILING) {
    warnings.push(
      `launch/${entry}: the definition is ${Math.round(size / 1024)} KB — above the ${DEFINITION_CEILING / 1024} KB ` +
        `argv-element ceiling; a launch this large hits E2BIG whenever it falls back to the argv JSON form`,
    );
  }
  const bytes = Buffer.byteLength(text);
  const tokens = tokenCount(path, env);
  notes.push(`launch/${entry}: ${bytes} bytes${tokens === null ? "" : `, ${tokens} tokens`}`);
}

function checkServer(mcpDir, name, errors, prefix = "") {
  let file;
  try {
    file = readServerFile(mcpDir, name);
  } catch (e) {
    errors.push(`${prefix}${e.message}`);
    return;
  }
  if (file.error) {
    errors.push(`${prefix}${file.error}`);
    return;
  }
  if (!Array.isArray(file.requires)) {
    errors.push(`${prefix}mcp/${name}.md: requires must be a list of probe strings`);
    return;
  }
  for (const req of file.requires) {
    for (const term of String(req).split(" | ")) {
      const bare = term.trim().replace(/^!/, "");
      const kind = bare.slice(0, bare.indexOf(":"));
      if (!PROBE_KINDS.includes(kind)) {
        errors.push(`${prefix}mcp/${name}.md: probe '${term.trim()}' has no kind — use ${PROBE_KINDS.map((k) => `${k}:`).join(" ")}`);
      }
    }
  }
}

/** Bytes are the gate; a token count is a note, and only when the daemon that
 *  can measure one is on PATH (D9 — `check` must run in CI with no daemon). */
function tokenCount(path, env) {
  if (!probe("bin:ccc-statusd", env)) return null;
  try {
    const out = execFileSync("ccc-statusd", ["session", "token-count", path], {
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = out.match(/\d[\d,]*/);
    return m ? Number(m[0].replace(/,/g, "")) : null;
  } catch {
    return null;
  }
}

/** The ladder, the rules and the render, for a human. Deterministic on both
 *  runtimes — the parity gate compares this byte for byte. */
export function explain(ctx = {}, world = {}) {
  const out = render(ctx, world);
  const lines = [
    `launch  profile=${ctx.profile ?? "—"} role=${ctx.role ?? "—"} model=${ctx.model ?? "—"} ` +
      `kind=${ctx.kind ?? "—"} cwd=${ctx.cwd ?? "—"}`,
    `sets    ${out.sets?.length ? out.sets.join(", ") : "none"}`,
    "",
    "candidates",
  ];
  const hit = out.page ? out.candidates.indexOf(out.page.name) : -1;
  out.candidates.forEach((name, i) => {
    if (i === hit) lines.push(`  ✓ ${name}${out.page.linked ? ` → ${out.page.real}` : ""}`);
    else if (hit >= 0 && i > hit) lines.push(`  · ${name}`);
    else lines.push(`  ✗ ${name}`);
  });
  lines.push("", "rules");
  for (const t of out.trace) lines.push(`  ${t}`);
  if (out.warnings.length > 0) {
    lines.push("", "warnings");
    for (const w of out.warnings) lines.push(`  ! ${w}`);
  }
  lines.push("", "render");
  lines.push(renderJSON(out));
  return `${lines.join("\n")}\n`;
}

const renderJSON = (out) =>
  JSON.stringify(
    { argv: out.argv, model_matched: out.model_matched, trace: out.trace, warnings: out.warnings },
    null,
    2,
  );

// ═══════════════════════════════════════════════════════════════════════════
// CLI — `launch.mjs [verb] '<json>' | --flag value`
// ═══════════════════════════════════════════════════════════════════════════

const VERBS = ["render", "explain", "check"];

export function parseArgs(args) {
  const flags = {};
  let json = {};
  let verb = "render";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = args[++i] ?? "";
    } else if (a.trim().startsWith("{")) {
      json = JSON.parse(a);
    } else if (i === 0 && VERBS.includes(a)) {
      verb = a;
    } else {
      throw new Error(`unrecognized argument '${a}' — pass a verb (${VERBS.join(", ")}), a JSON object, or --flag value`);
    }
  }
  const pick = (k) => flags[k] ?? (typeof json[k] === "string" && json[k] !== "" ? json[k] : undefined);
  const ctx = {
    model: pick("model"),
    effort: pick("effort"),
    profile: pick("profile"),
    role: pick("role"),
    kind: pick("launch"),
    cwd: pick("cwd") ?? pick("project"),
    argv: Array.isArray(json.argv) ? json.argv.map(String) : undefined,
  };
  return { verb, ctx, dir: pick("dir") };
}

/** The keys that say which endpoint a seat is. They come from the profile's
 *  .env ALONE: a pre-render from ccc-tmux runs in the spawner's shell, and the
 *  spawner's own pin must never route the seat. */
const IDENTITY = ["ANTHROPIC_MODEL", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];

/** The seat's environment: the profile's .env laid over the caller's, read as
 *  bash reads it — `export`, matching quotes, $VAR and ${VAR} expanded except
 *  inside single quotes. No profile is a claude seat: no identity at all. */
export function seatEnv(profile, env = process.env) {
  const merged = { ...env };
  for (const key of IDENTITY) delete merged[key];
  if (!profile) return merged;
  const home = env.UCC_HOME ?? `${env.HOME}/.local/share/ucc`;
  const file = join(home, "profiles", profile, ".env");
  if (!existsSync(file)) return merged;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim().replace(/^export\s+/, "");
    if (text === "" || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 0) continue;
    let value = text.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) value = value.slice(1, -1);
    if (quote !== "'") value = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => merged[a ?? b] ?? m);
    merged[text.slice(0, eq).trim()] = value;
  }
  return merged;
}

export function main(args, env = process.env) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (e) {
    process.stderr.write(`launch-config: ${e.message}\n`);
    return 1;
  }
  const dir = parsed.dir ? resolvePath(parsed.dir) : HERE;

  if (parsed.verb === "check") {
    const got = checkTree(dir, env);
    for (const n of got.notes) process.stdout.write(`note:  ${n}\n`);
    for (const w of got.warnings) process.stdout.write(`warn:  ${w}\n`);
    for (const e of got.errors) process.stdout.write(`error: ${e}\n`);
    process.stdout.write(
      got.errors.length === 0
        ? `check: ${dir} is good (${got.warnings.length} warning${got.warnings.length === 1 ? "" : "s"})\n`
        : `check: ${got.errors.length} error${got.errors.length === 1 ? "" : "s"} in ${dir}\n`,
    );
    return got.errors.length === 0 ? 0 : 1;
  }

  const home = env.UCC_HOME ?? `${env.HOME}/.local/share/ucc`;
  const world = { dir, env: seatEnv(parsed.ctx.profile, env), pluginRoot: join(home, "cache", "launch-plugins") };
  try {
    if (parsed.verb === "explain") process.stdout.write(explain(parsed.ctx, world));
    else process.stdout.write(`${renderJSON(render(parsed.ctx, world))}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      const text = e.message.startsWith("launch-config:") ? e.message : `launch-config: REFUSED — ${e.message}`;
      process.stderr.write(`${text}\n`);
      return 2;
    }
    process.stderr.write(`launch-config: render failed — ${e.message}\n`);
    return 1;
  }
}

// `import.meta.main` only landed in Node 24.2, and a silently-skipped CLI block
// would degrade every wrapper launch to "unparseable render output". Comparing
// argv[1] to this file works on every runtime that can load it.
const isMain =
  import.meta.main ??
  (process.argv[1] !== undefined && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url)));

if (isMain) process.exit(main(process.argv.slice(2)));
