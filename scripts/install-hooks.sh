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
#    Also symlinks scripts/statusline.sh into the same hooks destination
#    (alongside the *.sh hook symlinks, but not part of the hook-registration
#    loop — it is not a hook) and idempotently merges that STABLE installed
#    path into the "statusLine" key of ~/.claude/settings.json only — Claude
#    Code ONLY, never agy's hooks.json, since agy has no status-line surface
#    for this to install into (web-jam-tools#688, web-jam-tools#691).
#
#    Also idempotently sets "permissions.defaultMode" to DEFAULT_MODE
#    (currently "acceptEdits") in ~/.claude/settings.json — Claude Code ONLY,
#    never agy's hooks.json, since agy has no permission-mode concept at all
#    (docs/agy-hooks.md). This pins the session out of the "auto" mode in
#    which hooks/opus-delegation-gate.sh withdraws its subagent exemption and
#    refuses every Edit/Write/NotebookEdit — a defect that burned two
#    dispatched subagents (~93k and ~62k tokens, zero output) before nothing
#    pinned the mode (web-jam-tools#705).
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
#                           REQUIRES --settings-path (or CLAUDE_SETTINGS_PATH) to
#                           also be passed — --hooks-dir only redirects where hook
#                           symlinks are created, never the settings-merge targets,
#                           so passing it alone would still merge into the REAL
#                           $HOME/.claude/settings.json and $HOME/.gemini/config/
#                           hooks.json; the script refuses that combination
#                           (web-jam-tools#721).
#   --settings-path PATH   Merge into PATH instead of $HOME/.claude/settings.json
#                           (also settable via CLAUDE_SETTINGS_PATH). Mainly for
#                           testing the merge without touching a real settings file.
#                           NOTE: --settings-path alone does NOT sandbox a run —
#                           it only redirects the settings merge. The symlink step
#                           still targets $HOME/.claude/hooks (or CLAUDE_HOOKS_DIR)
#                           unless --hooks-dir is ALSO passed (web-jam-tools#273).
#   --agy-hooks-path PATH  Merge agy hooks into PATH instead of $HOME/.gemini/config/hooks.json
#                           (also settable via AGY_HOOKS_PATH).
#   --agents-md-path PATH  Merge rules pointer into PATH instead of $HOME/.agents/AGENTS.md
#                           (also settable via AGENTS_MD_PATH).
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

AGENTS_MD_PATH_EXPLICIT=0
if [ -n "${AGENTS_MD_PATH:-}" ]; then
  AGENTS_MD_PATH="$AGENTS_MD_PATH"
  AGENTS_MD_PATH_EXPLICIT=1
else
  AGENTS_MD_PATH="$HOME/.agents/AGENTS.md"
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
SESSION_START_HOOKS=(notes-sync-reminder.sh memory-cleanup-reminder.sh flash-issues-reminder.sh backlog-groom-reminder.sh backup-refusal-reminder.sh hook-install-drift-reminder.sh)

# Stop hooks this installer keeps registered in settings.json (web-jam-tools#290).
# Same flat, no-matcher shape as SESSION_START_HOOKS — Stop fires
# unconditionally at the end of a turn, same as SessionStart fires
# unconditionally at the start of a session.
#
# require-issue-citation-titles.sh (web-jam-tools#311) and
# require-clear-communication.sh (web-jam-tools#531) are BLOCKING (exit 2 on
# a violation).
STOP_HOOKS=(require-issue-citation-titles.sh require-clear-communication.sh)

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
  "Bash::gh-api-guard.sh"
  "Bash|mcp__.*::block-irreversible-operations.sh"
  "Bash::fmt-push-guard.sh"
  "Bash::block-agy-non-flash-model.sh"
  "Bash|Edit|Write::block-human-only-credentials.sh"
  "Edit|Write::feature-branch-guard.sh"
  "mcp__(gmail|claude_ai_Gmail)__.*::haiku-only-gmail-gate.sh"
  "mcp__.*__issue_write::require-model-label-on-issue-create.sh"
  "Write|Edit|NotebookEdit::block-out-of-tree-write.sh"
  "Write|Edit|NotebookEdit::opus-delegation-gate.sh"
  "mcp__.*__(issue_write|sub_issue_write)::require-approval-token-on-issue-write.sh"
)

