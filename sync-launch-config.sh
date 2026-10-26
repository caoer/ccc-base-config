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
# Everything else here (this script, ci-watch) stays out of
# the package: a shipped file may hold nothing user- or machine-specific.
#
# The lists name every entry the bundle may carry; the source decides which of
# them exist, so a name this config repo has not grown yet is simply not packed.
# A retired name must LEAVE these lists, not merely stop being written. The
# lists are read against the SOURCE — this machine — and an installed config
# still holding launch.ts, rules.ts or prompts/ would copy them back over the
# repo and undo their deletion, silently and in the direction nobody watches.
# MERIDIAN.md is absent on purpose: it declares this root to the local engine
# and is machine-local.
FILES=(launch.mjs GUIDE.md fleet.md undercover-group.md launch.test.mjs .gitignore)
DIRS=(launch mcp)

# The pages compose by symlink, so kind is part of the comparison: a link and a
# regular file holding the link's destination are the same bytes and different
# things. `cmp` alone reads them as equal, which is how a flattened link ships
# unnoticed.
differs() {
  local a=$1 b=$2
  if [[ -L $a || -L $b ]]; then
    [[ -L $a && -L $b && "$(readlink "$a")" == "$(readlink "$b")" ]] && return 1
    return 0
  fi
  cmp -s "$a" "$b" && return 1
  return 0
}

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
[[ -f "$dst/launch.mjs" ]] || die "$dst is not a launch-config bundle"

# The vendored copy may be AHEAD of this checkout: a section landed in
# ccc-statusd directly (THE SEAT — the minted seat, the seat-token identity)
# and was never reconciled here. launch.mjs is organised in sections, each
# opened by a `// NAME — …` line; a section the vendored copy carries and this
# checkout lacks would be reverted on every installed host by this sync,
# silently and in the direction nobody watches. Refused, naming the sections:
# the reconcile — copying them into this checkout and committing — comes
# first, then the sync.
sections() { grep -oE '^// [A-Z][A-Z ]+ —' "$1" | sed 's/ —$//; s|^// ||' | sort -u; }
if missing=$(comm -13 <(sections "$src/launch.mjs") <(sections "$dst/launch.mjs")) && [[ -n $missing ]]; then
  printf 'sync-launch-config: launch.mjs here lacks section(s) the vendored copy carries:\n' >&2
  printf '%s\n' "$missing" | sed 's/^/  /' >&2
  die "syncing would drop them from worker/launch-config/launch.mjs and from every host that installs it — reconcile this checkout first: bring the section(s) over from $dst/launch.mjs (git -C $repo log -- worker/launch-config/launch.mjs names the commits), run bun test launch.test.mjs here, commit, then sync"
fi

if ((dry)); then
  changed=0
  for f in "${FILES[@]}"; do
    [[ -e "$src/$f" || -L "$src/$f" ]] || continue
    differs "$src/$f" "$dst/$f" && { echo "differs: $f"; changed=1; }
  done
  for d in "${DIRS[@]}"; do
    [[ -d "$src/$d" ]] || continue
    # -c: compare content, so a mtime skew is not reported as a difference
    # -l: a symlink is a symlink on both sides, never a copy and never skipped
    while read -r line; do echo "$d/: $line"; changed=1; done < <(rsync -rlcin --delete "$src/$d/" "$dst/$d/" | grep -v '^\.d')
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

# -P on cp and -l on rsync: a link crosses as a link. Without them cp flattens
# it into a copy of its destination and rsync drops it entirely.
for f in "${FILES[@]}"; do
  [[ -e "$src/$f" || -L "$src/$f" ]] || continue
  cp -Pp "$src/$f" "$dst/$f"
done
for d in "${DIRS[@]}"; do
  [[ -d "$src/$d" ]] || continue
  rsync -rlc --delete "$src/$d/" "$dst/$d/"
done

# It has to pass where it now lives, not only where it was written.
(cd "$dst" && bun test launch.test.mjs)

if [[ -z "$(git -C "$repo" status --porcelain -- worker/launch-config)" ]]; then
  echo "already at config@$sha — nothing to commit"
  exit 0
fi

# Path-scoped add AND commit: ccc-statusd is a multi-agent working tree, so
# every other dirty file and anything already staged must stay out of this one.
git -C "$repo" add -A -- worker/launch-config
git -C "$repo" commit -q -m "launch-config: vendor config@$sha — $(git -C "$src" log -1 --format=%s)" -- worker/launch-config
git -C "$repo" --no-pager log -1 --oneline
