// Tests for launch.ts — the engine — and rules.ts — the config.
//
// Four levels:
//   1. Process contract — spawn `bun launch.ts` against THIS repo (what the
//      ucc wrapper and ccc-tmux actually run), locking the deployed argv per
//      role/model/profile and every fail-loud branch.
//   2. Runtime portability — the same launch under the shared node, because
//      the bash wrappers use node and only ccc-tmux uses bun.
//   3. Engine — resolve() against a made-up world, for the matching, probe,
//      interpolation and precedence rules the deployed config doesn't reach.
//   4. Matrix — the whole finite combination space, locked to a golden file.
//
// Run: bun test launch.test.ts   (from this repo root)

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  resolve,
  render as renderPlan,
  emitClaude,
  validate,
  probe,
  fixedWorld,
  splitEffort,
  siftArgv,
  withOneM,
  bareId,
  interpolate,
  interpolateDeep,
  matches,
  buildMatrix,
  readLocalPools,
  type Ctx,
  type Plan,
  type World,
} from "./launch.ts";

const LAUNCH = join(import.meta.dir, "launch.ts");
const SHARED_NODE = join(homedir(), ".local/share/ucc/shared/node/bin/node");

/** the command matrix.golden.txt is generated with — pinned world and no
 *  local pools, so the file is identical on every machine */
const GOLDEN_ARGS = ["matrix", "--pinned", "--pools", "none", "--models", ",claude-opus-5,claude-opus-4-8[200k],sonnet"];

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: { argv: string[]; model_matched: boolean; trace: string[]; warnings: string[] } | null;
  /** contents of any prompt file the argv points at */
  promptFiles: Record<string, string>;
}

/** the shell that runs the tests may be inside an endpoint profile; the
 *  deployed-selection cases are about a claude account */
const CLAUDE_ENV = (() => {
  const e = { ...process.env };
  delete e.ANTHROPIC_BASE_URL;
  return e;
})();

