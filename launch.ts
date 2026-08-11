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
// Exit codes (render/explain):
//   0 — rendered; splice the argv
//   1 — the render itself broke (bad config, missing file); callers may
//       degrade to a plain launch, warning on stderr
//   2 — REFUSED: an explicitly requested model cannot be honored (a pinned
//       endpoint arm serves a different id). The launching WRAPPER must abort:
//       it is the last gate, and degrading there would land the wrong model —
//       the exact fault this exit kills (zt-queue #17: fail LOUD or obey).
//       A pre-spawn renderer (ccc-tmux) surfaces the refusal and splices no
//       model of its own; the pane wrapper re-renders and enforces.
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
  ENDPOINT_SERVES_ITS_OWN_MODEL,
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
  /** the launch resumes an existing session (-r/--resume/-c/--continue);
   *  derived from argv — the session keeps its own model and effort */
  resume?: boolean;
};

// ─── World: everything outside this process ─────────────────────────────────
export type World = {
  env: Record<string, string | undefined>;
  hasFile: (path: string) => boolean;
  hasExec: (path: string) => boolean;
  hasBin: (name: string) => boolean;
  /** which arm to take when a route offers several */
  pick: (candidates: string[]) => string;
  /** per-user pool members from pools.local.json — merged with rules.ts pools */
  localPools: Record<string, string[]>;
  /**
   * model the user saved via the TUI (/model) into $CLAUDE_CONFIG_DIR/settings.json.
   * Endpoint profiles honor this over ANTHROPIC_MODEL so a picker choice sticks
   * across restarts (CLI --model beats env).
   */
  settingsModel: () => string | undefined;
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
  /** set when an explicitly requested model cannot be honored — the launch
   *  must not proceed. render/explain exit 2; callers abort, never degrade. */
  refusal?: string;
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

/** Read settings.json `model` from a Claude config dir. Empty/missing → undefined. */
export function readSettingsModel(configDir: string | undefined): string | undefined {
  if (!configDir || !configDir.trim()) return undefined;
  const path = join(configDir, "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { model?: unknown };
    if (typeof raw.model !== "string") return undefined;
    const m = raw.model.trim();
    return m === "" ? undefined : m;
  } catch {
    return undefined;
  }
}

export function realWorld(env = process.env, localPools: Record<string, string[]> = {}): World {
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
    localPools,
    settingsModel: () => readSettingsModel(env.CLAUDE_CONFIG_DIR),
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
    localPools: {},
    settingsModel: () => undefined,
    ...over,
  };
}

/**
 * Read pools.local.json — the per-user pool membership file the installer
 * never writes. A malformed file must never break launching: every problem
 * degrades to a stderr warning and an empty table.
 *
 *   { "FABLE_SPENT": ["some_profile_3x"] }
 */
export function readLocalPools(path: string): Record<string, string[]> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`launch: ${path} is not valid JSON — ignoring local pools (${e})`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`launch: ${path} must be an object of pool-name → [profiles] — ignoring local pools`);
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [name, members] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(members) || members.some((m) => typeof m !== "string")) {
      console.error(`launch: ${path}: pool '${name}' is not an array of strings — skipped`);
      continue;
    }
    out[name] = members as string[];
  }
  return out;
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
      const declared = pools[name];
      const local = world.localPools[name];
      if (!declared && !local) fail(`rules.ts: route names unknown pool '${name}'`);
      const members = [...(declared ?? []), ...(local ?? [])];
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
 * Derive launch context from the caller's raw command line.
 *
 * The wrapper forwards its whole "$@" and this is the ONE place that reads
 * it: the last --model becomes the requested model (and is REMOVED from the
 * clash-detection argv, so the normalized spelling we emit replaces the raw
 * one via the model_matched dance), and a resume/continue flag marks the
 * launch as resuming. Everything else stays in argv untouched — emitClaude's
 * family scan is what keeps the rules out of the caller's way.
 */
