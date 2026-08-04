#!/usr/bin/env bash
# install-hooks.sh — make this repo the single source of truth for Claude Code hooks.
#
# 1. For every *.sh under <repo>/hooks/, symlink ~/.claude/hooks/<name> -> it.
#    Idempotent: already-correct symlinks are left alone. An existing REAL
#    file is backed up (never deleted) to ~/.claude/hooks/<name>.bak-<date>.
#
# 2. Idempotently merges the SessionStart hook(s) listed in
#    SESSION_START_HOOKS, the PreToolUse hook(s) (any matcher) listed in
#    PRE_TOOL_USE_HOOKS, and the permissions.deny patterns listed in
#    DENY_RULES, below into ~/.claude/settings.json (only adding entries
#    that aren't already there; every other key — permissions.allow,
#    permissions.ask, other hook events, etc. — is left untouched).
#    settings.json is backed up to settings.json.bak-<date> immediately
#    before any write, and only if a write is actually happening.
#
# Note: settings.json itself is intentionally NOT version-controlled in this
# public repo (it contains Josh's permission strings); it's backed up
# privately instead, alongside Claude Code memory (see
# scripts/backup-claude-memory.sh). SESSION_START_HOOKS / PRE_TOOL_USE_HOOKS /
# DENY_RULES below are the hooks and deny patterns THIS script keeps
# registered automatically; add a new hook's script name (+ matcher, for
# PreToolUse) or a new deny pattern there and re-run to wire it up with no
# manual settings edit (web-jam-tools#163; PreToolUse matcher generalization
# web-jam-tools#265; DENY_RULES web-jam-tools#308).
#
# DENY_RULES is purely additive and versioned here so the same deny patterns
# are both checked into the repo AND live on this laptop's real
# ~/.claude/settings.json — it never touches permissions.allow/ask, and
# never removes or reorders any existing permissions.deny entry (hand-added
# or from a previous run).
#
# Usage: scripts/install-hooks.sh [--hooks-dir PATH] [--settings-path PATH] [--agy-hooks-path PATH] [--force]
#   --hooks-dir PATH       Symlink hooks into PATH instead of $HOME/.claude/hooks
#                           (also settable via CLAUDE_HOOKS_DIR). Mainly for testing
#                           the symlink step without touching the real hooks dir.
#   --settings-path PATH   Merge into PATH instead of $HOME/.claude/settings.json
#                           (also settable via CLAUDE_SETTINGS_PATH). Mainly for
#                           testing the merge without touching a real settings file.
#                           NOTE: --settings-path alone does NOT sandbox a run —
#                           it only redirects the settings merge. The symlink step
#                           still targets $HOME/.claude/hooks (or CLAUDE_HOOKS_DIR)
#                           unless --hooks-dir is ALSO passed (web-jam-tools#273).
#   --agy-hooks-path PATH  Merge agy hooks into PATH instead of $HOME/.gemini/config/hooks.json
#                           (also settable via AGY_HOOKS_PATH).
#   --force                 Required to link into the default hooks destination when
#                           this script is running from inside a git worktree (see
#                           the worktree guard below). Not needed with --hooks-dir.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_DIR/hooks"
STAMP="$(date +%Y%m%d-%H%M%S)"

SETTINGS_PATH_EXPLICIT=0
if [ -n "${CLAUDE_SETTINGS_PATH:-}" ]; then
  SETTINGS_PATH="$CLAUDE_SETTINGS_PATH"
  SETTINGS_PATH_EXPLICIT=1
else
  SETTINGS_PATH="$HOME/.claude/settings.json"
fi

AGY_HOOKS_PATH_EXPLICIT=0
if [ -n "${AGY_HOOKS_PATH:-}" ]; then
  AGY_HOOKS_PATH="$AGY_HOOKS_PATH"
  AGY_HOOKS_PATH_EXPLICIT=1
