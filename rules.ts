// ═══════════════════════════════════════════════════════════════════════════
// rules.ts — THE launch config. Pure data. This is the file you edit.
//
// Five tables, read top to bottom:
//
//   defaults          what every launch starts with
//   arms              a model + the system prompt that belongs to it
//   pools             named sets of ucc profiles (members live in a LOCAL file)
//   routes            THE ROUTER — first match wins, and it picks the arm
//   layers            additive config — every match applies, in order
//
// Nothing in this file runs. No fs, no process.env, no conditionals. A rule
// states WHEN it applies and WHAT it wants; launch.ts answers the when (from
// the real machine) and emits the what. That split is the whole point: any
// combination can be rendered without launching anything.
//
//   bun launch.ts explain --role leader --profile dewiest_gulp
//   bun launch.ts matrix
//   bun launch.ts matrix --html /tmp/launch-matrix.html
//
// Precedence, always these three steps in this order:
//   1. defaults   2. the arm the router picked   3. matching layers, in order
// Scalars: last writer wins. Lists (skills, append, mcp, tools): accumulate.
// A flag the caller already passed on the command line is never overridden.
//
// THIS FILE SHIPS IN THE UCC PACKAGE. It is installed to $UCC_HOME/config/ on
// every machine, so nothing user- or machine-specific may appear here — no
// profile names that belong to one account, no absolute paths outside
// $UCC_HOME. Per-user state lives in pools.local.json (see § pools).
// ═══════════════════════════════════════════════════════════════════════════

export type Append = { file: string } | { text: string };

/** An mcp config: a path to a JSON file, or the config object itself.
 *  Objects are serialized by the engine, so an interpolated value can never
 *  break out of its string — never hand-write mcp JSON as a string. */
export type Mcp = string | Record<string, unknown>;

/** A model and the system prompt that belongs with it. */
export type Arm = {
  model: string;
  /** replaces the harness base system prompt (repo-relative or ~) */
  prompt?: string;
  effort?: string;
  /** this endpoint speaks only this id — ignore an explicitly requested model */
  pin?: boolean;
};

/**
 * What a rule matches on. Every field present must match (AND).
 *
 *   profile  exact ucc profile name(s)
 *   pool     profile is a member of this named pool
 *   role     advisor | leader | worker
 *   cwd      "/abs/path" or "~/path" → cwd is that dir or below it;
 *            a bare word → substring of the cwd
 *   model    the requested model, exact; a trailing * matches a prefix
 *   noModel  true → only when the caller passed no model at all
 *
 * "*" as a value means "this field is present, whatever its value".
 */
export type When = {
  profile?: string | string[];
  pool?: string | string[];
  role?: string | string[];
  cwd?: string | string[];
  model?: string | string[];
  noModel?: boolean;
};

/** A router entry. First match wins; it names the arm. */
export type Route = {
  when: When;
  /** arm name; a list means "pick one" (matrix renders every candidate) */
  use: string | string[];
  why?: string;
};

/**
 * An additive config entry. Applies when `when` matches the launch AND every
 * `requires` probe holds on the real machine.
 *
 * Probes — "env:NAME" (set and non-empty) · "env:NAME~text" (contains text) ·
 * "file:PATH" · "exec:PATH" (exists and executable) · "bin:NAME" (on PATH).
 * Prefix with ! to negate. " | " inside one string is OR; separate strings AND.
 *
 * Strings interpolate ${role} ${profile} ${cwd} ${model} and ${ENV_VAR}.
 * ${A|B} takes the first non-empty; ${A:-text} falls back to a literal.
 */
