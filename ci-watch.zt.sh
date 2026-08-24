#!/usr/bin/env bash
# Wait for a Woodpecker pipeline, then print one line per step and the full log
# of every step that did not succeed.
#
# Run it in the BACKGROUND — it notifies on exit, so nothing has to sit and
# watch it. The script does the polling; the agent gets one verdict.
#
# Run it from inside the repo whose CI you are watching:
#
#   ~/.local/share/ucc/ci-watch.zt.sh              # newest pipeline for HEAD's sha
#   ~/.local/share/ucc/ci-watch.zt.sh 122          # that pipeline number
#   ~/.local/share/ucc/ci-watch.zt.sh --sha d863335f
#   ~/.local/share/ucc/ci-watch.zt.sh --start      # trigger on main, then watch it
#   ~/.local/share/ucc/ci-watch.zt.sh --timeout 10m 122
#   ~/.local/share/ucc/ci-watch.zt.sh --sha d863335f --timeout 12m
#
# Flags may appear in any order; an unknown flag exits 2 rather than being
# ignored.
#
# Exit code IS the verdict: 0 green, 1 red, 2 could not resolve a pipeline,
# 3 still running when the timeout expired (states printed, nothing killed).
#
# The verdict is ALSO the LAST LINE OF STDOUT: `ci-watch: VERDICT=<n> <words>`.
# Read that line whenever anything stands between this script and you, because
# A PIPE REPLACES OUR EXIT CODE WITH THE PIPE'S. `ci-watch … | tail` reports
# tail's 0, so a red (1) or still-running (3) pipeline reads as GREEN.
# Measured 2026-08-24: `--timeout 10m 984 2>&1 | tail -40` printed "still
# running after 10m", exited 3, and the caller recorded 0 — a false green
# (memo agents/fdc97943/memos/ci-watch-exit-0-on-still-running.md). 389 of 1622
# recorded ci-watch invocations in the fleet transcripts are piped like that.
# Redirect to a file and read $?, or read the VERDICT line — no pipe eats it.
# Timeout defaults to 4m — raise it for a pipeline you know runs longer.
#
# Source of truth: ccc-config (git@github.com:caoer/ccc-private-config.git),
# ci-watch.zt.sh at the repo root. Edit there, then copy to $UCC_HOME. A fix
# made only in the deployed copy has no history and evaporates.
# Token: $WOODPECKER_TOKEN, else decrypted from the sops store.
# Server: $WOODPECKER_SERVER (default ci.0xdao.app).
#
# Repo: DERIVED from the git remote of the directory you run in, then resolved
# to its Woodpecker id. Override explicitly with $WOODPECKER_REPO_ID. There is
# NO default id — there used to be one (12 = meridian-rs), and because pipeline
# NUMBERS COLLIDE ACROSS REPOS it would silently watch meridian-rs's pipeline of
# the same number and print a confident verdict about the wrong project. On
# 2026-08-19 that showed clippy failures in crates/wire-serve for a ccc-statusd
# branch containing no Rust. A wrong-repo watch is not an error: it succeeds,
# and it answers about somebody else. Now it either resolves the repo you are
# standing in or exits 2.
set -euo pipefail

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
      echo "ci-watch: unknown flag '$1' — see the header of $0" >&2; exit 2 ;;
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
  slug=""
  for r in origin forge-nyc $(git remote 2>/dev/null); do
    url=$(git remote get-url "$r" 2>/dev/null) || continue
    # trailing owner/name(.git) from ssh://, git@host:path, or https:// forms
    slug=$(printf '%s' "$url" | sed -E 's#\.git$##; s#.*[:/]([^/:]+/[^/]+)$#\1#')
    [ -n "$slug" ] && [ "$slug" != "$url" ] && break
    slug=""
  done
  if [ -z "$slug" ]; then
    echo "ci-watch: cannot derive a repo from git remotes in $PWD." >&2
    echo "  Run from inside the repo, or set WOODPECKER_REPO_ID explicitly." >&2
    exit 2
  fi
  REPO=$(curl -fsS -H "Authorization: Bearer $WOODPECKER_TOKEN" \
           "$WOODPECKER_SERVER/api/repos/lookup/$slug" 2>/dev/null \
         | sed -n 's/.*"id":[[:space:]]*\([0-9]\{1,\}\).*/\1/p' | head -1)
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
if [ -z "$pipeline" ]; then
  pipeline=$(curl -fsS -H "Authorization: Bearer $WOODPECKER_TOKEN" \
    "$WOODPECKER_SERVER/api/repos/$REPO/pipelines?perPage=50" |
    python3 -c '
import json,sys
sha=sys.argv[1]
for p in json.load(sys.stdin):
    if p["commit"].startswith(sha) or sha.startswith(p["commit"]):
        print(p["number"]); break
' "$sha")
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
    sleep "$INTERVAL"
    continue
  fi
  empty_polls=0
  # `pending`/`running` anywhere means the pipeline is not done yet.
  printf '%s\n' "$states" | grep -qE '\|(pending|running)$' || break
  if [ "$(date +%s)" -ge "$deadline" ]; then timed_out=1; break; fi
  sleep "$INTERVAL"
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

if [ "$rc" -ne 0 ]; then
  while IFS='|' read -r pid name state; do
    case "$state" in success|skipped|"") continue ;; esac
    echo; echo "=== log: $name ($state) ==="
    wp pipeline log show "$REPO" "$pipeline" "$pid" || true
  done <<<"$states"
fi
exit "$rc"
