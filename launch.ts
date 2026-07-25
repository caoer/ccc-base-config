#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════
// launch.ts — the engine. rules.ts is the config.
//
// A launcher (the ucc-<profile> bash wrapper, ccc-tmux spawn-agent, you in a
// shell) invokes this with the launch context; it prints the harness CLI
// params to splice into the launch.
//
//   bun launch.ts '{"harness":"claude","role":"worker","project":"/path"}'
//   bun launch.ts --role leader --output shell
//   bun launch.ts explain --role worker --profile dewiest_gulp
//   bun launch.ts matrix                     # every finite combination
//   bun launch.ts matrix --html /tmp/m.html  # the same, as a debug page
//
// Default output is JSON: { argv, model_matched, trace, warnings }
//   argv          — CLI params for the harness binary
//   model_matched — argv carries a real --model; the caller drops its own
//   trace         — which rules fired, in order (the debugging story)
//
// Three stages, in this order, and nothing else:
//
//   resolve(ctx, world) → Plan     rules.ts + the machine → a decision
//   emitClaude(plan)    → argv     a decision → harness flags
//   the CLI                        parses ctx, builds the world, prints
//
// The engine never reads process.env or the filesystem directly — it asks
// `world`. That is the seam: swap in a made-up world and any combination
// renders without a machine that matches it.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import {
  defaults,
  arms,
  pools,
  routes,
  layers,
  launcherDefaults,
  OWN_LAUNCHER_DEFAULTS,
  type Append,
  type Layer,
  type Mcp,
  type When,
} from "./rules.ts";

const ROOT = import.meta.dirname;

// ─── Context: what the launcher tells us ────────────────────────────────────
export type Ctx = {
  harness: "claude" | "codex";
  /** requested model — a real id, optionally with an effort suffix */
  model?: string;
  /** ucc profile (launcher basename `ucc-<p>`, or $UCC_PROFILE) */
  profile?: string;
  /** the launch cwd (the wire name for this is `project`) */
  cwd?: string;
  /** fleet role: advisor | leader | worker */
  role?: string;
  /** flags the caller already put on the command line — never overridden */
  argv?: string[];
};

// ─── World: everything outside this process ─────────────────────────────────
export type World = {
  env: Record<string, string | undefined>;
  hasFile: (path: string) => boolean;
  hasExec: (path: string) => boolean;
  hasBin: (name: string) => boolean;
  /** which arm to take when a route offers several */
  pick: (candidates: string[]) => string;
  /** are the bash wrappers out of the way yet? (rules.ts § launcherDefaults) */
  ownLauncherDefaults: boolean;
};

// ─── Config: the decision, before it becomes flags ──────────────────────────
export type Config = {
  model?: string;
  effort?: string;
  verbose?: boolean;
  /** REPLACES the harness base prompt */
  systemPromptFile?: string;
  /** system-prompt append stream, in order */
  append: Append[];
  /** preloaded at session start via one startup directive */
  skills: string[];
  /** file paths, or the config object itself (serialized at emit) */
  mcp: Mcp[];
  tools: string[];
  allowedTools: string[];
  disallowedTools: string[];
  excludeDynamicSections?: boolean;
  extraArgs: string[];
};

export type Plan = {
  ctx: Ctx;
  /** the arm the router picked, if any */
  arm?: string;
  /** every arm the winning route offered */
  candidates: string[];
  config: Config;
  trace: string[];
  warnings: string[];
};

// The annotation is on the binding, not just the arrow: that is what lets
// TypeScript treat `fail(...)` as ending control flow and narrow after it.
const fail: (msg: string) => never = (msg) => {
  console.error(`launch: ${msg}`);
  process.exit(1);
};

// ═══════════════════════════════════════════════════════════════════════════
// THE WORLD — the only code that touches env, disk, or PATH.
// ═══════════════════════════════════════════════════════════════════════════

export function realWorld(env = process.env): World {
  return {
    env,
    hasFile: (p) => p.trim() !== "" && existsSync(p),
    hasExec: (p) => {
      if (p.trim() === "" || !existsSync(p)) return false;
      try {
        return (statSync(p).mode & 0o111) !== 0;
      } catch {
        return false;
      }
    },
    hasBin: (name) => {
      if (name.trim() === "") return false;
      for (const dir of (env.PATH ?? "").split(":")) {
        if (dir && existsSync(join(dir, name))) return true;
      }
      return false;
    },
    pick: (c) => c[Math.floor(Math.random() * c.length)],
    ownLauncherDefaults: OWN_LAUNCHER_DEFAULTS,
  };
}

