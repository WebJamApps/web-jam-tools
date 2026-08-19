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
# hooks/lib/normalize_command.ts (same lib the other Bash guards use, e.g.
# block-dangerous-git-deploy.sh), then quoted-string CONTENTS are stripped,
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
unquoted=$(printf '%s' "$no_heredoc" | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g') || true
[ -z "$unquoted" ] && unquoted="$no_heredoc"

# A real `git push`: at the start of a shell segment (the whole command,
# or right after a `;`/`&&`/`||`/`|` operator or a newline) — so a leading
# `cd foo && git push ...` still fires, but `git push` embedded mid-phrase
# with no operator boundary does not.
segments=$(printf '%s' "$unquoted" | sed -E 's/(&&|\|\||[;|])/\n/g')
is_push=false
while IFS= read -r seg; do
  trimmed=$(printf '%s' "$seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  if printf '%s' "$trimmed" | grep -Eq '^git[[:space:]]+push([[:space:]]|$)'; then
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
