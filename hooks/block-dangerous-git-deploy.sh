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

# A checker that ran but gave no verdict, or one this script does not
# recognise, is a guard that could not run (command-reader design, "Checker
# that could not run"): every command would meet the same failure, so the
# agent stops and reports rather than restating the command.
could_not_run() {
  echo "BLOCKED (block-dangerous-git-deploy): safety guard could not run ($1). Refusing action (safety default: fail closed)." >&2
  echo "Stop and report this refusal to Josh; do not retry the action through another route." >&2
  exit 2
}

if ! HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd); then
  could_not_run "could not find the guard's own directory"
fi
if ! stderr_file=$(mktemp 2>/dev/null) || [ -z "$stderr_file" ]; then
  could_not_run "could not create a file to capture the checker's errors"
fi
trap 'rm -f "$stderr_file"' EXIT

# The shared runner refuses on its own when the checker crashes, times out or
# Deno is missing; that standard refusal is passed through as it stands. A
# runner that fails without it gets the same guard-failure response here, so
# a failure never ends with an empty or partial message.
runner_status=0
result=$(CMD_FOR_PY="$cmd" "$HOOK_DIR/lib/run_hook.sh" --group safety --name block-dangerous-git-deploy deno run --no-config --allow-env "$HOOK_DIR/lib/check_dangerous_git_deploy.ts" 2>"$stderr_file") || runner_status=$?
if [ "$runner_status" -ne 0 ]; then
  if grep -q '^BLOCKED (block-dangerous-git-deploy): safety guard could not run (' "$stderr_file" 2>/dev/null; then
    cat "$stderr_file" >&2
    exit 2
  fi
  could_not_run "the shared runner failed with exit code $runner_status and gave no refusal"
fi

# A refusal verdict names what the checker found on one line. A refusal marker
# with no description, or one spread over several lines, is not a verdict.
has_description() {
  case "$1" in
    *$'\n'*) return 1 ;;
  esac
  [[ "$1" =~ [^[:space:]] ]]
}

case "$result" in
  OK) ;;
  UNREADABLE:*)
    has_description "${result#UNREADABLE:}" || could_not_run "checker gave an UNREADABLE verdict without a description"
    could_not_read "${result#UNREADABLE:}"
    ;;
  BLOCK:*)
    has_description "${result#BLOCK:}" || could_not_run "checker gave a BLOCK verdict without a description"
    block "${result#BLOCK:}"
    ;;
  "") could_not_run "checker gave no verdict" ;;
  *) could_not_run "checker gave an unrecognised verdict: $(printf '%s' "$result" | head -n 1 | cut -c1-200)" ;;
esac

exit 0