/** A world that answers everything the same way — for rendering combinations
 *  that no machine here matches. */
export function fixedWorld(over: Partial<World> = {}): World {
  return {
    env: {},
    hasFile: () => false,
    hasExec: () => false,
    hasBin: () => false,
    pick: (c) => c[0],
    ownLauncherDefaults: OWN_LAUNCHER_DEFAULTS,
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MATCHING — how a rule's `when` and `requires` are answered.
// ═══════════════════════════════════════════════════════════════════════════

const list = (v?: string | string[]): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : [v];

/** ${role} ${profile} ${cwd} ${model} then env. ${A|B} first non-empty,
 *  ${A:-text} literal fallback. */
export function interpolate(s: string, ctx: Ctx, world: World): string {
  return s.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
    const cut = expr.indexOf(":-");
    const chain = cut >= 0 ? expr.slice(0, cut) : expr;
    const fallback = cut >= 0 ? expr.slice(cut + 2) : "";
    for (const raw of chain.split("|")) {
      const name = raw.trim();
      const v =
        name === "role"
          ? ctx.role
          : name === "profile"
            ? ctx.profile
            : name === "cwd"
              ? ctx.cwd
              : name === "model"
                ? ctx.model
                : world.env[name];
      if (v) return v;
    }
    return fallback;
  });
}

/** Interpolate every string inside a structure — keys and leaves alike.
 *  This is how an mcp config is built: values go through JSON.stringify at
 *  emit, so an env var carrying a quote cannot break out of its string. */
export function interpolateDeep(v: unknown, ctx: Ctx, world: World): unknown {
  if (typeof v === "string") return interpolate(v, ctx, world);
  if (Array.isArray(v)) return v.map((x) => interpolateDeep(x, ctx, world));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[interpolate(k, ctx, world)] = interpolateDeep(val, ctx, world);
    }
    return out;
  }
  return v;
}

const expandPath = (p: string, env: Record<string, string | undefined>): string => {
  const home = env.HOME ?? "";
  let out = p;
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = home + out.slice(1);
  return isAbsolute(out) ? out : resolvePath(ROOT, out);
};

/** " | " is OR within one probe string. A leading ! negates. */
export function probe(expr: string, ctx: Ctx, world: World): boolean {
  return expr.split(" | ").some((term) => probeOne(term.trim(), ctx, world));
}

function probeOne(term: string, ctx: Ctx, world: World): boolean {
  if (term.startsWith("!")) return !probeOne(term.slice(1).trim(), ctx, world);
  const cut = term.indexOf(":");
  if (cut < 0) return fail(`rules.ts: probe '${term}' has no kind — use env: file: exec: bin:`);
  const kind = term.slice(0, cut);
  const rest = term.slice(cut + 1);
  if (kind === "env") {
    const tilde = rest.indexOf("~");
    const name = (tilde < 0 ? rest : rest.slice(0, tilde)).trim();
    const value = world.env[name] ?? "";
    if (tilde < 0) return value !== "";
    return value.includes(interpolate(rest.slice(tilde + 1), ctx, world));
  }
  const path = interpolate(rest, ctx, world).trim();
  if (path === "") return false;
  if (kind === "file") return world.hasFile(expandPath(path, world.env));
  if (kind === "exec") return world.hasExec(expandPath(path, world.env));
  if (kind === "bin") return world.hasBin(path);
  return fail(`rules.ts: unknown probe kind '${kind}' — use env: file: exec: bin:`);
}

const matchPlain = (patterns: string[], value: string | undefined): boolean =>
  patterns.some((p) => (p === "*" ? !!value : p === value));

const matchModel = (patterns: string[], value: string | undefined): boolean =>
  patterns.some((p) =>
    p === "*"
      ? !!value
      : p.endsWith("*")
        ? !!value && value.startsWith(p.slice(0, -1))
        : p === value,
  );

const matchCwd = (
  patterns: string[],
  cwd: string | undefined,
  env: Record<string, string | undefined>,
): boolean => {
  if (!cwd) return false;
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.startsWith("/") || p.startsWith("~")) {
      const dir = expandPath(p, env).replace(/\/+$/, "");
      return cwd === dir || cwd.startsWith(dir + "/");
    }
    return cwd.includes(p);
  });
};

