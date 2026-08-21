#!/usr/bin/env bash
# PreToolUse guard: hard-refuse (exit 2) the 17 irreversible operations (R-24 & R-25).
# Hands Josh the runnable command to execute manually in a separate terminal outside Claude Code.
#
# Decision logic for the `tool_input.command` checks lives in
# hooks/lib/check_irreversible_operations.ts (web-jam-tools#524) — this script
# is a thin wrapper: it extracts the tool call from stdin JSON, hands the raw
# Bash command to the Deno lib, and turns a BLOCK result into Josh's
# runnable-command message. The MCP tool_name checks (delete_file,
# merge_pull_request) stay here since they match a JSON field name directly,
# not free-form text, so they were never exposed to the heredoc/quoting bug.
#
# SCOPE: this guard only ever sees a Bash tool_input.command string and an
# MCP tool_name. It does NOT see Write/Edit file writes, and it does NOT see
# anything agy does internally — agy's own hooks are inert
# (web-jam-tools#432 "agy hooks do not enforce — all 12 are inert on Flash,
# and a Stop/SessionStart entry kills the whole config; fix that, then give
# Antigravity Gmail MCP fenced by a working hook"). Do not widen this guard to
# compensate for that gap.
set -euo pipefail

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // .toolCall.name // empty' 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // .toolCall.args.CommandLine // empty' 2>/dev/null || true)

block() {
  local desc="$1" runnable="$2"
  echo "BLOCKED (irreversible operation guard): $desc" >&2
  echo "This operation is irreversible and hard-blocked for AI autonomy." >&2
  echo "To perform this operation, run the following command in a separate terminal outside Claude Code:" >&2
  echo "" >&2
  echo "    $runnable" >&2
  echo "" >&2
  echo "(Do NOT use the ! prefix inside Claude Code, as that lands output in the transcript.)" >&2
  exit 2
}

# MCP tools check (R-24)
if [[ "$tool_name" =~ delete_file$ ]]; then
  block "GitHub MCP delete_file" "gh api -X DELETE repos/OWNER/REPO/contents/PATH"
fi
if [[ "$tool_name" =~ merge_pull_request$ ]]; then
  block "GitHub MCP merge_pull_request" "gh pr merge <PR_NUMBER>"
fi

if [ -n "$cmd" ]; then
  HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
  stderr_file=$(mktemp)
  trap "rm -f '$stderr_file'" EXIT

  result=$(CMD_FOR_PY="$cmd" deno run --allow-env "$HOOK_DIR/lib/check_irreversible_operations.ts" 2>"$stderr_file") || true

  # Fails CLOSED: this is a destructive-operation guard, unlike the agy
  # cost-control guard which deliberately fails open. If the lib couldn't be
  # evaluated at all (deno missing/crashed, empty output), block rather than
  # let an unparseable command through.
  if [ -z "$result" ]; then
    stderr_output=$(cat "$stderr_file" 2>/dev/null || echo "")
    if [ -z "$stderr_output" ]; then
      stderr_output="(no error output available)"
    fi
    block "irreversible operation (guard could not evaluate the command — failing closed: $stderr_output)" "$cmd"
  fi
  if [ "$result" != "OK" ]; then
    block "${result#BLOCK:}" "$cmd"
  fi
fi

exit 0