else
  AGY_HOOKS_PATH="$HOME/.gemini/config/hooks.json"
fi

# HOOKS_DEST_IS_DEFAULT tracks whether HOOKS_DEST is still the real, live
# destination (as opposed to a caller-supplied override via --hooks-dir or
# CLAUDE_HOOKS_DIR). The worktree guard below only fires when it's still "1" —
# an explicit override is never touched by the guard, default or not
# (web-jam-tools#273).
if [ -n "${CLAUDE_HOOKS_DIR:-}" ]; then
  HOOKS_DEST="$CLAUDE_HOOKS_DIR"
  HOOKS_DEST_IS_DEFAULT=0
else
  HOOKS_DEST="$HOME/.claude/hooks"
  HOOKS_DEST_IS_DEFAULT=1
fi
FORCE=0

# SessionStart hooks this installer keeps registered in settings.json.
# Script names only (must exist under hooks/); the merge step below turns
# each into the literal command string "$HOME/.claude/hooks/<name>" (expanded
# by the shell that runs the hook, not by this installer — matches the style
# of the hooks already wired into settings.json).
SESSION_START_HOOKS=(notes-sync-reminder.sh)

# Stop hooks this installer keeps registered in settings.json (web-jam-tools#290).
# Same flat, no-matcher shape as SESSION_START_HOOKS — Stop fires
# unconditionally at the end of a turn, same as SessionStart fires
# unconditionally at the start of a session.
#
# require-issue-citation-titles.sh (web-jam-tools#311) is BLOCKING (exits 2
# on a bare issue/PR citation), unlike opus-no-delegation-warning.sh which
# is deliberately detective-only (always exits 0) — both are wired the same
# way here since Stop hooks all fire unconditionally regardless of whether
# an individual hook chooses to block.
STOP_HOOKS=(opus-no-delegation-warning.sh require-issue-citation-titles.sh)

# PreToolUse hooks this installer keeps registered in settings.json, as
# "<matcher>::<script>" pairs (web-jam-tools#265 — generalized from a
# Bash-only array so a hook can be wired to ANY PreToolUse matcher, not just
# Bash). Multiple scripts may share a matcher — each becomes its own entry
# under that matcher's "hooks" array in settings.json. Script names must
# exist under hooks/; matchers are plain PreToolUse matcher strings (a
# literal tool name, an alternation like "Edit|Write", or a regex like
# "mcp__.*__issue_write").
PRE_TOOL_USE_HOOKS=(
  "Bash::semver-push-reminder.sh"
  "Bash::block-secret-dumps.sh"
  "Bash::block-secret-literals.sh"
  "Bash::block-dangerous-git-deploy.sh"
  "Bash::authorization-check.sh"
  "Bash::fmt-push-guard.sh"
  "Bash::block-agy-non-flash-model.sh"
  "Bash|Edit|Write::block-human-only-credentials.sh"
  "Edit|Write::feature-branch-guard.sh"
  "mcp__(gmail|claude_ai_Gmail)__.*::haiku-only-gmail-gate.sh"
  "mcp__.*__issue_write::require-model-label-on-issue-create.sh"
)

# PostToolUse hooks, same "<matcher>::<script>" shape (web-jam-tools#272).
# The PreToolUse guards are blocklists and can only stop leak shapes someone
# enumerated in advance; three credentials leaked in two days in three shapes
# nobody had. This scans tool OUTPUT for credential-shaped strings instead, so
# it does not depend on knowing how the value got printed.
POST_TOOL_USE_HOOKS=(
  "Bash::scan-output-for-secrets.sh"
)

