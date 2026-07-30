#!/usr/bin/env bash
# Install the ccc pane-identity SessionStart hook into every ucc profile.
#
# Idempotent: re-run after a ucc reinstall or when a profile is added. Pairs with
# `herdr integration install claude`, which each profile also needs — that one
# reports the session id, this one reports profile + short id for the sidebar.
#
# Usage: sh ~/.local/share/ucc/config/herdr/install.sh [--dry-run]
set -euo pipefail

UCC_HOME="${UCC_HOME:-${HOME}/.local/share/ucc}"
HOOK="${UCC_HOME}/config/herdr/ccc-pane-identity.sh"
DRY_RUN="${1:-}"

[ -f "$HOOK" ] || { echo "missing hook script: $HOOK" >&2; exit 1; }

python3 - "$UCC_HOME" "$HOOK" "$DRY_RUN" <<'PY'
import json, os, sys, tempfile

ucc_home, hook, dry_run = sys.argv[1], sys.argv[2], sys.argv[3] == "--dry-run"
command = f"sh '{hook}' identity"
added = skipped = 0

profiles = sorted(os.listdir(os.path.join(ucc_home, "profiles")))
for profile in profiles:
    path = os.path.join(ucc_home, "profiles", profile, "settings.json")
    if not os.path.isfile(path):
        continue
    with open(path, encoding="utf-8") as handle:
        settings = json.load(handle)

    hooks = settings.setdefault("hooks", {})
    entries = hooks.setdefault("SessionStart", [])
    if any(h.get("command") == command for e in entries for h in e.get("hooks", [])):
        skipped += 1
        continue

    entries.append({"matcher": "*", "hooks": [{"type": "command", "command": command, "timeout": 10}]})
    added += 1
    if dry_run:
        continue

    # Atomic replace, and only after the rendered JSON parses — a truncated
    # settings.json breaks every launch of that profile.
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".settings-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, indent=2)
            handle.write("\n")
        with open(tmp, encoding="utf-8") as handle:
            json.load(handle)
        os.replace(tmp, path)
    except Exception:
        os.path.exists(tmp) and os.unlink(tmp)
        raise

print(f"{'would add' if dry_run else 'added'}: {added}   already present: {skipped}   profiles: {len(profiles)}")
PY