# PostToolUse hooks, same "<matcher>::<script>" shape (web-jam-tools#272).
# The PreToolUse guards are blocklists and can only stop leak shapes someone
# enumerated in advance; three credentials leaked in two days in three shapes
# nobody had. This scans tool OUTPUT for credential-shaped strings instead, so
# it does not depend on knowing how the value got printed.
POST_TOOL_USE_HOOKS=(
  "Bash::scan-output-for-secrets.sh"
)

# agy-ONLY PreToolUse hooks (web-jam-tools#432) — never wired into Claude
# Code's settings.json, only into AGY_HOOKS_PATH (via the shim below). Both
# depend on agy-native payload fields (raw, unprefixed MCP tool names;
# `modelName`) that Claude Code's hook payload doesn't carry, so they would
# either misfire or never fire there.
AGY_ONLY_PRE_TOOL_USE_HOOKS=(
  "send_email|delete_email|batch_delete_emails::block-agy-gmail-send-delete.sh"
  ".*::agy-model-guard.sh"
)

# permissions.defaultMode this installer keeps set in settings.json
# (web-jam-tools#705). When the session's permission mode is "auto" (rather
# than a deliberate mode), hooks/opus-delegation-gate.sh withdraws its
# subagent exemption and refuses EVERY Edit/Write/NotebookEdit to a
# git-tracked path, main thread and subagent alike — measured cost: two
# dispatched Sonnet subagents refused on their first edit, ~93k and ~62k
# tokens burned for zero output (2026-08-22). Nothing pinned the session out
# of the mode that triggers it, so this installer now does: it sets
# permissions.defaultMode to "acceptEdits", the same versioned/idempotent way
# it already manages DENY_RULES/ASK_RULES below (single scalar value, not a
# list — see the permissions.defaultMode merge in
# scripts/merge-hooks-into-settings.ts, modeled on the statusLine merge from
# web-jam-tools#688).
#
# Claude Code ONLY — deliberately NOT mirrored into agy's hooks.json. agy has
# no permission-mode concept at all (docs/agy-hooks.md: "without touching
# Claude Code's permissions at all (non-goal)"), so DEFAULT_MODE is passed
# only to the $SETTINGS_PATH invocations below, never to the $AGY_HOOKS_PATH
# ones (Josh-approved single-surface exception to the usual both-surfaces
# rule for hook/skill changes).
DEFAULT_MODE="acceptEdits"

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

  # git push --force / -f  — plain force stays DENIED, always. It overwrites
  # whatever arrived on the remote since your last fetch, with no check.
  # NOTE: --force-with-lease is deliberately NOT here — it moved to ASK_RULES
  # below. See the comment there for why.
  'Bash(git push --force *)'
  'Bash(git push --force)'
  'Bash(git push * --force *)'
  'Bash(git push * --force)'
  'Bash(git push -f *)'
  'Bash(git push -f)'
  'Bash(git push * -f *)'
  'Bash(git push * -f)'

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

  # Laptop Dropbox deny list (web-jam-tools#321)
  'Read(//home/joshua/Dropbox/Apps/**)'
  'Edit(//home/joshua/Dropbox/Apps/**)'
  'Read(//home/joshua/Dropbox/BreakPoint Ministries/**)'
  'Edit(//home/joshua/Dropbox/BreakPoint Ministries/**)'
  'Read(//home/joshua/Dropbox/Camera Uploads/**)'
  'Edit(//home/joshua/Dropbox/Camera Uploads/**)'
  'Read(//home/joshua/Dropbox/Capture/**)'
  'Edit(//home/joshua/Dropbox/Capture/**)'
  'Read(//home/joshua/Dropbox/CollegeLutheran/**)'
  'Edit(//home/joshua/Dropbox/CollegeLutheran/**)'
  'Read(//home/joshua/Dropbox/DropsyncFiles/**)'
  'Edit(//home/joshua/Dropbox/DropsyncFiles/**)'
  'Read(//home/joshua/Dropbox/Galapagos/**)'
  'Edit(//home/joshua/Dropbox/Galapagos/**)'
  'Read(//home/joshua/Dropbox/InBetween SetsMusic/**)'
  'Edit(//home/joshua/Dropbox/InBetween SetsMusic/**)'
  'Read(//home/joshua/Dropbox/JoshMariaMusic_private/**)'
  'Edit(//home/joshua/Dropbox/JoshMariaMusic_private/**)'
  'Read(//home/joshua/Dropbox/Migrated Paper Docs/**)'
  'Edit(//home/joshua/Dropbox/Migrated Paper Docs/**)'
  'Read(//home/joshua/Dropbox/Other (1)/**)'
  'Edit(//home/joshua/Dropbox/Other (1)/**)'
  'Read(//home/joshua/Dropbox/ShermanHome/**)'
  'Edit(//home/joshua/Dropbox/ShermanHome/**)'
  'Read(//home/joshua/Dropbox/TimShermanMusic/**)'
  'Edit(//home/joshua/Dropbox/TimShermanMusic/**)'
  'Read(//home/joshua/Dropbox/Web Design/**)'
  'Edit(//home/joshua/Dropbox/Web Design/**)'
  'Read(//home/joshua/Dropbox/WebJamApps/**)'
  'Edit(//home/joshua/Dropbox/WebJamApps/**)'
  'Read(//home/joshua/Dropbox/web-jam-llc/**)'
  'Edit(//home/joshua/Dropbox/web-jam-llc/**)'

  # Heroku hard denies (R-12 & Part G)
  'Bash(heroku config:get *)'
  'Bash(heroku config:set *)'
  'Bash(heroku config:unset *)'
  'Bash(heroku auth:token *)'
  'Bash(heroku auth:token)'
  'Bash(heroku pg:reset *)'
  'Bash(heroku apps:destroy *)'
  'Bash(heroku pg:backups:restore *)'

  # Irreversible Part G operation deny backstops (R-24)
  'Bash(gh repo delete *)'
  'Bash(gh repo delete)'
  'Bash(gh label delete *)'
  'Bash(gh label delete)'
  'Bash(gh project delete *)'
  'Bash(gh project delete)'
  'Bash(gh project item-delete *)'
  'Bash(gh project item-delete)'
  'Bash(gh project field-delete *)'
  'Bash(gh project field-delete)'
  'Bash(heroku addons:destroy *)'
  'Bash(heroku addons:destroy)'
  'mcp__claude_ai_GitHub_MCP__delete_file'
  'Bash(gh auth token *)'
  'Bash(gh auth token)'
  'Bash(gh issue delete *)'
  'Bash(gh issue delete)'
  'Bash(gh run delete *)'
  'Bash(gh run delete)'
  'Bash(gh repo sync *--force*)'
  'Bash(gh repo sync * --force)'
  'Bash(gh repo sync * --force *)'
  'Bash(gh issue transfer *)'
  'Bash(gh issue transfer)'
  'Bash(gh repo rename *)'
  'Bash(gh repo rename)'
  'Bash(gh workflow run *)'
  'Bash(gh workflow run)'
  'Bash(gh pr merge *)'
  'Bash(gh pr merge)'
  'mcp__claude_ai_GitHub_MCP__merge_pull_request'

  # claude mcp launch & config denies (R-16 & R-37)
  'Bash(claude mcp add *)'
  'Bash(claude mcp add-json *)'
  'Bash(claude mcp add-from-claude-desktop*)'
  'Bash(claude mcp login *)'
  'Bash(claude *--mcp-config*)'
  'Edit(//home/joshua/.claude.json)'
  'Edit(//home/joshua/.claude/mcp_config.json)'

  # gh api DELETE backstop patterns (R-7). KNOWN LIMITATION: these are literal
  # unquoted forms and do not match a quoted method value (-X 'DELETE',
  # --method="DELETE") — web-jam-tools#425 post-approval finding. Quoted
  # forms are caught only by hooks/gh-api-guard.sh's normalization, not by
  # this backstop; that hook is the authoritative guard for this class.
  'Bash(gh api -X DELETE *)'
  'Bash(gh api -X DELETE)'
  'Bash(gh api --method DELETE *)'
  'Bash(gh api --method DELETE)'
  'Bash(gh api -XDELETE *)'
  'Bash(gh api --method=DELETE *)'

  # Dropbox MCP mutation denial (web-jam-tools#321)
  'mcp__claude_ai_Dropbox__delete'
  'mcp__claude_ai_Dropbox__move'
)

