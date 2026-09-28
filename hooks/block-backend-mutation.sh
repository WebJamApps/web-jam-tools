#!/usr/bin/env bash
# PreToolUse guard (Bash): Prevent unauthorized HTTP mutations against the
# production backend (https://webjamsalem.herokuapp.com) and enforce skill
# boundaries between venue-mining and book-gig (web-jam-tools#1021).
#
# Classification: SAFETY GUARD.
# Prevents irreversible harm (mutated production records).
# When it cannot tell / indeterminate condition -> REFUSES (fails closed with exit 2).
# Safety guards never read the workflow off-switch.
set -euo pipefail

input=$(cat)

if [ -z "$input" ]; then
  echo "BLOCKED (backend mutation guard): Empty payload received on stdin — failing closed." >&2
  exit 2
fi

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
stderr_file=$(mktemp)
trap 'rm -f "$stderr_file"' EXIT

result=$(printf '%s' "$input" | deno run --no-config --allow-env --allow-read "$HOOK_DIR/lib/check_backend_mutation.ts" 2>"$stderr_file") || true

if [ -z "$result" ]; then
  err=$(cat "$stderr_file" 2>/dev/null || echo "")
  [ -z "$err" ] && err="check_backend_mutation.ts produced no output"
  echo "BLOCKED (backend mutation guard): Indeterminate condition ($err) — failing closed." >&2
  exit 2
fi

case "$result" in
  ALLOW:*)
    reason="${result#ALLOW:}"
    jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:$r}}'
    exit 0
    ;;
  DENY:*)
    reason="${result#DENY:}"
    echo "BLOCKED (backend mutation guard): $reason" >&2
    jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 2
    ;;
  PASS)
    exit 0
    ;;
  *)
    echo "BLOCKED (backend mutation guard): Unrecognized guard outcome ($result) — failing closed." >&2
    exit 2
    ;;
esac