export function siftArgv(raw: string[]): { model?: string; resume: boolean; argv: string[] } {
  let model: string | undefined;
  let resume = false;
  const argv: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--model") {
      if (i + 1 < raw.length) model = raw[++i];
      continue;
    }
    if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
      continue;
    }
    if (a === "-r" || a === "--resume" || a === "-c" || a === "--continue" ||
        a.startsWith("--resume=") || a.startsWith("--continue=")) {
      resume = true;
    }
    argv.push(a);
  }
  return { model, resume, argv };
}

/**
 * True when `model` is one rules.ts knows: an arm's id, or a route's model
 * pattern (exact or trailing-*). Used so an effort-looking suffix is only
 * peeled off ids we can actually route — never off a stranger.
 */
function isKnownModelBase(model: string): boolean {
  const bare = bareId(model);
  for (const a of Object.values(arms)) {
    if (bareId(a.model) === bare) return true;
  }
  for (const r of routes) {
    if (!r.when?.model) continue;
    if (matchModel(list(r.when.model), bare)) return true;
  }
  return false;
}

/**
 * claude-opus-4-8-xhigh → { model: "claude-opus-4-8", effort: "xhigh" }
 *
 * Only claude ids carry this convention, and only when the base id is one we
 * know (an arm or a route model pattern). An endpoint id is opaque —
 * splitting `gpt-5.6-sol-max` would invent a model that does not exist. An
 * unknown claude id that merely ends in `-high`/`-max`/… is left whole so we
 * do not invent an `--effort` for a stranger (the session keeps its own).
 */
export function splitEffort(model?: string): { model?: string; effort?: string } {
  if (!model) return {};
  if (!isClaude(model)) return { model };
  for (const e of EFFORTS) {
    if (!model.endsWith(`-${e}`)) continue;
    const base = model.slice(0, -(e.length + 1));
    if (!isKnownModelBase(base)) return { model };
    return { model: base, effort: e };
  }
  return { model };
}

function applyLayer(c: Config, l: Layer, ctx: Ctx, world: World, trace: string[]): void {
  const I = (s: string) => interpolate(s, ctx, world);
  const did: string[] = [];
  if (l.systemPrompt !== undefined) {
    c.systemPromptFile = I(l.systemPrompt);
    did.push(`system-prompt ${c.systemPromptFile}`);
  }
  if (l.append?.length) {
    for (const a of l.append) c.append.push("file" in a ? { file: I(a.file) } : { text: I(a.text) });
    did.push(`append ×${l.append.length}`);
  }
  if (l.mcp?.length) {
    c.mcp.push(
      ...l.mcp.map((m) =>
        typeof m === "string" ? I(m) : (interpolateDeep(m, ctx, world) as Record<string, unknown>),
      ),
    );
    did.push(`mcp ×${l.mcp.length}`);
  }
  if (l.tools?.length) {
    c.tools.push(...l.tools.map(I));
    did.push(`tools ${l.tools.join(",")}`);
  }
  if (l.allowedTools?.length) {
    c.allowedTools.push(...l.allowedTools.map(I));
    did.push(`allowedTools ${l.allowedTools.join(",")}`);
  }
  if (l.disallowedTools?.length) {
    c.disallowedTools.push(...l.disallowedTools.map(I));
    did.push(`disallowedTools ${l.disallowedTools.join(",")}`);
  }
  if (l.excludeDynamicSections !== undefined) {
    c.excludeDynamicSections = l.excludeDynamicSections;
    did.push(`exclude-dynamic-sections ${l.excludeDynamicSections}`);
  }
  if (l.effort !== undefined) {
    c.effort = l.effort;
    did.push(`effort ${l.effort}`);
  }
  if (l.verbose !== undefined) {
    c.verbose = l.verbose;
    did.push(`verbose ${l.verbose}`);
  }
  if (l.args?.length) {
    c.extraArgs.push(...l.args.map(I));
    did.push(`args ${l.args.join(" ")}`);
  }
  trace.push(`layer ${l.why ?? describe(l.when)}: ${did.join(", ") || "nothing"}`);
}