export function matches(when: When | undefined, ctx: Ctx, world: World): boolean {
  if (!when) return true;
  if (when.noModel === true && (ctx.model ?? "") !== "") return false;
  if (when.profile && !matchPlain(list(when.profile), ctx.profile)) return false;
  if (when.role && !matchPlain(list(when.role), ctx.role)) return false;
  if (when.model && !matchModel(list(when.model), ctx.model)) return false;
  if (when.cwd && !matchCwd(list(when.cwd), ctx.cwd, world.env)) return false;
  if (when.pool) {
    const inPool = list(when.pool).some((name) => {
      const members = pools[name];
      if (!members) fail(`rules.ts: route names unknown pool '${name}'`);
      return !!ctx.profile && members.includes(ctx.profile);
    });
    if (!inPool) return false;
  }
  return true;
}

const describe = (when?: When): string => {
  if (!when) return "always";
  const parts: string[] = [];
  if (when.noModel) parts.push("no model");
  for (const k of ["profile", "pool", "role", "model", "cwd"] as const) {
    if (when[k]) parts.push(`${k}=${list(when[k]).join("|")}`);
  }
  return parts.join(" ") || "always";
};

// ═══════════════════════════════════════════════════════════════════════════
// RESOLVE — rules.ts + the world → a Plan. Pure: no fs, no env, no writes.
// ═══════════════════════════════════════════════════════════════════════════

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const ONE_M = "[1m]";
const isClaude = (model: string): boolean => model.startsWith("claude-");

/** Every claude id carries [1m]; without it the session reports a 200k
 *  context window. An id that already names a variant is left alone. */
export const withOneM = (model: string): string =>
  isClaude(model) && !model.includes("[") ? model + ONE_M : model;

/** What the router matches on: the id without its [1m] postfix. */
export const bareId = (model: string): string =>
  model.endsWith(ONE_M) ? model.slice(0, -ONE_M.length) : model;

/**
 * claude-opus-4-8-xhigh → { model: "claude-opus-4-8", effort: "xhigh" }
 *
 * Only claude ids carry this convention. An endpoint id is opaque — splitting
 * `gpt-5.6-sol-max` would invent a model that does not exist.
 */
export function splitEffort(model?: string): { model?: string; effort?: string } {
  if (!model) return {};
  if (!isClaude(model)) return { model };
  for (const e of EFFORTS) {
    if (model.endsWith(`-${e}`)) return { model: model.slice(0, -(e.length + 1)), effort: e };
  }
  return { model };
}

function applyLayer(c: Config, l: Layer, ctx: Ctx, world: World, trace: string[]): void {
  const I = (s: string) => interpolate(s, ctx, world);
  const did: string[] = [];
  // A fallback layer fills only what nothing has set yet — it is a default,
  // not an override, so an arm's prompt and a role's brief both survive it.
  const taken = (already: boolean, field: string): boolean => {
    if (l.fallback && already) {
      did.push(`${field} kept`);
      return true;
    }
    return false;
  };
  if (l.systemPrompt !== undefined && !taken(c.systemPromptFile !== undefined, "system-prompt")) {
    c.systemPromptFile = I(l.systemPrompt);
    did.push(`system-prompt ${c.systemPromptFile}`);
  }
  if (l.append?.length && !taken(c.append.length > 0, "append")) {
    for (const a of l.append) c.append.push("file" in a ? { file: I(a.file) } : { text: I(a.text) });
    did.push(`append ×${l.append.length}`);
  }
  if (l.skills?.length && !taken(c.skills.length > 0, "skills")) {
    c.skills.push(...l.skills.map(I));
    did.push(`skills ${l.skills.join(",")}`);
  }
  if (l.mcp?.length && !taken(c.mcp.length > 0, "mcp")) {
    c.mcp.push(
      ...l.mcp.map((m) =>
        typeof m === "string" ? I(m) : (interpolateDeep(m, ctx, world) as Record<string, unknown>),
      ),
    );
    did.push(`mcp ×${l.mcp.length}`);
  }
  if (l.tools?.length && !taken(c.tools.length > 0, "tools")) {
    c.tools.push(...l.tools.map(I));
    did.push(`tools ${l.tools.join(",")}`);
  }
  if (l.allowedTools?.length && !taken(c.allowedTools.length > 0, "allowedTools")) {
    c.allowedTools.push(...l.allowedTools.map(I));
    did.push(`allowedTools ${l.allowedTools.join(",")}`);
  }
  if (l.disallowedTools?.length && !taken(c.disallowedTools.length > 0, "disallowedTools")) {
    c.disallowedTools.push(...l.disallowedTools.map(I));
    did.push(`disallowedTools ${l.disallowedTools.join(",")}`);
  }
  if (
    l.excludeDynamicSections !== undefined &&
    !taken(c.excludeDynamicSections !== undefined, "exclude-dynamic-sections")
  ) {
    c.excludeDynamicSections = l.excludeDynamicSections;
    did.push(`exclude-dynamic-sections ${l.excludeDynamicSections}`);
  }
  if (l.effort !== undefined && !taken(c.effort !== undefined, "effort")) {
    c.effort = l.effort;
    did.push(`effort ${l.effort}`);
  }
  if (l.verbose !== undefined && !taken(c.verbose !== undefined, "verbose")) {
    c.verbose = l.verbose;
    did.push(`verbose ${l.verbose}`);
  }
  if (l.args?.length && !taken(c.extraArgs.length > 0, "args")) {
    c.extraArgs.push(...l.args.map(I));
    did.push(`args ${l.args.join(" ")}`);
  }
  trace.push(`layer ${l.why ?? describe(l.when)}: ${did.join(", ") || "nothing"}`);
}

