#!/usr/bin/env bash
# Codex-only PreToolUse Gmail safety fence. The shared classifier owns the policy.
#
# Codex blocks only on exit 2 with a reason on stderr and logs any other nonzero exit as a hook
# error, so every way this fence can fail to reach a verdict (the shared runner cannot start, or it
# fails before its own safety fallback, e.g. reading stdin) is turned into the same refusal the
# runner gives when the classifier crashes.
set -uo pipefail

NAME="block-codex-gmail-write"

refuse() {
  echo "BLOCKED ($NAME): safety guard could not run ($1). Refusing action (safety default: fail closed)." >&2
  echo "Stop and report this refusal to Josh; do not retry the action through another route." >&2
  exit 2
}

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)" ||
  refuse "the hook directory could not be resolved"

status=0
"$HOOK_DIR/lib/run_hook.sh" --group safety --name "$NAME" \
  --event PreToolUse deno run --no-config "$HOOK_DIR/lib/check_codex_gmail_write.ts" || status=$?

case "$status" in
  0 | 2) exit "$status" ;;
  *) refuse "the shared hook runner exited $status" ;;
esac