export function resolve(ctx: Ctx, world: World): Plan {
  const trace: string[] = [];
  const warnings: string[] = [];
  let refusal: string | undefined;

  const requested = splitEffort(ctx.model);
  let explicitEffort = requested.effort;
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
    // survives; the arm then supplies only the prompt and the effort.
    let armNote = "";
    if (asked !== undefined && a.pin) {
      // A pinned arm serves exactly ONE id. A request for that id — bare, or
      // carrying an effort suffix (k3-max) — is honored, the suffix becoming
      // the effort. Any OTHER id is REFUSED: silently replacing an explicit
      // request was the launcher's worst fault (zt-queue #17, fail LOUD or
      // obey), and its endpoint cannot serve the requested id anyway.
      const pin = bareId(a.model);
      let base = bareId(asked);
      for (const e of EFFORTS) {
        if (base === `${pin}-${e}`) {
          base = pin;
          explicitEffort = e;
          trace.push(`model ${asked}: effort suffix on the pinned id → effort ${e}`);
          break;
        }
      }
      if (base === pin) {
        armNote = " (pinned — matches request)";
      } else {
        refusal =
          `--model ${ctx.model} cannot be served: profile '${c.profile ?? "?"}' routes to pinned arm ` +
          `'${arm}', whose endpoint serves only ${a.model}. ` +
          `Fix: drop --model to accept ${a.model} (request effort as --model ${pin}-<low|medium|high|xhigh|max>), ` +
          `or launch from a profile that serves ${asked} — for claude ids pick a claude-account profile ` +
          `(e.g. env -u UCC_PROFILE ucc-auto, or a ucc-<claude-profile> wrapper).`;
        warnings.push(`REFUSED: ${refusal}`);
      }
      config.model = a.model;
    } else if (asked !== undefined) {
      config.model = asked;
      armNote = " (as requested)";
    } else {
      config.model = a.model;
    }
    if (a.prompt) config.systemPromptFile = a.prompt;
    if (a.effort) config.effort = a.effort;
    trace.push(`arm ${arm}: model ${config.model}${armNote}${a.prompt ? `, prompt ${a.prompt}` : ""}`);
  } else if (asked) {
    config.model = asked;
    trace.push(`no route matched — model ${asked} passes through as a real id`);
  } else {
    trace.push("no route matched, no model requested — harness keeps its own model");
  }

  // The endpoint rule: someone else's API serves its own models, so ours are
  // meaningless there. A pinned arm is the exception — it states that we know
  // this endpoint's id. See rules.ts § third-party endpoints.
  const pinned = arm !== undefined && arms[arm]?.pin === true;
  if (config.model !== undefined && !pinned && probe(ENDPOINT_SERVES_ITS_OWN_MODEL, c, world)) {
    trace.push(
      `${ENDPOINT_SERVES_ITS_OWN_MODEL}: dropping --model ${config.model} — ` +
        `this endpoint serves its own, so ANTHROPIC_MODEL applies`,
    );
    if (asked !== undefined) {
      // The caller's own --model stays on its command line (model_matched=0),
      // so the request rides through to the endpoint — the designed override
      // path. Say so: the endpoint may serve it, reject it, or ignore it.
      warnings.push(
        `explicit --model ${ctx.model} rides through to an endpoint that serves its own models ` +
          `(ANTHROPIC_BASE_URL is set) — the endpoint may serve, reject, or ignore it`,
      );
    }
    config.model = undefined;
    // The arm's effort belongs to the fleet model we just dropped. Forcing it
    // onto an endpoint model the user (or ANTHROPIC_MODEL) picked makes the
    // TUI/settings effortLevel look like it "won't save". Layers (minimax)
    // may still set effort after this. An explicit effort suffix still wins
    // later via explicitEffort.
    if (config.effort !== undefined && !explicitEffort) {
      trace.push(
        `${ENDPOINT_SERVES_ITS_OWN_MODEL}: dropping arm effort ${config.effort} — ` +
          `endpoint model is not ours; session/settings keep their own effort`,
      );
      config.effort = undefined;
    }
    // TUI /model writes settings.json `model`. Without an explicit --model,
    // emit that saved id so it beats ANTHROPIC_MODEL on the next launch
    // (otherwise env pins the default forever and the picker looks broken).
    if (asked === undefined) {
      const saved = world.settingsModel();
      if (saved) {
        config.model = withOneM(saved);
        trace.push(
          `settings.json model ${saved}: honoring saved/TUI choice over ANTHROPIC_MODEL`,
        );
      }
    }
  }

  // 3. layers — every match applies, in order
  for (const layer of layers) {
    if (!matches(layer.when, c, world)) continue;
    const unmet = (layer.requires ?? []).filter((r) => !probe(r, c, world));
    if (unmet.length > 0) {
      trace.push(`layer ${layer.why ?? describe(layer.when)}: skipped — needs ${unmet.join("; ")}`);
      continue;
    }
    applyLayer(config, layer, c, world, trace);
  }

  // The resume rule: a resumed session keeps its own model and effort —
  // emitting an arm's would silently switch a session mid-conversation. An
  // EXPLICITLY requested model still wins: asking is consent to switch, and
  // emitting it normalized beats letting a raw selection id reach the CLI.
  if (c.resume && !asked && (config.model !== undefined || config.effort !== undefined)) {
    trace.push("resume/continue: the session keeps its own model and effort — dropping ours");
    config.model = undefined;
    config.effort = undefined;
  }

  // An explicit effort suffix on the requested model beats every rule.
  if (explicitEffort) config.effort = explicitEffort;

  // A role nobody routes on is a typo: it lands on the roleless arm and the
  // agent silently never learns what it is. Say so.
  if (c.role && !knownRoles().has(c.role)) {
    warnings.push(`role '${c.role}' matches no route in rules.ts — launching with the roleless prompt`);
  }

  refusal ??= minimaxEndpointRefusal(asked, world);
  if (refusal && !warnings.some((w) => w.startsWith("REFUSED: "))) {
    warnings.push(`REFUSED: ${refusal}`);
  }

  warnings.push(...validate(config));

  return { ctx: c, arm, candidates, config, trace, warnings, refusal };
}