export function resolve(ctx: Ctx, world: World): Plan {
  const trace: string[] = [];
  const warnings: string[] = [];

  const requested = splitEffort(ctx.model);
  // What we would emit for an explicit request, and what the router matches on.
  const asked = requested.model ? withOneM(requested.model) : undefined;
  const c: Ctx = { ...ctx, model: requested.model ? bareId(requested.model) : undefined };
  if (requested.effort) {
    trace.push(`model ${ctx.model}: effort suffix → ${requested.model} + effort ${requested.effort}`);
  }
  if (asked && asked !== requested.model) {
    trace.push(`model ${requested.model}: normalized to ${asked} (a claude id without [1m] reports 200k)`);
  }

  const config: Config = {
    append: [],
    skills: [],
    mcp: [],
    tools: [],
    allowedTools: [],
    disallowedTools: [],
    extraArgs: [],
  };

  // 1. defaults
  applyLayer(config, defaults, c, world, trace);

  // 2. the router — first match wins
  let arm: string | undefined;
  let candidates: string[] = [];
  for (const route of routes) {
    if (!matches(route.when, c, world)) continue;
    candidates = list(route.use);
    arm = candidates.length === 1 ? candidates[0] : world.pick(candidates);
    const of = candidates.length > 1 ? ` (of ${candidates.join(", ")})` : "";
    trace.push(`route [${describe(route.when)}] → ${arm}${of}${route.why ? ` — ${route.why}` : ""}`);
    break;
  }
  if (arm) {
    const a = arms[arm];
    if (!a) fail(`rules.ts: route names unknown arm '${arm}'`);
    // An explicitly requested id is emitted as asked, so a variant spelling
    // survives; the arm then supplies only the prompt and the effort. A pinned
    // arm ignores the request — its endpoint speaks no other id.
    const kept = asked !== undefined && !a.pin;
    config.model = kept ? asked : a.model;
    if (a.prompt) config.systemPromptFile = a.prompt;
    if (a.effort) config.effort = a.effort;
    trace.push(
      `arm ${arm}: model ${config.model}` +
        `${kept ? " (as requested)" : a.pin && asked ? " (pinned — request ignored)" : ""}` +
        `${a.prompt ? `, prompt ${a.prompt}` : ""}`,
    );
  } else if (asked) {
    config.model = asked;
    trace.push(`no route matched — model ${asked} passes through as a real id`);
  } else {
    trace.push("no route matched, no model requested — harness keeps its own model");
  }

  // 3. layers — every match applies, in order
  const all = [...layers, ...(world.ownLauncherDefaults ? launcherDefaults : [])];
  for (const layer of all) {
    if (!matches(layer.when, c, world)) continue;
    const unmet = (layer.requires ?? []).filter((r) => !probe(r, c, world));
    if (unmet.length > 0) {
      trace.push(`layer ${layer.why ?? describe(layer.when)}: skipped — needs ${unmet.join("; ")}`);
      continue;
    }
    applyLayer(config, layer, c, world, trace);
  }

  // An explicit effort suffix on the requested model beats every rule.
  if (requested.effort) config.effort = requested.effort;

  warnings.push(...validate(config));

  return { ctx: c, arm, candidates, config, trace, warnings };
}

