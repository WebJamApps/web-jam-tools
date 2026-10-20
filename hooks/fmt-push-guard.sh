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

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

# Run fmt:check from the repo root through the shared hook runner
fmt_status=0
fmt_out=$(cd "$top" && "$HOOK_DIR/lib/run_hook.sh" --group workflow --name fmt-push-guard --event PreToolUse deno eval '
  const cmd = new Deno.Command("deno", { args: ["task", "fmt:check"], stderr: "piped", stdout: "piped" });
  const out = await cmd.output();
  if (out.code === 0) Deno.exit(0);
  const text = new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout);
  if (text.includes("not formatted") || text.includes("Checked")) {
    console.error("BLOCKED: Formatting issues detected. Fix them before pushing:\n  cd \"" + Deno.cwd() + "\" && deno task fmt\n(rule: fmt-push-guard)");
    Deno.exit(2);
  }
  throw new Error(text || "fmt:check failed");
' 2>&1) || fmt_status=$?

if [ "$fmt_status" -eq 2 ]; then
  printf '%s\n' "$fmt_out" >&2
  exit 2
elif [[ "$fmt_out" == *'"hookSpecificOutput"'* ]]; then
  printf '%s\n' "$fmt_out"
  exit 0
fi

exit 0