/** hosts served by Anthropic itself — the harness default when no base url is set */
const OFFICIAL_ANTHROPIC_HOST = /(^|\.)anthropic\.com$/i;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** true when this url is unset/blank (harness default) or an Anthropic-owned host */
function isOfficialAnthropic(url: string | undefined): boolean {
  const u = (url ?? "").trim();
  if (u === "") return true;
  const host = hostOf(u);
  return host === undefined ? false : OFFICIAL_ANTHROPIC_HOST.test(host);
}

const namesMinimax = (s: string | undefined) => /minimax/i.test(s ?? "");

/**
 * The MiniMax endpoint rule, enforced rather than documented: a MiniMax session
 * must never leave through the DEFAULT official endpoint or the account's
 * default auth. Both failure modes are silent — the official API answers a
 * MiniMax model id with an error, or worse, an OAuth-authenticated claude
 * session runs while everyone believes it is MiniMax. So we refuse the launch.
 *
 * Scope is the SESSION endpoint only. A claude session that merely carries the
 * MiniMax coding-plan MCP (MINIMAX_API_KEY set, no MiniMax model) is untouched;
 * that server has its own MINIMAX_API_HOST, checked separately below.
 *
 * The correct setup is a profile .env like $UCC_HOME/profiles/minimax-us/.env:
 *   ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic
 *   MINIMAX_API_HOST=https://api.minimax.io
 *   ANTHROPIC_AUTH_TOKEN=…  MINIMAX_API_KEY=…  (sops: svc/common minimax_api_key)
 */