# permissions.deny patterns this installer keeps registered in settings.json
# (web-jam-tools#308). PreToolUse hooks exit with code 2 to hard-block
# unpermitted or destructive commands before execution. A deny rule is a
# genuine, deterministic refusal by the harness itself: the tool call is
# never attempted. These specifically block the ways `git push`/`git branch`
# can delete or clobber a REMOTE ref (deleting a remote branch is never
# something an agent should do without Josh explicitly naming that branch —
# see docs/cross-ai-rules.md's OPERATIONAL HARD RULES). Local branch
# cleanup (`git branch -d/-D` on a local ref, `git fetch --prune`) is
# UNAFFECTED by any of these patterns and remains permitted.
#
# Written in Claude Code's Bash permission-pattern syntax (see
# https://code.claude.com/docs/en/permissions): a bare `*` matches any
# sequence of characters including spaces and can appear at any position;
# `word *` (space before the trailing `*`) requires `word` to be followed by
# a space or end-of-string, so both "flag right after `git push`" and "flag
# after other args" need their own entries, as do "flag mid-command" and
# "flag as the last token" — hence several variants per flag below. Deny
# always wins over any matching allow rule, so these hold even if a broader
# `git push` allow rule exists.
DENY_RULES=(
  # git push --delete / -d <branch>  (explicit remote branch deletion)
  'Bash(git push --delete *)'
  'Bash(git push --delete)'
  'Bash(git push * --delete *)'
  'Bash(git push * --delete)'
  'Bash(git push -d *)'
  'Bash(git push -d)'
  'Bash(git push * -d *)'
  'Bash(git push * -d)'

  # git push <remote> :<branch>  (empty-source colon refspec — also deletes)
  'Bash(git push * :*)'

  # git push --force / -f / --force-with-lease
  'Bash(git push --force *)'
  'Bash(git push --force)'
  'Bash(git push * --force *)'
  'Bash(git push * --force)'
  'Bash(git push -f *)'
  'Bash(git push -f)'
  'Bash(git push * -f *)'
  'Bash(git push * -f)'
  'Bash(git push --force-with-lease*)'
  'Bash(git push * --force-with-lease*)'

  # git branch -D / --delete --force against a remotes/ ref (local ref
  # deletion of a REMOTE-tracking branch is out of scope of the local
  # cleanup allowance; plain local branches are untouched by this pattern)
  'Bash(git branch -D remotes/*)'
  'Bash(git branch * -D remotes/*)'
  'Bash(git branch --delete --force remotes/*)'
  'Bash(git branch * --delete --force remotes/*)'

  # git push --mirror / --prune (both can delete remote refs wholesale)
  'Bash(git push --mirror*)'
  'Bash(git push * --mirror*)'
  'Bash(git push --prune*)'
  'Bash(git push * --prune*)'
)

while [ $# -gt 0 ]; do
  case "$1" in
    --hooks-dir)
      HOOKS_DEST="$2"
      HOOKS_DEST_IS_DEFAULT=0
      shift 2
      ;;
    --settings-path)
      SETTINGS_PATH="$2"
      SETTINGS_PATH_EXPLICIT=1
      shift 2
      ;;
    --agy-hooks-path)
      AGY_HOOKS_PATH="$2"
      AGY_HOOKS_PATH_EXPLICIT=1
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$AGY_HOOKS_PATH_EXPLICIT" = "0" ] && [ "$SETTINGS_PATH_EXPLICIT" = "1" ]; then
  AGY_HOOKS_PATH="$(dirname "$SETTINGS_PATH")/hooks.json"
fi

[ -d "$HOOKS_SRC" ] || { echo "error: $HOOKS_SRC not found" >&2; exit 1; }

