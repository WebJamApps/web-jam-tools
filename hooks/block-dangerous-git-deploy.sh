#!/usr/bin/env bash
# PreToolUse guard (Bash): HARD-BLOCK outward/irreversible actions Claude must
# never take autonomously — PR merges, branch-protection changes, pushes to
# protected branches (main/dev), and production deploys. Josh performs these
# himself; Claude proposes and STOPS.
#
# Decision logic for the `tool_input.command` checks lives in
# hooks/lib/check_dangerous_git_deploy.ts — this script is a thin wrapper: it
# extracts the Bash command from stdin JSON, hands it to the Deno lib, and
# turns a BLOCK result into Josh's decision-required message below. The lib
# does real shell tokenization (heredoc bodies, quoted strings, and `#`
# comments are never mistaken for a real command) — same pattern as
# hooks/lib/check_irreversible_operations.ts (web-jam-tools#524).
#
# See memory: never-merge-or-deploy-without-permission. Exit 2 = block
# (stderr is shown to the model). Added 2026-06-15 after an unauthorized
# `gh pr merge --admin` dev->main that triggered a production deploy.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // .toolCall.args.CommandLine // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

block() {
  echo "BLOCKED (merge/deploy guard): $1" >&2
  echo "This is Josh's action to perform, not Claude's: propose it and STOP, let Josh run it himself." >&2
  echo "(rule: never-merge-or-deploy-without-permission — do NOT retry or work around this block)" >&2
  exit 2
}

# A command this guard could not read is refused with its own message
# (web-jam-tools#1422): nothing was identified, so it never says a merge or
# deploy was found and never sends the agent to Josh. The agent may restate
# the same action in a readable form, which comes back through this guard.
could_not_read() {
  echo "BLOCKED (merge/deploy guard): could not read the command; no protected operation was identified." >&2
  echo "$1" >&2
  echo "You may restate the same action in a form this guard can read. The restated command must be checked by this same guard." >&2
  echo "Do not change what the command does. Report this parsing or evaluation gap at the end of the turn." >&2
  exit 2
}

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
stderr_file=$(mktemp)
trap 'rm -f "$stderr_file"' EXIT

if ! result=$(CMD_FOR_PY="$cmd" "$HOOK_DIR/lib/run_hook.sh" --group safety --name block-dangerous-git-deploy deno run --no-config --allow-env "$HOOK_DIR/lib/check_dangerous_git_deploy.ts" 2>"$stderr_file"); then
  could_not_read "guard could not evaluate the command — failing closed: $(cat "$stderr_file")"
fi

# Fails CLOSED: this is a destructive-operation guard. If the lib couldn't be
# evaluated at all (deno missing/crashed, empty output), refuse rather than
# let an unparseable command through.
if [ -z "$result" ]; then
  stderr_output=$(cat "$stderr_file" 2>/dev/null || true)
  could_not_read "guard could not evaluate the command — failing closed: ${stderr_output:-(no error output available)}"
fi
case "$result" in
  OK) ;;
  UNREADABLE:*) could_not_read "${result#UNREADABLE:}" ;;
  BLOCK:*) block "${result#BLOCK:}" ;;
  *) could_not_read "guard could not evaluate the command — unexpected checker response" ;;
esac

exit 0
