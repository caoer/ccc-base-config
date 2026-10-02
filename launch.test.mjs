// ═══════════════════════════════════════════════════════════════════════════
// launch.test.mjs — one file, run by BOTH runtimes:
//
//   node --test worker/launch-config/launch.test.mjs
//   bun test worker/launch-config/launch.test.mjs
//
// so `node:test` + `node:assert/strict` are the only test imports: bun maps
// them onto its own runner. Nothing here reaches the network, the daemon or
// $UCC_HOME — every case builds a throwaway config tree under TMPDIR.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync, statSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { delimiter } from "node:path";

import {
  parsePage,
  PageError,
  Refusal,
  candidateNames,
  choosePage,
  probe,
  expand,
  expandDeep,
  readServerFile,
  resolveServers,
  render,
  siftArgv,
  FLEET_DENY_KEY,
  checkTree,
  explain,
  seatEnv,
  isFable,
  LIFT_SETTINGS,
  SEALED_DENY,
  LAUNCH_PLUGIN,
  PLUGIN_TTL_MS,
} from "./launch.mjs";

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A whole config dir: { "launch/default.md": "text", … } plus symlinks.
 *  Returns the dir; the caller registers cleanup with `t.after`. */
function fixture(files = {}, links = {}) {
  const dir = mkdtempSync(join(tmpdir(), "launch-cfg-"));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
  for (const [rel, target] of Object.entries(links)) {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(target, path);
  }
  return dir;
}

const cleanup = (t, dir) => t.after(() => rmSync(dir, { recursive: true, force: true }));

const page = (front, body = "You are a worker.\n") => `---\n${front}\n---\n${body}`;

// ═══════════════════════════════════════════════════════════════════════════
// Unit 1 — page grammar
// ═══════════════════════════════════════════════════════════════════════════

