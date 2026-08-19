#!/usr/bin/env bash
# PreToolUse (Bash): when the command is a real `git push`, inject a
# non-blocking reminder to bump the semver version field (package.json /
# deno.json) — UNLESS the branch has already bumped it since its
# merge-base with origin/dev, in which case emit a confirmation instead:
# a second bump on the same PR is a defect, not a to-do. See memory
# git-feature-branch-and-semver. Reminder only — never blocks the push,
# never exits non-zero (web-jam-tools#648).
#
# Push detection (item 5, web-jam-tools#648): the old `case "$cmd" in
# *"git push"*)` matched the substring anywhere in the command text,
# including inside a heredoc body or a quoted argument — so writing
# documentation *about* pushing tripped it (observed live while filing
# #648 itself: the heredoc for the issue body mentions "git push" in its
# "How to test locally" section). Heredoc BODIES that are consumed as data
# (not fed to an interpreter) are stripped first via the shared
# hooks/lib/normalize_command.ts (same lib block-secret-dumps.sh already
# shells out to — the only other Bash hook that does; everything else that
# imports the lib is TypeScript already running inside Deno, so it pays no
# extra process spawn and isn't comparable to what this hook is doing),
# then quoted-string CONTENTS are stripped,
# then a real `git push` is matched only at the start of a shell segment
# (the whole command, or right after a `;`/`&&`/`||`/`|`/newline operator)
# — never as a bare substring.
#
# Branch-awareness (items 1-4): resolves the branch's merge-base with
# origin/dev, compares the version field there against the working tree's
# current value, and picks the reminder or the confirmation accordingly.
# Every git invocation is guarded (`|| true` / `||` fallback) so a failing
# git call under `set -euo pipefail` cannot make this hook exit non-zero —
# any indeterminate case (no cwd, not a git repo, no origin/dev ref,
# detached HEAD, no version file) FAILS OPEN to the reminder: a spurious
# nag is cheap, a suppressed reminder on an unbumped branch is the bug this
# hook exists to prevent.
set -euo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)

[ -z "$cmd" ] && exit 0

# Fast path (performance; web-jam-tools#649 finding 1): this hook is
# registered as a PreToolUse Bash hook, so it fires on EVERY Bash tool call
# in the session — every `ls`, `cat`, `gh ...` — not just pushes. The Deno
# call below spawns a process to normalize the command (~26ms measured),
# which is wasteful to pay on every single Bash call. Cheap pre-filter: if
# the RAW command text does not contain BOTH "git" and "push" as
# substrings, no amount of normalization can ever turn it into a real
# `git push` match — every step after the Deno call (heredoc stripping,
# quote stripping, segment matching) only ever REMOVES text, never adds
# it, so a command lacking these raw substrings can never end up matching.
# This is a fast path, not a replacement: any command that survives it
# still goes through the full normalization + segment matching below.
if [[ "$cmd" != *git* || "$cmd" != *push* ]]; then
  exit 0
fi

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)

# Strip heredoc BODIES that are consumed as data (INTERPRETER-fed bodies,
# e.g. `bash <<EOF`, stay in scope — see normalize_command.ts).
no_heredoc=$(CMD_FOR_PY="$cmd" NORMALIZE_MODE=heredoc-only \
  deno run --allow-env "$HOOK_DIR/lib/normalize_command.ts" 2>/dev/null) || true
[ -z "$no_heredoc" ] && no_heredoc="$cmd"

# Strip quoted-string CONTENTS (both quote styles) so `git push` mentioned
# inside a quoted argument doesn't match either. This is a non-blocking
# reminder hook, not a deny guard, so a naive quote-stripper is an
# acceptable heuristic here.
#
# One alternation pass, not two sequential passes (web-jam-tools#649 Must
# Fix 1): a sequential single-quote-then-double-quote pass cannot tell an
# apostrophe inside a double-quoted string from a real single-quote
# delimiter, so e.g. `git commit -m "don't nag" && git push ... && gh pr
# comment ... --body "it's pushed"` had its two apostrophes mispaired,
# deleting the real `git push` between them and suppressing the reminder.
# A single alternation matches whichever quote opens first, same as a
# shell would.
unquoted=$(printf '%s' "$no_heredoc" | sed -E "s/\"[^\"]*\"|'[^']*'//g") || true
[ -z "$unquoted" ] && unquoted="$no_heredoc"

