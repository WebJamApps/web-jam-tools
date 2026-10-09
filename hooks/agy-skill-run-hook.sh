#!/usr/bin/env bash
# agy-skill-run-hook.sh — agy PreToolUse hook for skill runs (web-jam-tools#1319).
#
# Answers agy directly on stdout rather than through hooks/agy-hook-shim.sh,
# rewriting run_command terminal commands into calls of scripts/agy-skill-run.sh
# when a skill run is open.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
out=""
if ! out=$(deno run --no-config --allow-read --allow-env "$HOOK_DIR/lib/check_agy_skill_run.ts"); then
  echo '{"decision":"allow"}'
  exit 0
fi

if [ -z "$out" ]; then
  echo '{"decision":"allow"}'
else
  printf '%s\n' "$out"
fi
exit 0