# permissions.ask patterns this installer keeps registered in settings.json
# (web-jam-tools#339). Patterns in permissions.ask force Claude Code to prompt
# for confirmation before executing matching commands.
ASK_RULES=(
  # git push --force-with-lease — ASK, not DENY (Josh, 2026-08-13:
  # "force with lease should be allowed if I give permission").
  #
  # This is NOT a loosening of the remote-branch HARD RULE, which requires an
  # explicit imperative from Josh naming the branch before any force-push. A
  # deny rule cannot represent that: it is static string matching with no view
  # of the conversation, so it refused the authorized case and the unauthorized
  # one identically. An ask prompt IS the mechanism that represents it — it
  # shows Josh the literal command including the branch name and takes his
  # answer, per invocation, before anything runs. The check is not removed; it
  # is moved to the only layer that can actually evaluate the condition the
  # hard rule states.
  #
  # Scoped to --force-with-lease alone, which git itself refuses to run when
  # the remote moved after your last fetch — the case where a force push
  # destroys someone else's work is structurally prevented. Plain --force
  # remains in DENY_RULES above with no prompt and no exception, as do branch
  # deletion, empty-source refspecs, --mirror and --prune.
  #
  # Origin: 2026-08-13, a rebase of a feature branch behind an open PR could
  # not be published at all — the deny rule blocked the push and no
  # authorization from Josh could lift it, so the rebase was unlandable.
  'Bash(git push --force-with-lease*)'
  'Bash(git push * --force-with-lease*)'

  # gh pr (11 write verbs)
  'Bash(gh pr create *)'
  'Bash(gh pr create)'
  'Bash(gh pr comment *)'
  'Bash(gh pr comment)'
  'Bash(gh pr edit *)'
  'Bash(gh pr edit)'
  'Bash(gh pr lock *)'
  'Bash(gh pr ready *)'
  'Bash(gh pr ready)'
  'Bash(gh pr reopen *)'
  'Bash(gh pr revert *)'
  'Bash(gh pr review *)'
  'Bash(gh pr review)'
  'Bash(gh pr unlock *)'
  'Bash(gh pr update-branch *)'
  'Bash(gh pr update-branch)'
  'Bash(gh pr close *)'

  # gh issue (10 write verbs + develop)
  'Bash(gh issue create *)'
  'Bash(gh issue create)'
  'Bash(gh issue close *)'
  'Bash(gh issue comment *)'
  'Bash(gh issue edit *)'
  'Bash(gh issue lock *)'
  'Bash(gh issue pin *)'
  'Bash(gh issue reopen *)'
  'Bash(gh issue unlock *)'
  'Bash(gh issue unpin *)'
  'Bash(gh issue develop *)'
  'Bash(gh issue develop)'

  # gh repo (7 write verbs + 4 leaves)
  'Bash(gh repo create *)'
  'Bash(gh repo create)'
  'Bash(gh repo archive *)'
  'Bash(gh repo archive)'
  'Bash(gh repo edit *)'
  'Bash(gh repo edit)'
  'Bash(gh repo fork *)'
  'Bash(gh repo fork)'
  'Bash(gh repo sync *)'
  'Bash(gh repo sync)'
  'Bash(gh repo unarchive *)'
  'Bash(gh repo autolink create *)'
  'Bash(gh repo autolink delete *)'
  'Bash(gh repo deploy-key add *)'
  'Bash(gh repo deploy-key delete *)'

  # gh auth (5 write verbs)
  'Bash(gh auth login *)'
  'Bash(gh auth login)'
  'Bash(gh auth logout *)'
  'Bash(gh auth logout)'
  'Bash(gh auth refresh *)'
  'Bash(gh auth refresh)'
  'Bash(gh auth setup-git *)'
  'Bash(gh auth setup-git)'
  'Bash(gh auth switch *)'
  'Bash(gh auth switch)'

  # gh label (3 write verbs)
  'Bash(gh label clone *)'
  'Bash(gh label create *)'
  'Bash(gh label edit *)'

  # gh project (12 write verbs)
  'Bash(gh project close *)'
  'Bash(gh project close)'
  'Bash(gh project copy *)'
  'Bash(gh project copy)'
  'Bash(gh project create *)'
  'Bash(gh project create)'
  'Bash(gh project edit *)'
  'Bash(gh project edit)'
  'Bash(gh project field-create *)'
  'Bash(gh project field-create)'
  'Bash(gh project item-add *)'
  'Bash(gh project item-add)'
  'Bash(gh project item-archive *)'
  'Bash(gh project item-archive)'
  'Bash(gh project item-create *)'
  'Bash(gh project item-create)'
  'Bash(gh project item-edit *)'
  'Bash(gh project item-edit)'
  'Bash(gh project link *)'
  'Bash(gh project link)'
  'Bash(gh project mark-template *)'
  'Bash(gh project mark-template)'
  'Bash(gh project unlink *)'
  'Bash(gh project unlink)'

  # gh release (3 write verbs)
  'Bash(gh release create *)'
  'Bash(gh release create)'
  'Bash(gh release delete *)'
  'Bash(gh release edit *)'

  # gh run (2 write verbs)
  'Bash(gh run cancel *)'
  'Bash(gh run cancel)'
  'Bash(gh run rerun *)'
  'Bash(gh run rerun)'

  # gh workflow (2 write verbs)
  'Bash(gh workflow disable *)'
  'Bash(gh workflow disable)'
  'Bash(gh workflow enable *)'
  'Bash(gh workflow enable)'

  # gh secret / variable / cache / gpg-key / ssh-key / codespace / extension / org
  'Bash(gh secret set *)'
  'Bash(gh secret delete *)'
  'Bash(gh variable set *)'
  'Bash(gh variable delete *)'
  'Bash(gh cache delete *)'
  'Bash(gh gpg-key add *)'
  'Bash(gh gpg-key delete *)'
  'Bash(gh ssh-key add *)'
  'Bash(gh ssh-key delete *)'
  'Bash(gh codespace create *)'
  'Bash(gh codespace delete *)'
  'Bash(gh codespace edit *)'
  'Bash(gh codespace stop *)'
  'Bash(gh codespace rebuild *)'
  'Bash(gh extension install *)'
  'Bash(gh extension remove *)'
  'Bash(gh extension upgrade *)'
  'Bash(gh org mem-add *)'
  'Bash(gh org mem-remove *)'

  # Heroku ask rules (17 patterns)
  'Bash(heroku ps:scale *)'
  'Bash(heroku ps:restart *)'
  'Bash(heroku ps:stop *)'
  'Bash(heroku addons:create *)'
  'Bash(heroku addons:attach *)'
  'Bash(heroku addons:detach *)'
  'Bash(heroku addons:upgrade *)'
  'Bash(heroku addons:downgrade *)'
  'Bash(heroku maintenance:on *)'
  'Bash(heroku maintenance:off *)'
  'Bash(heroku releases:rollback *)'
  'Bash(heroku access:add *)'
  'Bash(heroku access:remove *)'
  'Bash(heroku access:update *)'
  'Bash(heroku domains:add *)'
  'Bash(heroku domains:remove *)'
  'Bash(heroku domains:clear *)'

  # GitHub MCP ask rules (16 tools)
  'mcp__claude_ai_GitHub_MCP__add_comment_to_pending_review'
  'mcp__claude_ai_GitHub_MCP__add_issue_comment'
  'mcp__claude_ai_GitHub_MCP__add_reply_to_pull_request_comment'
  'mcp__claude_ai_GitHub_MCP__create_branch'
  'mcp__claude_ai_GitHub_MCP__create_or_update_file'
  'mcp__claude_ai_GitHub_MCP__create_pull_request'
  'mcp__claude_ai_GitHub_MCP__create_repository'
  'mcp__claude_ai_GitHub_MCP__fork_repository'
  'mcp__claude_ai_GitHub_MCP__issue_write'
  'mcp__claude_ai_GitHub_MCP__pull_request_review_write'
  'mcp__claude_ai_GitHub_MCP__push_files'
  'mcp__claude_ai_GitHub_MCP__request_copilot_review'
  'mcp__claude_ai_GitHub_MCP__sub_issue_write'
  'mcp__claude_ai_GitHub_MCP__update_pull_request'
  'mcp__claude_ai_GitHub_MCP__update_pull_request_branch'
  'mcp__claude_ai_GitHub_MCP__run_secret_scanning'
)

