#!/usr/bin/env bash
# Vendor this config repo into the ccc-statusd worker bundle, and commit it there.
#
# The installer leaves a $UCC_HOME/config that has a .git alone, so on this
# machine the shipped copy only moves when this script runs. Run it in the same
# change that edits the rules — GUIDE.md § Distribution.
#
#   ./sync-launch-config.sh              copy, run the suite where it lands, commit
#   ./sync-launch-config.sh --dry-run    name what differs, change nothing
#   ./sync-launch-config.sh /path/to/ccc-statusd
#   CCC_STATUSD_REPO=/path/to/ccc-statusd ./sync-launch-config.sh
set -euo pipefail

die() { echo "sync-launch-config: $*" >&2; exit 1; }

src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# The bundle, exactly — `git ls-files worker/launch-config` on the other side.
# Everything else here (this script, ci-watch, pools.local.json) stays out of
# the package: a shipped file may hold nothing user- or machine-specific.
FILES=(launch.ts rules.ts GUIDE.md launch.test.ts matrix.golden.txt matrix-viewer.html .gitignore)
DIRS=(prompts)

dry=0
repo="${CCC_STATUSD_REPO:-}"
for a in "$@"; do
  case "$a" in
    -n | --dry-run) dry=1 ;;
    -h | --help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag $a" ;;
    *) repo="$a" ;;
  esac
done

if [[ -z $repo ]]; then
  for c in /Users/Shared/repos/ccc-statusd /Users/Shared/projects/caoer/ccc-statusd; do
    [[ -d "$c/worker/launch-config" ]] && { repo="$c"; break; }
  done
fi
[[ -n $repo ]] || die "no ccc-statusd checkout found — pass its path or set CCC_STATUSD_REPO"
repo="$(cd "$repo" 2> /dev/null && pwd -P)" || die "no such directory: $repo"
dst="$repo/worker/launch-config"
[[ -f "$dst/launch.ts" ]] || die "$dst is not a launch-config bundle"

if ((dry)); then
  changed=0
  for f in "${FILES[@]}"; do
    cmp -s "$src/$f" "$dst/$f" || { echo "differs: $f"; changed=1; }
  done
  for d in "${DIRS[@]}"; do
    # -c: compare content, so a mtime skew is not reported as a difference
    while read -r line; do echo "$d/: $line"; changed=1; done < <(rsync -rcin --delete "$src/$d/" "$dst/$d/" | grep -v '^\.d')
  done
  ((changed)) || echo "already in sync"
  exit 0
fi

# The vendor commit names a config sha, so that sha must describe what ships.
sha="$(git -C "$src" rev-parse --short HEAD)"
if [[ -n "$(git -C "$src" status --porcelain -- "${FILES[@]}" "${DIRS[@]}")" ]]; then
  git -C "$src" status --short -- "${FILES[@]}" "${DIRS[@]}" >&2
  die "the bundle is uncommitted here — commit it first, or the vendor commit's config@$sha is a lie"
fi

for f in "${FILES[@]}"; do cp -p "$src/$f" "$dst/$f"; done
for d in "${DIRS[@]}"; do rsync -rc --delete "$src/$d/" "$dst/$d/"; done

# It has to pass where it now lives, not only where it was written.
(cd "$dst" && bun test launch.test.ts)

if [[ -z "$(git -C "$repo" status --porcelain -- worker/launch-config)" ]]; then
  echo "already at config@$sha — nothing to commit"
  exit 0
fi

# Path-scoped add AND commit: ccc-statusd is a multi-agent working tree, so
# every other dirty file and anything already staged must stay out of this one.
git -C "$repo" add -A -- worker/launch-config
git -C "$repo" commit -q -m "launch-config: vendor config@$sha — $(git -C "$src" log -1 --format=%s)" -- worker/launch-config
git -C "$repo" --no-pager log -1 --oneline