# --- Worktree guard (web-jam-tools#273) ---
# A git worktree is never the checkout that the live ~/.claude/hooks should
# point at: worktrees are routinely thrown away (e.g. by agent sandboxes),
# and if the symlinks are left pointing into one that then gets deleted,
# every hook silently stops firing with no signal to Josh. So: refuse to
# link into the DEFAULT destination from inside a worktree unless --force is
# passed. An explicit --hooks-dir/CLAUDE_HOOKS_DIR override is exempt — it's
# never the live destination in the first place.
if [ "$HOOKS_DEST_IS_DEFAULT" = "1" ] && [ "$FORCE" != "1" ]; then
  GIT_DIR="$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
  GIT_COMMON_DIR="$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$GIT_DIR" ] && [ -n "$GIT_COMMON_DIR" ] && [ "$GIT_DIR" != "$GIT_COMMON_DIR" ]; then
    echo "error: $REPO_DIR is a git worktree, not the primary checkout." >&2
    echo "Refusing to link into the default hooks destination ($HOOKS_DEST) from a" >&2
    echo "worktree — worktrees get deleted, which would silently strand the live" >&2
    echo "symlinks (web-jam-tools#273). Pass --hooks-dir PATH to sandbox this run," >&2
    echo "or --force if you really mean to repoint the live hooks from here." >&2
    exit 1
  fi
fi

mkdir -p "$HOOKS_DEST"

for src in "$HOOKS_SRC"/*.sh; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  dest="$HOOKS_DEST/$name"

  # Already the correct symlink → nothing to do.
  if [ -L "$dest" ] && [ "$(readlink -f "$dest")" = "$(readlink -f "$src")" ]; then
    echo "$name: ok (already linked)"
    continue
  fi

  if [ -e "$dest" ] || [ -L "$dest" ]; then
    mv "$dest" "$dest.bak-$STAMP"
    ln -s "$src" "$dest"
    echo "$name: linked (previous version backed up to $name.bak-$STAMP)"
  else
    ln -s "$src" "$dest"
    echo "$name: linked (new)"
  fi
done

# --- Merge SESSION_START_HOOKS, STOP_HOOKS and PRE_TOOL_USE_HOOKS into settings.json (idempotent) ---
merge_session_start_args=()
for name in "${SESSION_START_HOOKS[@]}"; do
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in SESSION_START_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_session_start_args+=('$HOME/.claude/hooks/'"$name")
done

merge_stop_args=()
for name in "${STOP_HOOKS[@]}"; do
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in STOP_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_stop_args+=('$HOME/.claude/hooks/'"$name")
done

merge_pre_tool_use_args=()
for entry in "${PRE_TOOL_USE_HOOKS[@]}"; do
  matcher="${entry%%::*}"
  name="${entry#*::}"
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in PRE_TOOL_USE_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_pre_tool_use_args+=("$matcher"'::$HOME/.claude/hooks/'"$name")
done

# The merge logic itself lives in its own file (web-jam-tools#265) so it can
# also be unit-tested in isolation against fixture JSON, independent of the
# symlink step above (see test/install_hooks_merge.test.ts). This installer
# as a whole — including the symlink step — is exercised end to end, always
# sandboxed via --hooks-dir/--settings-path or a redirected $HOME, in
# test/install_hooks_script.test.ts (web-jam-tools#273).
merge_post_tool_use_args=()
for entry in "${POST_TOOL_USE_HOOKS[@]}"; do
  matcher="${entry%%::*}"
  name="${entry#*::}"
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in POST_TOOL_USE_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_post_tool_use_args+=("$matcher"'::$HOME/.claude/hooks/'"$name")
done

merge_deny_args=("${DENY_RULES[@]}")

python3 "$REPO_DIR/scripts/merge-hooks-into-settings.py" "$SETTINGS_PATH" "--" "${merge_session_start_args[@]}" "--stop" "${merge_stop_args[@]}" "--pre-tool-use" "${merge_pre_tool_use_args[@]}" "--post-tool-use" "${merge_post_tool_use_args[@]}" "--deny" "${merge_deny_args[@]}"

python3 "$REPO_DIR/scripts/merge-hooks-into-settings.py" "$AGY_HOOKS_PATH" "--" "--pre-tool-use" "${merge_pre_tool_use_args[@]}" "--post-tool-use" "${merge_post_tool_use_args[@]}"
