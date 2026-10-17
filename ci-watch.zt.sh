#!/usr/bin/env bash
# Wait for a Woodpecker pipeline, print one line per step and the full log of
# every step that did not succeed, and exit with the verdict. Usage, exit codes
# and environment: --help.
#
# Source of truth: ccc-config (git@github.com:caoer/ccc-private-config.git),
# ci-watch.zt.sh at the repo root. Edit there, then copy to $UCC_HOME. A fix
# made only in the deployed copy has no history and evaporates.
set -euo pipefail

usage() {
  cat <<'EOF'
ci-watch — wait for a Woodpecker pipeline on ci.0xdao.app, print one line per
step and the full log of every step that did not succeed, exit with the verdict.

Run it in the BACKGROUND (it notifies on exit; nothing has to sit and watch it),
from INSIDE the repo whose CI you are watching. `tea`, the Forgejo CLI, cannot
see pipelines; `woodpecker-cli` can, and this script wraps it.

Usage:
  ci-watch.zt.sh                      newest pipeline for HEAD's sha
  ci-watch.zt.sh 122                  pipeline number 122
  ci-watch.zt.sh --sha d863335f       newest pipeline for that sha
  ci-watch.zt.sh --start [branch]     trigger a pipeline (default: main), then watch it
  ci-watch.zt.sh --timeout 10m 122    wait longer than the 4m default (10m | 600 | 1h)
  ci-watch.zt.sh --help

Flags go in any order. An unknown flag exits 2 rather than being ignored.

The exit code IS the verdict:
  0  green — every step success or skipped
  1  RED — a step did not succeed; its log is printed
  2  no verdict — could not resolve or observe a pipeline, or Woodpecker
     refused the token (401/403)
  3  still running at the timeout (states printed, nothing killed) — NOT green
  4  KILLED — cancelled or superseded by a newer commit. NOT a test failure and
     NOT green; the cancelled steps' logs are not evidence. Each workflow that
     finished before the kill prints its verdict, and one that finished red
     makes the exit 1 RED, not 4.
  129|130|143  ci-watch itself was stopped by SIGHUP|SIGINT|SIGTERM before a
     verdict — NOT green; the pipeline was not judged.

Keep --timeout under the background limit of whatever runs ci-watch: a harness
that stops it first gets 143, never the pipeline's verdict.

The verdict is ALSO the last line of stdout: `ci-watch: VERDICT=<n> <words>`.
A pipe replaces the exit code with the pipe's own — `... | tail` reports tail's
0, so red or still-running reads as green. Redirect to a file and read $?, or
read the VERDICT line.

Repo: derived from the git remotes of the directory you run in (a URL on the
forge host, push URLs included), then resolved to its Woodpecker id. There is
no default — pipeline NUMBERS COLLIDE ACROSS REPOS, so a bare number from the
wrong checkout would answer, confidently, about another project. Override with
WOODPECKER_REPO_ID; ids are on the repo page at ci.0xdao.app (`woodpecker-cli
repo ls` lists names without them).

Environment:
  WOODPECKER_TOKEN       else decrypted from CCC_SECRETS_COMMON
                         (default /Users/Shared/repos/osfiles/secrets/svc/common.sops.yaml)
  WOODPECKER_SERVER      default https://ci.0xdao.app
  WOODPECKER_REPO_ID     explicit repo id, skips the derivation above
  WOODPECKER_FORGE_HOST  forge host the remotes are matched on, default git.0xdao.app
  CI_WATCH_TIMEOUT       default 4m; --timeout overrides
  CI_WATCH_INTERVAL      poll interval in seconds, default 20
EOF
}
# Before the EXIT trap below is installed: --help must not print a VERDICT line.
for arg in "$@"; do
  case "$arg" in -h|--help) usage; exit 0 ;; esac
done

