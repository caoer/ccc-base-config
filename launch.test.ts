// Tests for launch.ts — the engine — and rules.ts — the config.
//
// Three levels:
//   1. Process contract — spawn `bun launch.ts` against THIS repo (what the
//      ucc wrapper and ccc-tmux actually run), locking the deployed argv per
//      role/model/profile and every fail-loud branch.
//   2. Engine — resolve() against a made-up world, for the matching, probe,
//      interpolation and precedence rules the deployed config doesn't reach.
//   3. Matrix — the whole finite combination space, locked to a golden file.
//
// Run: bun test launch.test.ts   (from this repo root)

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolve,
  emitClaude,
  validate,
  probe,
  fixedWorld,
  splitEffort,
  interpolate,
  matches,
  buildMatrix,
  type Ctx,
  type Plan,
  type World,
} from "./launch.ts";

const LAUNCH = join(import.meta.dir, "launch.ts");

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: { argv: string[]; model_matched: boolean; trace: string[]; warnings: string[] } | null;
  /** contents of any prompt file the argv points at */
  promptFiles: Record<string, string>;
}

function run(args: string[]): RunResult {
  const proc = Bun.spawnSync(["bun", LAUNCH, ...args], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const stderr = proc.stderr.toString();
  let json: RunResult["json"] = null;
  if (proc.exitCode === 0 && stdout.trim().startsWith("{")) {
    try {
      json = JSON.parse(stdout);
    } catch {
      /* leave null; a test asserting json fails loudly */
    }
  }
  const promptFiles: Record<string, string> = {};
  for (let i = 0; json && i < json.argv.length - 1; i++) {
    if (json.argv[i] === "--append-system-prompt-file" || json.argv[i] === "--system-prompt-file") {
      promptFiles[json.argv[i]] = readFileSync(json.argv[i + 1], "utf8");
    }
  }
  return { exitCode: proc.exitCode, stdout, stderr, json, promptFiles };
}

const modelOf = (r: RunResult): string | undefined => {
  const i = r.json!.argv.indexOf("--model");
  return i >= 0 ? r.json!.argv[i + 1] : undefined;
};

// ═══════════════════════════════════════════════════════════════════════════
describe("deployed selection (process contract, real repo)", () => {
  test("bare launch: effort only — the harness keeps its own model", () => {
    const r = run([]);
    expect(r.exitCode).toBe(0);
    expect(r.json!.argv).toEqual(["--effort", "xhigh"]);
    expect(r.json!.model_matched).toBe(false);
    expect(r.json!.trace.join(" ")).toContain("layer base");
  });

  test("leader: fable arm + role brief + ccc-base preload", () => {
    const r = run(["--role", "leader"]);
    expect(r.exitCode).toBe(0);
    expect(modelOf(r)).toBe("claude-fable-5");
    expect(r.promptFiles["--system-prompt-file"]).toContain("software engineering agent");
    const append = r.promptFiles["--append-system-prompt-file"];
    expect(append).toContain("<session-startup>");
    expect(append).toContain("/ccc-base");
    expect(append).toContain("You are a **leader**");
    expect(append.indexOf("<session-startup>")).toBeLessThan(append.indexOf("You are a **leader**"));
  });

  test("advisor: fable arm + advisor brief", () => {
    const r = run(["--role", "advisor"]);
    expect(modelOf(r)).toBe("claude-fable-5");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.fable.md");
    expect(r.promptFiles["--append-system-prompt-file"]).toContain("You are an **advisor**");
  });

  test("worker: opus-1m arm + worker brief", () => {
    const r = run(["--role", "worker"]);
    expect(modelOf(r)).toBe("claude-opus-4-8[1m]");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.opus.md");
    expect(r.promptFiles["--append-system-prompt-file"]).toContain("You are a **worker**");
  });

  test("opus-xhigh: effort suffix splits off the model id", () => {
    const r = run(["--model", "claude-opus-4-8-xhigh"]);
    expect(modelOf(r)).toBe("claude-opus-4-8");
    expect(r.json!.argv).toContain("xhigh");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.opus.md");
  });

  test("explicit opus-1m keeps its 1m variant", () => {
    const r = run(["--model", "claude-opus-4-8[1m]"]);
    expect(modelOf(r)).toBe("claude-opus-4-8[1m]");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.opus.md");
  });

  test("unknown model passes through as a real id (never silently swallowed)", () => {
    const r = run(["--model", "sonnet"]);
    expect(modelOf(r)).toBe("sonnet");
    expect(r.json!.trace.join(" ")).toContain("passes through");
  });

  test("explicit model beats the role's pool", () => {
    const r = run(["--role", "leader", "--model", "claude-opus-4-8"]);
    expect(modelOf(r)).toBe("claude-opus-4-8");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.opus.md");
  });

  test("endpoint profile beats an explicit claude model — its API would reject it", () => {
    const r = run(["--profile", "codex", "--model", "claude-fable-5"]);
    expect(modelOf(r)).toBe("gpt-5.6-sol[1m]");
  });

  test("grok and kimi profiles route to their own ids", () => {
    expect(modelOf(run(["--profile", "grok"]))).toBe("grok-4.5[1m]");
    expect(modelOf(run(["--profile", "kimi-k3-moonshot"]))).toBe("k3[1m]");
  });

  test("does_bannock_6u with no role runs opus-1m (fable quota spent)", () => {
    expect(modelOf(run(["--profile", "does_bannock_6u"]))).toBe("claude-opus-4-8[1m]");
  });

  test("JSON param form ≡ flag form", () => {
    const a = run(['{"role":"leader"}']);
    const b = run(["--role", "leader"]);
    expect(a.json!.argv).toEqual(b.json!.argv);
  });

  test("flags override the JSON param", () => {
    const r = run(['{"model":"claude-opus-4-8"}', "--model", "sonnet"]);
    expect(modelOf(r)).toBe("sonnet");
  });

  test("`project` is accepted as the wire name for cwd", () => {
    const r = run(['{"project":"/tmp/x"}']);
    expect(r.exitCode).toBe(0);
  });

  test("shell output: one splice-ready line, trace on stderr", () => {
    const r = run(["--role", "worker", "--output", "shell"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("--model 'claude-opus-4-8[1m]'");
    expect(r.stderr).toContain("trace: ");
  });

  test("rendered append path is content-hashed — stable across runs", () => {
    expect(run(["--role", "worker"]).json!.argv).toEqual(run(["--role", "worker"]).json!.argv);
  });

  test("explain prints the decision, not JSON", () => {
    const proc = Bun.spawnSync(["bun", LAUNCH, "explain", "--role", "worker"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    expect(proc.exitCode).toBe(0);
    expect(out).toContain("route [");
    expect(out).toContain("arm opus-1m");
    expect(out).toContain("argv");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("fail-loud branches", () => {
  test("unknown role → missing roles/<role>.md fails loud", () => {
    const r = run(["--role", "ghost"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not found");
    expect(r.stderr).toContain("roles/ghost.md");
  });

  test("harness=codex is a fail-loud stub", () => {
    const r = run(["--harness", "codex"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("emit not implemented");
  });

  test("unknown harness rejected", () => {
    expect(run(["--harness", "gemini"]).stderr).toContain("unknown harness");
  });

  test("bad output value rejected", () => {
    expect(run(["--output", "yaml"]).stderr).toContain("output must be json or shell");
  });

  test("stray positional rejected", () => {
    const r = run(["leader"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unrecognized argument");
  });

  test("invalid JSON param rejected", () => {
    expect(run(["{not json"]).stderr).toContain("invalid JSON");
  });

  test("empty model from selection fails loud (never emits --model '')", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-test-"));
    const script = join(dir, "empty-model.ts");
    writeFileSync(
      script,
      `import { emitClaude, fixedWorld } from ${JSON.stringify(LAUNCH)};\n` +
        `emitClaude({ ctx: { harness: "claude" }, candidates: [], trace: [], warnings: [],\n` +
        `  config: { model: " ", append: [], skills: [], mcp: [], tools: [], allowedTools: [], disallowedTools: [], extraArgs: [] } }, fixedWorld());\n`,
    );
    const proc = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    rmSync(dir, { recursive: true, force: true });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("empty model");
  });

  test("inline mcp JSON that does not parse fails loud", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-mcp-"));
    const script = join(dir, "bad-mcp.ts");
    writeFileSync(
      script,
      `import { emitClaude, fixedWorld } from ${JSON.stringify(LAUNCH)};\n` +
        `emitClaude({ ctx: { harness: "claude" }, candidates: [], trace: [], warnings: [],\n` +
        `  config: { mcp: ['{"broken":'], append: [], skills: [], tools: [], allowedTools: [], disallowedTools: [], extraArgs: [] } }, fixedWorld());\n`,
    );
    const proc = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    rmSync(dir, { recursive: true, force: true });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("not valid JSON");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("engine: matching", () => {
  const w = fixedWorld();
  const ctx = (over: Partial<Ctx> = {}): Ctx => ({ harness: "claude", ...over });

  test("a missing `when` matches everything", () => {
    expect(matches(undefined, ctx(), w)).toBe(true);
    expect(matches({}, ctx(), w)).toBe(true);
  });

  test("fields AND together, list values OR", () => {
    const when = { profile: ["a", "b"], role: "worker" };
    expect(matches(when, ctx({ profile: "b", role: "worker" }), w)).toBe(true);
    expect(matches(when, ctx({ profile: "b", role: "leader" }), w)).toBe(false);
    expect(matches(when, ctx({ profile: "c", role: "worker" }), w)).toBe(false);
  });

  test('"*" means the field is present at all', () => {
    expect(matches({ role: "*" }, ctx({ role: "worker" }), w)).toBe(true);
    expect(matches({ role: "*" }, ctx(), w)).toBe(false);
  });

  test("noModel only matches a launch that named no model", () => {
    expect(matches({ noModel: true }, ctx(), w)).toBe(true);
    expect(matches({ noModel: true }, ctx({ model: "x" }), w)).toBe(false);
  });

  test("pool membership", () => {
    expect(matches({ pool: "FABLE_FLEET" }, ctx({ profile: "dewiest_gulp" }), w)).toBe(true);
    expect(matches({ pool: "FABLE_FLEET" }, ctx({ profile: "vows_yogic_9k" }), w)).toBe(false);
    expect(matches({ pool: "FABLE_FLEET" }, ctx(), w)).toBe(false);
  });

  test("model patterns: exact and trailing-* prefix", () => {
    expect(matches({ model: "claude-opus-4-8" }, ctx({ model: "claude-opus-4-8" }), w)).toBe(true);
    expect(matches({ model: "claude-opus-4-8" }, ctx({ model: "claude-opus-4-8[1m]" }), w)).toBe(false);
    expect(matches({ model: "claude-*" }, ctx({ model: "claude-opus-4-8[1m]" }), w)).toBe(true);
    expect(matches({ model: "claude-*" }, ctx({ model: "gpt-5.6" }), w)).toBe(false);
  });

  test("cwd: an absolute pattern matches that dir and everything below it", () => {
    const when = { cwd: "/Users/Shared/projects/caoer" };
    expect(matches(when, ctx({ cwd: "/Users/Shared/projects/caoer" }), w)).toBe(true);
    expect(matches(when, ctx({ cwd: "/Users/Shared/projects/caoer/ccc-statusd" }), w)).toBe(true);
    expect(matches(when, ctx({ cwd: "/Users/Shared/projects/caoer-other" }), w)).toBe(false);
    expect(matches(when, ctx(), w)).toBe(false);
  });

  test("cwd: a bare word is a substring match on the path", () => {
    expect(matches({ cwd: "ccc-statusd" }, ctx({ cwd: "/x/ccc-statusd/y" }), w)).toBe(true);
    expect(matches({ cwd: "ccc-statusd" }, ctx({ cwd: "/x/other" }), w)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("engine: interpolation and effort suffix", () => {
  const w = fixedWorld({ env: { HOME: "/home/zt", FOO: "foo-value", EMPTY: "" } });
  const ctx: Ctx = { harness: "claude", role: "worker", profile: "p1" };

  test("ctx fields and env vars", () => {
    expect(interpolate("roles/${role}.md", ctx, w)).toBe("roles/worker.md");
    expect(interpolate("${profile}/${FOO}", ctx, w)).toBe("p1/foo-value");
  });

  test("${A|B} takes the first non-empty", () => {
    expect(interpolate("${EMPTY|FOO}", ctx, w)).toBe("foo-value");
    expect(interpolate("${MISSING|FOO}", ctx, w)).toBe("foo-value");
  });

  test("${A:-literal} falls back to the literal", () => {
    expect(interpolate("${MISSING:-https://x.example}", ctx, w)).toBe("https://x.example");
    expect(interpolate("${FOO:-fallback}", ctx, w)).toBe("foo-value");
  });

  test("an unresolvable reference becomes empty, never the literal ${...}", () => {
    expect(interpolate("a${MISSING}b", ctx, w)).toBe("ab");
  });

  test("effort suffixes split off; a bare id is untouched", () => {
    expect(splitEffort("claude-opus-4-8-xhigh")).toEqual({ model: "claude-opus-4-8", effort: "xhigh" });
    expect(splitEffort("claude-opus-4-8-low")).toEqual({ model: "claude-opus-4-8", effort: "low" });
    expect(splitEffort("claude-opus-4-8")).toEqual({ model: "claude-opus-4-8" });
    expect(splitEffort(undefined)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("engine: probes", () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-probe-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const real = join(dir, "present.md");
  writeFileSync(real, "x");
  const runner = join(dir, "runme");
  writeFileSync(runner, "#!/bin/sh\n");
  chmodSync(runner, 0o755);

  // The real world: env is whatever the case supplies, disk is the tmp files
  // created above, and uvx is the only binary on PATH.
  const world = (env: Record<string, string | undefined> = {}): World =>
    fixedWorld({
      env,
      hasFile: (p) => p === real || p === runner,
      hasExec: (p) => p === runner,
      hasBin: (n) => n === "uvx",
    });

  const ctx: Ctx = { harness: "claude" };
  const ok = (expr: string, env?: Record<string, string | undefined>) => probe(expr, ctx, world(env));

  test("env: set and non-empty", () => {
    expect(ok("env:A", { A: "1" })).toBe(true);
    expect(ok("env:A", { A: "" })).toBe(false);
    expect(ok("env:A")).toBe(false);
  });

  test("env:NAME~text is a substring test", () => {
    expect(ok("env:URL~minimax.io", { URL: "https://api.minimax.io/x" })).toBe(true);
    expect(ok("env:URL~minimax.io", { URL: "https://api.anthropic.com" })).toBe(false);
  });

  test("file: exists, exec: exists and is executable, bin: is on PATH", () => {
    expect(ok(`file:${real}`)).toBe(true);
    expect(ok(`file:${real}-missing`)).toBe(false);
    expect(ok(`exec:${runner}`)).toBe(true);
    expect(ok(`exec:${real}`)).toBe(false);
    expect(ok("bin:uvx")).toBe(true);
    expect(ok("bin:nope")).toBe(false);
  });

  test("an empty path never counts as present", () => {
    expect(ok("file:${UNSET_VAR}")).toBe(false);
  });

  test("' | ' is OR inside one probe, and ! negates", () => {
    expect(ok("env:A | env:B", { B: "1" })).toBe(true);
    expect(ok("env:A | env:B", {})).toBe(false);
    expect(ok("!env:A", {})).toBe(true);
    expect(ok("!env:A", { A: "1" })).toBe(false);
  });

  test("separate requires entries AND — one unmet skips the layer", () => {
    const w = fixedWorld({ ownLauncherDefaults: true, hasBin: (n) => n === "uvx", env: {} });
    const plan = resolve({ harness: "claude" }, w);
    expect(plan.config.mcp).toEqual([]);
    expect(plan.trace.join("\n")).toContain("skipped — needs");
  });

  test("probes interpolate before they resolve", () => {
    expect(probe("file:${HOME}/present.md", ctx, fixedWorld({
      env: { HOME: dir },
      hasFile: (p) => p === real,
    }))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("engine: precedence and emit", () => {
  const w = fixedWorld();

  test("defaults, then arm, then layers — an arm's prompt survives a fallback", () => {
    const plan = resolve({ harness: "claude", role: "worker" }, w);
    expect(plan.arm).toBe("opus-1m");
    expect(plan.config.systemPromptFile).toBe("prompts/SYSTEM_PROMPT.opus.md");
    expect(plan.config.effort).toBe("xhigh");
    expect(plan.config.skills).toEqual(["ccc-base"]);
  });

  test("an explicit effort suffix beats every rule", () => {
    const plan = resolve({ harness: "claude", role: "worker", model: "claude-opus-4-8-low" }, w);
    expect(plan.config.effort).toBe("low");
  });

  test("the first matching route wins and stops the search", () => {
    const plan = resolve({ harness: "claude", profile: "codex", role: "worker" }, w);
    expect(plan.arm).toBe("gpt-5.6-sol");
  });

  test("no route and no model leaves the harness its own model", () => {
    const plan = resolve({ harness: "claude" }, w);
    expect(plan.arm).toBeUndefined();
    expect(plan.config.model).toBeUndefined();
  });

  test("variadic flags are emitted as ONE --flag=value token", () => {
    const argv = emitClaude(planWith({ mcp: ["{}"], disallowedTools: ["WebSearch"], tools: ["Bash", "Read"] }), w);
    expect(argv).toContain("--mcp-config={}");
    expect(argv).toContain("--disallowedTools=WebSearch");
    expect(argv).toContain("--tools=Bash,Read");
    // never a bare flag whose value would swallow the user's prompt
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--tools");
  });

  test("a flag the caller already passed is left alone", () => {
    const plan = planWith({ model: "m", mcp: ["{}"] }, { argv: ["--mcp-config=/mine.json"] });
    const argv = emitClaude(plan, w);
    expect(argv).toContain("--model");
    expect(argv.join(" ")).not.toContain("--mcp-config={}");
    expect(plan.trace.join(" ")).toContain("caller passed --mcp-config");
  });

  test("--system-prompt from the caller suppresses ours, in either spelling", () => {
    const plan = planWith({ systemPromptFile: "prompts/SYSTEM_PROMPT.opus.md" }, { argv: ["--system-prompt", "hi"] });
    expect(emitClaude(plan, w)).not.toContain("--system-prompt-file");
  });

  test("exclude-dynamic-sections is dropped with a warning when a prompt replaces the base", () => {
    const conflict = planWith({
      systemPromptFile: "prompts/SYSTEM_PROMPT.opus.md",
      excludeDynamicSections: true,
    }).config;
    const warnings = validate(conflict);
    expect(warnings.join(" ")).toContain("does nothing");
    expect(conflict.excludeDynamicSections).toBe(false);
    expect(emitClaude(planWith(conflict), w)).not.toContain("--exclude-dynamic-system-prompt-sections");
  });

  test("exclude-dynamic-sections survives when nothing replaces the base prompt", () => {
    const solo = planWith({ excludeDynamicSections: true }).config;
    expect(validate(solo)).toEqual([]);
    expect(emitClaude(planWith(solo), w)).toContain("--exclude-dynamic-system-prompt-sections");
  });

  test("a real launch carries no warnings", () => {
    expect(resolve({ harness: "claude", role: "worker" }, w).warnings).toEqual([]);
  });

  test("skills dedupe, normalize leading slashes, and produce one directive", () => {
    const argv = emitClaude(planWith({ skills: ["/ccc-work", "ccc-base", "ccc-work"] }), w);
    const content = readFileSync(argv[argv.indexOf("--append-system-prompt-file") + 1], "utf8");
    expect(content).toContain("/ccc-work, /ccc-base");
    expect(content).not.toContain("//ccc-work");
    expect(content.match(/<session-startup>/g)).toHaveLength(1);
  });

  test("a lone append file passes through untouched (no .rendered copy)", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-append-"));
    const f = join(dir, "solo.md");
    writeFileSync(f, "SOLO");
    const argv = emitClaude(planWith({ append: [{ file: f }] }), w);
    expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe(f);
    rmSync(dir, { recursive: true, force: true });
  });

  test("mixed pieces compose in order, blank pieces dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-compose-"));
    const f = join(dir, "brief.md");
    writeFileSync(f, "BRIEF-BODY\n");
    const argv = emitClaude(planWith({ append: [{ text: "FIRST" }, { text: "  " }, { file: f }] }), w);
    const content = readFileSync(argv[argv.indexOf("--append-system-prompt-file") + 1], "utf8");
    expect(content.indexOf("FIRST")).toBeLessThan(content.indexOf("BRIEF-BODY"));
    expect(content).not.toContain("  \n\n");
    rmSync(dir, { recursive: true, force: true });
  });

  test("verbose true emits --verbose; false or absent does not", () => {
    expect(emitClaude(planWith({ verbose: true }), w)).toContain("--verbose");
    expect(emitClaude(planWith({ verbose: false }), w)).not.toContain("--verbose");
    expect(emitClaude(planWith({}), w)).not.toContain("--verbose");
  });

  test("extraArgs are emitted verbatim, last", () => {
    const argv = emitClaude(planWith({ model: "m", extraArgs: ["--foo", "bar baz"] }), w);
    expect(argv.slice(-2)).toEqual(["--foo", "bar baz"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("the launcher-defaults cutover", () => {
  test("OFF by default — bash still owns the shared prompt and mcp configs", () => {
    const plan = resolve({ harness: "claude", role: "worker" }, fixedWorld());
    expect(plan.config.mcp).toEqual([]);
    expect(plan.config.systemPromptFile).toBe("prompts/SYSTEM_PROMPT.opus.md");
  });

  test("ON: mcp configs accumulate, but a fallback never overrides an arm", () => {
    const w = fixedWorld({
      ownLauncherDefaults: true,
      env: { HOME: "/home/zt", SUPERZ_BOT_TOKEN: "t" },
      hasFile: () => true,
      hasExec: () => true,
    });
    const worker = resolve({ harness: "claude", role: "worker" }, w);
    expect(worker.config.systemPromptFile).toBe("prompts/SYSTEM_PROMPT.opus.md");
    expect(worker.config.mcp.length).toBe(2);

    const bare = resolve({ harness: "claude" }, w);
    expect(bare.config.systemPromptFile).toBe("~/.local/share/ucc/shared/SYSTEM_PROMPT.md");
  });

  test("ON: minimax adds its mcp and disallows WebSearch only when its gates hold", () => {
    const base = {
      ownLauncherDefaults: true,
      hasFile: () => false,
      hasExec: () => false,
      hasBin: (n: string) => n === "uvx",
    };
    const armed = resolve(
      { harness: "claude" },
      fixedWorld({ ...base, env: { MINIMAX_API_KEY: "k", MINIMAX_API_HOST: "https://h.example" } }),
    );
    expect(armed.config.disallowedTools).toEqual(["WebSearch"]);
    expect(armed.config.mcp[0]).toContain('"MINIMAX_API_KEY":"k"');
    expect(armed.config.mcp[0]).toContain('"MINIMAX_API_HOST":"https://h.example"');

    const noUvx = resolve({ harness: "claude" }, fixedWorld({ ...base, hasBin: () => false, env: { MINIMAX_API_KEY: "k" } }));
    expect(noUvx.config.mcp).toEqual([]);

    const noKey = resolve({ harness: "claude" }, fixedWorld({ ...base, env: {} }));
    expect(noKey.config.mcp).toEqual([]);
  });

  test("ON: a minimax base url without an explicit key uses the auth token", () => {
    const plan = resolve(
      { harness: "claude" },
      fixedWorld({
        ownLauncherDefaults: true,
        hasBin: (n) => n === "uvx",
        env: { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" },
      }),
    );
    expect(plan.config.mcp[0]).toContain('"MINIMAX_API_KEY":"tok"');
    expect(plan.config.mcp[0]).toContain("https://api.minimax.io");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("matrix", () => {
  test("every combination renders, and none is silently model-less by accident", () => {
    const rows = buildMatrix(
      { profiles: ["", "codex", "dewiest_gulp"], roles: ["", "worker"], models: [""], cwds: [""] },
      { ...fixedWorld(), pick: (c) => c[0] },
    );
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(Array.isArray(r.argv)).toBe(true);
    expect(rows.find((r) => r.profile === "codex" && r.role === "worker")!.arm).toBe("gpt-5.6-sol");
  });

  test("the golden matrix is current — regenerate with `bun launch.ts matrix > matrix.golden.txt`", () => {
    const proc = Bun.spawnSync(["bun", LAUNCH, "matrix"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const golden = readFileSync(join(import.meta.dir, "matrix.golden.txt"), "utf8");
    expect(proc.stdout.toString()).toBe(golden);
  });

  test("matrix --html writes a self-contained page with the data inlined", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-html-"));
    const out = join(dir, "m.html");
    const proc = Bun.spawnSync(["bun", LAUNCH, "matrix", "--html", out], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    const html = readFileSync(out, "utf8");
    expect(html).not.toContain("__MATRIX__");
    expect(html).toContain("const DATA = {");
    const data = JSON.parse(html.match(/const DATA = (\{.*?\});\n/s)![1]);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows[0]).toHaveProperty("trace");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function planWith(over: Partial<Plan["config"]>, ctxOver: Partial<Ctx> = {}): Plan {
  return {
    ctx: { harness: "claude", ...ctxOver },
    candidates: [],
    trace: [],
    warnings: [],
    config: {
      append: [],
      skills: [],
      mcp: [],
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      extraArgs: [],
      ...over,
    },
  };
}
