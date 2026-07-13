#!/bin/sh
# Remove per-profile `model` / `verbose` overrides from every
# ~/.local/share/ucc/profiles/*/settings.json so launches take those
# values from this config repo's layers (shared.md, models/*.md) instead.
# Idempotent — safe to re-run after new profiles are created.
set -eu

for f in "$HOME"/.local/share/ucc/profiles/*/settings.json; do
  jq -e 'del(.model, .verbose)' "$f" > "$f.tmp"
  mv "$f.tmp" "$f"
  echo "cleaned: $f"
done