CHECK_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check)
      CHECK_MODE=1
      shift
      ;;
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
    --agents-md-path)
      AGENTS_MD_PATH="$2"
      AGENTS_MD_PATH_EXPLICIT=1
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

# --- Partial-sandbox guard (web-jam-tools#721) ---
# --hooks-dir/CLAUDE_HOOKS_DIR only ever redirected where hook *symlinks* are
# created (HOOKS_DEST) — it never redirected the settings-merge targets
# (SETTINGS_PATH, and transitively AGY_HOOKS_PATH/AGENTS_MD_PATH, both
# derived from SETTINGS_PATH above). A caller who passed --hooks-dir alone,
# believing that flag sandboxes "the test run," still had this installer
# merge into the REAL $HOME/.claude/settings.json and $HOME/.gemini/config/
# hooks.json — in particular overwriting the live statusLine command with a
# path into the temporary hooks directory. That happened for real during
# work on a different issue (see #721's reproduction).
#
# Refuse the combination instead of silently deriving a second sandboxed
# path, matching the existing worktree guard below: name the exact flag the
# caller needs to pass, and fail BEFORE any write, not after.
if [ "$HOOKS_DEST_IS_DEFAULT" = "0" ] && [ "$SETTINGS_PATH_EXPLICIT" = "0" ]; then
  echo "error: --hooks-dir (or CLAUDE_HOOKS_DIR) was given without --settings-path." >&2
  echo "--hooks-dir only sandboxes where hook symlinks are created — it does NOT" >&2
  echo "sandbox the settings-merge targets (\$HOME/.claude/settings.json," >&2
  echo "\$HOME/.gemini/config/hooks.json), so this combination would still merge" >&2
  echo "into your REAL live settings, including overwriting the live statusLine" >&2
  echo "command with a path into the temporary hooks directory (web-jam-tools#721)." >&2
  echo "Pass --settings-path PATH (or CLAUDE_SETTINGS_PATH) too to fully sandbox" >&2
  echo "this run." >&2
  exit 1