export function minimaxEndpointRefusal(asked: string | undefined, world: World): string | undefined {
  const env = world.env;
  const fix =
    `Fix: launch from a MiniMax profile whose .env sets ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic, ` +
    `MINIMAX_API_HOST=https://api.minimax.io and its own ANTHROPIC_AUTH_TOKEN ` +
    `(credential: sops secrets/svc/common.sops.yaml key minimax_api_key) — e.g. ucc-minimax-us.`;

  const wants = namesMinimax(env.ANTHROPIC_MODEL) || namesMinimax(asked);
  if (wants) {
    const url = env.ANTHROPIC_BASE_URL;
    const named = namesMinimax(asked) ? `--model ${asked}` : `ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL}`;
    if (isOfficialAnthropic(url)) {
      return (
        `${named} asks for MiniMax, but ANTHROPIC_BASE_URL is ` +
        `${(url ?? "").trim() === "" ? "unset — the harness would use the DEFAULT official Anthropic endpoint" : `'${url}', an official Anthropic host`}. ` +
        `This fleet never reaches MiniMax through the official endpoint. ${fix}`
      );
    }
    const auth = (env.ANTHROPIC_AUTH_TOKEN ?? env.ANTHROPIC_API_KEY ?? "").trim();
    if (auth === "") {
      return (
        `${named} asks for MiniMax at ${url}, but neither ANTHROPIC_AUTH_TOKEN nor ANTHROPIC_API_KEY is set — ` +
        `the launch would fall back to this account's default Anthropic auth. ${fix}`
      );
    }
  }

  // The MiniMax MCP server's own host, whoever the session model is.
  const mcpHost = (env.MINIMAX_API_HOST ?? "").trim();
  if (mcpHost !== "" && isOfficialAnthropic(mcpHost)) {
    return `MINIMAX_API_HOST='${mcpHost}' points at an official Anthropic host — MiniMax is not served there. ${fix}`;
  }
  return undefined;
}