describe("unit 1: frontmatter grammar", () => {
  test("splits frontmatter from a verbatim body", () => {
    const { front, body } = parsePage(
      "---\nmodel: claude-opus-5-5[1m]\n---\nLine one\n\n---\nnot frontmatter\n",
      "p.md",
    );
    assert.deepEqual(front, { model: "claude-opus-5-5[1m]" });
    assert.equal(body, "Line one\n\n---\nnot frontmatter\n");
  });

  test("a page with no frontmatter is all body", () => {
    const { front, body } = parsePage("You are a worker.\n", "p.md");
    assert.deepEqual(front, {});
    assert.equal(body, "You are a worker.\n");
  });

  test("flow lists, quoted items, comments and blank lines", () => {
    const { front } = parsePage(
      [
        "---",
        "# a comment",
        "",
        "tools: [Bash, Read, AskUserQuestion]",
        'requires: ["env:A | env:B", "exec:${HOME}/.local/bin/x"]',
        "empty: []",
        "---",
        "body",
      ].join("\n"),
      "p.md",
    );
    assert.deepEqual(front.tools, ["Bash", "Read", "AskUserQuestion"]);
    assert.deepEqual(front.requires, ["env:A | env:B", "exec:${HOME}/.local/bin/x"]);
    assert.deepEqual(front.empty, []);
  });

  test("scalars: quotes preserved as text, numbers and booleans coerced", () => {
    const { front } = parsePage(
      ['---', 'description: "a page, with a comma"', "maxTurns: 12", "verbose: false", "model: k3", "---", "b"].join("\n"),
      "p.md",
    );
    assert.equal(front.description, "a page, with a comma");
    assert.equal(front.maxTurns, 12);
    assert.equal(front.verbose, false);
    assert.equal(front.model, "k3");
  });

  test("a quoted scalar that looks like a number stays a string", () => {
    const { front } = parsePage('---\neffort: "5"\n---\nb', "p.md");
    assert.equal(front.effort, "5");
  });

  test("an escaped quote inside a quoted list item", () => {
    const { front } = parsePage('---\ntools: ["a \\"b\\"", \'it\'\'s\']\n---\nb', "p.md");
    assert.deepEqual(front.tools, ['a "b"', "it's"]);
  });

  // Every refusal names the offending line — the number is the whole point of
  // the message, so each case asserts it.
  const refusals = [
    {
      why: "nested map",
      text: "---\nmodel: x\npermissions:\n  deny: [WebSearch]\n---\nb",
      line: 3,
      match: /nested map/,
    },
    {
      why: "indented continuation",
      text: "---\nmodel: x\n  more: y\n---\nb",
      line: 3,
      match: /indented/,
    },
    {
      why: "block list",
      text: "---\ntools:\n- Bash\n- Read\n---\nb",
      line: 2,
      match: /nested map/,
    },
    {
      why: "block list under a legal key",
      text: "---\nmodel: x\n- Bash\n---\nb",
      line: 3,
      match: /block list/,
    },
    {
      why: "multi-line scalar",
      text: "---\nprompt: |\n  hello\n---\nb",
      line: 2,
      match: /multi-line scalar/,
    },
    {
      why: "folded scalar",
      text: "---\nmodel: x\nprompt: >\n  hello\n---\nb",
      line: 3,
      match: /multi-line scalar/,
    },
    {
      why: "anchor",
      text: "---\nmodel: x\nbase: &common\n---\nb",
      line: 3,
      match: /anchor/,
    },
    {
      why: "alias",
      text: "---\nmodel: x\ntools: *common\n---\nb",
      line: 3,
      match: /anchor/,
    },
    {
      why: "not a key: value pair",
      text: "---\nmodel: x\njust some prose\n---\nb",
      line: 3,
      match: /not a key/,
    },
    {
      why: "unclosed flow list",
      text: "---\ntools: [Bash,\n  Read]\n---\nb",
      line: 2,
      match: /does not close/,
    },
    {
      why: "unterminated frontmatter",
      text: "---\nmodel: x\nbody with no closing fence\n",
      line: 1,
      match: /never closed/,
    },
    {
      why: "a flow map",
      text: "---\nmodel: x\ntools: {nested: true}\n---\nb",
      line: 3,
      match: /nested map/,
    },
    {
      why: "a flow list inside a flow list",
      text: "---\ntools: [[Bash]]\n---\nb",
      line: 2,
      match: /nested/,
    },
    {
      why: "an alias inside a flow list",
      text: "---\ntools: [Bash, *common]\n---\nb",
      line: 2,
      match: /anchor/,
    },
  ];

  for (const c of refusals) {
    test(`refuses ${c.why}, naming the line`, () => {
      assert.throws(
        () => parsePage(c.text, "bad.md"),
        (e) => {
          assert.ok(e instanceof PageError, `expected a PageError, got ${e}`);
          assert.equal(e.line, c.line);
          assert.match(e.message, c.match);
          assert.match(e.message, new RegExp(`^bad\\.md:${c.line}: `));
          return true;
        },
      );
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit 2 — the ladder
// ═══════════════════════════════════════════════════════════════════════════

describe("unit 2: candidate construction", () => {
  const cases = [
    {
      why: "--launch, with a role: the kind goes first, role-first within it",
      ctx: { kind: "heartbeat", role: "worker", profile: "does_bannock_6u" },
      want: [
        "heartbeat.worker.md",
        "heartbeat.md",
        "@does_bannock_6u.worker.md",
        "@does_bannock_6u.md",
        "default.worker.md",
        "default.md",
      ],
    },
    {
      why: "explicit model: every shorter dash-prefix, role-first at each rung",
      ctx: { model: "claude-opus-4-8", role: "worker" },
      want: [
        "claude-opus-4-8.worker.md",
        "claude-opus-4-8.md",
        "claude-opus-4.worker.md",
        "claude-opus-4.md",
        "claude-opus.worker.md",
        "claude-opus.md",
        "claude.worker.md",
        "claude.md",
        "default.worker.md",
        "default.md",
      ],
    },
    {
      why: "the [1m] postfix is not part of a filename",
      ctx: { model: "claude-opus-5-5[1m]" },
      want: ["claude-opus-5-5.md", "claude-opus-5.md", "claude-opus.md", "claude.md", "default.md"],
    },
    {
      why: "a model id with no dashes is one rung",
      ctx: { model: "k3", profile: "kimi-k3-moonshot" },
      want: ["k3.md", "@kimi-k3-moonshot.md", "default.md"],
    },
    {
      why: "sets come after the profile, in the order given",
      ctx: { profile: "p", sets: ["FABLE_SPENT", "SLOW"], role: "advisor" },
      want: [
        "@p.advisor.md",
        "@p.md",
        "FABLE_SPENT.advisor.md",
        "FABLE_SPENT.md",
        "SLOW.advisor.md",
        "SLOW.md",
        "default.advisor.md",
        "default.md",
      ],
    },
    {
      why: "bare default: nothing known at all",
      ctx: {},
      want: ["default.md"],
    },
    {
      why: "a kind named default is not tried twice",
      ctx: { kind: "default" },
      want: ["default.md"],
    },
  ];

  for (const c of cases) {
    test(c.why, () => assert.deepEqual(candidateNames(c.ctx), c.want));
  }
});

describe("unit 2: the pick", () => {
  test("first existing file wins, and misses are traced", (t) => {
    const dir = fixture({
      "launch/claude-opus-4-8.md": page("model: claude-opus-4-8[1m]"),
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]"),
    });
    cleanup(t, dir);
    const trace = [];
    const got = choosePage(join(dir, "launch"), { model: "claude-opus-4-8", role: "worker" }, trace, []);
    assert.equal(got.pick.stem, "claude-opus-4-8");
    assert.deepEqual(got.candidates, [
      "claude-opus-4-8.worker.md",
      "claude-opus-4-8.md",
      "claude-opus-4.worker.md",
      "claude-opus-4.md",
      "claude-opus.worker.md",
      "claude-opus.md",
      "claude.worker.md",
      "claude.md",
      "default.worker.md",
      "default.md",
    ]);
    assert.match(trace.join("\n"), /candidate claude-opus-4-8\.worker\.md: no file/);
    assert.match(trace.join("\n"), /page claude-opus-4-8\.md/);
  });

  test("role-first, then the roleless rung", (t) => {
    const dir = fixture({ "launch/default.md": page("model: claude-opus-5-5[1m]") });
    cleanup(t, dir);
    const roleless = choosePage(join(dir, "launch"), { role: "leader" }, [], []);
    assert.equal(roleless.pick.stem, "default");

    const dir2 = fixture({
      "launch/default.md": page("model: claude-opus-5-5[1m]"),
      "launch/default.leader.md": page("model: claude-opus-5-5[1m]"),
    });
    cleanup(t, dir2);
    assert.equal(choosePage(join(dir2, "launch"), { role: "leader" }, [], []).pick.stem, "default.leader");
  });

  test("a symlink resolves, and the definition is named after the real stem", (t) => {
    const dir = fixture(
      { "launch/claude-fable-5-1.advisor.md": page("model: claude-fable-5-1[1m]") },
      {
        "launch/claude-fable.advisor.md": "claude-fable-5-1.advisor.md",
        "launch/@codex.advisor.md": "claude-fable.advisor.md",
      },
    );
    cleanup(t, dir);
    const trace = [];
    const got = choosePage(join(dir, "launch"), { profile: "codex", role: "advisor" }, trace, []);
    assert.equal(got.pick.name, "@codex.advisor.md");
    assert.equal(got.pick.stem, "claude-fable-5-1.advisor");
    assert.match(trace.join("\n"), /→ claude-fable-5-1\.advisor\.md/);
  });

  test("a set member takes the set page, ahead of default", (t) => {
    const dir = fixture(
      { "launch/claude-opus-5-5.advisor.md": page("model: claude-opus-5-5[1m]") },
      { "launch/FABLE_SPENT.advisor.md": "claude-opus-5-5.advisor.md" },
    );
    cleanup(t, dir);
    const got = choosePage(join(dir, "launch"), { profile: "zt", sets: ["FABLE_SPENT"], role: "advisor" }, [], []);
    assert.equal(got.pick.stem, "claude-opus-5-5.advisor");
  });

  test("a symlink pointing outside launch/ is not a candidate — the ladder continues", (t) => {
    const dir = fixture({
      "launch/default.md": page("model: claude-opus-5-5[1m]"),
      "outside/evil.md": page("model: claude-opus-5-5[1m]"),
    });
    cleanup(t, dir);
    symlinkSync("../outside/evil.md", join(dir, "launch", "@codex.md"));
    const warnings = [];
    const got = choosePage(join(dir, "launch"), { profile: "codex" }, [], warnings);
    assert.equal(got.pick.stem, "default");
    assert.match(warnings.join("\n"), /@codex\.md.*outside/);
  });

  test("a dangling symlink is not a candidate", (t) => {
    const dir = fixture({ "launch/default.md": page("model: claude-opus-5-5[1m]") });
    cleanup(t, dir);
    symlinkSync("gone.md", join(dir, "launch", "@codex.md"));
    const warnings = [];
    const got = choosePage(join(dir, "launch"), { profile: "codex" }, [], warnings);
    assert.equal(got.pick.stem, "default");
    assert.match(warnings.join("\n"), /@codex\.md/);
  });

  test("an empty body is not a candidate — plain keeps the harness prompt, an empty one loses it", (t) => {
    const dir = fixture({
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]", "\n\n"),
      "launch/default.md": page("model: claude-opus-5-5[1m]"),
    });
    cleanup(t, dir);
    const warnings = [];
    const got = choosePage(join(dir, "launch"), { role: "worker" }, [], warnings);
    assert.equal(got.pick.stem, "default");
    assert.match(warnings.join("\n"), /default\.worker\.md: empty body/);
  });

  test("no candidate at all, or no launch/ at all: no pick, one warning, no throw", (t) => {
    for (const files of [{ "launch/.keep": "" }, { "fleet.md": FLEET }]) {
      const dir = fixture(files);
      cleanup(t, dir);
      const warnings = [];
      const got = choosePage(join(dir, "launch"), { role: "worker" }, [], warnings);
      assert.equal(got.pick, null);
      assert.match(warnings.join("\n"), /no launch page/);
    }
  });

  test("--launch with no file refuses with R10's message, even when default.md exists", (t) => {
    const dir = fixture({ "launch/default.md": page("model: claude-opus-5-5[1m]") });
    cleanup(t, dir);
    assert.throws(
      () => choosePage(join(dir, "launch"), { kind: "nope" }, [], []),
      (e) => {
        assert.ok(e instanceof Refusal);
        assert.equal(e.message, "launch-config: no launch kind 'nope' in $UCC_HOME/config/launch/");
        return true;
      },
    );
  });

  test("--launch wins over every other rung", (t) => {
    const dir = fixture({
      "launch/heartbeat.md": page("model: claude-sonnet-5[1m]"),
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]"),
    });
    cleanup(t, dir);
    const got = choosePage(join(dir, "launch"), { kind: "heartbeat", role: "worker" }, [], []);
    assert.equal(got.pick.stem, "heartbeat");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit 3 — MCP server files
// ═══════════════════════════════════════════════════════════════════════════

const server = (requires, cfg) =>
  `---\nrequires: ${requires}\n---\n\n# a server\n\n\`\`\`json\n${cfg}\n\`\`\`\n`;

describe("unit 3: probe grammar", () => {
  const env = { TOKEN: "abc", URL: "https://api.minimax.io/anthropic", EMPTY: "", PATH: "/nowhere" };

  const cases = [
    ["env:TOKEN", true],
    ["env:MISSING", false],
    ["env:EMPTY", false],
    ["env:URL~minimax", true],
    ["env:URL~openai", false],
    ["!env:TOKEN", false],
    ["!env:MISSING", true],
    ["env:MISSING | env:TOKEN", true],
    ["env:MISSING | env:ALSO_MISSING", false],
    ["bin:definitely-not-a-real-binary", false],
    ["file:/definitely/not/here", false],
    ["exec:/definitely/not/here", false],
    ["nonsense", false],
    ["what:ever", false],
  ];
  for (const [expr, want] of cases) {
    test(`${expr} → ${want}`, () => assert.equal(probe(expr, env), want));
  }

  test("exec: sees the executable bit; file: only existence", (t) => {
    const dir = fixture({ "bin/tool": "#!/bin/sh\n", "notes.md": "x" });
    cleanup(t, dir);
    chmodSync(join(dir, "bin/tool"), 0o755);
    assert.equal(probe(`file:${join(dir, "notes.md")}`, {}), true);
    assert.equal(probe(`exec:${join(dir, "notes.md")}`, {}), false);
    assert.equal(probe(`bin:tool`, { PATH: join(dir, "bin") }), true);
    assert.equal(probe(`exec:\${HOME}/bin/tool`, { HOME: dir }), true);
    assert.equal(probe(`exec:\${HOME}/notes.md`, { HOME: dir }), false);
  });
});

describe("unit 3: expansion", () => {
  test("${VAR}, ${A|B} and ${A:-text}", () => {
    const env = { B: "second", HOME: "/home/zt" };
    assert.equal(expand("${HOME}/bin", env), "/home/zt/bin");
    assert.equal(expand("${A|B}", env), "second");
    assert.equal(expand("${A:-19223}", env), "19223");
    assert.equal(expand("${A|B:-fallback}", env), "second");
    assert.equal(expand("${MISSING:-}", env), "");
  });

  test("an unset variable with no default expands to empty and reports it", () => {
    const missing = [];
    assert.equal(expand("Bearer ${NOPE}", {}, (n) => missing.push(n)), "Bearer ");
    assert.deepEqual(missing, ["NOPE"]);
  });

  test("expandDeep walks keys and leaves, leaving non-strings alone", () => {
    const got = expandDeep(
      { url: "http://localhost:${PORT:-19223}/mcp", headers: { Authorization: "Bearer ${T}" }, timeout: 86400000, on: true },
      { T: "tok" },
    );
    assert.deepEqual(got, {
      url: "http://localhost:19223/mcp",
      headers: { Authorization: "Bearer tok" },
      timeout: 86400000,
      on: true,
    });
  });
});

describe("unit 3: server files", () => {
  test("the first json fence is the server object; requires is the gate", (t) => {
    const dir = fixture({
      "mcp/one.md": server('["env:TOKEN"]', '{"type": "http", "url": "http://localhost:${PORT:-1}/mcp"}'),
    });
    cleanup(t, dir);
    const got = readServerFile(join(dir, "mcp"), "one");
    assert.deepEqual(got.requires, ["env:TOKEN"]);
    assert.deepEqual(got.config, { type: "http", url: "http://localhost:${PORT:-1}/mcp" });
  });

  test("a met gate, an unmet gate and a missing file: one server, one skip, one warning", (t) => {
    const dir = fixture({
      "mcp/met.md": server('["env:TOKEN"]', '{"type": "http", "url": "http://x/${TOKEN}"}'),
      "mcp/unmet.md": server('["env:NOPE"]', '{"type": "http", "url": "http://y"}'),
    });
    cleanup(t, dir);
    const trace = [];
    const warnings = [];
    const got = resolveServers(join(dir, "mcp"), ["met", "unmet", "gone"], { TOKEN: "abc" }, trace, warnings);
    assert.deepEqual(got, [{ met: { type: "http", url: "http://x/abc" } }]);
    assert.equal(trace.filter((l) => /skipped — needs/.test(l)).length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /mcp\/gone\.md/);
  });

  test("a fence that does not parse is an error, not a crash", (t) => {
    const dir = fixture({ "mcp/broken.md": server("[]", "{not json}") });
    cleanup(t, dir);
    assert.match(readServerFile(join(dir, "mcp"), "broken").error, /does not parse/);
  });

  test("a server file with no json fence is an error", (t) => {
    const dir = fixture({ "mcp/empty.md": "---\nrequires: []\n---\n\nno fence here\n" });
    cleanup(t, dir);
    assert.match(readServerFile(join(dir, "mcp"), "empty").error, /json fence/);
  });

  test("a grammar refusal in a server file degrades to a warning", (t) => {
    const dir = fixture({ "mcp/bad.md": '---\nrequires: ["env:A"]\n  nested: true\n---\n\n```json\n{}\n```\n' });
    cleanup(t, dir);
    const warnings = [];
    const got = resolveServers(join(dir, "mcp"), ["bad"], {}, [], warnings);
    assert.deepEqual(got, []);
    assert.match(warnings[0], /mcp\/bad\.md:3/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit 4 — definition builder, wire rules, output contract
// ═══════════════════════════════════════════════════════════════════════════

const FLEET = "---\ndisallowedTools: [TaskOutput, Artifact, ReportFindings, ListAgents, ScheduleWakeup]\n---\n\nthe fleet deny list\n";
const FLEET_FLAG = "--disallowedTools=TaskOutput,Artifact,ReportFindings,ListAgents,ScheduleWakeup";

/** A config dir with fleet.md and one default.worker page, plus extras. */
function configFixture(extra = {}, links = {}) {
  return fixture(
    {
      "fleet.md": FLEET,
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]\neffort: xhigh", "You are a worker.\n"),
      ...extra,
    },
    links,
  );
}

const flag = (argv, name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
/** The definition a render carries — the argv JSON, or the plugin dir's agent
 *  file plus its servers.json read back into the same shape. */
const definitionOf = (out) => {
  if (out.argv.includes("--agents")) return JSON.parse(flag(out.argv, "--agents"));
  const root = flag(out.argv, "--plugin-dir");
  const name = flag(out.argv, "--agent").slice(LAUNCH_PLUGIN.length + 1);
  const { front, body } = parsePage(readFileSync(join(root, "agents", `${name}.md`), "utf8"));
  const { name: _named, ...agent } = front;
  agent.prompt = body;
  const servers = join(root, "servers.json");
  if (existsSync(servers)) {
    agent.mcpServers = Object.entries(JSON.parse(readFileSync(servers, "utf8")).mcpServers).map(([k, v]) => ({ [k]: v }));
  }
  return { [name]: agent };
};

describe("unit 4: argv sifting", () => {
  test("reads the model, effort, resume and kind out of the caller's raw argv", () => {
    const got = siftArgv(["--model", "claude-opus-5-5", "--effort", "max", "--launch", "heartbeat", "-r", "abc", "-p", "hi"]);
    assert.equal(got.model, "claude-opus-5-5");
    assert.equal(got.effort, "max");
    assert.equal(got.kind, "heartbeat");
    assert.equal(got.resume, true);
    // --model is removed so the normalized spelling can replace it; --effort
    // stays (it is forwarded once); --launch never reaches the binary.
    assert.deepEqual(got.argv, ["--effort", "max", "-r", "abc", "-p", "hi"]);
  });

  test("the = spellings, and --continue", () => {
    const got = siftArgv(["--model=claude-fable-5-1", "--effort=high", "--launch=heartbeat", "--continue"]);
    assert.equal(got.model, "claude-fable-5-1");
    assert.equal(got.effort, "high");
    assert.equal(got.kind, "heartbeat");
    assert.equal(got.resume, true);
  });

  test("-- ends option scanning: a prompt shaped like a flag stays verbatim", () => {
    const raw = ["-p", "--", "--launch=heartbeat", "--model", "claude-opus-5-5", "--resume"];
    const got = siftArgv(raw);
    assert.equal(got.kind, undefined);
    assert.equal(got.model, undefined);
    assert.equal(got.resume, false);
    assert.deepEqual(got.argv, raw);
  });
});

test("unit 4: -- ends the family-clash scan too", (t) => {
  const dir = configFixture();
  cleanup(t, dir);
  const out = render({ role: "worker", argv: ["-p", "--", "--system-prompt", "--effort", "--disallowedTools=x"] }, { dir, env: {} });
  assert.equal(flag(out.argv, "--agent"), "default.worker");
  assert.equal(flag(out.argv, "--effort"), "xhigh");
  assert.equal(out.argv.includes(FLEET_FLAG), true);
});

describe("unit 4: the work root", () => {
  test("an existing $UCC_HOME/work rides as the last token, --add-dir=<path>", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const home = mkdtempSync(join(tmpdir(), "launch-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    mkdirSync(join(home, ".local/share/ucc/work"), { recursive: true });
    const out = render({ role: "worker" }, { dir, env: { HOME: home } });
    assert.equal(out.argv.at(-1), `--add-dir=${join(home, ".local/share/ucc/work")}`);
    const ucc = join(home, "ucc-home");
    mkdirSync(join(ucc, "work"), { recursive: true });
    assert.equal(render({ role: "worker" }, { dir, env: { HOME: home, UCC_HOME: ucc } }).argv.at(-1), `--add-dir=${join(ucc, "work")}`);
  });

  test("no work dir, or no home at all: no --add-dir", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const home = mkdtempSync(join(tmpdir(), "launch-home-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    for (const env of [{}, { HOME: home }]) {
      assert.equal(render({ role: "worker" }, { dir, env }).argv.some((a) => a.startsWith("--add-dir")), false);
    }
  });
});

describe("unit 4: the definition and the wire", () => {
  test("the output contract: agents, agent, effort and the fleet deny list", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: {} });
    assert.deepEqual(out.argv, [
      "--agents",
      out.argv[1],
      "--agent",
      "default.worker",
      "--effort",
      "xhigh",
      "--settings",
      LIFT_SETTINGS,
      FLEET_FLAG,
    ]);
    assert.equal(out.model_matched, false);
    const def = definitionOf(out);
    assert.deepEqual(Object.keys(def), ["default.worker"]);
    assert.equal(def["default.worker"].prompt, "You are a worker.\n");
    assert.equal(def["default.worker"].description, "launch page default.worker");
    assert.equal(def["default.worker"].model, "claude-opus-5-5[1m]");
    assert.equal("effort" in def["default.worker"], false);
    assert.equal(out.warnings.length, 0);
  });

  test("unknown keys pass through; effort, mcpServers and name never do", (t) => {
    const dir = configFixture({
      "launch/default.worker.md": page(
        'description: "the fleet worker"\nmodel: claude-opus-5-5[1m]\neffort: xhigh\ntools: [Bash, Read]\ndisallowedTools: [AskUserQuestion]\npermissionMode: acceptEdits\nmaxTurns: 40',
      ),
    });
    cleanup(t, dir);
    const def = definitionOf(render({ role: "worker" }, { dir, env: {} }))["default.worker"];
    assert.deepEqual(def, {
      description: "the fleet worker",
      prompt: "You are a worker.\n",
      tools: ["Bash", "Read"],
      disallowedTools: ["AskUserQuestion"],
      permissionMode: "acceptEdits",
      maxTurns: 40,
      model: "claude-opus-5-5[1m]",
    });
  });

  test("a body with a quote, a ${VAR} and newlines survives the JSON unharmed", (t) => {
    const body = 'Say "hello" — never ${HOME}.\n\nSecond line ends with a backslash \\\n';
    const dir = configFixture({ "launch/default.worker.md": page("model: claude-opus-5-5[1m]", body) });
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: { HOME: "/home/zt" } });
    assert.equal(definitionOf(out)["default.worker"].prompt, body);
    assert.equal(out.argv.some((a) => a.includes("\n")), false, "no argv element may carry a newline");
  });

  test("[1m] is appended to an explicit claude id, and --model is emitted", (t) => {
    const dir = configFixture({ "launch/claude-opus-4-8.md": page("model: claude-opus-4-8[1m]") });
    cleanup(t, dir);
    const out = render({ model: "claude-opus-4-8", role: "worker" }, { dir, env: {} });
    assert.equal(flag(out.argv, "--model"), "claude-opus-4-8[1m]");
    assert.equal(out.model_matched, true);
    assert.equal(definitionOf(out)["claude-opus-4-8"].model, "claude-opus-4-8[1m]");
    assert.match(out.trace.join("\n"), /normalized to claude-opus-4-8\[1m\]/);
  });

  test("pin: an explicit model the profile's ANTHROPIC_MODEL cannot serve refuses", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    assert.throws(
      () => render({ model: "claude-opus-5-5", role: "worker", profile: "codex" }, { dir, env: { ANTHROPIC_MODEL: "gpt-6-astra[1m]" } }),
      (e) => {
        assert.ok(e instanceof Refusal);
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /--model claude-opus-5-5 cannot be served/);
        assert.match(e.message, /profile 'codex'/);
        assert.match(e.message, /serves only gpt-6-astra\[1m\]/);
        assert.match(e.message, /Fix: drop --model/);
        return true;
      },
    );
  });

  test("pin: a matching explicit model is served, and the page model is not re-emitted", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ model: "gpt-6-astra", role: "worker", profile: "codex" }, { dir, env: { ANTHROPIC_MODEL: "gpt-6-astra[1m]" } });
    assert.equal("model" in definitionOf(out)["default.worker"], false);
    assert.match(out.trace.join("\n"), /pin: ANTHROPIC_MODEL=gpt-6-astra\[1m\]/);
  });

  test("pin: with no explicit model the page's model is omitted from the definition", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker", profile: "codex" }, { dir, env: { ANTHROPIC_MODEL: "gpt-6-astra[1m]" } });
    assert.equal("model" in definitionOf(out)["default.worker"], false);
    assert.equal(out.argv.includes("--model"), false);
    assert.match(out.trace.join("\n"), /pin: ANTHROPIC_MODEL=gpt-6-astra\[1m\] — the harness reads it natively/);
  });

  test("foreign endpoint: the page's effort is withheld, an explicit --effort still wins", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const env = { ANTHROPIC_MODEL: "gpt-6-astra[1m]", ANTHROPIC_BASE_URL: "https://chatgpt.com/backend-api/codex" };
    const out = render({ role: "worker", profile: "codex" }, { dir, env });
    assert.equal(out.argv.includes("--effort"), false);
    assert.match(out.trace.join("\n"), /foreign endpoint: withholding the page effort xhigh/);

    const asked = render({ role: "worker", profile: "codex", effort: "max" }, { dir, env });
    assert.equal(flag(asked.argv, "--effort"), "max");
    assert.match(asked.trace.join("\n"), /explicit effort: max/);
  });

  test("foreign endpoint with no ANTHROPIC_MODEL: no model, and a warning naming the profile", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker", profile: "zenmux" }, { dir, env: { ANTHROPIC_BASE_URL: "https://zenmux.ai/api/anthropic" } });
    assert.equal("model" in definitionOf(out)["default.worker"], false);
    assert.equal(out.warnings.some((w) => w === "profile zenmux has no ANTHROPIC_MODEL — provision one"), true);
  });

  test("an explicit model on a foreign endpoint with no pin rides through on the caller's own argv", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render(
      { model: "claude-opus-5-5", role: "worker", profile: "zenmux" },
      { dir, env: { ANTHROPIC_BASE_URL: "https://zenmux.ai/api/anthropic" } },
    );
    assert.equal(out.model_matched, false);
    assert.equal(out.argv.includes("--model"), false);
    assert.match(out.warnings.join("\n"), /rides through to an endpoint that serves its own models/);
  });

  test("resume drops the page's model and effort but still emits the definition", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker", argv: ["-r", "abc"] }, { dir, env: {} });
    assert.equal(flag(out.argv, "--agent"), "default.worker");
    assert.equal("model" in definitionOf(out)["default.worker"], false);
    assert.equal(out.argv.includes("--effort"), false);
    assert.match(out.trace.join("\n"), /resume\/continue: the session keeps its own model and effort/);
  });

  test("resume with an explicit model keeps it — asking is consent to switch", (t) => {
    const dir = configFixture({ "launch/claude-opus-4-8.md": page("model: claude-opus-4-8[1m]") });
    cleanup(t, dir);
    const out = render({ argv: ["--continue", "--model", "claude-opus-4-8"] }, { dir, env: {} });
    assert.equal(flag(out.argv, "--model"), "claude-opus-4-8[1m]");
  });

  test("the caller's own agent, agents or system-prompt flag suppresses everything, deny list included", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    for (const flagName of ["--agent", "--agents", "--system-prompt", "--system-prompt-file"]) {
      const out = render({ role: "worker", argv: [flagName, "x"] }, { dir, env: {} });
      assert.deepEqual(out.argv, [], flagName);
      assert.match(out.trace.join("\n"), new RegExp(`caller passed \\${flagName}`));
    }
  });

  test("the caller's own --effort is not re-emitted", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker", argv: ["--effort", "low"] }, { dir, env: {} });
    assert.equal(out.argv.filter((a) => a === "--effort").length, 0);
    assert.match(out.trace.join("\n"), /caller passed --effort/);
  });

  test("the caller's own --disallowedTools suppresses the fleet list only", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker", argv: ["--disallowedTools=Bash"] }, { dir, env: {} });
    assert.equal(out.argv.some((a) => a.startsWith("--disallowedTools")), false);
    assert.equal(flag(out.argv, "--agent"), "default.worker");
  });

  test("mcpServers names resolve through mcp/, gate by gate", (t) => {
    const dir = configFixture({
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]\nmcpServers: [ccc-statusd, shellkit]"),
      "mcp/ccc-statusd.md": server('["env:CCC_STATUSD_MCP_TOKEN"]', '{"type": "http", "url": "http://localhost:${CCC_STATUSD_MCP_PORT:-19223}/mcp", "headers": {"Authorization": "Bearer ${CCC_STATUSD_MCP_TOKEN}"}}'),
      "mcp/shellkit.md": server('["env:SHELLKIT_MCP_TOKEN"]', '{"type": "http", "url": "http://localhost:19222/mcp"}'),
    });
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: { CCC_STATUSD_MCP_TOKEN: "tok" } });
    assert.deepEqual(definitionOf(out)["default.worker"].mcpServers, [
      { "ccc-statusd": { type: "http", url: "http://localhost:19223/mcp", headers: { Authorization: "Bearer tok" } } },
    ]);
    assert.match(out.trace.join("\n"), /mcp shellkit: skipped — needs env:SHELLKIT_MCP_TOKEN/);
  });

  test("no page at all: nothing is emitted and the launch is plain", (t) => {
    const dir = fixture({ "fleet.md": FLEET, "launch/.keep": "" });
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: {} });
    assert.deepEqual(out.argv, []);
    assert.equal(out.model_matched, false);
    assert.match(out.warnings.join("\n"), /no launch page/);
  });

  test("a grammar refusal on the winning page degrades to a plain launch, naming the line", (t) => {
    const dir = configFixture({ "launch/default.worker.md": "---\nmodel: x\n  nested: true\n---\nbody\n" });
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: {} });
    assert.deepEqual(out.argv, []);
    assert.match(out.warnings.join("\n"), /default\.worker\.md:3/);
  });

  test("a page's own disallowedTools stays on the page; the fleet list is one flag", (t) => {
    const dir = configFixture({
      "launch/default.leader.md": page("model: claude-opus-5-5[1m]\ndisallowedTools: [AskUserQuestion]"),
    });
    cleanup(t, dir);
    const out = render({ role: "leader" }, { dir, env: {} });
    assert.deepEqual(definitionOf(out)["default.leader"].disallowedTools, ["AskUserQuestion"]);
    assert.equal(out.argv.filter((a) => a.startsWith("--disallowedTools")).length, 1);
    assert.equal(out.argv.includes(FLEET_FLAG), true);
    assert.equal(FLEET_DENY_KEY, "disallowedTools");
  });

  test("a role no page knows still launches, with a warning", (t) => {
    const dir = configFixture({ "launch/default.md": page("model: claude-opus-5-5[1m]") });
    cleanup(t, dir);
    const out = render({ role: "reviewer" }, { dir, env: {} });
    assert.equal(flag(out.argv, "--agent"), "default");
    assert.match(out.warnings.join("\n"), /role 'reviewer'/);
  });

  test("FABLE_SPENT is derived from the profile's ratelimit.json", (t) => {
    const future = String(Math.floor(Date.now() / 1000) + 3600);
    const past = String(Math.floor(Date.now() / 1000) - 3600);
    const rl = (extra) => JSON.stringify({ "7d_oi-reset": future, "7d_oi-status": "allowed", ...extra });
    const dir = configFixture(
      {
        "launch/claude-opus-5-5.worker.md": page("model: claude-opus-5-5[1m]\neffort: xhigh"),
        "launch/default.worker.md": page("model: claude-fable-5-1[1m]\neffort: medium"),
        "profiles/rejected/ratelimit.json": rl({ "7d_oi-status": "rejected" }),
        "profiles/spent/ratelimit.json": rl({ "7d_oi-utilization": "0.95" }),
        "profiles/warned/ratelimit.json": rl({ "7d_oi-status": "allowed_warning", "7d_oi-utilization": "0.5" }),
        "profiles/stale/ratelimit.json": JSON.stringify({ "7d_oi-reset": past, "7d_oi-status": "rejected" }),
        "profiles/broken/ratelimit.json": "{not json",
      },
      { "launch/FABLE_SPENT.worker.md": "claude-opus-5-5.worker.md" },
    );
    cleanup(t, dir);
    const env = { UCC_HOME: dir };
    const agent = (profile) => flag(render({ role: "worker", profile }, { dir, env }).argv, "--agent");

    const out = render({ role: "worker", profile: "rejected" }, { dir, env });
    assert.equal(flag(out.argv, "--agent"), "claude-opus-5-5.worker");
    assert.match(out.trace.join("\n"), /set FABLE_SPENT: ratelimit\.json 7d_oi-status=rejected/);
    assert.equal(agent("spent"), "claude-opus-5-5.worker");
    for (const quiet of ["warned", "stale", "broken", "absent"]) {
      const o = render({ role: "worker", profile: quiet }, { dir, env });
      assert.equal(flag(o.argv, "--agent"), "default.worker", quiet);
      assert.deepEqual(o.warnings, [], quiet);
      assert.doesNotMatch(o.trace.join("\n"), /FABLE_SPENT/, quiet);
    }
  });
});