fi

if [ "$AGY_HOOKS_PATH_EXPLICIT" = "0" ] && [ "$SETTINGS_PATH_EXPLICIT" = "1" ]; then
  AGY_HOOKS_PATH="$(dirname "$SETTINGS_PATH")/hooks.json"
fi

if [ "$AGENTS_MD_PATH_EXPLICIT" = "0" ] && [ "$SETTINGS_PATH_EXPLICIT" = "1" ]; then
  AGENTS_MD_PATH="$(dirname "$SETTINGS_PATH")/AGENTS.md"
fi

[ -d "$HOOKS_SRC" ] || { echo "error: $HOOKS_SRC not found" >&2; exit 1; }

# --- Secret-scan gate (web-jam-tools#339) ---
# Runs BEFORE any settings file is written or checked against. Fails closed (exit 1).
if [ -f "$SETTINGS_PATH" ]; then
  if ! scan_output=$(CLAUDE_SETTINGS_PATH="$SETTINGS_PATH" "$REPO_DIR/scripts/scan-settings-for-secrets.sh" 2>&1); then
    echo "error: secret-scan gate failed on $SETTINGS_PATH" >&2
    echo "$scan_output" >&2
    exit 1
  fi
fi

# --- Read-only drift check (--check mode, web-jam-tools#339) ---
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

