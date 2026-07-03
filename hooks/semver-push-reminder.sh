#!/usr/bin/env bash
# PreToolUse (Bash): when the command is a `git push`, inject a non-blocking
# reminder to bump the semver version field. See memory
# git-feature-branch-and-semver. Reminder only — does not block the push.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)

case "$cmd" in
  *"git push"*)
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"SEMVER REMINDER: before pushing, bump the version field (package.json / deno.json) — patch=fix, minor=feature, major=breaking. Rule: git-feature-branch-and-semver."}}'
    ;;
esac
exit 0
