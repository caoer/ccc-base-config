#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════
// launch.ts — THE launch config. One self-contained file.
//
// A harness launcher (ccc-tmux spawn-agent, a ucc script, you in a shell)
// invokes this with the launch context; it prints the harness CLI params to
// splice into the launch. No folder conventions, no merge rules — select()
// below IS the config: read it top-to-bottom, edit it, run it.
//
//   bun launch.ts --role leader                 # see exactly what a leader gets
//   bun launch.ts --model claude-opus-4-8-xhigh --output shell
//   bun launch.ts '{"harness":"claude","role":"worker","project":"/path"}'
//
// JSON output: { argv, model_matched, trace, warnings }
//   argv          — CLI params for the harness binary
//   model_matched — argv carries a real --model; the caller drops its own
//   trace         — which selection rules fired, in order (the debugging story)
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";

// ─── Context: what the launcher tells us ────────────────────────────────────
export type Ctx = {
  harness: "claude" | "codex";
  model?: string; //   requested model — a real id, or an arm name select() knows
  profile?: string; // ucc profile (launcher basename `ucc-<p>`, or UCC_PROFILE)
  project?: string; // project path (the spawn cwd) — match with .includes()
  role?: string; //    fleet role: advisor | leader | worker
};

// ─── Config: what a launch gets ─────────────────────────────────────────────
export type Config = {
  model?: string; //            real model id → --model
  effort?: string; //           → --effort
  verbose?: boolean; //         → --verbose
  systemPromptFile?: string; // REPLACES the harness base prompt (repo-relative or ~)
  skills: string[]; //          preloaded at session start via one startup directive
  append: Append[]; //          system-prompt append stream, in order
  extraArgs: string[]; //       escape hatch — emitted verbatim at the end
};
export type Append = { file: string } | { text: string };

// ═══════════════════════════════════════════════════════════════════════════
// SELECTION — edit this. Top-to-bottom; later lines override earlier ones.
// Every branch calls note() so running the file shows exactly what fired.
// ═══════════════════════════════════════════════════════════════════════════