merge_post_tool_use_args=()
for entry in "${POST_TOOL_USE_HOOKS[@]}"; do
  matcher="${entry%%::*}"
  name="${entry#*::}"
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in POST_TOOL_USE_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_post_tool_use_args+=("$matcher"'::$HOME/.claude/hooks/'"$name")
done

[ -e "$HOOKS_SRC/agy-hook-shim.sh" ] || { echo "error: $HOOKS_SRC/agy-hook-shim.sh not found" >&2; exit 1; }

# --- Status line (web-jam-tools#688, web-jam-tools#691) ---
# Claude Code ONLY — agy has no status-line surface for this to install
# into, so unlike a hook or a skill this is a single-surface change by
# nature, not by omission. merge_status_line_args below is passed to the
# $SETTINGS_PATH invocations exclusively; the $AGY_HOOKS_PATH invocations
# never receive it and stay byte-identical to before this feature existed.
#
# The registered command is the STABLE installed path under $HOOKS_DEST
# (same destination the *.sh hooks are symlinked into, honoring
# --hooks-dir/CLAUDE_HOOKS_DIR), never $REPO_DIR — a raw working-tree path
# breaks if the repo moves or a checked-out branch lacks the file
# (web-jam-tools#691). The actual symlink is created below, alongside the
# hook symlinks, but scripts/statusline.sh is NOT added to HOOKS_SRC/the
# hook-registration loops — it is not a hook.
[ -e "$REPO_DIR/scripts/statusline.sh" ] || { echo "error: $REPO_DIR/scripts/statusline.sh not found" >&2; exit 1; }
STATUS_LINE_DEST="$HOOKS_DEST/statusline.sh"
STATUS_LINE_COMMAND="$STATUS_LINE_DEST"
merge_status_line_args=("$STATUS_LINE_COMMAND")

# --- permissions.defaultMode (web-jam-tools#705) ---
# Same Claude-Code-only scoping as merge_status_line_args above: passed only
# to the $SETTINGS_PATH invocations below, never to $AGY_HOOKS_PATH.
merge_default_mode_args=("$DEFAULT_MODE")