# A real `git push`: at the start of a shell segment (the whole command,
# or right after a `;`/`&&`/`||`/`|` operator or a newline) — so a leading
# `cd foo && git push ...` still fires, but `git push` embedded mid-phrase
# with no operator boundary does not.
segments=$(printf '%s' "$unquoted" | sed -E 's/(&&|\|\||[;|])/\n/g') || true
is_push=false
while IFS= read -r seg; do
  trimmed=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//') || true
  # Strip an optional leading wrapper before the git anchor
  # (web-jam-tools#649 Must Fix 2, plus delta-review follow-ups): an opening
  # `(` subshell or `{` group, a `then`/`do` keyword from an
  # `if`/`while`/`for` construct, a narrow allowlist of transparent wrapper
  # commands (sudo/env/command/time), and a leading `VAR=value` assignment
  # prefix (e.g. `FOO=bar git push`). This is deliberately NOT a loosened
  # bare substring match — item 5 of web-jam-tools#648 still requires `git
  # push` to sit at a segment boundary; only these specific, narrow prefixes
  # are peeled off first. Looped (bounded) so stacked prefixes — e.g. `time
  # sudo git push` — are peeled one layer per pass rather than just the
  # outermost one. Known limitation, left alone deliberately (delta review):
  # a wrapper carrying its own option arguments (`sudo -u joshua git push`,
  # `timeout 30 git push`) still will not match, because a bounded allowlist
  # cannot know which tokens are the wrapper's options — closing that would
  # mean loosening toward a bare substring match, which would undo item 5 of
  # web-jam-tools#648.
  candidate="$trimmed"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    stripped=$(printf '%s' "$candidate" | sed -E '
      s/^[({]+[[:space:]]*//
      s/^(then|do)[[:space:]]+//
      s/^(sudo|env|command|time)[[:space:]]+//
      s/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+//
    ') || true
    [ "$stripped" = "$candidate" ] && break
    candidate="$stripped"
  done
  if printf '%s' "$candidate" | grep -Eq '^git[[:space:]]+push([[:space:];)]|$)'; then
    is_push=true
    break
  fi
done <<<"$segments"

[ "$is_push" != true ] && exit 0

REMINDER='{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"SEMVER REMINDER: before pushing, bump the version field (package.json / deno.json) — patch=fix, minor=feature, major=breaking. Rule: git-feature-branch-and-semver."}}'

remind() {
  printf '%s' "$REMINDER"
  exit 0
}

# No cwd in the payload -> indeterminate -> fail open.
[ -z "$cwd" ] && remind

top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || true
[ -z "$top" ] && remind # cwd is not a git repo -> fail open

# Detached HEAD -> indeterminate (no branch to compare) -> fail open.
branch=$(git -C "$top" symbolic-ref --short -q HEAD 2>/dev/null) || true
[ -z "$branch" ] && remind

# No origin/dev ref locally (may not have been fetched at hook time) ->
# indeterminate -> fail open.
git -C "$top" rev-parse --verify -q origin/dev >/dev/null 2>&1 || remind

mergebase=$(git -C "$top" merge-base HEAD origin/dev 2>/dev/null) || true
[ -z "$mergebase" ] && remind

versionfile=""
if [ -f "$top/deno.json" ]; then
  versionfile="deno.json"
elif [ -f "$top/package.json" ]; then
  versionfile="package.json"
fi
[ -z "$versionfile" ] && remind # no version file -> fail open

old_version=$(git -C "$top" show "$mergebase:$versionfile" 2>/dev/null |
  jq -r '.version // empty' 2>/dev/null) || true
[ -z "$old_version" ] && remind

new_version=$(jq -r '.version // empty' "$top/$versionfile" 2>/dev/null) || true
[ -z "$new_version" ] && remind

if [ "$old_version" != "$new_version" ]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"SEMVER: version already bumped on this branch ('"$old_version"' -> '"$new_version"' in '"$versionfile"') since its merge-base with origin/dev — do NOT bump again; a second version bump on the same PR is a defect, not a to-do. Rule: git-feature-branch-and-semver."}}'
  exit 0
fi

remind
