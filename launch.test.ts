// Tests for launch.ts — the one-file launch config.
//
// Two levels:
//   1. Process contract — spawn `bun launch.ts` against THIS repo (what
//      spawn-agent / a human actually runs), locking the deployed selection
//      behavior per role/model/profile and every fail-loud branch.
//   2. Render machinery — import renderClaude() directly for composition
//      rules that the deployed selection doesn't exercise.
//
// Run: bun test launch.test.ts   (from this repo root)

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderClaude, type Config } from "./launch";

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
  const proc = Bun.spawnSync(["bun", LAUNCH, ...args], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" });
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

describe("deployed selection (process contract, real repo)", () => {
  test("bare launch: fable-5 xhigh, no prompt override, model_matched", () => {
    const r = run([]);
    expect(r.exitCode).toBe(0);
    expect(r.json!.argv).toEqual(["--model", "claude-fable-5", "--effort", "xhigh"]);
    expect(r.json!.model_matched).toBe(true);
    expect(r.json!.trace.join(" ")).toContain("base:");
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
    expect(r.exitCode).toBe(0);
    expect(modelOf(r)).toBe("claude-fable-5");
    expect(r.json!.argv).toContain("--system-prompt-file");
    expect(r.promptFiles["--append-system-prompt-file"]).toContain("You are an **advisor**");
  });

  test("worker: base model, NO system-prompt override, worker brief", () => {
    const r = run(["--role", "worker"]);
    expect(r.exitCode).toBe(0);
    expect(modelOf(r)).toBe("claude-fable-5");
    expect(r.json!.argv).not.toContain("--system-prompt-file");
    expect(r.promptFiles["--append-system-prompt-file"]).toContain("You are a **worker**");
  });

  test("opus-xhigh: opus model + opus prompt + xhigh effort", () => {
    const r = run(["--model", "claude-opus-4-8-xhigh"]);
    expect(modelOf(r)).toBe("claude-opus-4-8");
    expect(r.json!.argv).toContain("xhigh");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.opus.md");
  });

  test("plain opus: opus arm, effort inherited from base", () => {
    const r = run(["--model", "claude-opus-4-8"]);
    expect(modelOf(r)).toBe("claude-opus-4-8");
    expect(r.json!.argv).toContain("--effort");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.opus.md");
  });

  test("unknown model passes through as a real id (never silently swallowed)", () => {
    const r = run(["--model", "sonnet"]);
    expect(modelOf(r)).toBe("sonnet");
    expect(r.json!.trace.join(" ")).toContain("passthrough");
  });

  test("explicit model beats the role's default arm", () => {
    const r = run(["--role", "leader", "--model", "claude-opus-4-8"]);
    expect(modelOf(r)).toBe("claude-opus-4-8");
    expect(r.json!.argv.join(" ")).toContain("SYSTEM_PROMPT.opus.md");
  });

  test("codex profile: gpt-5.6 xhigh, harness base prompt kept", () => {
    const r = run(["--profile", "codex"]);
    expect(modelOf(r)).toBe("gpt-5.6");
    expect(r.json!.argv).not.toContain("--system-prompt-file");
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

  test("shell output: one splice-ready line, trace on stderr", () => {
    const r = run(["--role", "worker", "--output", "shell"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("--model claude-fable-5");
    expect(r.stderr).toContain("trace: ");
  });

  test("rendered append path is content-hashed — stable across runs", () => {
    const a = run(["--role", "worker"]);
    const b = run(["--role", "worker"]);
    expect(a.json!.argv).toEqual(b.json!.argv);
  });
});

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
    expect(r.stderr).toContain("render not implemented");
  });

  test("unknown harness rejected", () => {
    const r = run(["--harness", "gemini"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown harness");
  });

  test("bad output value rejected", () => {
    const r = run(["--output", "yaml"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("output must be json or shell");
  });

  test("stray positional rejected", () => {
    const r = run(["leader"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unrecognized argument");
  });

  test("invalid JSON param rejected", () => {
    const r = run(["{not json"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("invalid JSON");
  });

  test("empty model from selection fails loud (never emits --model '')", () => {
    // renderClaude exits the process on this guard — exercise it in a subprocess.
    const dir = mkdtempSync(join(tmpdir(), "launch-test-"));
    const script = join(dir, "empty-model.ts");
    writeFileSync(
      script,
      `import { renderClaude } from ${JSON.stringify(LAUNCH)};\n` +
        `renderClaude({ model: " ", skills: [], append: [], extraArgs: [] });\n`,
    );
    const proc = Bun.spawnSync(["bun", script], { stdout: "pipe", stderr: "pipe" });
    rmSync(dir, { recursive: true, force: true });
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("empty model");
  });
});

describe("render machinery (renderClaude direct)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "launch-render-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const cfg = (over: Partial<Config>): Config => ({ skills: [], append: [], extraArgs: [], ...over });

  test("skills dedupe + leading-slash normalization, one directive", () => {
    const argv = renderClaude(cfg({ skills: ["/ccc-work", "ccc-base", "ccc-work"] }));
    const content = readFileSync(argv[argv.indexOf("--append-system-prompt-file") + 1], "utf8");
    expect(content).toContain("/ccc-work, /ccc-base");
    expect(content).not.toContain("//ccc-work");
    expect(content.match(/<session-startup>/g)).toHaveLength(1);
  });

  test("a lone append file passes through untouched (no .rendered copy)", () => {
    const f = join(tmp, "solo.md");
    writeFileSync(f, "SOLO");
    const argv = renderClaude(cfg({ append: [{ file: f }] }));
    expect(argv[argv.indexOf("--append-system-prompt-file") + 1]).toBe(f);
  });

  test("mixed pieces compose in order, blank pieces dropped", () => {
    const f = join(tmp, "brief.md");
    writeFileSync(f, "BRIEF-BODY\n");
    const argv = renderClaude(cfg({ append: [{ text: "FIRST" }, { text: "  " }, { file: f }] }));
    const content = readFileSync(argv[argv.indexOf("--append-system-prompt-file") + 1], "utf8");
    expect(content.indexOf("FIRST")).toBeLessThan(content.indexOf("BRIEF-BODY"));
    expect(content).not.toContain("  \n\n");
  });

  test("verbose true emits --verbose; false/absent does not", () => {
    expect(renderClaude(cfg({ verbose: true }))).toContain("--verbose");
    expect(renderClaude(cfg({ verbose: false }))).not.toContain("--verbose");
    expect(renderClaude(cfg({}))).not.toContain("--verbose");
  });

  test("extraArgs emitted verbatim at the end", () => {
    const argv = renderClaude(cfg({ model: "m", extraArgs: ["--foo", "bar baz"] }));
    expect(argv.slice(-2)).toEqual(["--foo", "bar baz"]);
  });
});