/** Flag combinations the harness silently ignores. Drops the losing flag and
 *  says so, rather than emitting something that quietly does nothing. */
export function validate(config: Config): string[] {
  const warnings: string[] = [];
  if (config.excludeDynamicSections && config.systemPromptFile) {
    warnings.push(
      "--exclude-dynamic-system-prompt-sections does nothing when a system prompt replaces the harness default — dropped",
    );
    config.excludeDynamicSections = false;
  }
  return warnings;
}

// ═══════════════════════════════════════════════════════════════════════════
// EMIT — Plan → harness argv. The only stage that writes files.
// ═══════════════════════════════════════════════════════════════════════════

// Flags the caller may already have used. We never emit one twice: theirs wins.
const FAMILIES: Record<string, string[]> = {
  model: ["--model"],
  effort: ["--effort"],
  systemPrompt: ["--system-prompt", "--system-prompt-file"],
  append: ["--append-system-prompt", "--append-system-prompt-file"],
  mcp: ["--mcp-config"],
  tools: ["--tools"],
  allowedTools: ["--allowedTools", "--allowed-tools"],
  disallowedTools: ["--disallowedTools", "--disallowed-tools"],
  excludeDynamicSections: ["--exclude-dynamic-system-prompt-sections"],
  verbose: ["--verbose"],
};

/** Families that carry a stream rather than one value. Suppressing one drops
 *  everything the rules wanted to add, so it is a warning, not a trace line. */
const ACCUMULATORS = new Set(["append", "mcp", "tools", "allowedTools", "disallowedTools"]);

/** `dry` renders without touching disk: nothing is written, and a missing
 *  file becomes a warning instead of exiting. That is what lets `matrix`
 *  render combinations this machine does not have. */
export type EmitOpts = { dry?: boolean };

export function emitClaude(plan: Plan, world: World, opts: EmitOpts = {}): string[] {
  const c = plan.config;
  const env = world.env;
  const given = plan.ctx.argv ?? [];
  const argv: string[] = [];

  // Referenced files that don't exist fail loud — a typo'd path must not
  // silently shrink the prompt.
  const mustExist = (p: string, what: string): string => {
    if (p.split("/").includes("..")) {
      fail(`${what}: a path may not climb out with '..' — ${p}`);
    }
    const abs = expandPath(p, env);
    if (!existsSync(abs)) {
      if (!opts.dry) fail(`${what} not found: ${abs}`);
      plan.warnings.push(`${what} not found: ${abs}`);
    }
    return abs;
  };

  // .rendered/ holds content-hashed compositions — gitignored, safe to delete.
  // The name is the content hash, so a dry render names the same file it would
  // have written.
  const writeRendered = (prefix: string, content: string): string => {
    const dir = resolvePath(ROOT, ".rendered");
    const h = createHash("sha256").update(content).digest("hex").slice(0, 12);
    const path = resolvePath(dir, `${prefix}-${h}.md`);
    if (!opts.dry) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content);
    }
    return path;
  };

  const readPiece = (p: string): string => {
    const abs = mustExist(p, "append file");
    return existsSync(abs) ? readFileSync(abs, "utf8").trim() : "";
  };

  const mine = (family: string): boolean => {
    const flags = FAMILIES[family];
    const clash = flags.find((f) => given.some((a) => a === f || a.startsWith(`${f}=`)));
    if (!clash) return true;
    const note = `caller passed ${clash} — the rules' ${family} is not applied`;
    if (ACCUMULATORS.has(family)) plan.warnings.push(note);
    plan.trace.push(`emit: ${note}`);
    return false;
  };

  if (c.model !== undefined && mine("model")) {
    if (!c.model.trim()) {
      fail("selection produced an empty model — set a real id or leave model undefined");
    }
    argv.push("--model", c.model);
  }
  if (c.effort && mine("effort")) {
    if (!EFFORTS.includes(c.effort)) {
      fail(`effort '${c.effort}' is not one of ${EFFORTS.join(", ")} — fix it in rules.ts`);
    }
    argv.push("--effort", c.effort);
  }
  if (c.systemPromptFile && mine("systemPrompt")) {
    argv.push("--system-prompt-file", mustExist(c.systemPromptFile, "system prompt file"));
  }

  // Skill preload: ONE startup directive at the head of the append stream.
  // Claude Code has no preload flag — the Skill tool on turn one is the path.
  const pieces: Append[] = [...c.append];
  const skills = [...new Set(c.skills.map((s) => s.trim().replace(/^\/+/, "")).filter(Boolean))];
  if (skills.length > 0) {
    const names = skills.map((s) => `/${s}`).join(", ");
    pieces.unshift({
      text: `<session-startup>\nBefore anything else, load these skills for this session: ${names}\n</session-startup>`,
    });
  }
  if (pieces.length > 0 && mine("append")) {
    if (pieces.length === 1 && "file" in pieces[0]) {
      // a lone file passes through untouched
      argv.push("--append-system-prompt-file", mustExist(pieces[0].file, "append file"));
    } else {
      const text = pieces
        .map((p) => ("text" in p ? p.text.trim() : readPiece(p.file)))
        .filter(Boolean)
        .join("\n\n");
      argv.push("--append-system-prompt-file", writeRendered("append", `${text}\n`));
    }
  }

  // --mcp-config, --tools, --allowedTools and --disallowedTools are declared
  // variadic (<configs...>). A space-separated value swallows every argument
  // that follows, including the user's prompt — so these are always emitted
  // as ONE --flag=value token.
  if (c.mcp.length > 0 && mine("mcp")) {
    for (const m of c.mcp) {
      // A path is checked; an object is serialized, which is what makes an
      // interpolated value structurally unable to escape its string.
      argv.push(`--mcp-config=${typeof m === "string" ? mustExist(m, "mcp config file") : JSON.stringify(m)}`);
    }
  }
  if (c.tools.length > 0 && mine("tools")) argv.push(`--tools=${c.tools.join(",")}`);
  if (c.allowedTools.length > 0 && mine("allowedTools")) {
    argv.push(`--allowedTools=${c.allowedTools.join(",")}`);
  }
  if (c.disallowedTools.length > 0 && mine("disallowedTools")) {
    argv.push(`--disallowedTools=${c.disallowedTools.join(",")}`);
  }

  if (c.excludeDynamicSections && mine("excludeDynamicSections")) {
    argv.push("--exclude-dynamic-system-prompt-sections");
  }
  if (c.verbose === true && mine("verbose")) argv.push("--verbose");
  argv.push(...c.extraArgs);
  return argv;
}

