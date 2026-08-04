#!/usr/bin/env bash
# PreToolUse guard (Bash): block `git push` when `deno task fmt:check` fails,
# preventing format-only CI failures. Detects a `git push` command, finds the
# repo root, and runs fmt:check. If formatting issues are found, block the push
# and advise the user to run `deno task fmt`.
#
# Rationale: CI's `deno fmt --check` step is the first place formatting drift
# is caught, so agents can burn a full CI run on whitespace. This guard catches
# it locally before the push.
#
# Exit 2 = block (stderr is shown to the model). Exit 0 = allow (silent unless
# fmt:check output is captured for logging). The hook is a no-op if the command
# is not a git push, if the repo has no deno.json, or if deno is not available.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -z "$cmd" ] && exit 0

# Collapse newlines/whitespace so multi-line commands match too
c=$(printf '%s' "$cmd" | tr '\n' ' ' | tr -s ' ')

# Check if this is a git push command
if ! printf '%s' "$c" | grep -Eq 'git +push'; then
  exit 0  # not a git push → allow
fi

# Try to find the git repo root (allows repo-relative paths in push)
# For now, assume current directory. In practice, git push runs from a repo.
dir="."

# Find the git root
top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -z "$top" ] && exit 0  # not in a git repo → allow

# Check if this is a Deno project (has deno.json)
if [ ! -f "$top/deno.json" ]; then
  exit 0  # not a Deno project → allow
fi

# Check if deno is available
if ! command -v deno &>/dev/null; then
  exit 0  # deno not available → allow (can't check anyway)
fi

# Run fmt:check from the repo root
if ! (cd "$top" && deno task fmt:check 2>&1); then
  echo "BLOCKED: Formatting issues detected. Fix them before pushing:" >&2
  echo "  cd '$top' && deno task fmt" >&2
  echo "(rule: fmt-push-guard)" >&2
  exit 2
fi

exit 0
