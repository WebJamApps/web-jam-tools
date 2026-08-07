#!/usr/bin/env bash
# PreToolUse guard (Bash): Match gh api commands to enforce consent rules (R-6).
# - Deny (exit 2) if method is DELETE (-X DELETE / --method DELETE).
# - Force prompt (JSON ask) if method is POST/PUT/PATCH or field flags are passed.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // .toolCall.args.CommandLine // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

# Check if command includes `gh api`
if ! printf '%s' "$cmd" | grep -Eq 'gh +api( |$)'; then
  exit 0
fi

# Lowercase the command string for uniform inspection
lc_cmd=$(printf '%s' "$cmd" | tr '[:upper:]' '[:lower:]')

# Check for DELETE method
if printf '%s' "$lc_cmd" | grep -Eq '(-x|--method) +delete|(-xdelete|--method=delete)'; then
  echo "BLOCKED (gh api guard): gh api DELETE is denied (irreversible state change)." >&2
  echo "This is Josh's decision to make — propose the command and let Josh run it manually." >&2
  exit 2
fi

# Check for state-changing methods (POST, PUT, PATCH) or field flags (-f, -F, --raw-field, --field, --input)
if printf '%s' "$lc_cmd" | grep -Eq '(-x|--method) +(post|put|patch)|(-xpost|-xput|-xpatch|--method=post|--method=put|--method=patch)|(-f|-f=|--field|--raw-field|--input)'; then
  jq -cn '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"gh api state-changing command requires user confirmation"}}'
  exit 0
fi

exit 0