# ── The verdict has to survive the caller ────────────────────────────────────
# The exit code is an OUT-OF-BAND channel, and a pipe silently drops it: the
# caller's $? becomes the LAST pipe element's. `ci-watch … | tail` therefore
# reports 0 for a red or still-running pipeline. That is the single largest
# false-green generator in this fleet — measured 2026-08-24 on pipeline 984,
# where this script printed "still running after 10m", exited 3, and the run
# was recorded as exit 0.
#
# No script can fix a caller's pipe. So the verdict ALSO goes IN-BAND, on the
# last line of stdout, where a pipe carries it instead of eating it. Emitted
# from an EXIT trap so EVERY exit path is covered — including the early exit 2s
# and a `set -e` abort, which previously produced a step table and no verdict.
verdict_words() {
  case "$1" in
    0) echo "green — every step success or skipped" ;;
    1) echo "RED — at least one step did not succeed" ;;
    2) echo "NO VERDICT — could not resolve or observe a pipeline" ;;
    3) echo "STILL RUNNING at the timeout — NOT green" ;;
    4) echo "KILLED — cancelled or superseded by a newer commit, NOT a test failure" ;;
    129|130|143) echo "ci-watch was STOPPED by a signal before a verdict — NOT green" ;;
    *) echo "ci-watch itself failed before reaching a verdict" ;;
  esac
}
# `|| true` on every write: a caller like `| head -5` closes the pipe early,
# and a SIGPIPE here would overwrite the very verdict we are reporting.
on_exit() {
  _rc=$?
  echo "ci-watch: VERDICT=$_rc $(verdict_words "$_rc")" || true
  # A tty or a regular file preserves our exit code; a pipe does not.
  if [ ! -t 1 ] && [ -p /dev/stdout ]; then
    echo "ci-watch: stdout is a PIPE — \$? is the pipe's exit code, NOT this verdict. Read the VERDICT line above." || true
  fi
}
trap on_exit EXIT
# A signal must reach on_exit as its own exit code. Untrapped, bash dies on it
# and on_exit reads the $? of the last command that completed — 0 while the
# loop below waits on pending workflows — so a harness stopping ci-watch at its
# background limit printed `VERDICT=0 green` for a pipeline whose workflows had
# not started (ccc-statusd pipeline 2177).
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
# Sleep in the background and wait on it: bash runs a trap only after a
# foreground child returns, and `wait` is interrupted by the signal at once.
nap() { sleep "$1" & wait $!; }

export WOODPECKER_SERVER=${WOODPECKER_SERVER:-https://ci.0xdao.app}
export WOODPECKER_DISABLE_UPDATE_CHECK=1
SECRETS=${CCC_SECRETS_COMMON:-/Users/Shared/repos/osfiles/secrets/svc/common.sops.yaml}
INTERVAL=${CI_WATCH_INTERVAL:-20}
TIMEOUT=${CI_WATCH_TIMEOUT:-4m}

# 4m | 240 | 1h — seconds out.
secs() {
  case "$1" in
    *h) echo $(( ${1%h} * 3600 )) ;;
    *m) echo $(( ${1%m} * 60 )) ;;
    *s) echo "${1%s}" ;;
    *)  echo "$1" ;;
  esac
}
# Flags in ANY order, and an unknown flag is a loud refusal. --timeout used to
# be read only in FIRST position, so `--sha X --timeout 12m` silently kept the
# 4m default and exited 3 on a pipeline that was fine — a dropped flag reads as
# a hung pipeline (measured 2026-08-19).
START_BRANCH="" SHA_ARG="" PIPELINE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout)
      [ $# -ge 2 ] || { echo "ci-watch: --timeout needs a value (e.g. 10m)" >&2; exit 2; }
      TIMEOUT=$2; shift 2 ;;
    --sha)
      [ $# -ge 2 ] || { echo "ci-watch: --sha needs a value" >&2; exit 2; }
      SHA_ARG=$2; shift 2 ;;
    --start)
      # Optional branch; a following FLAG is not a branch name.
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then START_BRANCH=$2; shift 2
      else START_BRANCH=main; shift; fi ;;
    -*)
      echo "ci-watch: unknown flag '$1' — see $0 --help" >&2; exit 2 ;;
    *)
      PIPELINE_ARG=$1; shift ;;
  esac
