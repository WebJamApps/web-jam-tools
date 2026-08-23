#!/usr/bin/env bash
# PreToolUse guard: read the plan-gate approval token (web-jam-tools#497, not
# written by this change) and decide whether a pending issue_write /
# sub_issue_write MCP call is one Josh already approved.
#
# web-jam-tools#502 — Josh approving a filing plan should not mean the
# `ask` permission rule on mcp__*__issue_write / mcp__*__sub_issue_write
# still prompts per-issue. That `ask` rule is NOT loosened by this change
# (see docs/cross-ai-rules.md and the design doc's "guard is never loosened
# to reduce friction" rule) — instead this hook returns an explicit
# `permissionDecision` that the Claude Code PreToolUse contract honors:
#
#   - "allow": the title is in the token approved for THIS session -> the
#     call proceeds with no prompt. A hook "allow" does not bypass deny
#     rules, only the ask escalation, per the documented contract.
#   - "deny": the title is absent, or the token is missing/expired/from
#     another session -> the call is denied outright, never merely asked.
#   - no output (exit 0): this hook has no opinion (wrong tool, or an
#     issue_write call that isn't a "create") -> normal permission flow
#     (the standing `ask` rule) applies untouched.
#
# Exit code is always 0 here: a `deny` decision is carried in the JSON
# payload (permissionDecision), not via exit 2 — exit 2 would hard-block
# regardless of JSON and skip the structured reason. Same pattern as
# hooks/haiku-only-gmail-gate.sh and hooks/gh-api-guard.sh.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
input=$(cat)

result=$(printf '%s' "$input" | deno run --no-config --allow-env --allow-read "$HOOK_DIR/lib/check_issue_approval_token.ts" 2>/dev/null) || true

if [ -z "$result" ]; then
  # deno run itself failed to produce output (crash, bad Deno install, etc).
  # Fail CLOSED only for the tool calls this guard is actually responsible
  # for; anything else passes through untouched.
  if printf '%s' "$input" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"mcp__[^"]*__(issue_write|sub_issue_write)"'; then
    jq -cn '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Approval-token guard could not evaluate this call (hook parser failure) — failing closed. See hooks/lib/check_issue_approval_token.ts."}}'
  fi
  exit 0
fi

case "$result" in
  ALLOW:*)
    reason="${result#ALLOW:}"
    jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:$r}}'
    ;;
  DENY:*)
    reason="${result#DENY:}"
    jq -cn --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    ;;
  *)
    exit 0
    ;;
esac
exit 0
