#!/usr/bin/env bash
# Tests for ci-watch.zt.sh against a fake woodpecker-cli and curl, no network.
# The fixture is pipeline 2177 of ccc-statusd: workflows ci and ci-go green,
# deploy-worker and bundle-watch queued (`pending`) for a CI slot.
# Run: ./ci-watch.test.sh   (exit 0 = every case passed)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
script=$here/ci-watch.zt.sh
tmp=$(mktemp -d "${TMPDIR:-/tmp}/ci-watch-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/woodpecker-cli" <<'EOF'
#!/usr/bin/env bash
if [ "$FAKE_PIPELINE" = killed-red ]; then
  case "$1 $2" in
    "pipeline log") echo "fake log of step $6: test result: FAILED. 14 failed"; exit 0 ;;
    "pipeline ps") cat <<'T'
3|clone|success
9|obs silence|killed
13|aarch64 record|canceled
19|clone|success
20|test (cargo test --workspace --locked)|failure
T
      exit 0 ;;
  esac
fi
[ "$1 $2" = "pipeline ps" ] || { echo "fake woodpecker-cli: unhandled $*" >&2; exit 9; }
late=pending; [ "$FAKE_PIPELINE" = done ] && late=success
cat <<T
5|clone|$late
6|bundle-marker-watch|$late
7|clone|success
8|submodule|success
9|go-test|success
10|go-test-race|success
11|clone|success
12|submodule|success
13|bundle-marker-watch-battery|success
14|deploy-publish-monotonic-battery|success
15|harness-selfcheck-battery|success
16|release-preflight-battery|success
17|seat-holder-battery|success
18|ccc-verify-battery|success
19|frozen-layer-battery|success
20|verify-generated|success
21|worker-installer-tests|success
22|clone|$late
23|tag-test-lane-gate|$late
24|submodule|$late
25|deploy|$late
26|bundle-marker-watch|$late
T
EOF
cat >"$tmp/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [ "$FAKE_PIPELINE" = unauthorized ]; then
  echo "curl: (22) The requested URL returned error: 401" >&2; exit 22
fi
status=running; [ "$FAKE_PIPELINE" = done ] && status=success
case "$*" in
  *"/pipelines/2441"*)    echo '{"number":2441,"commit":"97a3686f0000","status":"killed","workflows":[{"name":"build","state":"killed","error":"Canceled"},{"name":"test","state":"failure","error":null}]}' ;;
  *"/pipelines?perPage"*) echo "[{\"number\":2177,\"commit\":\"8c957a7f0000\",\"status\":\"$status\"}]" ;;
  *"/pipelines/2177"*)    echo "{\"number\":2177,\"commit\":\"8c957a7f0000\",\"status\":\"$status\"}" ;;
  *) echo "fake curl: unhandled $*" >&2; exit 22 ;;
esac
EOF
chmod +x "$tmp/bin/"*
export PATH="$tmp/bin:$PATH" WOODPECKER_TOKEN=fake WOODPECKER_REPO_ID=10 CI_WATCH_INTERVAL=1

fails=0
check() {  # name, want-exit, want-verdict-line-prefix, got-exit, output-file
  local verdict; verdict=$(grep '^ci-watch: VERDICT=' "$5" | tail -1)
  if [ "$4" = "$2" ] && [ "${verdict#"$3"}" != "$verdict" ]; then
    echo "ok   $1 (exit $4; $verdict)"
  else
    echo "FAIL $1: want exit $2 and '$3…', got exit $4 and '$verdict'"; sed 's/^/     | /' "$5"
    fails=$((fails + 1))
  fi
}

# 1. Pipeline finished green: VERDICT=0.
FAKE_PIPELINE=done "$script" --sha 8c957a7f >"$tmp/done.out" 2>&1
check "finished pipeline is green" 0 "ci-watch: VERDICT=0 " $? "$tmp/done.out"

# 2. Workflows still pending at the timeout: VERDICT=3, never green.
FAKE_PIPELINE=pending "$script" --sha 8c957a7f --timeout 2s >"$tmp/timeout.out" 2>&1
check "pending at timeout is still-running" 3 "ci-watch: VERDICT=3 " $? "$tmp/timeout.out"

# 3. The watcher is terminated while workflows are pending, as a harness does at
#    its background limit: the in-band verdict must not read green.
FAKE_PIPELINE=pending "$script" --sha 8c957a7f --timeout 30m >"$tmp/term.out" 2>&1 &
pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q '^watching ' "$tmp/term.out" && break; sleep 0.5; done
sleep 1
kill -TERM "$pid"
wait "$pid"
check "terminated while pending is not green" 143 "ci-watch: VERDICT=143 " $? "$tmp/term.out"

# 4. Woodpecker rejects the token (401): no verdict, never red.
FAKE_PIPELINE=unauthorized "$script" --sha 8c957a7f >"$tmp/401.out" 2>&1
check "rejected token is no verdict" 2 "ci-watch: VERDICT=2 " $? "$tmp/401.out"

# 5. Killed after a workflow already finished red (collector-rs pipeline 2441: `test`
#    failed, then a newer push killed `build`): RED with the failed step's log, never KILLED.
FAKE_PIPELINE=killed-red "$script" 2441 >"$tmp/killed-red.out" 2>&1
rc=$?
grep -q '^workflow test finished failure before the kill$' "$tmp/killed-red.out" &&
  grep -q 'fake log of step 20' "$tmp/killed-red.out" &&
  ! grep -q 'fake log of step 9' "$tmp/killed-red.out" || rc="$rc, workflow verdict or failed-step log missing"
check "killed after a red workflow is red" 1 "ci-watch: VERDICT=1 " "$rc" "$tmp/killed-red.out"

[ "$fails" -eq 0 ] && echo "all passed" || echo "$fails failed"
exit "$fails"