export type Layer = {
  when?: When;
  requires?: string[];
  /** replaces the harness base system prompt */
  systemPrompt?: string;
  /** appended to the system prompt, in order */
  append?: Append[];
  mcp?: Mcp[];
  /** the built-in tool set → --tools= ("" disables all, "default" for all) */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  /** --exclude-dynamic-system-prompt-sections; the harness ignores it when a
   *  system prompt replacement is in play, so launch.ts warns and drops it */
  excludeDynamicSections?: boolean;
  effort?: string;
  verbose?: boolean;
  /** escape hatch — emitted verbatim at the end */
  args?: string[];
  why?: string;
};

// ─── defaults ───────────────────────────────────────────────────────────────

export const defaults: Layer = {
  effort: "xhigh",
  verbose: false,
  /** the fleet-wide disable list — every launch drops these. Add a name here
   *  to take a built-in tool away from every agent on every profile. */
  disallowedTools: ["TaskOutput"],
  why: "base",
};

// ─── arms ───────────────────────────────────────────────────────────────────
// A model never travels alone — it carries the system prompt written for it.
//
// EVERY claude id carries the [1m] postfix. Without it the session reports a
// 200k context window. The router strips the postfix before matching, so a
// route says `claude-opus-5` and both spellings reach it.

// A role gets a WHOLE prompt, not an overlay — one file per case, written
// somewhere else and only pointed at from here. So an arm is a (model, prompt)
// pair, and there is one arm per case. It is a long table on purpose: every
// launch this fleet can produce is a row you can read, and nothing is assembled
// at render time.

export const arms: Record<string, Arm> = {
  // ── the fleet default ──
  "opus-5": { model: "claude-opus-5[1m]", prompt: "prompts/opus-5-stance.md", effort: "medium" },
  "opus-5:advisor": { model: "claude-opus-5[1m]", prompt: "prompts/opus-5-stance.advisor.md", effort: "medium" },
  "opus-5:leader": { model: "claude-opus-5[1m]", prompt: "prompts/opus-5-stance.leader.md", effort: "medium" },
  "opus-5:worker": { model: "claude-opus-5[1m]", prompt: "prompts/opus-5-stance.worker.md", effort: "medium" },

  // ── advisors stay here: the armed, battle-tested arm ──
  fable: { model: "claude-fable-5[1m]", prompt: "prompts/fable-5-calibration.md" },
  "fable:advisor": { model: "claude-fable-5[1m]", prompt: "prompts/fable-5-calibration.advisor.md" },
  "fable:leader": { model: "claude-fable-5[1m]", prompt: "prompts/fable-5-calibration.leader.md" },
  "fable:worker": { model: "claude-fable-5[1m]", prompt: "prompts/fable-5-calibration.worker.md" },

  // ── reached only by an explicit --model ──
  "opus-4-8": { model: "claude-opus-4-8[1m]", prompt: "prompts/opus-4-operator.md" },

  // ── endpoints that speak their own model ids, and have no claude-opus-5.
  //    They pin: an explicitly requested claude id would be rejected upstream.
  //    They run the fable prompts — same files, different model. ──
  "gpt-5.6-sol": { model: "gpt-5.6-sol[1m]", prompt: "prompts/fable-5-calibration.md", effort: "xhigh", pin: true },
  "gpt-5.6-sol:advisor": { model: "gpt-5.6-sol[1m]", prompt: "prompts/fable-5-calibration.advisor.md", effort: "xhigh", pin: true },
  "gpt-5.6-sol:leader": { model: "gpt-5.6-sol[1m]", prompt: "prompts/fable-5-calibration.leader.md", effort: "xhigh", pin: true },
  "gpt-5.6-sol:worker": { model: "gpt-5.6-sol[1m]", prompt: "prompts/fable-5-calibration.worker.md", effort: "xhigh", pin: true },

  k3: { model: "k3[1m]", prompt: "prompts/fable-5-calibration.md", effort: "xhigh", pin: true },
  "k3:advisor": { model: "k3[1m]", prompt: "prompts/fable-5-calibration.advisor.md", effort: "xhigh", pin: true },
  "k3:leader": { model: "k3[1m]", prompt: "prompts/fable-5-calibration.leader.md", effort: "xhigh", pin: true },
  "k3:worker": { model: "k3[1m]", prompt: "prompts/fable-5-calibration.worker.md", effort: "xhigh", pin: true },

  "grok-4.5": { model: "grok-4.5[1m]", prompt: "prompts/fable-5-calibration.md", effort: "xhigh", pin: true },
  "grok-4.5:advisor": { model: "grok-4.5[1m]", prompt: "prompts/fable-5-calibration.advisor.md", effort: "xhigh", pin: true },
  "grok-4.5:leader": { model: "grok-4.5[1m]", prompt: "prompts/fable-5-calibration.leader.md", effort: "xhigh", pin: true },
  "grok-4.5:worker": { model: "grok-4.5[1m]", prompt: "prompts/fable-5-calibration.worker.md", effort: "xhigh", pin: true },

  "deepseek-v4-flash:cloud": { model: "deepseek-v4-flash:cloud[1m]", prompt: "prompts/fable-5-calibration.md", effort: "max", pin: true },
  "deepseek-v4-flash:cloud:advisor": { model: "deepseek-v4-flash:cloud[1m]", prompt: "prompts/fable-5-calibration.advisor.md", effort: "max", pin: true },
  "deepseek-v4-flash:cloud:leader": { model: "deepseek-v4-flash:cloud[1m]", prompt: "prompts/fable-5-calibration.leader.md", effort: "max", pin: true },
  "deepseek-v4-flash:cloud:worker": { model: "deepseek-v4-flash:cloud[1m]", prompt: "prompts/fable-5-calibration.worker.md", effort: "max", pin: true },
};