done
deadline=$(( $(date +%s) + $(secs "$TIMEOUT") ))

if [ -z "${WOODPECKER_TOKEN:-}" ]; then
  WOODPECKER_TOKEN=$(sops -d --extract '["woodpecker_token"]' "$SECRETS")
  export WOODPECKER_TOKEN
fi
wp() { woodpecker-cli "$@"; }

# --- Repo resolution: explicit override, else derive from where we stand. -----
# No default. Pipeline numbers collide across repos, so guessing the repo means
# confidently answering about the wrong project.
if [ -n "${WOODPECKER_REPO_ID:-}" ]; then
  REPO=$WOODPECKER_REPO_ID
  echo "repo: $REPO (explicit \$WOODPECKER_REPO_ID)"
else
  # A slug only means something for a remote pointing at the forge THIS server
  # watches, so the forge host is what the search is keyed on — not remote order.
  # Taking the first remote that merely parses answers about the wrong project
  # whenever a repo is mirrored: ccc-pages' `origin` FETCHES from github.com and
  # pushes to both forges, so remote order yields `caoer/ccc-pages` — a github
  # owner this server has never heard of — while `caoer115/ccc-pages` sits right
  # there on a push URL. Push URLs are searched for exactly that reason.
  FORGE_HOST=${WOODPECKER_FORGE_HOST:-git.0xdao.app}
  slug="" fallback=""
  for r in origin forge-nyc $(git remote 2>/dev/null); do
    for url in $(git remote get-url --all "$r" 2>/dev/null) \
               $(git remote get-url --push --all "$r" 2>/dev/null); do
      # trailing owner/name(.git) from ssh://, git@host:path, or https:// forms
      s=$(printf '%s' "$url" | sed -E 's#\.git$##; s#.*[:/]([^/:]+/[^/]+)$#\1#')
      [ -n "$s" ] && [ "$s" != "$url" ] || continue
      case "$url" in *"$FORGE_HOST"*) slug=$s; break 2 ;; esac
      # Keep the first parseable non-forge slug: with an unusual forge host the
      # lookup below is still worth one try, and its refusal names the slug.
      [ -n "$fallback" ] || fallback=$s
    done
  done
  [ -n "$slug" ] || slug=$fallback
  if [ -z "$slug" ]; then
    echo "ci-watch: cannot derive a repo from git remotes in $PWD." >&2
    echo "  Run from inside the repo, or set WOODPECKER_REPO_ID explicitly." >&2
    exit 2
  fi
  # `|| true` on the substitution, and it is load-bearing: under `set -o
  # pipefail` a 404 makes `curl -f` exit 22 and takes the whole script with it,
  # so the caller saw a bare 22 instead of the diagnosis five lines down.
  REPO=$(curl -fsS -H "Authorization: Bearer $WOODPECKER_TOKEN" \
           "$WOODPECKER_SERVER/api/repos/lookup/$slug" 2>/dev/null \
         | sed -n 's/.*"id":[[:space:]]*\([0-9]\{1,\}\).*/\1/p' | head -1) || true
  if [ -z "$REPO" ]; then
    echo "ci-watch: '$slug' is not a repo Woodpecker knows at $WOODPECKER_SERVER." >&2
    echo "  Set WOODPECKER_REPO_ID explicitly, or check: woodpecker-cli repo ls" >&2
    exit 2
  fi
  echo "repo: $REPO ($slug, derived from git remote)"
fi

