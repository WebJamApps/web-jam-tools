#!/usr/bin/env bash
# PreToolUse guard: hard-refuse (exit 2) the 17 irreversible operations (R-24 & R-25).
# Hands Josh the runnable command to execute manually in a separate terminal outside Claude Code.
#
# Decision logic for the `tool_input.command` checks lives in
# hooks/lib/check_irreversible_operations.ts (web-jam-tools#524) — this script
# is a thin wrapper: it extracts the tool call from stdin JSON, hands the raw
# Bash command to the Deno lib, and turns a BLOCK result into Josh's
# runnable-command message. The MCP tool_name checks (GitHub operations and
# Part R's named tools and server-scoped backstop) stay here since they match
# a JSON field directly, not free-form text, so they were never exposed to
# the heredoc/quoting bug.
#
# SCOPE: this guard only ever sees a Bash tool_input.command string and an
# MCP tool_name. It does NOT see Write/Edit file writes. Claude Code and Codex
# invoke the installed symlink directly; agy reaches this same script through
# its existing shim registration. No registration changes are needed for content fixes.
set -euo pipefail

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -rs 'select(length == 1) | .[0] | (.tool_name // .toolCall.name) | select(type == "string" and test("^[^[:space:]]+$"))' 2>/dev/null || true)
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

could_not_read() {
  echo "BLOCKED (irreversible operation guard): could not read the command; no protected operation was identified." >&2
  echo "$1" >&2
  echo "You may restate the same action in a form this guard can read. The restated command must be checked by this same guard." >&2
  echo "Do not change what the command does. Report this parsing or evaluation gap at the end of the turn." >&2
  exit 2
}

block_mcp() {
  echo "BLOCKED (irreversible operation guard): MCP tool $tool_name" >&2
  echo "This operation is irreversible and hard-blocked for AI autonomy." >&2
  echo "Stop and report this refusal to Josh; do not retry through another route." >&2
  echo "Josh must perform this operation in the service's own interface outside the agent." >&2
  exit 2
}

[ -n "$tool_name" ] || could_not_read "guard could not read a nonempty string tool name — failing closed"

# REAPER's local DAW operations are outside this guard's MCP scope. Check
# its prefix before suffix rules so even midi_delete_file remains exempt.
[[ "$tool_name" == mcp__reaper__* ]] && exit 0

# MCP tools check (R-24)
if [[ "$tool_name" =~ delete_file$ ]]; then
  block "GitHub MCP delete_file" "gh api -X DELETE repos/OWNER/REPO/contents/PATH"
fi
if [[ "$tool_name" =~ merge_pull_request$ ]]; then
  block "GitHub MCP merge_pull_request" "gh pr merge <PR_NUMBER>"
fi

# Part R's literal irreversible tools (R-38). Keep these explicit, independently
# of the backstop, so each named capability has its own control test.
case "$tool_name" in
  mcp__google-drive__deleteCalendarEvent|mcp__google-drive__deleteComment|\
  mcp__google-drive__deleteGoogleSlide|mcp__google-drive__deleteSlideElement|\
  mcp__google-drive__deleteSheet|mcp__google-drive__deleteRange|\
  mcp__gmail__delete_email|mcp__gmail__batch_delete_emails|\
  mcp__gmail__delete_filter|mcp__gmail__delete_label|\
  mcp__claude_ai_Gmail__delete_label)
    block_mcp
    ;;
esac

case "$tool_name" in
  mcp__google-drive__deleteItem)
    # Drive deleteItem is recoverable Trash and remains in the permission
    # layer's ask tier (R-39 / D-30).
    ;;
  mcp__google-drive__*|mcp__gmail__*|mcp__claude_ai_Gmail__*|\
  mcp__claude_ai_Google_Drive__*|mcp__claude_ai_Dropbox__*)
    # Strip the MCP and server prefixes; inspect the tool name, not its arguments.
    mcp_tool="${tool_name#*__}"
    mcp_tool="${mcp_tool#*__}"
    case "${mcp_tool,,}" in
      *delete*|*destroy*|*remove*|*purge*|*wipe*) block_mcp ;;
    esac
    ;;
esac

if [ -n "$cmd" ]; then
  HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
  stderr_file=$(mktemp)
  trap "rm -f '$stderr_file'" EXIT

  if ! result=$(CMD_FOR_PY="$cmd" "$HOOK_DIR/lib/run_hook.sh" --group safety --name block-irreversible-operations deno run --no-config --allow-env "$HOOK_DIR/lib/check_irreversible_operations.ts" 2>"$stderr_file"); then
    could_not_read "guard could not evaluate the command — failing closed: $(cat "$stderr_file")"
  fi

  # Fails CLOSED: this is a destructive-operation guard, unlike the agy
  # cost-control guard which deliberately fails open. If the lib couldn't be
  # evaluated at all (deno missing/crashed, empty output), block rather than
  # let an unparseable command through.
  if [ -z "$result" ]; then
    stderr_output=$(cat "$stderr_file" 2>/dev/null || echo "")
    if [ -z "$stderr_output" ]; then
      stderr_output="(no error output available)"
    fi
    could_not_read "guard could not evaluate the command — failing closed: $stderr_output"
  fi
  case "$result" in
    OK) ;;
    UNREADABLE:*) could_not_read "${result#UNREADABLE:}" ;;
    BLOCK:*) block "${result#BLOCK:}" "$cmd" ;;
    *) could_not_read "guard could not evaluate the command — unexpected checker response" ;;
  esac
fi

exit 0