// ─── third-party endpoints ──────────────────────────────────────────────────
// A profile that sets ANTHROPIC_BASE_URL points at someone else's API, which
// serves its own models — a claude id means nothing there. When this probe
// holds we emit NO --model at all, and the profile's own ANTHROPIC_MODEL
// applies. That is ~27 of the installed profiles (zenmux, vol, glm, minimax,
// deepseek …), none of which are named in the routes below — deepseek-ollama
// is the one exception, routed below because its endpoint serves a known id.
//
// A `pin`ned arm is the exception: pinning states that we DO know this
// endpoint's model id. codex depends on it — its .env sets no ANTHROPIC_MODEL,
// so dropping ours would leave it with no model at all.

export const ENDPOINT_SERVES_ITS_OWN_MODEL = "env:ANTHROPIC_BASE_URL";

// ─── pools ──────────────────────────────────────────────────────────────────
// Named sets of ucc profiles. A route matches a pool instead of listing
// profiles inline, so one account moves between fleets by moving one line.
//
// MEMBERS ARE PER-USER, so they do NOT live in this shipped file. The engine
// merges members from `pools.local.json` next to this file — plain JSON,
// written by hand or by tooling, never touched by the installer:
//
//   { "FABLE_SPENT": ["some_profile_3x"] }
//
// This table only DECLARES the pools routes may name (a route naming a pool
// that exists nowhere is a typo and fails loud).

export const pools: Record<string, string[]> = {
  /** accounts whose fable quota is spent or unavailable — the account may
   *  still have credit, but fable is metered separately, so these never
   *  route to the fable arm. Members: pools.local.json. */
  FABLE_SPENT: [],
};

// ─── routes ─────────────────────────────────────────────────────────────────
// THE ROUTER. Read top to bottom; the FIRST match wins and names the arm.
//
// Reading order, and why it is this order:
//   1. endpoint profiles — their API has no claude model at all, so they win
//      over everything, including an explicitly requested one
//   2. an explicitly requested model — exact id first, then the variant
//      catch-alls, so a new claude-opus-5 spelling still gets its prompt
//   3. advisor — the one role that stays on fable
//   4. everything else — claude-opus-5, the default
//
// An explicitly requested model is emitted as asked (normalized to [1m]); the
// arm it matches then supplies only the prompt and the effort. A launch that
// requested nothing takes the arm's model too.