# --- agy-side PreToolUse/PostToolUse args (web-jam-tools#432) ---
#
# agy ignores its own PreToolUse "matcher" JSON field entirely (finding 2),
# and neither Claude veto mechanism (exit 2 /
# hookSpecificOutput.permissionDecision) is honoured there (finding 5) — so
# every hook registered directly is a no-op on that surface. Instead of
# registering each hook script directly (as the Claude settings.json args
# above do), every agy-side entry is wrapped in
# hooks/agy-hook-shim.sh <event> <base64-matcher> <target-hook-path>, which
# normalizes the payload, enforces the matcher itself, runs the target hook
# UNMODIFIED, and translates its verdict into agy's own
# {"decision":"deny","reason":"..."} form (verified working — finding 6).
#
# The matcher is base64-encoded rather than embedded as literal shell text:
# agy's exact command-string invocation mechanism (full shell parse, vs. a
# naive whitespace split) is not independently verifiable (agy is
# closed-source), and several matchers below contain shell metacharacters
# ("mcp__(gmail|claude_ai_Gmail)__.*", "Bash|mcp__.*") that would be
# misparsed or trigger glob expansion under a naive/unquoted split. Base64
# text is safe under either invocation mechanism.
agy_shim_arg() {
  local event="$1" matcher="$2" name="$3"
  local matcher_b64
  matcher_b64="$(printf '%s' "$matcher" | base64 | tr -d '\n')"
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  printf '%s' "$matcher"'::$HOME/.claude/hooks/agy-hook-shim.sh '"$event"' '"$matcher_b64"' $HOME/.claude/hooks/'"$name"
}

merge_agy_pre_tool_use_args=()
for entry in "${PRE_TOOL_USE_HOOKS[@]}" "${AGY_ONLY_PRE_TOOL_USE_HOOKS[@]}"; do
  matcher="${entry%%::*}"
  name="${entry#*::}"
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in PRE_TOOL_USE_HOOKS/AGY_ONLY_PRE_TOOL_USE_HOOKS)" >&2; exit 1; }
  merge_agy_pre_tool_use_args+=("$(agy_shim_arg PreToolUse "$matcher" "$name")")
done

merge_agy_post_tool_use_args=()
for entry in "${POST_TOOL_USE_HOOKS[@]}"; do
  matcher="${entry%%::*}"
  name="${entry#*::}"
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in POST_TOOL_USE_HOOKS)" >&2; exit 1; }
  merge_agy_post_tool_use_args+=("$(agy_shim_arg PostToolUse "$matcher" "$name")")
done

merge_deny_args=("${DENY_RULES[@]}")
merge_ask_args=("${ASK_RULES[@]}")

