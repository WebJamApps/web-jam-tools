#!/usr/bin/env bash
# PreToolUse guard: check issue citations in bodies written to GitHub (web-jam-tools#1056).
# Reuses hooks/lib/detect_bare_issue_refs.ts against bodies written via:
#   - Bash: gh pr comment, gh pr review, gh issue comment, gh issue create, gh issue edit
#     (and guarded task equivalents: post-pr-comment, post-pr-review, post-issue-comment, edit-issue, create-issue)
#   - MCP: issue_write, pull_request_review_write, add_comment_to_pending_review,
#     add_reply_to_pull_request_comment, update_issue_comment, add_issue_comment
#
# Fail OPEN on parse errors (workflow guard, D-16, D-20). Exit 2 on bare citation (stderr shown to model).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"/.. && pwd)"
CHECKER="$REPO_DIR/hooks/lib/check_issue_citation_on_write.ts"

input=$(cat)

result=$(printf '%s' "$input" | deno run --no-config --allow-env --allow-read "$CHECKER" 2>/dev/null) || true

if [ -z "$result" ]; then
  exit 0
fi

case "$result" in
  PASS)
    exit 0
    ;;
  PASS:*)
    note="issue-citation guard: ${result#PASS: }"
    jq -cn --arg note "$note" '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $note}}' 2>/dev/null || true
    exit 0
    ;;
  DENY:*)
    printf '%s\n' "${result#DENY:}" >&2
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