export const routes: Route[] = [
  // 1. endpoint profiles — role first, then the roleless launch
  { when: { profile: "codex", role: "advisor" }, use: "gpt-5.6-sol:advisor" },
  { when: { profile: "codex", role: "leader" }, use: "gpt-5.6-sol:leader" },
  { when: { profile: "codex", role: "worker" }, use: "gpt-5.6-sol:worker" },
  { when: { profile: "codex" }, use: "gpt-5.6-sol", why: "codex endpoint" },

  { when: { profile: "kimi-k3-moonshot", role: "advisor" }, use: "k3:advisor" },
  { when: { profile: "kimi-k3-moonshot", role: "leader" }, use: "k3:leader" },
  { when: { profile: "kimi-k3-moonshot", role: "worker" }, use: "k3:worker" },
  { when: { profile: "kimi-k3-moonshot" }, use: "k3", why: "moonshot endpoint" },

  { when: { profile: "grok", role: "advisor" }, use: "grok-4.5:advisor" },
  { when: { profile: "grok", role: "leader" }, use: "grok-4.5:leader" },
  { when: { profile: "grok", role: "worker" }, use: "grok-4.5:worker" },
  { when: { profile: "grok" }, use: "grok-4.5", why: "grok endpoint" },

  { when: { profile: "deepseek-ollama", role: "advisor" }, use: "deepseek-v4-flash:cloud:advisor" },
  { when: { profile: "deepseek-ollama", role: "leader" }, use: "deepseek-v4-flash:cloud:leader" },
  { when: { profile: "deepseek-ollama", role: "worker" }, use: "deepseek-v4-flash:cloud:worker" },
  { when: { profile: "deepseek-ollama" }, use: "deepseek-v4-flash:cloud", why: "ollama endpoint" },

  // 2. the caller named a model. An effort suffix (-low … -max) and the [1m]
  //    postfix are both stripped before these are matched. Role first: asking
  //    for a model must not cost an agent its role prompt.
  { when: { model: "claude-opus-5", role: "advisor" }, use: "opus-5:advisor" },
  { when: { model: "claude-opus-5", role: "leader" }, use: "opus-5:leader" },
  { when: { model: "claude-opus-5", role: "worker" }, use: "opus-5:worker" },
  { when: { model: "claude-opus-5" }, use: "opus-5" },

  { when: { model: "claude-fable-5", role: "advisor" }, use: "fable:advisor" },
  { when: { model: "claude-fable-5", role: "leader" }, use: "fable:leader" },
  { when: { model: "claude-fable-5", role: "worker" }, use: "fable:worker" },
  { when: { model: "claude-fable-5" }, use: "fable" },

  { when: { model: "claude-opus-4-8" }, use: "opus-4-8", why: "no role prompts for this arm" },
  //    variant catch-alls — an unlisted claude spelling still gets a prompt
  //    rather than silently launching on the harness default
  { when: { model: "claude-opus-5*" }, use: "opus-5", why: "opus-5 variant" },
  { when: { model: "claude-fable-*" }, use: "fable", why: "fable variant" },
  { when: { model: "claude-opus-*" }, use: "opus-4-8", why: "older opus variant" },
  //    anything else named passes through as a real id, no prompt arm.

  // 3. advisors keep fable — except where its quota is spent.
  { when: { noModel: true, role: "advisor", pool: "FABLE_SPENT" }, use: "opus-5:advisor", why: "fable quota spent" },
  { when: { noModel: true, role: "advisor" }, use: "fable:advisor", why: "advisors stay on fable" },

  // 4. the default: everything else runs claude-opus-5.
  { when: { noModel: true, role: "leader" }, use: "opus-5:leader" },
  { when: { noModel: true, role: "worker" }, use: "opus-5:worker" },
  { when: { noModel: true }, use: "opus-5", why: "fleet default, no role" },
];