export function select(ctx: Ctx, note: (why: string) => void): Config {
  const c: Config = {
    // base: every launch — Fable 5 at xhigh, the harness's own base prompt
    //    model: "claude-fable-5",
    effort: "xhigh",
    verbose: false,
    skills: [],
    append: [],
    extraArgs: [],
  };
  note(`base: ${c.model} ${c.effort}`);

  // prompt arms: a model choice carries its system prompt
  const fable = () => {
    c.model = "claude-fable-5";
    c.systemPromptFile = "prompts/SYSTEM_PROMPT.fable.md";
  };
  const opus = (model = "claude-opus-4-8") => {
    c.model = model;
    c.systemPromptFile = "prompts/SYSTEM_PROMPT.opus.md";
  };

  // role: fleet agents preload ccc-base and carry their role brief
  if (ctx.role) {
    c.skills.push("ccc-base");
    c.append.push({ file: `roles/${ctx.role}.md` });
    note(`role=${ctx.role}: +skill ccc-base, +roles/${ctx.role}.md`);
  }

  // profile fleets: two named rosters that split the standard fleet. FABLE_FLEET
  // runs the full fable arm for the thinking roles (advisor, leader) and opus-1m
  // for its workers; OPUS_1M_FLEET runs opus-1m for every role. A profile in
  // neither roster — or an empty FABLE_FLEET — falls through to opus-1m too.
  const OPUS_1M = "claude-opus-4-8[1m]";
  const FABLE_FLEET = new Set([
    "dewiest_gulp",
    "crusted_standby_0n",
    "grid-mullein1b",
  ]);
  const OPUS_1M_FLEET = new Set([
    "vows_yogic_9k",
    "blusher-83savvy",
    "monk0foreleg",
    "dewiest_gulp",
    "crusted_standby_0n",
    "colder_therapy0i",
  ]);

  // ─── Role pools: THE first model rule. Each role draws its model from a pool.
  // advisor/leader think on fable; workers run opus-1m. Comment out the role-pool
  // BRANCH in the selection chain below to disable this and fall through to the
  // per-profile rules (FABLE_FLEET / OPUS_1M_FLEET / does_bannock_6u). Pools hold
  // model ids; pick() chooses one, applyModel() routes it through its prompt arm.
  const THINKING_POOL = ["claude-fable-5"]; // advisor, leader
  const WORKER_POOL = [OPUS_1M]; //           worker
  const rolePool = (role?: string): string[] | undefined =>
    role === "advisor" || role === "leader"
      ? THINKING_POOL
      : role === "worker"
        ? WORKER_POOL
        : undefined;
  const pick = (pool: string[]) =>
    pool[Math.floor(Math.random() * pool.length)];
  const applyModel = (model: string) => {
    if (model === "claude-fable-5") fable();
    else if (model.startsWith("claude-opus-4-8")) opus(model);
    else c.model = model;
  };

  // model: explicit id wins; then role pools; then the per-profile fallback
  // rules (reached only when the role-pool branch below is commented out).
  if (ctx.model === "claude-fable-5") {
    fable();
    note("model=claude-fable-5: fable arm");
  } else if (ctx.model?.startsWith("claude-opus-4-8")) {
    opus();
    if (ctx.model.endsWith("-xhigh")) c.effort = "xhigh";
    note(`model=${ctx.model}: opus arm, effort ${c.effort}`);
  } else if (ctx.model) {
    c.model = ctx.model;
    note(`model=${ctx.model}: passthrough as real id`);
  } else if (rolePool(ctx.role)) {
    // role pool — the first roster rule. comment out this branch to fall
    // through to the per-profile rules below.
    applyModel(pick(rolePool(ctx.role)!));
    note(`role=${ctx.role}, no model: ${c.model} (role pool)`);
  } else if (ctx.profile === "does_bannock_6u") {
    // fable quota spent on this account — every role runs opus-1m
    opus(OPUS_1M);
    note(`profile=does_bannock_6u, no model: ${c.model} (fable quota spent)`);
  } else if (
    (ctx.role === "advisor" || ctx.role === "leader") &&
    ctx.profile &&
    FABLE_FLEET.has(ctx.profile)
  ) {
    // FABLE_FLEET thinking roles run the full fable arm
    fable();
    note(
      `profile=${ctx.profile} role=${ctx.role}, no model: fable arm (FABLE_FLEET)`,
    );
  } else if (ctx.role) {
    // every other fleet launch — FABLE_FLEET workers, all of OPUS_1M_FLEET, and
    // any unlisted profile — runs opus-1m
    opus(OPUS_1M);
    const fleet =
      ctx.profile && OPUS_1M_FLEET.has(ctx.profile)
        ? "OPUS_1M_FLEET"
        : "default";
    note(
      `profile=${ctx.profile ?? "?"} role=${ctx.role}, no model: ${c.model} (${fleet})`,
    );
  }

  // codex profile: its endpoint speaks gpt ids;
  if (ctx.profile === "codex") {
    c.model = "gpt-5.6-sol[1m]";
    c.effort = "xhigh";
    c.systemPromptFile = "prompts/SYSTEM_PROMPT.fable.md";
    note(`profile=codex: ${c.model} ${c.effort}`);
  }

  // kimi profile: its moonshot endpoint speaks k3 ids — every role
  if (ctx.profile === "kimi-k3-moonshot") {
    c.model = "k3[1m]";
    c.effort = "xhigh";
    c.systemPromptFile = "prompts/SYSTEM_PROMPT.fable.md";
    note(`profile=kimi-k3-moonshot: ${c.model} ${c.effort}`);
  }

  if (ctx.profile === "grok") {
    c.model = "grok-4.5[1m]";
    c.effort = "xhigh";
    c.systemPromptFile = "prompts/SYSTEM_PROMPT.fable.md";
    note(`profile=grok: ${c.model} ${c.effort}`);
  }

  return c;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER — Config → harness argv. Machinery; rarely touched.
// ═══════════════════════════════════════════════════════════════════════════

// node ≥23.6 runs this file as-is (native type stripping); keep it free of
// Bun-only APIs so the ucc shared node and bun are both valid runtimes.
const ROOT = import.meta.dirname;
const HOME = process.env.HOME ?? "";

const fail = (msg: string): never => {
  console.error(`launch: ${msg}`);
  process.exit(1);
};

const expandPath = (p: string): string => {
  if (p === "~") p = HOME;
  else if (p.startsWith("~/")) p = HOME + p.slice(1);
  return isAbsolute(p) ? p : resolve(ROOT, p);
};

// Referenced files that don't exist fail loud — a typo'd path must not
// silently shrink the prompt.
const mustExist = (p: string, what: string): string => {
  const abs = expandPath(p);
  if (!existsSync(abs)) fail(`${what} not found: ${abs}`);
  return abs;
};

// .rendered/ holds content-hashed compositions — gitignored, safe to delete.
const writeRendered = (prefix: string, content: string): string => {
  const dir = resolve(ROOT, ".rendered");
  mkdirSync(dir, { recursive: true });
  const h = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const path = resolve(dir, `${prefix}-${h}.md`);
  writeFileSync(path, content);
  return path;
};

export function renderClaude(c: Config): string[] {
  const argv: string[] = [];

  if (c.model !== undefined) {
    if (!c.model.trim())
      fail(
        "selection produced an empty model — set a real id or leave model undefined",
      );
    argv.push("--model", c.model);
  }
  if (c.effort) argv.push("--effort", c.effort);
  if (c.systemPromptFile)
    argv.push(
      "--system-prompt-file",
      mustExist(c.systemPromptFile, "system prompt file"),
    );

  // Skill preload: ONE startup directive at the head of the append stream.
  // Claude Code has no preload flag — the Skill tool on turn one is the load path.
  const pieces: Append[] = [...c.append];
  const skills = [
    ...new Set(
      c.skills.map((s) => s.trim().replace(/^\/+/, "")).filter(Boolean),
    ),
  ];
  if (skills.length > 0) {
    const list = skills.map((s) => `/${s}`).join(", ");
    pieces.unshift({
      text: `<session-startup>\nBefore anything else, load these skills for this session: ${list}\n</session-startup>`,
    });
  }

  if (pieces.length === 1 && "file" in pieces[0]) {
    // a lone file passes through untouched
    argv.push(
      "--append-system-prompt-file",
      mustExist(pieces[0].file, "append file"),
    );
  } else if (pieces.length > 0) {
    const text = pieces
      .map((p) =>
        "text" in p
          ? p.text.trim()
          : readFileSync(mustExist(p.file, "append file"), "utf8").trim(),
      )
      .filter(Boolean)
      .join("\n\n");
    argv.push(
      "--append-system-prompt-file",
      writeRendered("append", text + "\n"),
    );
  }

  if (c.verbose === true) argv.push("--verbose");
  argv.push(...c.extraArgs);
  return argv;
}

export function renderCodex(_c: Config): string[] {
  // Seam for the native codex CLI. Nothing routes here yet — the `codex` ucc
  // profile drives the claude harness against a codex endpoint. Map model /
  // effort / prompts to codex flags here when a native codex launch lands.
  return fail(
    "harness=codex: render not implemented — fill in renderCodex() in launch.ts",
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI ENTRY — `bun launch.ts '<json>'` or `--flag value` pairs.
// ═══════════════════════════════════════════════════════════════════════════

function parseCtx(args: string[]): { ctx: Ctx; output: "json" | "shell" } {
  let json: Record<string, unknown> = {};
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) flags[a.slice(2)] = args[++i] ?? "";
    else if (a.trim().startsWith("{")) {
      try {
        json = JSON.parse(a) as Record<string, unknown>;
      } catch (e) {
        fail(`invalid JSON param: ${e}`);
      }
    } else
      fail(
        `unrecognized argument '${a}' — pass a JSON object or --flag value pairs`,
      );
  }
  const pick = (k: string): string | undefined =>
    flags[k] ??
    (typeof json[k] === "string" && json[k] !== ""
      ? (json[k] as string)
      : undefined);

  const harness = pick("harness") ?? "claude";
  if (harness !== "claude" && harness !== "codex")
    fail(`unknown harness '${harness}' — claude or codex`);
  const output = pick("output") ?? "json";
  if (output !== "json" && output !== "shell")
    fail(`output must be json or shell, got '${output}'`);
  return {
    ctx: {
      harness,
      model: pick("model"),
      profile: pick("profile"),
      project: pick("project"),
      role: pick("role"),
    },
    output,
  };
}

if (import.meta.main) {
  const { ctx, output } = parseCtx(process.argv.slice(2));
  const trace: string[] = [];
  const config = select(ctx, (why) => trace.push(why));
  const argv =
    ctx.harness === "codex" ? renderCodex(config) : renderClaude(config);
  const result = {
    argv,
    model_matched: argv.includes("--model"),
    trace,
    warnings: [] as string[],
  };

  if (output === "shell") {
    const q = (a: string) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
    console.log(argv.map(q).join(" "));
    for (const t of trace) console.error(`trace: ${t}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}
