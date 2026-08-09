#!/usr/bin/env bash
# PreToolUse guard: hard-refuse (exit 2) the 17 irreversible operations (R-24 & R-25).
# Hands Josh the runnable command to execute manually in a separate terminal outside Claude Code.
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
  # Normalize command string
  c=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')

  # 1) gh repo delete
  if printf '%s' "$c" | grep -Eq 'gh +repo +delete( |$)'; then
    block "'gh repo delete'" "$cmd"
  fi

  # 2) gh label delete
  if printf '%s' "$c" | grep -Eq 'gh +label +delete( |$)'; then
    block "'gh label delete'" "$cmd"
  fi

  # 3) gh project delete
  if printf '%s' "$c" | grep -Eq 'gh +project +delete( |$)'; then
    block "'gh project delete'" "$cmd"
  fi

  # 4) gh project item-delete
  if printf '%s' "$c" | grep -Eq 'gh +project +item-delete( |$)'; then
    block "'gh project item-delete'" "$cmd"
  fi

  # 5) gh project field-delete
  if printf '%s' "$c" | grep -Eq 'gh +project +field-delete( |$)'; then
    block "'gh project field-delete'" "$cmd"
  fi

  # 6) heroku addons:destroy
  if printf '%s' "$c" | grep -Eq 'heroku +addons:destroy( |$)'; then
    block "'heroku addons:destroy'" "$cmd"
  fi

  # 8) gh auth token
  if printf '%s' "$c" | grep -Eq 'gh +auth +token( |$)'; then
    block "'gh auth token' (credential exposure)" "$cmd"
  fi

  # 9) gh issue delete
  if printf '%s' "$c" | grep -Eq 'gh +issue +delete( |$)'; then
    block "'gh issue delete'" "$cmd"
  fi

  # 10) gh run delete
  if printf '%s' "$c" | grep -Eq 'gh +run +delete( |$)'; then
    block "'gh run delete'" "$cmd"
  fi

  # 11) gh repo sync --force
  if printf '%s' "$c" | grep -Eq 'gh +repo +sync +.*--force( |$)'; then
    block "'gh repo sync --force'" "$cmd"
  fi

  # 12) gh issue transfer
  if printf '%s' "$c" | grep -Eq 'gh +issue +transfer( |$)'; then
    block "'gh issue transfer'" "$cmd"
  fi

  # 13) gh repo rename
  if printf '%s' "$c" | grep -Eq 'gh +repo +rename( |$)'; then
    block "'gh repo rename'" "$cmd"
  fi

  # 14) gh workflow run
  if printf '%s' "$c" | grep -Eq 'gh +workflow +run( |$)'; then
    block "'gh workflow run'" "$cmd"
  fi

  # 15) gh pr merge
  if printf '%s' "$c" | grep -Eq 'gh +pr +merge( |$)'; then
    block "'gh pr merge'" "$cmd"
  fi

  # 17) Remote branch deletion via git push (--delete, -d, or :branch)
  if printf '%s' "$c" | sed -E 's/(\&\&|\|\||;|\|)/\n/g' \
    | grep -Eq 'git +push +(.* +)?((--delete|-d)( |$)|[[:space:]"'\'']*:[^ ]+)'; then
    block "remote branch deletion via 'git push'" "$cmd"
  fi
fi

exit 0
