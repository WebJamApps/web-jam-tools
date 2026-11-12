#!/usr/bin/env bash
# PreToolUse guard (Bash): denies the four raw `gh` write verbs this repo
# gates behind guarded `deno task` commands — `gh pr review`, `gh pr
# comment`, `gh issue comment`, `gh issue edit` (web-jam-tools#685).
#
# Rationale: an Agent-tool-dispatched subagent runs in an independent
# permission context and does not inherit permissions.allow, so a raw write
# verb sitting under `permissions.ask` dead-ends with no human present to
# answer the prompt. A hook is enforcement, not a permission rule — hooks
# are proven to fire inside a dispatched subagent, unlike permission rules —
# so it denies the raw verb outright and points at the guarded `deno task`
# equivalent, which the four scripts/gh-write/* CLIs (post-pr-review.ts,
# post-pr-comment.ts, post-issue-comment.ts, edit-issue.ts) can complete
# without a human present. This is why raw `gh pr review` etc. stop working
# for everyone, Josh included — a hook cannot distinguish an interactive
# human from a headless agent the way an `ask` prompt could.
#
# Registered on Bash for BOTH surfaces by scripts/install-hooks.sh: directly
# into Claude Code's settings.json, and via hooks/agy-hook-shim.sh
# (unmodified — this hook needs no agy-specific code) into agy's
# ~/.gemini/config/hooks.json.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

NOTE_FILE=$(mktemp)
trap 'rm -f "$NOTE_FILE"' EXIT

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
message=$(CMD_FOR_PY="$cmd" "$HOOK_DIR/lib/run_hook.sh" --group workflow --name block-raw-gh-write --note-file "$NOTE_FILE" deno run --no-config --allow-env "$HOOK_DIR/lib/check_raw_gh_write.ts")

if [ -s "$NOTE_FILE" ]; then
  cat "$NOTE_FILE"
  exit 0
fi

if [ -n "$message" ]; then
  echo "$message" >&2
  exit 2
fi

exit 0