// ─── layers ─────────────────────────────────────────────────────────────────
// Additive config. Every layer whose `when` matches and whose `requires` hold
// applies, in this order.
//
// The engine owns ALL launch config — the bash wrappers inject nothing. The
// old shared-SYSTEM_PROMPT.md convention is gone: a launch's whole prompt is
// its arm's file, and these layers add only functional config (mcp servers).

export const layers: Layer[] = [
  {
    why: "workers/leaders launch without AskUserQuestion",
    when: { role: ["worker", "leader"] },
    disallowedTools: ["AskUserQuestion"],
  },
  {
    why: "shared mcp servers (tolaria, shellkit)",
    requires: ["file:~/.local/share/ucc/shared/.mcp.json"],
    mcp: ["~/.local/share/ucc/shared/.mcp.json"],
  },
  // U1.0 transport unification: the two ccc-statusd layers below are mutually
  // exclusive on one probe. Until the DRAIN cutover exports the daemon-minted
  // CCC_STATUSD_MCP_TOKEN (ccc-statusd docs/j2-transport-cutover-runbook.md),
  // every launch keeps the stdio sidecar; the export is the cutover switch,
  // and unexporting it is the rollback.
  {
    why: "ccc-statusd mcp, stdio sidecar — retired at the U1.0 DRAIN cutover; inert once the daemon-served token is exported",
    requires: [
      "exec:${HOME}/.local/bin/ccc-statusd",
      "!env:CCC_STATUSD_MCP_TOKEN",
      "env:SUPERZ_BOT_TOKEN | file:${CCC_TELEGRAM_SECRETS_FILE} | file:${CCC_TELEGRAM_DATA_DIR:-~/.local/share/ucc/data/ccc-telegram}/telegram.yaml",
    ],
    mcp: [
      {
        mcpServers: {
          "ccc-statusd": {
            type: "stdio",
            command: "${HOME}/.local/bin/ccc-statusd",
            args: ["mcp"],
            timeout: 86400000,
          },
        },
      },
    ],
  },
  {
    why: "ccc-statusd mcp, daemon-served streamable HTTP (U1.0) — live once the DRAIN cutover exports the daemon-minted token",
    requires: [
      "exec:${HOME}/.local/bin/ccc-statusd",
      "env:CCC_STATUSD_MCP_TOKEN",
      "env:SUPERZ_BOT_TOKEN | file:${CCC_TELEGRAM_SECRETS_FILE} | file:${CCC_TELEGRAM_DATA_DIR:-~/.local/share/ucc/data/ccc-telegram}/telegram.yaml",
    ],
    mcp: [
      {
        mcpServers: {
          "ccc-statusd": {
            type: "http",
            url: "http://localhost:${CCC_STATUSD_MCP_PORT:-19223}/mcp",
            headers: {
              Authorization: "Bearer ${CCC_STATUSD_MCP_TOKEN}",
            },
            timeout: 86400000,
          },
        },
      },
    ],
  },
  {
    why: "minimax coding-plan mcp — its own WebSearch is worse than none",
    requires: [
      "bin:uvx",
      "env:MINIMAX_API_KEY | env:ANTHROPIC_BASE_URL~minimax.io",
      "env:MINIMAX_API_KEY | env:ANTHROPIC_AUTH_TOKEN | env:ANTHROPIC_API_KEY",
    ],
    mcp: [
      {
        mcpServers: {
          MiniMax: {
            command: "uvx",
            args: ["minimax-coding-plan-mcp", "-y"],
            env: {
              MINIMAX_API_KEY: "${MINIMAX_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY}",
              MINIMAX_API_HOST: "${MINIMAX_API_HOST:-https://api.minimax.io}",
            },
          },
        },
      },
    ],
    disallowedTools: ["WebSearch"],
  },
];