sha=${SHA_ARG:-$(git rev-parse HEAD)}
pipeline=$PIPELINE_ARG
if [ -n "$START_BRANCH" ]; then
  pipeline=$(wp pipeline create --branch "$START_BRANCH" "$REPO" | awk 'NR>1 {print $1; exit}')
fi

# Newest pipeline whose commit is $sha. `pipeline ls` prints a table; the
# commit is not in it, so ask the API for the mapping.
# The fetch is its own step: piped straight into the parser, a refused request
# (401: the token was rejected) made the parser exit 1 under pipefail, and
# exit 1 reads as a red pipeline.
if [ -z "$pipeline" ]; then
  if ! list=$(curl -fsS -H "Authorization: Bearer $WOODPECKER_TOKEN" \
      "$WOODPECKER_SERVER/api/repos/$REPO/pipelines?perPage=50" 2>&1); then
    echo "ci-watch: cannot read the pipelines of repo $REPO: $list" >&2
    echo "  401 or 403: WOODPECKER_TOKEN was rejected — check it, then run again." >&2
    exit 2
  fi
  pipeline=$(printf '%s' "$list" |
    python3 -c '
import json,sys
sha=sys.argv[1]
for p in json.load(sys.stdin):
    if p["commit"].startswith(sha) or sha.startswith(p["commit"]):
        print(p["number"]); break
' "$sha") || pipeline=""
fi
[ -n "$pipeline" ] || { echo "no pipeline found for $sha" >&2; exit 2; }

# A pipeline given BY NUMBER names its own commit — label the watch with that,
# never with the cwd's HEAD. (2026-08-23: pipeline 826 was printed as the cwd's
# 24f6787a while it had actually built 6d97b3ca; a PR was merged on the wrong
# verdict because of that label.)
if [ -n "$PIPELINE_ARG" ]; then
  sha=$(curl -fsS -H "Authorization: Bearer $WOODPECKER_TOKEN"     "$WOODPECKER_SERVER/api/repos/$REPO/pipelines/$pipeline" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["commit"])') || sha="unknown"
fi

echo "watching $WOODPECKER_SERVER/repos/$REPO/pipeline/$pipeline (sha ${sha:0:8}), timeout $TIMEOUT"
timed_out=0
empty_polls=0
while :; do
  # NEVER let a failed query read as a finished pipeline. `wp` can exit 0 while
  # printing a fatal (e.g. `client error 404` for a pipeline that exists but is
  # not yet queryable), and an empty $states matches no `pending|running`, so
  # the old loop broke, rendered zero rows, and exited 0 — a FALSE GREEN on a
  # pipeline nobody had observed (measured 2026-08-19).
  states=$(wp pipeline ps "$REPO" "$pipeline" --format '{{.step.PID}}|{{.step.Name}}|{{.step.State}}' 2>&1) || true
  if ! printf '%s\n' "$states" | grep -qE '^[0-9]+\|'; then
    empty_polls=$((empty_polls + 1))
    if [ "$empty_polls" -ge 3 ]; then
      echo "ci-watch: cannot read steps of pipeline $pipeline after $empty_polls tries." >&2
      printf '%s\n' "$states" | sed 's/^/  /' >&2
      echo "  Refusing to report a verdict for a pipeline nobody could observe." >&2
      exit 2
    fi
    nap "$INTERVAL"
    continue
  fi
  empty_polls=0
  # `pending`/`running` anywhere means the pipeline is not done yet.
  printf '%s\n' "$states" | grep -qE '\|(pending|running)$' || break
  if [ "$(date +%s)" -ge "$deadline" ]; then timed_out=1; break; fi
  nap "$INTERVAL"
done

rc=0
rows=0
while IFS='|' read -r pid name state; do
  [ -n "$pid" ] || continue
  rows=$((rows + 1))
  printf '%-8s %-52s %s\n' "$pid" "$name" "$state"
  case "$state" in success|skipped) ;; *) rc=1 ;; esac
done <<<"$states"

