#!/bin/sh
# Remove per-profile `verbose` overrides (and `model` only on claude-account
# profiles) from every ~/.local/share/ucc/profiles/*/settings.json.
#
# Endpoint profiles (ANTHROPIC_BASE_URL in .env) KEEP settings.json `model`:
# the TUI /model picker writes it there, and with no --model flag the harness
# reads it natively — that is what makes the choice stick across restarts.
# launch.ts itself emits no model on a non-Anthropic endpoint (a foreign
# provider serves foreign ids, so no default is guessed). Stripping the key
# made the picker look broken ("won't save").
#
# Claude-account profiles still drop `model`: launch.ts owns --model for them.
# Idempotent — safe to re-run after new profiles are created.
set -eu

for f in "$HOME"/.local/share/ucc/profiles/*/settings.json; do
  dir=$(dirname "$f")
  envf="$dir/.env"
  is_endpoint=0
  if [ -f "$envf" ] && grep -q '^ANTHROPIC_BASE_URL=.' "$envf" 2>/dev/null; then
    is_endpoint=1
  fi
  if [ "$is_endpoint" -eq 1 ]; then
    jq -e 'del(.verbose)' "$f" > "$f.tmp"
  else
    jq -e 'del(.model, .verbose)' "$f" > "$f.tmp"
  fi
  mv "$f.tmp" "$f"
  echo "cleaned: $f (endpoint=$is_endpoint)"
done