/** every role any route mentions — the set rules.ts actually knows */
function knownRoles(): Set<string> {
  const roles = new Set<string>();
  for (const r of routes) for (const role of list(r.when.role)) if (role !== "*") roles.add(role);
  for (const l of layers) for (const role of list(l.when?.role)) if (role !== "*") roles.add(role);
  return roles;
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

  // Nothing is synthesized here. A prompt is a file, written elsewhere; this
  // only concatenates the pieces a layer asked for, in order.
  const pieces: Append[] = [...c.append];
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

/** Every profile the rules actually mention — the axis that changes anything.
 *  Local pool members count: they are rules too, just per-user ones. */
export function rulesProfiles(localPools: Record<string, string[]> = {}): string[] {
  const named = new Set<string>();
  for (const members of Object.values(pools)) for (const m of members) named.add(m);
  for (const members of Object.values(localPools)) for (const m of members) named.add(m);
  for (const r of routes) for (const p of list(r.when.profile)) named.add(p);
  for (const l of layers) for (const p of list(l.when?.profile)) named.add(p);
  return [...named].sort();
}

/** A profile's own env — its .env is where ANTHROPIC_BASE_URL and
 *  ANTHROPIC_MODEL live, and those decide whether it gets a --model at all.
 *  The CLI supplies the reader; the matrix itself stays free of the disk. */
export type ProfileEnv = (profile: string) => Record<string, string | undefined>;

export function buildMatrix(axes: Axes, world: World, profileEnv?: ProfileEnv): Row[] {
  const rows: Row[] = [];
  for (const profile of axes.profiles) {
    // Render each profile against ITS environment, not the caller's shell:
    // every ANTHROPIC_* comes from the profile's own .env, never inherited,
    // or a matrix run from inside an endpoint session would report every
    // claude account as model-less.
    let w = world;
    if (profileEnv && profile) {
      const base: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(world.env)) if (!k.startsWith("ANTHROPIC_")) base[k] = v;
      w = { ...world, env: { ...base, ...profileEnv(profile) } };
    }
    for (const role of axes.roles) {
      for (const model of axes.models) {
        for (const cwd of axes.cwds) {
          const ctx: Ctx = { harness: "claude" };
          if (profile) ctx.profile = profile;
          if (role) ctx.role = role;
          if (model) ctx.model = model;
          if (cwd) ctx.cwd = cwd;
          // dry: a matrix run inspects, it never writes
          const { argv, plan } = render(ctx, w, { dry: true });
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

function matrixTable(rows: Row[], axes: Axes, note = ""): string {
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
  const header = note ? [axisNote, note] : [axisNote];
  return [...header, "", line(head), line(widths.map((w) => "─".repeat(w))), ...body.map(line)].join("\n");
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
  /** pools.local.json override: a path, or "none" to disable */
  pools?: string;
  /** matrix only: render against a fixed world (no env, no disk probes) so
   *  the output is identical on every machine — what the golden file pins */
  pinned: boolean;
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
      else if (name === "all-profiles" || name === "pinned") bare.add(name);
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
  // The wrapper forwards its raw "$@": derive the requested model and the
  // resume flag from it. An explicit `model` param (ccc-tmux) still wins.
  if (ctx.argv) {
    const sifted = siftArgv(ctx.argv);
    ctx.model ??= sifted.model;
    ctx.resume = sifted.resume;
    ctx.argv = sifted.argv;
  }

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
    pools: pick("pools"),
    pinned: bare.has("pinned"),
    axes,
    html: pick("html"),
    allProfiles: bare.has("all-profiles"),
  };
}

const uccHome = (env: Record<string, string | undefined>): string =>
  env.UCC_HOME ?? `${env.HOME}/.local/share/ucc`;

/** Read a profile's .env — plain KEY=VALUE lines, the installer's own format. */
function readProfileEnv(
  profile: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const file = resolvePath(uccHome(env), "profiles", profile, ".env");
  if (!existsSync(file)) return {};
  const out: Record<string, string | undefined> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const eq = text.indexOf("=");
    if (eq < 0) continue;
    out[text.slice(0, eq).trim()] = text.slice(eq + 1).trim();
  }
  return out;
}

function installedProfiles(env: Record<string, string | undefined>): string[] {
  const dir = expandPath(`${uccHome(env)}/profiles`, env);
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
  // pools.local.json sits next to the rules — per-user, installer-untouched.
  // `--pools none` renders the shipped rules alone (what the golden matrix
  // pins); `--pools <path>` points at a fixture.
  const poolsPath =
    p.pools === "none"
      ? undefined
      : p.pools !== undefined
        ? expandPath(p.pools, process.env)
        : resolvePath(ROOT, "pools.local.json");
  const world = realWorld(process.env, poolsPath ? readLocalPools(poolsPath) : {});

  if (p.verb === "render") {
    const { argv, plan } = render(p.ctx, world);
    if (plan.refusal) {
      console.error(`launch: REFUSED — ${plan.refusal}`);
      process.exit(2);
    }
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
    const localPoolNote = Object.entries(world.localPools)
      .map(([k, v]) => `${k}+[${v.join(", ")}]`)
      .join(" ");
    console.log(`world   local-pools=${localPoolNote || "none"}`);
    console.log("");
    for (const t of plan.trace) console.log(`  ${t}`);
    console.log("");
    if (plan.candidates.length > 1) console.log(`  arm candidates: ${plan.candidates.join(", ")}`);
    for (const w of plan.warnings) console.log(`  ! ${w}`);
    console.log("argv");
    for (const a of argv) console.log(`  ${a}`);
    if (plan.refusal) process.exit(2);
  } else {
    const axes: Axes = {
      profiles: p.axes.profiles ?? ["", ...(p.allProfiles ? installedProfiles(world.env) : rulesProfiles(world.localPools))],
      roles: p.axes.roles ?? ["", "advisor", "leader", "worker"],
      models: p.axes.models ?? [""],
      cwds: p.axes.cwds ?? [""],
    };
    // matrix must be reproducible: always take the first candidate. --pinned
    // goes further and swaps in a fixed world, so the table is identical on
    // every machine — mcp layers and profile .env files no longer leak in.
    const mWorld = p.pinned
      ? fixedWorld({ pick: (c) => c[0], localPools: world.localPools })
      : { ...world, pick: (c) => c[0] };
    const rows = buildMatrix(axes, mWorld, p.pinned ? undefined : (prof) => readProfileEnv(prof, world.env));
    if (p.html) {
      console.log(writeViewer(rows, axes, p.html, new Date().toISOString()));
    } else if (p.outputGiven && p.output === "json") {
      console.log(JSON.stringify({ axes, rows }, null, 2));
    } else {
      // a named profile renders against its own .env; the no-profile rows
      // can only reflect the shell you are standing in, so say when that
      // shell is itself an endpoint session
      const shellEndpoint = mWorld.env.ANTHROPIC_BASE_URL;
      console.log(
        matrixTable(
          rows,
          axes,
          shellEndpoint
            ? `this shell sets ANTHROPIC_BASE_URL=${shellEndpoint} — the profile-less rows drop --model for that reason; named profiles use their own .env`
            : "",
        ),
      );
    }
  }
}
