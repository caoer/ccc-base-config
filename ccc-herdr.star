# ccc-herdr.star — pane-label rendering for the ccc fleet (the P2 painter).
# Owner: the ccc-herdr resident painter; ccc-statusd no longer renders herdr.
# Loop after an edit: `ccc-herdr check` (exit 1 on any diagnostic, prints the
# wire lines) → the painter hot-reloads on save; `ccc-herdr paint` forces now.
#
# Starlark successor of ccc-herdr.toml (2026-08-14). painter/auq stay static
# dicts; render(v) computes every per-pane surface — conditionals live HERE,
# never in herdr. v carries session facts as string attributes:
# SESSION_ID · SESSION_ID_SHORT · CCC_SESSION (session dir name, "ad-hoc"
# unjoined) · ROLE · TITLE (/rename) · NAME (TITLE→PROFILE fallback) · MODEL
# · PROFILE · PROFILE_IF_UNNAMED · HERDR_TITLE (pane OSC title, from herdr)
# · STATUS · CONTEXT_PERCENT · CONTEXT_TOKENS · COST · IDLE (time since last
# hook event, "5m"/"1h5m"/"2d3h"; empty under 1m).
# Token semantics: "" or None = clear that token herdr-side; an OMITTED key
# keeps herdr's stored value until the lease expires. 80-char clamp per value.

painter = dict(
    enabled = True,                   # kill switch for BOTH writers (identity + AUQ)
    method = "pane.report_metadata",  # herdr JSON-RPC method
    agent = "claude",                 # herdr agent label on reports
    ttl = "6h",                       # identity lease, duration STRING ("0" = live until replaced)
)

auq = dict(
    blocked_label = "AUQ",  # label while an AskUserQuestion pends ("" = AUQ writer off)
    lease = "20m",          # blocked-label lease, renewed by the painter sweep
)

# Per-role sidebar colors: herdr token fg is single-valued, so each role gets
# its OWN token and only one is nonempty; herdr styles them independently in
# ~/.config/herdr/config.toml [ui.sidebar.agents.rows_by_agent] ($role_worker
# / $role_advisor / $role_leader, plus plain $role as the unknown-role
# fallback). Roleless panes clear all four.
ROLES = ("worker", "advisor", "leader")

def render(v):
    tokens = {
        "id": v.SESSION_ID_SHORT,
        "session": v.CCC_SESSION,
        "name": v.TITLE,                  # /rename title ONLY — cleared until the session is renamed
        "profile": v.PROFILE_IF_UNNAMED,  # ucc profile UNTIL a title exists, then cleared — never both
        "idle": v.IDLE,                   # cleared while active
        # "model": v.MODEL,               # uncomment to add a model token
        # Fallback for roles outside ROLES (also clears the retired pre-split
        # "role" token that panes painted before this config).
        "role": v.ROLE if v.ROLE not in ROLES else "",
    }
    for role in ROLES:
        tokens["role_" + role] = v.ROLE if v.ROLE == role else ""

    params = {}
    if v.HERDR_TITLE.strip():
        # Navigator row label — OMITTED (not cleared) while the pane has no
        # OSC title, so herdr keeps the last good one.
        params["title"] = "%s %s|%s" % (v.CCC_SESSION, v.NAME, v.HERDR_TITLE)

    return dict(
        display_agent = v.PROFILE,  # herdr display_agent field
        tokens = tokens,
        params = params,
    )