export function emitCodex(_plan: Plan, _world: World): string[] {
  // Seam for the native codex CLI. Nothing routes here yet — the `codex` ucc
  // profile drives the claude harness against a codex endpoint. Map model /
  // effort / prompts to codex flags here when a native codex launch lands.
  return fail("harness=codex: emit not implemented — fill in emitCodex() in launch.ts");
}

export function render(ctx: Ctx, world: World, opts: EmitOpts = {}): { argv: string[]; plan: Plan } {
  const plan = resolve(ctx, world);
  const argv = ctx.harness === "codex" ? emitCodex(plan, world) : emitClaude(plan, world, opts);
  return { argv, plan };
}

// ═══════════════════════════════════════════════════════════════════════════
// MATRIX — every finite combination, rendered.
// ═══════════════════════════════════════════════════════════════════════════

export type Axes = { profiles: string[]; roles: string[]; models: string[]; cwds: string[] };
export type Row = {
  profile: string;
  role: string;
  model: string;
  cwd: string;
  arm: string;
  candidates: string[];
  argv: string[];
  trace: string[];
  warnings: string[];
};

/** Every profile rules.ts actually mentions — the axis that changes anything. */
export function rulesProfiles(): string[] {
  const named = new Set<string>();
  for (const members of Object.values(pools)) for (const m of members) named.add(m);
  for (const r of routes) for (const p of list(r.when.profile)) named.add(p);
  for (const l of layers) for (const p of list(l.when?.profile)) named.add(p);
  return [...named].sort();
}

export function buildMatrix(axes: Axes, world: World): Row[] {
  const rows: Row[] = [];
  for (const profile of axes.profiles) {
    for (const role of axes.roles) {
      for (const model of axes.models) {
        for (const cwd of axes.cwds) {
          const ctx: Ctx = { harness: "claude" };
          if (profile) ctx.profile = profile;
          if (role) ctx.role = role;
          if (model) ctx.model = model;
          if (cwd) ctx.cwd = cwd;
          // dry: a matrix run inspects, it never writes
          const { argv, plan } = render(ctx, world, { dry: true });
          rows.push({
            profile,
            role,
            model,
            cwd,
            arm: plan.arm ?? "",
            candidates: plan.candidates,
            argv,
            trace: plan.trace,
            warnings: plan.warnings,
          });
        }
      }
    }
  }
  return rows;
}

