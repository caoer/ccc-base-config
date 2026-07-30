#!/bin/sh
# Report ucc session identity to herdr as display-only pane metadata.
#
# SessionStart bootstrap: labels the pane before its first prompt. Since the
# [herdr] hooks.toml table landed, this script is a thin shim — the report's
# CONTENT (token vocabulary, display fields, method) is composed by
# `ccc-statusd hook herdr-identity` from the same config the per-turn owner
# (the daemon's UserPromptSubmit/Stop repaint) uses, so the two writers can
# never drift. Customize the report in $UCC_HOME/hooks.toml [herdr]; see
# ccc-base HOOKS.md § The [herdr] table.
#
# SessionStart survives `ccc-statusd config generate` (it does not manage
# that array) — but on nix-managed hosts osfiles' ucc-settings.nix
# wholesale-copies every profile's settings.json on `osf rebuild`, wiping
# SessionStart with everything else. The entry MUST be declared in
# ucc-settings.nix there; install.sh (this directory) is the durable sweep
# only on non-nix hosts, and the repair command right after a wipe.
#
# Inert outside a herdr pane.

set -eu

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0

CCC_STATUSD="${CCC_STATUSD_BIN:-$HOME/.local/bin/ccc-statusd}"
[ -x "$CCC_STATUSD" ] || exit 0

exec "$CCC_STATUSD" hook herdr-identity
