// ═══════════════════════════════════════════════════════════════════════════
// rules.ts — THE launch config. Pure data. This is the file you edit.
//
// Six tables, read top to bottom:
//
//   defaults          what every launch starts with
//   arms              a model + the system prompt that belongs to it
//   pools             named sets of ucc profiles
//   routes            THE ROUTER — first match wins, and it picks the arm
//   layers            additive config — every match applies, in order
//   launcherDefaults  the layers the bash wrappers still own (OFF today)
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
// ═══════════════════════════════════════════════════════════════════════════

export type Append = { file: string } | { text: string };

/** A model and the system prompt that belongs with it. */
export type Arm = {
  model: string;
  /** replaces the harness base system prompt (repo-relative or ~) */
  prompt?: string;
  effort?: string;
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
  /** arm name; a list means "pick one" (matrix shows every candidate) */
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
  /** a default, not an override: only fills fields nothing has set yet */
  fallback?: boolean;
  /** replaces the harness base system prompt */
  systemPrompt?: string;
  /** appended to the system prompt, in order */
  append?: Append[];
  /** loaded on turn one via a startup directive */
  skills?: string[];
  /** file paths or inline JSON → --mcp-config= */
  mcp?: string[];
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
// Every launch starts here. No model: a bare `ucc-<profile>` keeps whatever
// the harness and the profile settings already choose.

export const defaults: Layer = {
  effort: "xhigh",
  verbose: false,
  why: "base",
};

// ─── arms ───────────────────────────────────────────────────────────────────
// A model never travels alone — it carries the system prompt written for it.
// Add an arm here, then point a route at it.

export const arms: Record<string, Arm> = {
  fable: {
    model: "claude-fable-5",
    prompt: "prompts/SYSTEM_PROMPT.fable.md",
  },
  opus: {
    model: "claude-opus-4-8",
    prompt: "prompts/SYSTEM_PROMPT.opus.md",
  },
  "opus-1m": {
    model: "claude-opus-4-8[1m]",
    prompt: "prompts/SYSTEM_PROMPT.opus.md",
  },
  // Endpoints that speak their own model ids. They run the fable prompt layer.
  "gpt-5.6-sol": {
    model: "gpt-5.6-sol[1m]",
    prompt: "prompts/SYSTEM_PROMPT.fable.md",
    effort: "xhigh",
  },
  k3: {
    model: "k3[1m]",
    prompt: "prompts/SYSTEM_PROMPT.fable.md",
    effort: "xhigh",
  },
  "grok-4.5": {
    model: "grok-4.5[1m]",
    prompt: "prompts/SYSTEM_PROMPT.fable.md",
    effort: "xhigh",
  },
};

// ─── pools ──────────────────────────────────────────────────────────────────
// Named sets of ucc profiles. A route matches a pool instead of listing
// profiles inline, so one account moves between fleets by moving one line.

export const pools: Record<string, string[]> = {
  FABLE_FLEET: ["dewiest_gulp", "crusted_standby_0n", "grid-mullein1b"],
  OPUS_1M_FLEET: [
    "vows_yogic_9k",
    "blusher-83savvy",
    "monk0foreleg",
    "dewiest_gulp",
    "crusted_standby_0n",
    "colder_therapy0i",
  ],
};

// ─── routes ─────────────────────────────────────────────────────────────────
// THE ROUTER. Read top to bottom; the FIRST match wins and names the arm.
// A launch that matches nothing here and named no model gets no --model at all.

export const routes: Route[] = [
  // 1. Endpoint profiles. Their API rejects claude ids, so these beat an
  //    explicit --model too.
  { when: { profile: "codex" }, use: "gpt-5.6-sol", why: "codex endpoint" },
  { when: { profile: "kimi-k3-moonshot" }, use: "k3", why: "moonshot endpoint" },
  { when: { profile: "grok" }, use: "grok-4.5", why: "grok endpoint" },

  // 2. The caller named a model. An effort suffix (-low … -max) is stripped
  //    off the id first and applied as --effort, so claude-opus-4-8-xhigh
  //    lands here as claude-opus-4-8.
  { when: { model: "claude-fable-5" }, use: "fable" },
  { when: { model: "claude-opus-4-8" }, use: "opus" },
  { when: { model: "claude-opus-4-8[1m]" }, use: "opus-1m" },
  //    Any other named model passes through as a real id, no prompt arm.

  // 3. Role pools — the fleet's standing model policy. Comment these two
  //    lines out and the per-profile rules below take over.
  { when: { noModel: true, role: ["advisor", "leader"] }, use: ["fable"] },
  { when: { noModel: true, role: "worker" }, use: ["opus-1m"] },

  // 4. Per-profile rules. Reached only when a launch carries no model and the
  //    role pools above did not claim it.
  {
    when: { noModel: true, profile: "does_bannock_6u" },
    use: "opus-1m",
    why: "fable quota spent on this account",
  },
  {
    when: { noModel: true, pool: "FABLE_FLEET", role: ["advisor", "leader"] },
    use: "fable",
    why: "FABLE_FLEET thinking roles",
  },
  {
    when: { noModel: true, role: "*" },
    use: "opus-1m",
    why: "every other fleet launch",
  },
];

// ─── layers ─────────────────────────────────────────────────────────────────
// Additive config. Every layer whose `when` matches and whose `requires` hold
// applies, in this order.

export const layers: Layer[] = [
  {
    when: { role: "*" },
    skills: ["ccc-base"],
    append: [{ file: "roles/${role}.md" }],
    why: "fleet role brief",
  },
];

// ─── launcherDefaults ───────────────────────────────────────────────────────
// The bash wrappers (ucc-<profile>, ucc-auto, ucc-sdk) still inject these
// today, so they are OFF here — turning them on without cutting the bash over
// would double every --mcp-config.
//
// Cutover, in order:
//   1. forward the caller's argv into launch.ts (so it can see what the user
//      already passed and stay out of the way)
//   2. delete ucc_resolve_prompt_args + the two mcp helpers from
//      constants.mjs / install-wrappers.mjs / profile-cli.mjs, regenerate
//   3. stop the wrapper re-rendering a spawn that ccc-tmux already rendered
//   4. flip OWN_LAUNCHER_DEFAULTS to true
//
// Preview the flipped state any time, without flipping it:
//   bun launch.ts explain --own-defaults --role worker
//   bun launch.ts matrix  --own-defaults

export const OWN_LAUNCHER_DEFAULTS = false;

export const launcherDefaults: Layer[] = [
  {
    why: "shared base system prompt — only when no arm brought one",
    requires: ["file:~/.local/share/ucc/shared/SYSTEM_PROMPT.md"],
    fallback: true,
    systemPrompt: "~/.local/share/ucc/shared/SYSTEM_PROMPT.md",
  },
  {
    why: "shared system prompt append — only when no role brief took the slot",
    requires: ["file:~/.local/share/ucc/shared/SYSTEM_PROMPT_APPEND.md"],
    fallback: true,
    append: [{ file: "~/.local/share/ucc/shared/SYSTEM_PROMPT_APPEND.md" }],
  },
  {
    why: "shared mcp servers (tolaria, shellkit)",
    requires: ["file:~/.local/share/ucc/shared/.mcp.json"],
    mcp: ["~/.local/share/ucc/shared/.mcp.json"],
  },
  {
    why: "ccc-statusd mcp — only once telegram is configured",
    requires: [
      "exec:${HOME}/.local/bin/ccc-statusd",
      "env:SUPERZ_BOT_TOKEN | file:${CCC_TELEGRAM_SECRETS_FILE} | file:${CCC_TELEGRAM_DATA_DIR:-~/.local/share/ucc/data/ccc-telegram}/telegram.yaml",
    ],
    mcp: [
      '{"mcpServers":{"ccc-statusd":{"type":"stdio","command":"${HOME}/.local/bin/ccc-statusd","args":["mcp"],"timeout":86400000}}}',
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
      '{"mcpServers":{"MiniMax":{"command":"uvx","args":["minimax-coding-plan-mcp","-y"],"env":{"MINIMAX_API_KEY":"${MINIMAX_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY}","MINIMAX_API_HOST":"${MINIMAX_API_HOST:-https://api.minimax.io}"}}}}',
    ],
    disallowedTools: ["WebSearch"],
  },
];