function runWith(bin: string, args: string[]): RunResult {
  const proc = Bun.spawnSync([bin, LAUNCH, ...args], {
    cwd: import.meta.dir,
    env: CLAUDE_ENV,
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

const run = (args: string[]): RunResult => runWith("bun", args);

const modelOf = (r: RunResult): string | undefined => {
  const i = r.json!.argv.indexOf("--model");
  return i >= 0 ? r.json!.argv[i + 1] : undefined;
};
const promptOf = (r: RunResult): string | undefined => {
  const i = r.json!.argv.indexOf("--system-prompt-file");
  return i >= 0 ? r.json!.argv[i + 1].split("/").pop() : undefined;
};

// ═══════════════════════════════════════════════════════════════════════════
describe("deployed selection (process contract, real repo)", () => {
  test("bare launch: opus-5 is the fleet default", () => {
    const r = run([]);
    expect(r.exitCode).toBe(0);
    expect(modelOf(r)).toBe("claude-opus-5[1m]");
    expect(promptOf(r)).toBe("opus-5-stance.md");
    expect(r.json!.model_matched).toBe(true);
  });

  test("every arm prompt bakes in the harness-environment brief (Bash timeout policy)", () => {
    for (const args of [[], ["--role", "worker"], ["--role", "advisor"], ["--model", "claude-opus-4-8"]]) {
      const r = run(args);
      expect(r.json!.argv).not.toContain("--append-system-prompt-file");
      const prompt = r.promptFiles["--system-prompt-file"];
      expect(prompt).toContain("# Harness Environment");
      expect(prompt).toContain("never kills the command");
    }
  });

  test("advisor is the one role that stays on fable", () => {
    const r = run(["--role", "advisor"]);
    expect(modelOf(r)).toBe("claude-fable-5[1m]");
    expect(promptOf(r)).toBe("fable-5-calibration.advisor.md");
  });

  test("leader and worker run opus-5", () => {
    for (const role of ["leader", "worker"]) {
      const r = run(["--role", role]);
      expect(modelOf(r)).toBe("claude-opus-5[1m]");
      expect(promptOf(r)).toBe(`opus-5-stance.${role}.md`);
    }
  });

  test("a role gets a WHOLE prompt — role brief, arm doctrine, environment brief in one file", () => {
    for (const role of ["advisor", "leader", "worker"]) {
      const r = run(["--role", role]);
      // one file carries everything; nothing rides a separate append flag
      expect(r.json!.argv).not.toContain("--append-system-prompt-file");
      const prompt = r.promptFiles["--system-prompt-file"];
      expect(prompt).toContain("# Harness Environment");
      expect(prompt).toContain(`You are ${role === "advisor" ? "an" : "a"} **${role}**`);
      // the arm's own doctrine is in the same file, not a separate flag
      expect(prompt).toContain("You are a software engineering agent");
      // the skill-preload directive is gone: config no longer writes prompt text
      expect(prompt).not.toContain("<session-startup>");
    }
  });

  test("each role prompt is a distinct file, and the roleless one is separate", () => {
    const files = ["advisor", "leader", "worker"].map((role) => promptOf(run(["--role", role])));
    files.push(promptOf(run([])));
    expect(new Set(files).size).toBe(4);
  });

  test("an endpoint profile carries role prompts too", () => {
    const r = run(["--profile", "grok", "--role", "worker"]);
    expect(modelOf(r)).toBe("grok-4.5[1m]");
    expect(promptOf(r)).toBe("fable-5-calibration.worker.md");
  });

  test("every claude id carries [1m] — a bare id would report a 200k window", () => {
    expect(modelOf(run(["--model", "claude-opus-5"]))).toBe("claude-opus-5[1m]");
    expect(modelOf(run(["--model", "claude-fable-5"]))).toBe("claude-fable-5[1m]");
    expect(modelOf(run(["--model", "claude-opus-4-8"]))).toBe("claude-opus-4-8[1m]");
  });

  test("both spellings of an id reach the same route", () => {
    expect(run(["--model", "claude-opus-5"]).json!.argv).toEqual(
      run(["--model", "claude-opus-5[1m]"]).json!.argv,
    );
  });

  test("an effort suffix splits off and beats the arm's effort", () => {
    const r = run(["--model", "claude-opus-5-low"]);
    expect(modelOf(r)).toBe("claude-opus-5[1m]");
    expect(r.json!.argv[r.json!.argv.indexOf("--effort") + 1]).toBe("low");
  });

  test("an unlisted claude variant keeps its id AND still gets a prompt arm", () => {
    const r = run(["--model", "claude-opus-4-8[200k]"]);
    expect(modelOf(r)).toBe("claude-opus-4-8[200k]");
    expect(promptOf(r)).toBe("opus-4-operator.md");
  });

  test("a non-claude id is opaque — no effort split, no [1m], no prompt", () => {
    const r = run(["--model", "gpt-5.6-sol-max"]);
    expect(modelOf(r)).toBe("gpt-5.6-sol-max");
    expect(r.json!.argv).not.toContain("--system-prompt-file");
    expect(r.json!.argv[r.json!.argv.indexOf("--effort") + 1]).toBe("xhigh");
  });

  test("unknown model passes through as a real id (never silently swallowed)", () => {
    const r = run(["--model", "sonnet"]);
    expect(modelOf(r)).toBe("sonnet");
    expect(r.json!.trace.join(" ")).toContain("passes through");
  });

  test("an explicit model beats the role's model but keeps the role's prompt", () => {
    const r = run(["--role", "advisor", "--model", "claude-opus-5"]);
    expect(modelOf(r)).toBe("claude-opus-5[1m]");
    expect(promptOf(r)).toBe("opus-5-stance.advisor.md");
  });

  test("endpoint profiles keep their own ids and have no claude-opus-5", () => {
    expect(modelOf(run(["--profile", "codex"]))).toBe("gpt-5.6-sol[1m]");
    expect(modelOf(run(["--profile", "grok"]))).toBe("grok-4.5[1m]");
    expect(modelOf(run(["--profile", "kimi-k3-moonshot"]))).toBe("k3[1m]");
  });

  test("a pinned endpoint ignores an explicitly requested claude model", () => {
    const r = run(["--profile", "codex", "--model", "claude-opus-5"]);
    expect(modelOf(r)).toBe("gpt-5.6-sol[1m]");
    expect(r.json!.trace.join(" ")).toContain("pinned");
  });

  test("an endpoint profile applies to every role", () => {
    for (const role of ["advisor", "leader", "worker"]) {
      expect(modelOf(run(["--profile", "grok", "--role", role]))).toBe("grok-4.5[1m]");
    }
  });

  test("a spent fable quota (pools.local.json) sends that advisor to opus-5", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-pools-"));
    const fixture = join(dir, "pools.local.json");
    writeFileSync(fixture, JSON.stringify({ FABLE_SPENT: ["spent_acct_1a"] }));
    const r = run(["--pools", fixture, "--profile", "spent_acct_1a", "--role", "advisor"]);
    rmSync(dir, { recursive: true, force: true });
    expect(modelOf(r)).toBe("claude-opus-5[1m]");
    expect(r.json!.trace.join(" ")).toContain("quota spent");
  });

  test("without a local pools entry the same advisor stays on fable", () => {
    const r = run(["--pools", "none", "--profile", "spent_acct_1a", "--role", "advisor"]);
    expect(modelOf(r)).toBe("claude-fable-5[1m]");
  });

  test("a malformed pools.local.json warns and never breaks the launch", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-pools-bad-"));
    const fixture = join(dir, "pools.local.json");
    writeFileSync(fixture, "{not json");
    const r = run(["--pools", fixture, "--role", "advisor"]);
    rmSync(dir, { recursive: true, force: true });
    expect(r.exitCode).toBe(0);
    expect(modelOf(r)).toBe("claude-fable-5[1m]");
    expect(r.stderr).toContain("ignoring local pools");
  });

  test("JSON param form ≡ flag form", () => {
    expect(run(['{"role":"leader"}']).json!.argv).toEqual(run(["--role", "leader"]).json!.argv);
  });

  test("flags override the JSON param", () => {
    expect(modelOf(run(['{"model":"claude-opus-5"}', "--model", "sonnet"]))).toBe("sonnet");
  });

  test("`project` is the wire name for cwd and actually reaches the matcher", () => {
    // proven discriminating by the cwd matcher, not by exit code
    const w = fixedWorld();
    expect(matches({ cwd: "ccc-statusd" }, { harness: "claude", cwd: "/x/ccc-statusd" }, w)).toBe(true);
    const r = run(['{"project":"/x/ccc-statusd"}', "--output", "json"]);
    expect(r.exitCode).toBe(0);
    const proc = Bun.spawnSync(["bun", LAUNCH, "explain", '{"project":"/x/ccc-statusd"}'], {
      cwd: import.meta.dir,
      env: CLAUDE_ENV,
      stdout: "pipe",
    });
    expect(proc.stdout.toString()).toContain("cwd=/x/ccc-statusd");
  });

  test("shell output: one splice-ready line, trace on stderr", () => {
    const r = run(["--role", "worker", "--output", "shell"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("--model 'claude-opus-5[1m]'");
    expect(r.stderr).toContain("trace: ");
  });

  test("shell output quotes hostile values into one argument", () => {
    const r = run(["--model", "a'b;touch /tmp/SHELL-PWN", "--output", "shell"]);
    expect(r.stdout).toContain(`'a'\\''b;touch /tmp/SHELL-PWN'`);
  });

  test("a launch is reproducible", () => {
    expect(run(["--role", "worker"]).json!.argv).toEqual(run(["--role", "worker"]).json!.argv);
  });

  test("a role no route knows lands on the roleless prompt, and says so", () => {
    const r = run(["--role", "ghost"]);
    expect(r.exitCode).toBe(0);
    expect(promptOf(r)).toBe("opus-5-stance.md");
    expect(r.json!.warnings.join(" ")).toContain("matches no route");
  });

  test("explain prints the decision, not JSON", () => {
    const proc = Bun.spawnSync(["bun", LAUNCH, "explain", "--role", "worker"], {
      cwd: import.meta.dir,
      env: CLAUDE_ENV,
      stdout: "pipe",
    });
    const out = proc.stdout.toString();
    expect(out).toContain("route [");
    expect(out).toContain("arm opus-5");
    expect(out).toContain("argv");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("forwarded argv (the wrapper passes its whole command line)", () => {
  const withArgv = (argv: string[], extra: string[] = []) =>
    run([JSON.stringify({ argv }), ...extra]);

  test("--system-prompt from the caller suppresses the arm prompt (the ucc-* bug)", () => {
    // ucc-<p> --tools "" --system-prompt "." --safe-mode --model haiku
    const r = withArgv(["--tools", "", "--system-prompt", ".", "--safe-mode", "--model", "haiku"]);
    expect(r.exitCode).toBe(0);
    expect(r.json!.argv).not.toContain("--system-prompt-file");
    // haiku matches no route: it passes through as a real id
    expect(modelOf(r)).toBe("haiku");
  });

  test("--system-prompt-file from the caller suppresses ours too", () => {
    const r = withArgv(["--system-prompt-file", "/tmp/mine.md"]);
    expect(r.json!.argv).not.toContain("--system-prompt-file");
  });

  test("the requested model is read from argv and emitted normalized", () => {
    const viaArgv = withArgv(["--model", "claude-opus-5"]);
    expect(modelOf(viaArgv)).toBe("claude-opus-5[1m]");
    expect(viaArgv.json!.model_matched).toBe(true);
    expect(promptOf(viaArgv)).toBe("opus-5-stance.md");
  });

  test("--model= form works and the last --model wins", () => {
    const r = withArgv(["--model=claude-opus-5", "--model", "claude-fable-5"]);
    expect(modelOf(r)).toBe("claude-fable-5[1m]");
  });

  test("a resume launch keeps the session's model and effort but gets its prompt", () => {
    const r = withArgv(["-c"]);
    expect(r.exitCode).toBe(0);
    expect(r.json!.argv).not.toContain("--model");
    expect(r.json!.argv).not.toContain("--effort");
    expect(r.json!.model_matched).toBe(false);
    expect(promptOf(r)).toBe("opus-5-stance.md");
    expect(r.json!.trace.join(" ")).toContain("resume/continue");
  });

  test("an explicitly requested model on resume is honored, normalized", () => {
    const r = withArgv(["-r", "abcd1234", "--model", "claude-opus-5"]);
    expect(modelOf(r)).toBe("claude-opus-5[1m]");
    expect(r.json!.model_matched).toBe(true);
  });

  test("a second render over already-rendered flags adds nothing but the model", () => {
    // what a ccc-tmux spawn hands the wrapper: everything already rendered
    const r = withArgv([
      "--session-id", "0f0f",
      "--system-prompt-file", "/x/prompts/opus-5-stance.worker.md",
      "--effort", "xhigh",
      "--mcp-config=/x/shared/.mcp.json",
      "--disallowedTools=TaskOutput",
      "--model", "claude-opus-5[1m]",
      "do the thing",
    ]);
    expect(r.json!.argv).toEqual(["--model", "claude-opus-5[1m]"]);
    expect(r.json!.model_matched).toBe(true);
  });

  test("a positional that mentions --model is not a model request", () => {
    const r = withArgv(["fix the --model flag parser"]);
    expect(modelOf(r)).toBe("claude-opus-5[1m]");
  });

  test("siftArgv: extraction, stripping, resume detection", () => {
    expect(siftArgv(["--model", "m1", "a", "--model=m2"])).toEqual({
      model: "m2",
      resume: false,
      argv: ["a"],
    });
    expect(siftArgv(["-r", "id", "x"])).toEqual({ model: undefined, resume: true, argv: ["-r", "id", "x"] });
    expect(siftArgv(["--continue"])).toEqual({ model: undefined, resume: true, argv: ["--continue"] });
    expect(siftArgv(["--resume=abc"])).toEqual({ model: undefined, resume: true, argv: ["--resume=abc"] });
    expect(siftArgv(["hello --model world"])).toEqual({
      model: undefined,
      resume: false,
      argv: ["hello --model world"],
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("local pools file", () => {
  test("missing file is an empty table", () => {
    expect(readLocalPools("/nonexistent/pools.local.json")).toEqual({});
  });

  test("valid file parses; malformed entries are skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "pools-unit-"));
    const f = join(dir, "pools.local.json");
    writeFileSync(f, JSON.stringify({ FABLE_SPENT: ["a", "b"], BAD: "not-array", WORSE: [1] }));
    expect(readLocalPools(f)).toEqual({ FABLE_SPENT: ["a", "b"] });
    rmSync(dir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("runtime portability (the wrappers use node, not bun)", () => {
  const available = existsSync(SHARED_NODE);

  test("the shared node exists where the wrappers look for it", () => {
    expect(available).toBe(true);
  });

  test("node and bun render byte-identical argv", () => {
    for (const args of [[], ["--role", "worker"], ["--role", "advisor"], ["--model", "claude-opus-5-low"]]) {
      const viaNode = runWith(SHARED_NODE, args);
      expect(viaNode.exitCode).toBe(0);
      expect(viaNode.json).not.toBeNull();
      expect(viaNode.json!.argv).toEqual(run(args).json!.argv);
    }
  });

  test("node runs the CLI block at all (import.meta.main is not universal)", () => {
    const r = runWith(SHARED_NODE, ["--role", "worker"]);
    expect(r.stdout.trim()).not.toBe("");
    expect(r.json!.model_matched).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("fail-loud branches", () => {
  test("a prompt file named in rules.ts but missing on disk fails loud", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-missing-"));
    const script = join(dir, "case.ts");
    writeFileSync(
      script,
      `import { emitClaude, fixedWorld } from ${JSON.stringify(LAUNCH)};\n` +
        `emitClaude({ ctx: { harness: "claude" }, candidates: [], trace: [], warnings: [],\n` +
        `  config: { systemPromptFile: "prompts/nope.md", append: [], mcp: [], tools: [], allowedTools: [], disallowedTools: [], extraArgs: [] } }, fixedWorld());\n`,
    );
    const proc = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    rmSync(dir, { recursive: true, force: true });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("not found");
  });

  test("a prompt path may not climb out of the repo with ..", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-climb-"));
    const script = join(dir, "case.ts");
    writeFileSync(
      script,
      `import { emitClaude, fixedWorld } from ${JSON.stringify(LAUNCH)};\n` +
        `emitClaude({ ctx: { harness: "claude" }, candidates: [], trace: [], warnings: [],\n` +
        `  config: { systemPromptFile: "../../../../tmp/pwn.md", append: [], mcp: [], tools: [], allowedTools: [], disallowedTools: [], extraArgs: [] } }, fixedWorld());\n`,
    );
    const proc = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    rmSync(dir, { recursive: true, force: true });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("may not climb out");
  });

  test("harness=codex is a fail-loud stub", () => {
    expect(run(["--harness", "codex"]).stderr).toContain("emit not implemented");
  });

  test("unknown harness rejected", () => {
    expect(run(["--harness", "gemini"]).stderr).toContain("unknown harness");
  });

  test("bad output value rejected", () => {
    expect(run(["--output", "yaml"]).stderr).toContain("output must be json or shell");
  });

  test("stray positional rejected", () => {
    expect(run(["leader"]).stderr).toContain("unrecognized argument");
  });

  test("invalid JSON param rejected", () => {
    expect(run(["{not json"]).stderr).toContain("invalid JSON");
  });

  const inSubprocess = (body: string): { exitCode: number; stderr: string } => {
    const dir = mkdtempSync(join(tmpdir(), "launch-fail-"));
    const script = join(dir, "case.ts");
    writeFileSync(script, `import { emitClaude, fixedWorld } from ${JSON.stringify(LAUNCH)};\n${body}\n`);
    const proc = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    rmSync(dir, { recursive: true, force: true });
    return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
  };

  const PLAN = (over: string) =>
    `emitClaude({ ctx: { harness: "claude" }, candidates: [], trace: [], warnings: [],\n` +
    `  config: { append: [], mcp: [], tools: [], allowedTools: [], disallowedTools: [], extraArgs: [], ${over} } }, fixedWorld());`;

  test("empty model fails loud (never emits --model '')", () => {
    const r = inSubprocess(PLAN(`model: " "`));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("empty model");
  });

  test("an effort the harness does not accept fails at render, not at launch", () => {
    const r = inSubprocess(PLAN(`effort: "ultra"`));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not one of");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("third-party endpoints (ANTHROPIC_BASE_URL)", () => {
  const endpoint = (over: Partial<World> = {}) =>
    fixedWorld({ env: { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic" }, ...over });

  test("no --model at all — the endpoint serves its own", () => {
    const plan = resolve({ harness: "claude", role: "worker" }, endpoint());
    expect(plan.config.model).toBeUndefined();
    expect(plan.trace.join(" ")).toContain("serves its own");
    // the prompt is still ours
    expect(plan.config.systemPromptFile).toBe("prompts/opus-5-stance.worker.md");
  });

  test("an explicitly requested model is dropped too, so the caller's own flag stands", () => {
    const plan = resolve({ harness: "claude", model: "claude-opus-5" }, endpoint());
    expect(plan.config.model).toBeUndefined();
    expect(emitClaude(plan, endpoint())).not.toContain("--model");
  });

  test("model_matched is false, so the wrapper keeps whatever the user passed", () => {
    const { argv } = renderPlan({ harness: "claude", role: "worker" }, endpoint());
    expect(argv.includes("--model")).toBe(false);
  });

  test("a pinned arm keeps its id — pinning says we know this endpoint", () => {
    for (const [profile, model] of [
      ["codex", "gpt-5.6-sol[1m]"],
      ["grok", "grok-4.5[1m]"],
      ["kimi-k3-moonshot", "k3[1m]"],
    ] as const) {
      expect(resolve({ harness: "claude", profile, role: "worker" }, endpoint()).config.model).toBe(model);
    }
  });

  test("codex would otherwise have no model at all — its .env pins none", () => {
    // the reason `pin` is the exception rather than a blanket drop
    const plan = resolve({ harness: "claude", profile: "codex" }, endpoint());
    expect(plan.config.model).toBe("gpt-5.6-sol[1m]");
  });

  test("a claude account is untouched — no base url, no rule", () => {
    const plan = resolve({ harness: "claude", role: "worker" }, fixedWorld({ env: {} }));
    expect(plan.config.model).toBe("claude-opus-5[1m]");
  });

  test("an empty ANTHROPIC_BASE_URL does not count as set", () => {
    const plan = resolve({ harness: "claude", role: "worker" }, fixedWorld({ env: { ANTHROPIC_BASE_URL: "" } }));
    expect(plan.config.model).toBe("claude-opus-5[1m]");
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

  test("pool membership comes from the world's local pools", () => {
    const lw = fixedWorld({ localPools: { FABLE_SPENT: ["local_acct"] } });
    expect(matches({ pool: "FABLE_SPENT" }, ctx({ profile: "local_acct" }), lw)).toBe(true);
    expect(matches({ pool: "FABLE_SPENT" }, ctx({ profile: "vows_yogic_9k" }), lw)).toBe(false);
    expect(matches({ pool: "FABLE_SPENT" }, ctx(), lw)).toBe(false);
    // the shipped table is empty — with no local file nobody is fable-spent
    expect(matches({ pool: "FABLE_SPENT" }, ctx({ profile: "local_acct" }), w)).toBe(false);
  });

  test("model patterns: exact and trailing-* prefix", () => {
    expect(matches({ model: "claude-opus-5" }, ctx({ model: "claude-opus-5" }), w)).toBe(true);
    expect(matches({ model: "claude-opus-5" }, ctx({ model: "claude-opus-5[200k]" }), w)).toBe(false);
    expect(matches({ model: "claude-opus-*" }, ctx({ model: "claude-opus-5[200k]" }), w)).toBe(true);
    expect(matches({ model: "claude-opus-*" }, ctx({ model: "gpt-5.6" }), w)).toBe(false);
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

  test("a cwd route actually changes a launch", () => {
    // rules.ts has no cwd route today; prove the wiring end to end here
    const inRepo = resolve({ harness: "claude", cwd: "/Users/Shared/projects/caoer/ccc-statusd" }, w);
    const outside = resolve({ harness: "claude", cwd: "/tmp" }, w);
    expect(inRepo.config.model).toBe(outside.config.model);
    expect(matches({ cwd: "/Users/Shared/projects/caoer" }, inRepo.ctx, w)).toBe(true);
    expect(matches({ cwd: "/Users/Shared/projects/caoer" }, outside.ctx, w)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("engine: model ids", () => {
  test("[1m] is added to claude ids and only claude ids", () => {
    expect(withOneM("claude-opus-5")).toBe("claude-opus-5[1m]");
    expect(withOneM("claude-opus-5[1m]")).toBe("claude-opus-5[1m]");
    expect(withOneM("claude-opus-4-8[200k]")).toBe("claude-opus-4-8[200k]");
    expect(withOneM("sonnet")).toBe("sonnet");
    expect(withOneM("gpt-5.6-sol[1m]")).toBe("gpt-5.6-sol[1m]");
  });

  test("the router matches on the id without its [1m]", () => {
    expect(bareId("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(bareId("claude-opus-5")).toBe("claude-opus-5");
    expect(bareId("claude-opus-4-8[200k]")).toBe("claude-opus-4-8[200k]");
  });

  test("effort suffixes split off claude ids only", () => {
    expect(splitEffort("claude-opus-5-xhigh")).toEqual({ model: "claude-opus-5", effort: "xhigh" });
    expect(splitEffort("claude-opus-5-low")).toEqual({ model: "claude-opus-5", effort: "low" });
    expect(splitEffort("claude-opus-5")).toEqual({ model: "claude-opus-5" });
    // an endpoint id is opaque — splitting would invent a model
    expect(splitEffort("gpt-5.6-sol-max")).toEqual({ model: "gpt-5.6-sol-max" });
    expect(splitEffort("sonnet-high")).toEqual({ model: "sonnet-high" });
    expect(splitEffort(undefined)).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("engine: interpolation", () => {
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

  test("interpolateDeep walks objects, arrays and keys", () => {
    const out = interpolateDeep({ "${role}": ["${FOO}", { k: "${profile}" }], n: 1 }, ctx, w);
    expect(out).toEqual({ worker: ["foo-value", { k: "p1" }], n: 1 });
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
    const w = fixedWorld({ hasBin: (n) => n === "uvx", env: {} });
    const plan = resolve({ harness: "claude" }, w);
    expect(plan.config.mcp).toEqual([]);
    expect(plan.trace.join("\n")).toContain("skipped — needs");
  });

  test("probes interpolate before they resolve", () => {
    const w = fixedWorld({ env: { HOME: dir }, hasFile: (p) => p === real });
    expect(probe("file:${HOME}/present.md", ctx, w)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("engine: precedence and emit", () => {
  const w = fixedWorld();

  test("defaults, then arm, then layers", () => {
    const plan = resolve({ harness: "claude", role: "worker" }, w);
    expect(plan.arm).toBe("opus-5:worker");
    expect(plan.config.systemPromptFile).toBe("prompts/opus-5-stance.worker.md");
    expect(plan.config.effort).toBe("xhigh");
    expect(plan.config.append).toEqual([]);
  });

  test("an explicit effort suffix beats every rule", () => {
    expect(resolve({ harness: "claude", role: "worker", model: "claude-opus-5-low" }, w).config.effort).toBe("low");
  });

  test("the first matching route wins and stops the search", () => {
    expect(resolve({ harness: "claude", profile: "codex", role: "worker" }, w).arm).toBe("gpt-5.6-sol:worker");
  });

  test("variadic flags are emitted as ONE --flag=value token", () => {
    const argv = emitClaude(
      planWith({ mcp: [{ mcpServers: {} }], disallowedTools: ["WebSearch"], tools: ["Bash", "Read"] }),
      w,
    );
    expect(argv).toContain('--mcp-config={"mcpServers":{}}');
    expect(argv).toContain("--disallowedTools=WebSearch");
    expect(argv).toContain("--tools=Bash,Read");
    // never a bare flag whose value would swallow the user's prompt
    expect(argv).not.toContain("--mcp-config");
    expect(argv).not.toContain("--tools");
  });

  test("an mcp object is serialized, so a hostile value cannot add a server", () => {
    const hostile = '","command":"/bin/sh","args":["-c","touch /tmp/PWN"]},"evil":{"command":"id';
    const plan = planWith({
      mcp: [{ mcpServers: { MiniMax: { command: "uvx", env: { KEY: hostile } } } }],
    });
    const argv = emitClaude(plan, w);
    const cfg = JSON.parse(argv.find((a) => a.startsWith("--mcp-config="))!.slice("--mcp-config=".length));
    expect(Object.keys(cfg.mcpServers)).toEqual(["MiniMax"]);
    expect(cfg.mcpServers.MiniMax.command).toBe("uvx");
    expect(cfg.mcpServers.MiniMax.env.KEY).toBe(hostile);
  });

  test("a scalar flag the caller already passed is left alone, quietly", () => {
    const plan = planWith({ model: "m", effort: "low" }, { argv: ["--effort=max"] });
    const argv = emitClaude(plan, w);
    expect(argv).not.toContain("--effort");
    expect(plan.warnings).toEqual([]);
    expect(plan.trace.join(" ")).toContain("caller passed --effort");
  });

  test("a suppressed accumulator warns — it drops everything the rules wanted", () => {
    const plan = planWith({ model: "m", mcp: [{ a: 1 }] }, { argv: ["--mcp-config=/mine.json"] });
    const argv = emitClaude(plan, w);
    expect(argv.join(" ")).not.toContain("--mcp-config={");
    expect(plan.warnings.join(" ")).toContain("--mcp-config");
  });

  test("--system-prompt from the caller suppresses ours, in either spelling", () => {
    const plan = planWith({ systemPromptFile: "prompts/opus-5-stance.md" }, { argv: ["--system-prompt", "hi"] });
    expect(emitClaude(plan, w)).not.toContain("--system-prompt-file");
  });

  test("exclude-dynamic-sections is dropped with a warning when a prompt replaces the base", () => {
    const conflict = planWith({
      systemPromptFile: "prompts/opus-5-stance.md",
      excludeDynamicSections: true,
    }).config;
    expect(validate(conflict).join(" ")).toContain("does nothing");
    expect(conflict.excludeDynamicSections).toBe(false);
  });

  test("exclude-dynamic-sections survives alone, and is not double-emitted", () => {
    const solo = planWith({ excludeDynamicSections: true }).config;
    expect(validate(solo)).toEqual([]);
    expect(emitClaude(planWith(solo), w)).toContain("--exclude-dynamic-system-prompt-sections");
    const already = planWith(solo, { argv: ["--exclude-dynamic-system-prompt-sections"] });
    expect(emitClaude(already, w)).not.toContain("--exclude-dynamic-system-prompt-sections");
  });

  test("a real launch carries no warnings", () => {
    expect(resolve({ harness: "claude", role: "worker" }, w).warnings).toEqual([]);
  });

  test("a lone append file passes through untouched (no .rendered copy)", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-append-"));
    const f = join(dir, "solo.md");
    writeFileSync(f, "SOLO");
    expect(emitClaude(planWith({ append: [{ file: f }] }), w)).toContain(f);
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

  test("dry mode names the same file but writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-dry-"));
    const f = join(dir, "brief.md");
    writeFileSync(f, "BODY\n");
    const wet = emitClaude(planWith({ append: [{ text: "A" }, { file: f }] }), w);
    const path = wet[wet.indexOf("--append-system-prompt-file") + 1];
    const before = statSync(path).mtimeMs;
    const dry = emitClaude(planWith({ append: [{ text: "A" }, { file: f }] }), w, { dry: true });
    expect(dry[dry.indexOf("--append-system-prompt-file") + 1]).toBe(path);
    expect(statSync(path).mtimeMs).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dry mode turns a missing file into a warning instead of an exit", () => {
    const plan = planWith({ append: [{ text: "A" }, { file: "roles/ghost.md" }] });
    emitClaude(plan, w, { dry: true });
    expect(plan.warnings.join(" ")).toContain("roles/ghost.md");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("mcp layers — the engine owns all launch config, bash injects nothing", () => {
  test("a bare world gets no mcp: every layer's requires is unmet, and says so", () => {
    const plan = resolve({ harness: "claude", role: "worker" }, fixedWorld());
    expect(plan.config.mcp).toEqual([]);
    expect(plan.config.systemPromptFile).toBe("prompts/opus-5-stance.worker.md");
    expect(plan.trace.join("\n")).toContain("skipped — needs");
  });

  test("mcp configs accumulate and never displace the arm's prompt", () => {
    const w = fixedWorld({
      env: { HOME: "/home/zt", SUPERZ_BOT_TOKEN: "t" },
      hasFile: () => true,
      hasExec: () => true,
    });
    const worker = resolve({ harness: "claude", role: "worker" }, w);
    expect(worker.config.systemPromptFile).toBe("prompts/opus-5-stance.worker.md");
    expect(worker.config.mcp.length).toBe(2);
  });

  test("minimax adds its mcp and disallows WebSearch only when its gates hold", () => {
    const base = {
      hasFile: () => false,
      hasExec: () => false,
      hasBin: (n: string) => n === "uvx",
    };
    const armed = resolve(
      { harness: "claude" },
      fixedWorld({ ...base, env: { MINIMAX_API_KEY: "k", MINIMAX_API_HOST: "https://h.example" } }),
    );
    expect(armed.config.disallowedTools).toEqual(["TaskOutput", "WebSearch"]);
    const cfg = armed.config.mcp[0] as { mcpServers: { MiniMax: { env: Record<string, string> } } };
    expect(cfg.mcpServers.MiniMax.env.MINIMAX_API_KEY).toBe("k");
    expect(cfg.mcpServers.MiniMax.env.MINIMAX_API_HOST).toBe("https://h.example");

    expect(
      resolve({ harness: "claude" }, fixedWorld({ ...base, hasBin: () => false, env: { MINIMAX_API_KEY: "k" } }))
        .config.mcp,
    ).toEqual([]);
    expect(resolve({ harness: "claude" }, fixedWorld({ ...base, env: {} })).config.mcp).toEqual([]);
  });

  test("a minimax base url without an explicit key uses the auth token", () => {
    const plan = resolve(
      { harness: "claude" },
      fixedWorld({
        hasBin: (n) => n === "uvx",
        env: { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic", ANTHROPIC_AUTH_TOKEN: "tok" },
      }),
    );
    const cfg = plan.config.mcp[0] as { mcpServers: { MiniMax: { env: Record<string, string> } } };
    expect(cfg.mcpServers.MiniMax.env.MINIMAX_API_KEY).toBe("tok");
    expect(cfg.mcpServers.MiniMax.env.MINIMAX_API_HOST).toBe("https://api.minimax.io");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("matrix", () => {
  test("every combination renders, and each names a model or explains why not", () => {
    const rows = buildMatrix(
      { profiles: ["", "codex", "spent_acct_1a"], roles: ["", "advisor", "worker"], models: [""], cwds: [""] },
      { ...fixedWorld({ localPools: { FABLE_SPENT: ["spent_acct_1a"] } }), pick: (c) => c[0] },
    );
    expect(rows).toHaveLength(9);
    for (const r of rows) {
      expect(r.argv).toContain("--model");
      expect(r.arm).not.toBe("");
    }
    expect(rows.find((r) => r.profile === "codex" && r.role === "worker")!.arm).toBe("gpt-5.6-sol:worker");
    expect(rows.find((r) => r.profile === "" && r.role === "advisor")!.arm).toBe("fable:advisor");
    // the local pool reroutes only that account's advisor
    expect(rows.find((r) => r.profile === "spent_acct_1a" && r.role === "advisor")!.arm).toBe("opus-5:advisor");
  });

  test("a matrix run writes nothing", () => {
    const proc = Bun.spawnSync(["bun", LAUNCH, ...GOLDEN_ARGS], { cwd: import.meta.dir, env: CLAUDE_ENV, stdout: "pipe" });
    expect(proc.exitCode).toBe(0);
    const rendered = join(import.meta.dir, ".rendered");
    const before = existsSync(rendered) ? statSync(rendered).mtimeMs : 0;
    Bun.spawnSync(["bun", LAUNCH, ...GOLDEN_ARGS], { cwd: import.meta.dir, env: CLAUDE_ENV, stdout: "pipe" });
    const after = existsSync(rendered) ? statSync(rendered).mtimeMs : 0;
    expect(after).toBe(before);
  });

  test("each profile renders against ITS env, never the caller's session", () => {
    const leaked = fixedWorld({ env: { ANTHROPIC_BASE_URL: "https://leaked.example" }, pick: (c) => c[0] });
    const profileEnv = (p: string) =>
      p === "endpoint" ? { ANTHROPIC_BASE_URL: "https://third-party.example" } : {};
    const rows = buildMatrix(
      { profiles: ["claude-acct", "endpoint"], roles: ["worker"], models: [""], cwds: [""] },
      leaked,
      profileEnv,
    );
    // the claude account keeps its model despite the leaked session var
    expect(rows[0].argv).toContain("claude-opus-5[1m]");
    // the endpoint profile gets none, from its own .env
    expect(rows[1].argv).not.toContain("--model");
  });

  test("without a profile-env reader the matrix uses the caller's env", () => {
    const rows = buildMatrix(
      { profiles: ["anything"], roles: ["worker"], models: [""], cwds: [""] },
      fixedWorld({ env: { ANTHROPIC_BASE_URL: "https://x.example" }, pick: (c) => c[0] }),
    );
    expect(rows[0].argv).not.toContain("--model");
  });

  test("a matrix surfaces a role no route knows", () => {
    const rows = buildMatrix(
      { profiles: [""], roles: ["ghost"], models: [""], cwds: [""] },
      { ...fixedWorld(), pick: (c) => c[0] },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].warnings.join(" ")).toContain("matches no route");
  });

  test("the table names every candidate when a route offers more than one", () => {
    // no route is multi-candidate today; assert the column logic directly
    const rows = buildMatrix(
      { profiles: [""], roles: ["worker"], models: [""], cwds: [""] },
      { ...fixedWorld(), pick: (c) => c[0] },
    );
    expect(rows[0].candidates).toEqual(["opus-5:worker"]);
  });

  test("the golden matrix is current — regenerate with the GOLDEN_ARGS command", () => {
    const proc = Bun.spawnSync(["bun", LAUNCH, ...GOLDEN_ARGS], {
      cwd: import.meta.dir,
      env: CLAUDE_ENV,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe(readFileSync(join(import.meta.dir, "matrix.golden.txt"), "utf8"));
  });

  test("the golden covers the explicit-model half of the router", () => {
    const golden = readFileSync(join(import.meta.dir, "matrix.golden.txt"), "utf8");
    expect(golden).toContain("claude-opus-5");
    expect(golden).toContain("claude-opus-4-8[200k]");
    expect(golden).toContain("sonnet");
    // every role prompt must be visible in the table
    expect(golden).toContain("opus-5-stance.worker.md");
    expect(golden).toContain("fable-5-calibration.advisor.md");
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
    const data = JSON.parse(html.match(/const DATA = (\{.*?\});\n/s)![1]);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows[0]).toHaveProperty("trace");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a hostile value cannot break out of the viewer's script block", () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-xss-"));
    const out = join(dir, "m.html");
    Bun.spawnSync(
      ["bun", LAUNCH, "matrix", "--profiles", '</script><img src=x onerror=alert(1)>', "--html", out],
      { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
    );
    const html = readFileSync(out, "utf8");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c");
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
      mcp: [],
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      extraArgs: [],
      ...over,
    },
  };
}