# Zero observed steps is not a green pipeline; it is no evidence at all.
if [ "$rows" -eq 0 ]; then
  echo "ci-watch: pipeline $pipeline reported no steps — no verdict." >&2
  exit 2
fi

if [ "$timed_out" -eq 1 ]; then
  echo "still running after $TIMEOUT — re-run with --timeout <dur> to keep waiting" >&2
  exit 3
fi

# A step that is not success|skipped makes rc=1 above — but "did not succeed" and
# "failed" are DIFFERENT FACTS, and RED is what a caller ACTS on. Woodpecker KILLS
# an in-flight pipeline when a newer commit supersedes it, so an ordinary force-push
# turns a healthy branch's steps into `killed` and reads as RED. That false RED lands
# on the superseded sha — precisely the one nobody revisits — where it goes
# unexamined and can later be quoted as proof the branch was broken.
#
# So ask the PIPELINE about itself. The step table is a report ABOUT the pipeline;
# the API's `.status` IS the pipeline.
#
# FAIL-CLOSED: if that query fails, or says anything other than `killed`, rc stays 1.
# A broken lookup must never downgrade a real RED.
#
# A kill does not erase what already finished. Woodpecker kills the PIPELINE when a
# newer commit arrives, but a workflow that completed before that keeps its own
# state: collector-rs pipeline 2441 had its `test` workflow fail (exit 101) seven
# minutes before the next push killed the still-running `build`, and the whole run
# read as KILLED — the red went unseen. So a killed pipeline is judged by its
# finished workflows: any of them red keeps rc=1, all of them green makes it 4.
killed_red=0
if [ "$rc" -ne 0 ]; then
  pjson=$(curl -fsS -H "Authorization: Bearer $WOODPECKER_TOKEN" \
    "$WOODPECKER_SERVER/api/repos/$REPO/pipelines/$pipeline" 2>/dev/null) || pjson=""
  pstatus=$(printf '%s' "$pjson" |
    python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null) || pstatus=""
  if [ "$pstatus" = "killed" ]; then
    # name|state of every workflow that finished on its own (not cut by the kill).
    finished=$(printf '%s' "$pjson" | python3 -c '
import json,sys
for w in json.load(sys.stdin).get("workflows") or []:
    if w.get("state") not in ("killed", "canceled", "pending", "running", "blocked"):
        print("%s|%s" % (w.get("name", "?"), w.get("state", "?")))
' 2>/dev/null) || finished="?|unreadable"
    red_wf=""
    while IFS='|' read -r wname wstate; do
      [ -n "$wname" ] || continue
      echo "workflow $wname finished $wstate before the kill"
      case "$wstate" in success|skipped) ;; *) red_wf="$red_wf $wname" ;; esac
    done <<<"$finished"
    if [ -n "$red_wf" ]; then
      killed_red=1
      echo "ci-watch: pipeline $pipeline was KILLED, but workflow(s)$red_wf had already finished red — RED." >&2
      echo "  Logs below are the failed steps only; the steps the kill cancelled are not evidence." >&2
    else
      rc=4
      echo "ci-watch: pipeline $pipeline status is KILLED — cancelled or superseded by a newer commit." >&2
      echo "  Not a test failure. Steps below were cancelled mid-flight, so their logs are not evidence." >&2
      echo "  If you superseded this sha yourself, this is an artifact. Otherwise find out who cancelled it." >&2
    fi
  fi
fi

# Dump logs only for a genuine failure. A cancelled step has no failure to show.
if [ "$rc" -eq 1 ]; then
  while IFS='|' read -r pid name state; do
    case "$state" in success|skipped|"") continue ;; esac
    if [ "$killed_red" -eq 1 ]; then
      case "$state" in failure|error) ;; *) continue ;; esac
    fi
    echo; echo "=== log: $name ($state) ==="
    wp pipeline log show "$REPO" "$pipeline" "$pid" || true
  done <<<"$states"
fi
exit "$rc"
