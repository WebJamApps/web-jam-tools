#!/usr/bin/env bash
# agy-hook-shim.sh — the translation shim (web-jam-tools#432).
#
# Registered by scripts/install-hooks.sh, once per (matcher, hook) pair, into
# the agy-side hooks file ONLY (~/.gemini/config/hooks.json). Never wired
# into Claude Code's settings.json — Claude's own PreToolUse matcher/veto
# mechanism already works and needs no translation.
#
# Usage: agy-hook-shim.sh <PreToolUse|PostToolUse> <base64-matcher> <target-hook-path>
#
# All logic lives in hooks/lib/agy_hook_shim.ts (unit-tested directly); this
# is a thin wrapper, same pattern as every other hook in this directory.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
exec deno run --no-config --allow-read --allow-run --allow-env "$HOOK_DIR/lib/agy_hook_shim.ts" "$@"
