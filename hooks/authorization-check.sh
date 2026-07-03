#!/usr/bin/env bash
# PreToolUse (Bash): when the command is state-changing / outward-facing
# (gh issue/pr create-edit, git push, gh api writes, heroku config:set, gh
# label changes), inject a non-blocking reminder to verify Josh explicitly
# authorized the action. Added 2026-07-03 after three same-day incidents of
# acting on questions ("...!?"). See memory no-unauthorized-token-spend.
# Reminder only — does not block.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_input',{}).get('command',''))" 2>/dev/null || true)

if printf '%s' "$cmd" | grep -qE 'gh (issue|pr|label|release|repo) (create|edit|close|delete|merge|comment)|git push|gh api[^|]*-(X|-method) *(POST|PATCH|PUT|DELETE)|heroku config:set|gh pr ready'; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"AUTHORIZATION CHECK: this command changes external state. Did Josh EXPLICITLY authorize it with an imperative (go/do it/fix it/create it)? If his latest message contains a ? (incl. !?), it is a QUESTION — answer it instead and end with: say go if you want it done. Rule: no-unauthorized-token-spend."}}'
fi
exit 0