// The two refusals are decided before any shortcut or degrade: a caller's own
// --system-prompt, a missing page and a malformed page each used to return
// success first, so the wrapper forwarded the incompatible model with exit 0.
describe("unit 4: the seal — lift, sealed deny, Fable print refusal", () => {
  const SEALED_FLAG = `${FLEET_FLAG},${SEALED_DENY.join(",")}`;
  const fablePages = { "launch/claude-fable-5-1.md": page("model: claude-fable-5-1[1m]\neffort: xhigh") };

  test("isFable: the alias and every claude-fable id, with or without [1m]", () => {
    for (const m of ["fable", "fable[1m]", "claude-fable-5-1", "claude-fable-5-1[1m]"]) assert.equal(isFable(m), true, m);
    for (const m of ["opus", "sonnet", "claude-opus-5-5[1m]", "claude-sonnet-5-5", "gpt-6-astra"]) assert.equal(isFable(m), false, m);
  });

  test("an explicit Opus or Sonnet model lifts: one --settings turning the force off and the fork on", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
      const out = render({ role: "worker", model }, { dir, env: {} });
      assert.equal(out.argv.filter((a) => a === "--settings").length, 1, model);
      assert.deepEqual(JSON.parse(flag(out.argv, "--settings")), {
        env: { CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "0", CLAUDE_CODE_FORK_SUBAGENT: "1" },
      });
      assert.equal(out.argv.includes(FLEET_FLAG), true, "a lifted seat keeps the fleet list alone");
      assert.match(out.trace.join("\n"), new RegExp(`lift: model ${model}\\[1m\\]`));
    }
  });

  test("the page's own non-Fable model lifts too", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: {} });
    assert.equal(flag(out.argv, "--settings"), LIFT_SETTINGS);
  });

  test("a Fable seat stays sealed: no --settings, the five fork denies in the one deny flag", (t) => {
    const dir = configFixture(fablePages);
    cleanup(t, dir);
    for (const ctx of [{ model: "claude-fable-5-1" }, { argv: ["--model", "fable"] }, {}]) {
      const d = ctx.model || ctx.argv ? dir : configFixture({ "launch/default.worker.md": page("model: claude-fable-5-1[1m]") });
      if (d !== dir) cleanup(t, d);
      const out = render({ role: "worker", ...ctx }, { dir: d, env: {} });
      assert.equal(out.argv.includes("--settings"), false);
      assert.equal(out.argv.filter((a) => a.startsWith("--disallowedTools")).length, 1);
      assert.equal(out.argv.includes(SEALED_FLAG), true);
      assert.match(out.trace.join("\n"), /sealed: model .*fable.* is Fable/);
    }
  });

  test("a resume that names no --model stays sealed; one that names it lifts", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const bare = render({ role: "worker", argv: ["--resume", "abc"] }, { dir, env: {} });
    assert.equal(bare.argv.includes("--settings"), false);
    assert.equal(bare.argv.includes(SEALED_FLAG), true);
    assert.match(bare.trace.join("\n"), /sealed: resume without --model/);
    const named = render({ role: "worker", argv: ["--resume", "abc", "--model", "claude-opus-5-5"] }, { dir, env: {} });
    assert.equal(flag(named.argv, "--settings"), LIFT_SETTINGS);
  });

  test("the caller's own --settings keeps the seal and gets the sealed deny", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker", model: "claude-opus-5-5", argv: ["--settings", "{}"] }, { dir, env: {} });
    assert.equal(out.argv.includes("--settings"), false);
    assert.equal(out.argv.includes(SEALED_FLAG), true);
    assert.match(out.trace.join("\n"), /caller passed --settings/);
    assert.match(out.trace.join("\n"), /sealed: caller passed --settings/);
  });

  test("the caller's own --disallowedTools replaces the fleet list, never the seal's fork denies", (t) => {
    const dir = configFixture(fablePages);
    cleanup(t, dir);
    const sealed = render({ role: "worker", model: "claude-fable-5-1", argv: ["--disallowedTools=WebFetch"] }, { dir, env: {} });
    assert.deepEqual(sealed.argv.filter((a) => a.startsWith("--disallowedTools")), [`--disallowedTools=${SEALED_DENY.join(",")}`]);
    const lifted = render({ role: "worker", model: "claude-opus-5-5", argv: ["--disallowed-tools", "WebFetch"] }, { dir, env: {} });
    assert.equal(lifted.argv.some((a) => a.startsWith("--disallowedTools")), false);
  });

  test("a pinned profile renders no model and stays sealed; an early return emits nothing", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const pinned = render({ role: "worker", profile: "codex" }, { dir, env: { ANTHROPIC_MODEL: "gpt-6-astra[1m]" } });
    assert.equal(pinned.argv.includes("--settings"), false);
    assert.match(pinned.trace.join("\n"), /sealed: no model/);
    assert.deepEqual(render({ role: "worker", model: "claude-opus-5-5", argv: ["--agents", "{}"] }, { dir, env: {} }).argv, []);
  });

  test("print mode on an explicit Fable model refuses, before every shortcut", (t) => {
    const dir = configFixture(fablePages);
    cleanup(t, dir);
    for (const argv of [["-p", "hi"], ["--print", "hi"], ["-p", "--system-prompt", "."], ["-p", "--model", "fable"]]) {
      const ctx = argv.includes("--model") ? { argv } : { model: "claude-fable-5-1", argv };
      assert.throws(() => render({ role: "worker", ...ctx }, { dir, env: {} }), (e) => {
        assert.ok(e instanceof Refusal, `expected a Refusal for ${argv.join(" ")}`);
        assert.equal(e.exitCode, 2);
        assert.match(e.message, /print mode on .*fable.*Fable runs only as a seat/);
        assert.match(e.message, /UCC_FABLE_PRINT=1/);
        return true;
      });
    }
  });

  test("print mode on the page's Fable model refuses; -p after -- is the user's text", (t) => {
    const dir = configFixture({ "launch/default.worker.md": page("model: claude-fable-5-1[1m]") });
    cleanup(t, dir);
    assert.throws(() => render({ role: "worker", argv: ["-p", "hi"] }, { dir, env: {} }), /print mode on claude-fable-5-1\[1m\] \(page default\.worker\.md\)/);
    const interactive = render({ role: "worker", argv: ["--", "-p"] }, { dir, env: {} });
    assert.equal(flag(interactive.argv, "--agent"), "default.worker");
  });

  test("UCC_FABLE_PRINT=1 in the seat env admits a Fable print run, sealed", (t) => {
    const dir = configFixture(fablePages);
    cleanup(t, dir);
    const out = render({ role: "worker", model: "claude-fable-5-1", argv: ["-p", "hi"] }, { dir, env: { UCC_FABLE_PRINT: "1" } });
    assert.equal(flag(out.argv, "--model"), "claude-fable-5-1[1m]");
    assert.equal(out.argv.includes(SEALED_FLAG), true);
  });

  test("print mode on Opus renders and lifts", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const out = render({ role: "worker", model: "claude-opus-5-5", argv: ["-p", "hi"] }, { dir, env: {} });
    assert.equal(flag(out.argv, "--settings"), LIFT_SETTINGS);
  });
});