const flagValue = (argv: string[], flag: string): string => {
  const i = argv.indexOf(flag);
  if (i >= 0) return argv[i + 1] ?? "";
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : "";
};

const short = (p: string): string => (p ? p.replace(`${ROOT}/`, "") : "");

function matrixTable(rows: Row[], axes: Axes): string {
  // Only the flags the dedicated columns already show are hidden from extras;
  // the append file is NOT one of them — dropping it would let the role brief
  // disappear without the table changing.
  const shown = new Set(["--model", "--effort", "--system-prompt-file"]);
  const multi = rows.some((r) => r.candidates.length > 1);
  const head = ["profile", "role", "model in", "cwd", "arm", "model out", "effort", "prompt", "extras"];
  if (multi) head.splice(5, 0, "candidates");
  const body = rows.map((r) => {
    const extras = r.argv.filter((a, i) => {
      if (shown.has(a)) return false;
      if (i > 0 && shown.has(r.argv[i - 1])) return false;
      return true;
    });
    const cells = [
      r.profile || "—",
      r.role || "—",
      r.model || "—",
      short(r.cwd) || "—",
      r.arm || "—",
      flagValue(r.argv, "--model") || "—",
      flagValue(r.argv, "--effort") || "—",
      short(flagValue(r.argv, "--system-prompt-file")) || "—",
      extras.map(short).map((e) => (e.length > 34 ? `${e.slice(0, 33)}…` : e)).join(" ") || "—",
    ];
    if (multi) cells.splice(5, 0, r.candidates.length > 1 ? r.candidates.join("|") : "—");
    return cells;
  });
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const axisNote =
    `${rows.length} combinations — ` +
    `${axes.profiles.length} profiles × ${axes.roles.length} roles × ` +
    `${axes.models.length} models × ${axes.cwds.length} cwds`;
  return [axisNote, "", line(head), line(widths.map((w) => "─".repeat(w))), ...body.map(line)].join("\n");
}

function writeViewer(rows: Row[], axes: Axes, out: string, generated: string): string {
  const template = resolvePath(ROOT, "matrix-viewer.html");
  if (!existsSync(template)) fail(`matrix viewer template not found: ${template}`);
  // The JSON is inlined into a <script>. A value carrying "</script>" would
  // close the block early, so every < goes in escaped — still valid JSON.
  const data = JSON.stringify({ generated, root: ROOT, axes, rows })
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  // a function replacement keeps any $-sequence in the data literal intact
  const html = readFileSync(template, "utf8").replace("/*__MATRIX__*/null", () => data);
  // an output path is the caller's, so it resolves against their cwd
  const path = isAbsolute(out) || out.startsWith("~") ? expandPath(out, process.env) : resolvePath(process.cwd(), out);
  writeFileSync(path, html);
  return path;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI ENTRY — `launch.ts [verb] '<json>' | --flag value`
// ═══════════════════════════════════════════════════════════════════════════

const VERBS = ["render", "explain", "matrix"];

type Parsed = {
  verb: string;
  ctx: Ctx;
  output: "json" | "shell";
  /** false → the caller took the default, and matrix may prefer its table */
  outputGiven: boolean;
  ownDefaults: boolean;
  axes: Partial<Axes>;
  html?: string;
  allProfiles: boolean;
};

function parseArgs(args: string[]): Parsed {
  let json: Record<string, unknown> = {};
  const flags: Record<string, string> = {};
  const bare = new Set<string>();
  let verb = "render";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) flags[name] = a.slice(eq + 1);
      else if (name === "own-defaults" || name === "all-profiles") bare.add(name);
      else flags[name] = args[++i] ?? "";
    } else if (a.trim().startsWith("{")) {
      try {
        json = JSON.parse(a) as Record<string, unknown>;
      } catch (e) {
        fail(`invalid JSON param: ${e}`);
      }
    } else if (i === 0 && VERBS.includes(a)) {
      verb = a;
    } else {
      fail(`unrecognized argument '${a}' — pass a verb (${VERBS.join(", ")}), a JSON object, or --flag value pairs`);
    }
  }

  const pick = (k: string): string | undefined =>
    flags[k] ?? (typeof json[k] === "string" && json[k] !== "" ? (json[k] as string) : undefined);

  const harness = pick("harness") ?? "claude";
  if (harness !== "claude" && harness !== "codex") fail(`unknown harness '${harness}' — claude or codex`);
  const output = pick("output") ?? "json";
  if (output !== "json" && output !== "shell") fail(`output must be json or shell, got '${output}'`);

  const ctx: Ctx = {
    harness,
    model: pick("model"),
    profile: pick("profile"),
    // `project` is the wire name both launchers already send
    cwd: pick("cwd") ?? pick("project"),
    role: pick("role"),
    argv: Array.isArray(json.argv) ? (json.argv as unknown[]).map(String) : undefined,
  };

  const csv = (k: string): string[] | undefined => {
    const v = pick(k);
    return v === undefined ? undefined : v.split(",").map((s) => s.trim());
  };
  const axes: Partial<Axes> = {};
  if (csv("profiles")) axes.profiles = csv("profiles")!;
  if (csv("roles")) axes.roles = csv("roles")!;
  if (csv("models")) axes.models = csv("models")!;
  if (csv("cwds")) axes.cwds = csv("cwds")!;
  else if (pick("cwd") && verb === "matrix") axes.cwds = [pick("cwd")!];

  return {
    verb,
    ctx,
    output,
    outputGiven: pick("output") !== undefined,
    ownDefaults: bare.has("own-defaults"),
    axes,
    html: pick("html"),
    allProfiles: bare.has("all-profiles"),
  };
}