if [ "$CHECK_MODE" = "1" ]; then
  DRIFT=0
  for src in "$HOOKS_SRC"/*.sh; do
    [ -e "$src" ] || continue
    name="$(basename "$src")"
    dest="$HOOKS_DEST/$name"
    if [ ! -L "$dest" ] || [ "$(readlink -f "$dest")" != "$(readlink -f "$src")" ]; then
      echo "drift: hook script $name is not linked at $dest" >&2
      DRIFT=1
    fi
  done

  if [ -d "$HOOKS_DEST" ]; then
    for dest in "$HOOKS_DEST"/*; do
      [ -e "$dest" ] || [ -L "$dest" ] || continue
      if [ -L "$dest" ]; then
        name="$(basename "$dest")"
        if [ ! -e "$dest" ] || { [ ! -e "$HOOKS_SRC/$name" ] && [[ "$(readlink "$dest")" == *"$HOOKS_SRC"* ]]; }; then
          echo "drift: orphaned symlink $name at $dest" >&2
          DRIFT=1
        fi
      fi
    done
  fi

  if [ ! -L "$STATUS_LINE_DEST" ] || [ "$(readlink -f "$STATUS_LINE_DEST")" != "$(readlink -f "$REPO_DIR/scripts/statusline.sh")" ]; then
    echo "drift: status-line script is not linked at $STATUS_LINE_DEST" >&2
    DRIFT=1
  fi

  if ! deno run --allow-read --allow-env "$REPO_DIR/scripts/merge-hooks-into-settings.ts" "$SETTINGS_PATH" "--check" "--" "${merge_session_start_args[@]}" "--stop" "${merge_stop_args[@]}" "--pre-tool-use" "${merge_pre_tool_use_args[@]}" "--post-tool-use" "${merge_post_tool_use_args[@]}" "--deny" "${merge_deny_args[@]}" "--ask" "${merge_ask_args[@]}" "--status-line" "${merge_status_line_args[@]}" "--default-mode" "${merge_default_mode_args[@]}"; then
    DRIFT=1
  fi

  if ! deno run --allow-read --allow-env "$REPO_DIR/scripts/merge-hooks-into-settings.ts" "$AGY_HOOKS_PATH" "--check" "--forbid-lifecycle-hooks" "--" "--pre-tool-use" "${merge_agy_pre_tool_use_args[@]}" "--post-tool-use" "${merge_agy_post_tool_use_args[@]}"; then
    DRIFT=1
  fi

  if ! deno run --allow-read --allow-env "$REPO_DIR/scripts/merge-agents-md-pointer.ts" "$AGENTS_MD_PATH" "--check"; then
    DRIFT=1
  fi


  if [ "$DRIFT" -ne 0 ]; then
    echo "error: drift detected" >&2
    exit 1
  fi
  echo "install-hooks: check passed (no drift)"
  exit 0
fi

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

if [ -d "$HOOKS_DEST" ]; then
  for dest in "$HOOKS_DEST"/*; do
    [ -e "$dest" ] || [ -L "$dest" ] || continue
    if [ -L "$dest" ]; then
      name="$(basename "$dest")"
      if [ ! -e "$dest" ] || { [ ! -e "$HOOKS_SRC/$name" ] && [[ "$(readlink "$dest")" == *"$HOOKS_SRC"* ]]; }; then
        rm -f "$dest"
        echo "$name: pruned orphaned symlink"
      fi
    fi
  done
fi

# --- Status-line script symlink (web-jam-tools#688, web-jam-tools#691) ---
# scripts/statusline.sh is not a hook — it deliberately stays out of
# HOOKS_SRC/the hook-registration loops above (PreToolUse/PostToolUse/
# SessionStart/Stop never see it) — but it gets the same stable,
# checkout-independent installed location under $HOOKS_DEST so the
# "statusLine" command merged into settings.json below (STATUS_LINE_COMMAND)
# survives the repo moving or a branch checkout lacking the file, the same
# guarantee the *.sh hooks already have.
if [ -L "$STATUS_LINE_DEST" ] && [ "$(readlink -f "$STATUS_LINE_DEST")" = "$(readlink -f "$REPO_DIR/scripts/statusline.sh")" ]; then
  echo "statusline.sh: ok (already linked)"
elif [ -e "$STATUS_LINE_DEST" ] || [ -L "$STATUS_LINE_DEST" ]; then
  mv "$STATUS_LINE_DEST" "$STATUS_LINE_DEST.bak-$STAMP"
  ln -s "$REPO_DIR/scripts/statusline.sh" "$STATUS_LINE_DEST"
  echo "statusline.sh: linked (previous version backed up to statusline.sh.bak-$STAMP)"
else
  ln -s "$REPO_DIR/scripts/statusline.sh" "$STATUS_LINE_DEST"
  echo "statusline.sh: linked (new)"
fi

# The merge logic itself lives in its own file (web-jam-tools#265) so it can
# also be unit-tested in isolation against fixture JSON, independent of the
# symlink step above (see test/install_hooks_merge.test.ts). This installer
# as a whole — including the symlink step — is exercised end to end, always
# sandboxed via --hooks-dir/--settings-path or a redirected $HOME, in
# test/install_hooks_script.test.ts (web-jam-tools#273).

deno run --allow-read --allow-write --allow-env "$REPO_DIR/scripts/merge-hooks-into-settings.ts" "$SETTINGS_PATH" "--" "${merge_session_start_args[@]}" "--stop" "${merge_stop_args[@]}" "--pre-tool-use" "${merge_pre_tool_use_args[@]}" "--post-tool-use" "${merge_post_tool_use_args[@]}" "--deny" "${merge_deny_args[@]}" "--ask" "${merge_ask_args[@]}" "--status-line" "${merge_status_line_args[@]}" "--default-mode" "${merge_default_mode_args[@]}"

deno run --allow-read --allow-write --allow-env "$REPO_DIR/scripts/merge-hooks-into-settings.ts" "$AGY_HOOKS_PATH" "--forbid-lifecycle-hooks" "--" "--pre-tool-use" "${merge_agy_pre_tool_use_args[@]}" "--post-tool-use" "${merge_agy_post_tool_use_args[@]}"

deno run --allow-read --allow-write --allow-env "$REPO_DIR/scripts/merge-agents-md-pointer.ts" "$AGENTS_MD_PATH"