describe("unit 4: refusals come before every shortcut", () => {
  const pinned = { ANTHROPIC_MODEL: "gpt-6-astra[1m]" };
  const mismatch = ["--model", "claude-opus-5-5"];
  const refuses = (ctx, world, re) =>
    assert.throws(() => render(ctx, world), (e) => {
      assert.ok(e instanceof Refusal, `expected a Refusal, got ${e}`);
      assert.match(e.message, re);
      return true;
    });

  test("the caller's own --system-prompt does not hide a pin mismatch", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    refuses({ role: "worker", profile: "codex", argv: [...mismatch, "--system-prompt", "."] }, { dir, env: pinned }, /cannot be served/);
  });

  test("the caller's own --system-prompt does not hide an unknown kind", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    refuses({ role: "worker", argv: ["--launch", "nope", "--system-prompt", "."] }, { dir, env: {} }, /no launch kind 'nope'/);
  });

  test("a malformed winning page does not hide a pin mismatch", (t) => {
    const dir = configFixture({ "launch/default.worker.md": "---\nmodel: x\n  nested: true\n---\nbody\n" });
    cleanup(t, dir);
    refuses({ role: "worker", profile: "codex", argv: mismatch }, { dir, env: pinned }, /cannot be served/);
  });

  test("a missing page does not hide a pin mismatch", (t) => {
    const dir = fixture({ "fleet.md": FLEET, "launch/.keep": "" });
    cleanup(t, dir);
    refuses({ role: "worker", profile: "codex", argv: mismatch }, { dir, env: pinned }, /cannot be served/);
  });

  test("a second render of already-rendered argv emits nothing and refuses nothing", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const ctx = { role: "worker", profile: "codex", argv: ["--model", "gpt-6-astra", "-p", "hi"] };
    const first = render(ctx, { dir, env: pinned });
    assert.equal(flag(first.argv, "--agent"), "default.worker");
    // model_matched is false under the pin, so the wrapper keeps its own --model
    const second = render({ ...ctx, argv: [...first.argv, ...ctx.argv] }, { dir, env: pinned });
    assert.deepEqual(second.argv, []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit 5 — explain and check
// ═══════════════════════════════════════════════════════════════════════════

const LAUNCHER = fileURLToPath(new URL("./launch.mjs", import.meta.url));

/** The first executable of this name on PATH, or null (a runtime this host
 *  does not have skips its half of the parity gate rather than failing it). */
function whichBin(name) {
  for (const d of (process.env.PATH ?? "").split(delimiter)) {
    if (d === "") continue;
    const p = join(d, name);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The CLI writes plugin dirs under $UCC_HOME: a caller that names none gets
 *  a throwaway home, never the real one. */
function runLauncher(bin, args, env = {}) {
  const scratch = env.UCC_HOME === undefined ? mkdtempSync(join(tmpdir(), "launch-home-")) : undefined;
  const home = scratch === undefined ? {} : { UCC_HOME: scratch };
  try {
    return {
      code: 0,
      out: execFileSync(bin, [LAUNCHER, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...home, ...env } }),
    };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? ""), err: String(e.stderr ?? "") };
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}

/** A tree `check` is meant to like. */
function goodTree() {
  return fixture(
    {
      "fleet.md": FLEET,
      "launch/claude-opus-5-5.worker.md": page("model: claude-opus-5-5[1m]\neffort: xhigh\nmcpServers: [ccc-statusd]"),
      "launch/heartbeat.md": page("model: claude-sonnet-5[1m]\neffort: medium\ntools: [Bash, Read]"),
      "mcp/ccc-statusd.md": server('["env:CCC_STATUSD_MCP_TOKEN"]', '{"type": "http", "url": "http://localhost:1/mcp"}'),
    },
    { "launch/default.worker.md": "claude-opus-5-5.worker.md" },
  );
}

describe("unit 5: check", () => {
  test("green on a whole tree, and on a tree with no launch/ yet", (t) => {
    const dir = goodTree();
    cleanup(t, dir);
    const got = checkTree(dir, {});
    assert.deepEqual(got.errors, [], got.errors.join("\n"));
    // bytes are always priced; tokens only when a daemon is on PATH (none here)
    assert.deepEqual(
      got.notes.map((n) => n.replace(/\d+ bytes/, "N bytes")).sort(),
      ["launch/claude-opus-5-5.worker.md: N bytes", "launch/heartbeat.md: N bytes"],
    );

    const bare = fixture({ "fleet.md": FLEET });
    cleanup(t, bare);
    const empty = checkTree(bare, {});
    assert.deepEqual(empty.errors, []);
    assert.match(empty.warnings.join("\n"), /launch\//);
  });

  const broken = [
    {
      why: "a nested map",
      files: { "launch/default.md": "---\nmodel: claude-opus-5-5[1m]\n  deny: [WebSearch]\n---\nbody\n" },
      match: /default\.md:3: indented line/,
    },
    {
      why: "an unreachable name",
      files: { "launch/claude-opus-5-5.Advisor.md": page("model: claude-opus-5-5[1m]") },
      match: /claude-opus-5-5\.Advisor\.md: .*no ladder ever builds/,
    },
    {
      why: "a claude model with no [1m]",
      files: { "launch/default.md": page("model: claude-opus-5-5") },
      match: /default\.md: model 'claude-opus-5-5' is a claude id without \[1m\]/,
    },
  ];

  for (const c of broken) {
    test(`red on ${c.why}, with its own message`, (t) => {
      const dir = fixture({ "fleet.md": FLEET, ...c.files });
      cleanup(t, dir);
      const got = checkTree(dir, {});
      assert.equal(got.errors.length, 1, got.errors.join("\n"));
      assert.match(got.errors[0], c.match);
    });
  }

  test("fleet.md with a second key is red", (t) => {
    const dir = fixture({ "fleet.md": "---\ndisallowedTools: [TaskOutput]\nmodel: claude-opus-5-5[1m]\n---\nb\n" });
    cleanup(t, dir);
    assert.match(checkTree(dir, {}).errors.join("\n"), /fleet\.md carries 'model'/);
  });

  test("an mcpServers name with no file, an empty body, and a link out of launch/", (t) => {
    const dir = fixture({
      "fleet.md": FLEET,
      "launch/default.md": page("model: claude-opus-5-5[1m]\nmcpServers: [nope]"),
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]", ""),
      "outside/evil.md": page("model: claude-opus-5-5[1m]"),
    });
    cleanup(t, dir);
    symlinkSync("../outside/evil.md", join(dir, "launch", "default.leader.md"));
    const errors = checkTree(dir, {}).errors.join("\n");
    assert.match(errors, /mcp\/nope\.md/);
    assert.match(errors, /default\.worker\.md: empty body/);
    assert.match(errors, /default\.leader\.md: resolves outside launch\//);
  });

  // A link's target is checked wherever it lives: a subdirectory or a dotfile
  // inside launch/ is never a top-level entry, so "the target is checked as its
  // own entry" once certified a broken page that every launch through the link
  // then rendered.
  test("every resolved real target is checked once, named by its real path", (t) => {
    const dir = fixture(
      {
        "fleet.md": FLEET,
        "launch/.hidden/body.md": page("model: claude-opus-5-5\ntools: [Bash]"),
        "launch/claude-opus-5-5.md": page("model: claude-opus-5-5"),
      },
      {
        "launch/default.md": ".hidden/body.md",
        "launch/FABLE_SPENT.md": ".hidden/body.md",
        "launch/claude-opus.md": "claude-opus-5-5.md",
      },
    );
    cleanup(t, dir);
    const got = checkTree(dir, {});
    assert.deepEqual(
      got.errors.map((e) => e.slice(0, e.indexOf(":", 8))).sort(),
      ["launch/.hidden/body.md", "launch/claude-opus-5-5.md"],
      got.errors.join("\n"),
    );
  });

  test("a link whose role suffix differs from its target's is red", (t) => {
    const dir = fixture(
      { "fleet.md": FLEET, "launch/claude-fable.worker.md": page("model: claude-fable-5-1[1m]") },
      { "launch/@codex.leader.md": "claude-fable.worker.md", "launch/@codex.worker.md": "claude-fable.worker.md", "launch/default.md": "claude-fable.worker.md" },
    );
    cleanup(t, dir);
    const got = checkTree(dir, {});
    assert.deepEqual(
      got.errors.map((e) => e.slice(0, e.indexOf(":"))).sort(),
      ["launch/@codex.leader.md → claude-fable.worker.md", "launch/default.md → claude-fable.worker.md"],
      got.errors.join("\n"),
    );
    assert.match(got.errors[0], /leader.*worker/);
  });

  test("a definition above 128 KB warns; a page carrying name is red", (t) => {
    const dir = fixture({
      "fleet.md": FLEET,
      "launch/default.md": page("model: claude-opus-5-5[1m]", "x".repeat(129 * 1024)),
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]", "x".repeat(120 * 1024)),
      "launch/heartbeat.md": page('name: heartbeat\nmodel: claude-opus-5-5[1m]'),
    });
    cleanup(t, dir);
    const got = checkTree(dir, {});
    assert.equal(got.warnings.length, 1, got.warnings.join("\n"));
    assert.match(got.warnings[0], /default\.md: the definition is \d+ KB — above the 128 KB/);
    assert.match(got.errors.join("\n"), /heartbeat\.md carries 'name'/);
  });

  test("check is green on the shipped tree", () => {
    const got = checkTree(fileURLToPath(new URL(".", import.meta.url)), {});
    assert.deepEqual(got.errors, [], got.errors.join("\n"));
  });
});

describe("unit 5: explain", () => {
  test("ticks the hit, shows the resolved path, the rules and the render JSON", (t) => {
    const dir = goodTree();
    cleanup(t, dir);
    const text = explain({ role: "worker", model: "claude-opus-5-5" }, { dir, env: {} });
    assert.match(text, /✓ claude-opus-5-5\.worker\.md/);
    assert.match(text, /claude-opus-5-5\.md/);
    assert.match(text, /--agent/);
    const json = JSON.parse(text.slice(text.indexOf("{")));
    assert.equal(json.model_matched, true);
    assert.deepEqual(Object.keys(json), ["argv", "model_matched", "trace", "warnings"]);
  });

  test("--launch explains only the rungs it tries", (t) => {
    const dir = goodTree();
    cleanup(t, dir);
    const text = explain({ kind: "heartbeat", role: "worker" }, { dir, env: {} });
    assert.match(text, /✗ heartbeat\.worker\.md\n  ✓ heartbeat\.md\n\nrules/);
    assert.doesNotMatch(text, /default\.worker\.md/);
  });

  test("an unknown kind refuses instead of explaining", (t) => {
    const dir = goodTree();
    cleanup(t, dir);
    assert.throws(() => explain({ kind: "nope" }, { dir, env: {} }), Refusal);
  });
});

describe("unit 5: the seat's environment", () => {
  test("the profile's .env reads as bash would, and the identity keys come from it alone", (t) => {
    const dir = fixture({
      "profiles/codex/.env": [
        "# the endpoint",
        'export ANTHROPIC_MODEL="gpt-6-astra[1m]"',
        "ANTHROPIC_BASE_URL='https://x/$NOT_EXPANDED'",
        "TOKEN=abc",
        "DERIVED=${TOKEN}-$HOME",
        "",
      ].join("\n"),
    });
    cleanup(t, dir);
    const spawner = { UCC_HOME: dir, HOME: "/h", ANTHROPIC_MODEL: "foreign[1m]", ANTHROPIC_API_KEY: "spawner-key", PATH: "/bin" };
    assert.deepEqual(seatEnv("codex", spawner), {
      UCC_HOME: dir,
      HOME: "/h",
      PATH: "/bin",
      ANTHROPIC_MODEL: "gpt-6-astra[1m]",
      ANTHROPIC_BASE_URL: "https://x/$NOT_EXPANDED",
      TOKEN: "abc",
      DERIVED: "abc-/h",
    });
    // no profile, or a profile whose .env sets no identity: a claude seat
    assert.deepEqual(seatEnv(undefined, spawner), { UCC_HOME: dir, HOME: "/h", PATH: "/bin" });
    assert.deepEqual(seatEnv("absent", spawner), { UCC_HOME: dir, HOME: "/h", PATH: "/bin" });
  });
});

describe("unit 5: the CLI", () => {
  test("render prints the output contract and exits 0", (t) => {
    const dir = goodTree();
    cleanup(t, dir);
    const got = runLauncher(process.execPath, [`{"role":"worker"}`, "--dir", dir]);
    assert.equal(got.code, 0);
    const out = JSON.parse(got.out);
    assert.equal(out.argv[out.argv.indexOf("--agent") + 1], "ucc-launch:claude-opus-5-5.worker");
    assert.equal(out.argv.includes("--agents"), false);
    assert.equal(out.model_matched, false);
  });

  test("an unknown --launch kind exits 2 with R10's message", (t) => {
    const dir = goodTree();
    cleanup(t, dir);
    const got = runLauncher(process.execPath, [`{"role":"worker","launch":"nope"}`, "--dir", dir]);
    assert.equal(got.code, 2);
    assert.equal(got.err.trim(), "launch-config: no launch kind 'nope' in $UCC_HOME/config/launch/");
  });

  test("check exits non-zero on a broken tree", (t) => {
    const dir = fixture({ "fleet.md": FLEET, "launch/default.md": page("model: claude-opus-5-5") });
    cleanup(t, dir);
    const got = runLauncher(process.execPath, ["check", "--dir", dir]);
    assert.equal(got.code, 1);
    assert.match(got.out + got.err, /\[1m\]/);
  });

  // A config directory reached through a symlinked ANCESTOR is the normal case,
  // not an exotic one: on macOS $TMPDIR lives under /var, which is a link to
  // /private/var. `check` once read "is this entry a symlink?" as
  // `realpath !== joinpath`, which every page satisfies under such a path — so
  // it skipped all of them as "already checked via their target" and pronounced
  // a tree carrying a real error good, exit 0. A validator that silently sees
  // nothing is worse than no validator, so this tree is reached only by a link.
  test("check still sees a broken tree reached through a symlinked ancestor", (t) => {
    const dir = fixture({ "fleet.md": FLEET, "launch/default.md": page("model: claude-opus-5-5") });
    cleanup(t, dir);
    const outer = mkdtempSync(join(tmpdir(), "launch-cfg-via-"));
    cleanup(t, outer);
    const via = join(outer, "via");
    symlinkSync(dir, via);

    const got = runLauncher(process.execPath, ["check", "--dir", via]);
    assert.equal(got.code, 1, `check went green through a symlinked ancestor: ${got.out}${got.err}`);
    assert.match(got.out + got.err, /\[1m\]/);
  });

  // A pre-render from ccc-tmux runs in the SPAWNER's shell. Its pin must not
  // route the seat: from a codex seat, a claude worker spawn once booted on
  // the harness default model, silently, and one with --model was refused.
  test("the spawner's own pin does not reach a seat whose profile sets none", (t) => {
    const dir = goodTree();
    cleanup(t, dir);
    mkdirSync(join(dir, "profiles", "claude_seat"), { recursive: true });
    writeFileSync(join(dir, "profiles", "claude_seat", ".env"), "TOKEN=x\n");
    const env = { UCC_HOME: dir, ANTHROPIC_MODEL: "gpt-6-astra[1m]", ANTHROPIC_BASE_URL: "http://127.0.0.1:8765" };
    for (const ctx of [`{"role":"worker","profile":"claude_seat"}`, `{"role":"worker"}`]) {
      const got = runLauncher(process.execPath, [ctx, "--dir", dir], env);
      assert.equal(got.code, 0, got.err);
      const out = JSON.parse(got.out);
      assert.doesNotMatch(out.trace.join("\n"), /pin:|foreign endpoint/, ctx);
      assert.equal(definitionOf(out)["claude-opus-5-5.worker"].model, "claude-opus-5-5[1m]", ctx);
    }
  });

  test("node and bun print byte-identical explain output", (t) => {
    const node = whichBin("node");
    const bun = whichBin("bun");
    if (!node || !bun) {
      t.skip(`both runtimes are needed (node=${node}, bun=${bun})`);
      return;
    }
    const dir = goodTree();
    cleanup(t, dir);
    const args = ["explain", "--dir", dir, "--role", "worker", "--profile", "does_bannock_6u"];
    const a = runLauncher(node, args, { UCC_HOME: dir });
    const b = runLauncher(bun, args, { UCC_HOME: dir });
    assert.equal(a.code, 0, a.err);
    assert.equal(b.code, 0, b.err);
    assert.equal(a.out, b.out);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit 6 — the plugin dir: the definition on disk, the argv naming it
// ═══════════════════════════════════════════════════════════════════════════

describe("unit 6: the plugin dir", () => {
  const withServer = () =>
    configFixture({
      "launch/default.worker.md": page("model: claude-opus-5-5[1m]\neffort: xhigh\nmcpServers: [one]\ntools: [Bash, Read]", "You are a worker.\n"),
      "mcp/one.md": server("[]", '{"type": "http", "url": "http://x/mcp"}'),
    });

  test("the definition goes to a plugin dir; argv carries its path, the agent and the server file", (t) => {
    const dir = withServer();
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: {}, pluginRoot: join(dir, "plugins") });
    const root = flag(out.argv, "--plugin-dir");
    assert.match(root, new RegExp(`^${join(dir, "plugins")}/[0-9a-f]{12}$`));
    assert.deepEqual(out.argv, [
      "--plugin-dir",
      root,
      "--agent",
      "ucc-launch:default.worker",
      `--mcp-config=${join(root, "servers.json")}`,
      "--effort",
      "xhigh",
      "--settings",
      LIFT_SETTINGS,
      FLEET_FLAG,
    ]);
    assert.deepEqual(definitionOf(out)["default.worker"], {
      description: "launch page default.worker",
      tools: ["Bash", "Read"],
      model: "claude-opus-5-5[1m]",
      prompt: "You are a worker.\n",
      mcpServers: [{ one: { type: "http", url: "http://x/mcp" } }],
    });
    assert.equal(JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8")).name, "ucc-launch");
    assert.equal(statSync(join(root, "servers.json")).mode & 0o777, 0o600);
    assert.equal(statSync(root).mode & 0o777, 0o700);
  });

  test("identical renders share one dir; a changed page gets its own", (t) => {
    const dir = withServer();
    cleanup(t, dir);
    const world = { dir, env: {}, pluginRoot: join(dir, "plugins") };
    const first = flag(render({ role: "worker" }, world).argv, "--plugin-dir");
    assert.equal(flag(render({ role: "worker" }, world).argv, "--plugin-dir"), first);
    writeFileSync(join(dir, "launch", "default.worker.md"), page("model: claude-opus-5-5[1m]", "You are another worker.\n"));
    const changed = render({ role: "worker" }, world);
    assert.notEqual(flag(changed.argv, "--plugin-dir"), first);
    assert.equal(changed.argv.some((a) => a.startsWith("--mcp-config")), false);
  });

  test("a root that cannot be written falls back to the argv JSON form", (t) => {
    const dir = configFixture({ blocker: "a file, not a dir" });
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: {}, pluginRoot: join(dir, "blocker") });
    assert.equal(flag(out.argv, "--agent"), "default.worker");
    assert.equal(definitionOf(out)["default.worker"].prompt, "You are a worker.\n");
    assert.match(out.trace.join("\n"), /argv fallback: .*could not be written/);
  });

  test("a key a plugin agent ignores keeps the argv JSON form", (t) => {
    const dir = configFixture({ "launch/default.worker.md": page("permissionMode: plan") });
    cleanup(t, dir);
    const out = render({ role: "worker" }, { dir, env: {}, pluginRoot: join(dir, "plugins") });
    assert.equal(definitionOf(out)["default.worker"].permissionMode, "plan");
    assert.match(out.trace.join("\n"), /argv fallback: a plugin agent ignores permissionMode/);
    assert.equal(existsSync(join(dir, "plugins")), false);
  });

  test("a render sweeps sibling dirs unused past the TTL and keeps fresh ones", (t) => {
    const dir = configFixture();
    cleanup(t, dir);
    const root = join(dir, "plugins");
    for (const name of ["old", "fresh"]) mkdirSync(join(root, name), { recursive: true });
    const stale = (Date.now() - PLUGIN_TTL_MS - 60_000) / 1000;
    utimesSync(join(root, "old"), stale, stale);
    render({ role: "worker" }, { dir, env: {}, pluginRoot: root });
    assert.equal(existsSync(join(root, "old")), false);
    assert.equal(existsSync(join(root, "fresh")), true);
  });
});