function installedProfiles(env: Record<string, string | undefined>): string[] {
  const dir = expandPath(`${env.UCC_HOME ?? `${env.HOME}/.local/share/ucc`}/profiles`, env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

// `import.meta.main` only landed in Node 24.2, and a silently-skipped CLI
// block would degrade every wrapper launch to "unparseable render output".
// Comparing argv[1] to this file works on every runtime that can load it.
const isMain =
  (import.meta as { main?: boolean }).main ??
  (process.argv[1] !== undefined &&
    resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname));

if (isMain) {
  const p = parseArgs(process.argv.slice(2));
  const world = realWorld();
  if (p.ownDefaults) world.ownLauncherDefaults = true;

  if (p.verb === "render") {
    const { argv, plan } = render(p.ctx, world);
    if (p.output === "shell") {
      const q = (a: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
      console.log(argv.map(q).join(" "));
      for (const t of plan.trace) console.error(`trace: ${t}`);
      for (const w of plan.warnings) console.error(`warning: ${w}`);
    } else {
      console.log(
        JSON.stringify(
          { argv, model_matched: argv.includes("--model"), trace: plan.trace, warnings: plan.warnings },
          null,
          2,
        ),
      );
    }
  } else if (p.verb === "explain") {
    const { argv, plan } = render(p.ctx, world);
    const ctx = p.ctx;
    console.log(
      `launch  harness=${ctx.harness} profile=${ctx.profile ?? "—"} role=${ctx.role ?? "—"} ` +
        `model=${ctx.model ?? "—"} cwd=${ctx.cwd ?? "—"}`,
    );
    console.log(`world   launcher-defaults=${world.ownLauncherDefaults ? "ON" : "OFF (bash still owns them)"}`);
    console.log("");
    for (const t of plan.trace) console.log(`  ${t}`);
    console.log("");
    if (plan.candidates.length > 1) console.log(`  arm candidates: ${plan.candidates.join(", ")}`);
    for (const w of plan.warnings) console.log(`  ! ${w}`);
    console.log("argv");
    for (const a of argv) console.log(`  ${a}`);
  } else {
    const axes: Axes = {
      profiles: p.axes.profiles ?? ["", ...(p.allProfiles ? installedProfiles(world.env) : rulesProfiles())],
      roles: p.axes.roles ?? ["", "advisor", "leader", "worker"],
      models: p.axes.models ?? [""],
      cwds: p.axes.cwds ?? [""],
    };
    // matrix must be reproducible: always take the first candidate
    const rows = buildMatrix(axes, { ...world, pick: (c) => c[0] });
    if (p.html) {
      console.log(writeViewer(rows, axes, p.html, new Date().toISOString()));
    } else if (p.outputGiven && p.output === "json") {
      console.log(JSON.stringify({ axes, rows }, null, 2));
    } else {
      console.log(matrixTable(rows, axes));
    }
  }
}
