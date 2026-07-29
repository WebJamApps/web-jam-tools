#!/usr/bin/env bash
# backup-claude-memory.sh — Task 43 (added 2026-05-21, executed 2026-05-22)
#
# Backs up Claude Code's persistent memory (per-project + shared) to Dropbox.
# Without this, memory at ~/.claude/projects/*/memory/ + ~/.claude/shared-memory/
# is laptop-local with NO backup — a disk failure or accidental delete erases
# everything Claude Code remembers across sessions.
#
# Strategy: rclone sync per-project memory subdirs only (NOT the noisy
# tool-results / sessions / cache / file-history dirs that live alongside).
# Dropbox handles version history for free, so each run overwrites the
# destination — restore is a copy in the other direction (see claude-backup/README.md).
#
# Scheduled via crontab at 06:55 and 18:55 ET (every 12h), keeping the morning
# run 5 min clear of drive-cleanup at 07:00. Twice daily halves the window in
# which same-day memory/rule edits exist only on the laptop.
# Manual: just run this script.

set -euo pipefail

# CLAUDE_DIR / BACKUP_DST_DIR are overridable (web-jam-tools#304) so the
# settings.json secret-literal guard added below can be exercised end to end
# against a throwaway fixture directory instead of Josh's real
# ~/.claude + ~/Dropbox — mirrors the --hooks-dir/--settings-path override
# convention already used by scripts/install-hooks.sh.
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
SRC_PROJECTS="$CLAUDE_DIR/projects"
SRC_SHARED="$CLAUDE_DIR/shared-memory"
DST="${BACKUP_DST_DIR:-$HOME/Dropbox/web-jam-llms/claude-backup}"
LOG="$DST/backup-log.txt"

mkdir -p "$DST/projects" "$DST/shared-memory"

ts() { date -u +%FT%TZ; }

# Per-project memory sync. Only iterates project dirs that actually have a
# memory/ subdir — other state (tool-results, session blobs) is skipped.
for project_dir in "$SRC_PROJECTS"/*/; do
    project=$(basename "$project_dir")
    mem_dir="$project_dir/memory"
    if [ -d "$mem_dir" ]; then
        rclone sync "$mem_dir" "$DST/projects/$project/memory" \
            --exclude '.tmp' \
            --exclude '*~'
    fi
done

# Cross-project shared memory (symlinked into each project as memory/shared/).
# Backed up once at the top level; the symlinks inside per-project memory/
# dirs deref to the same source so they're effectively duplicates of this.
rclone sync "$SRC_SHARED" "$DST/shared-memory" \
    --exclude '.tmp' \
    --exclude '*~'

# Global Claude Code instructions. Not under any memory/ dir, so the loops above
# miss it — but it carries durable cross-project rules and routing notes, so back
# it up too. copyto (single file) keeps it flat at the backup root.
rclone copyto "$CLAUDE_DIR/CLAUDE.md" "$DST/CLAUDE.md"

# Claude Code config (web-jam-tools#139). settings.json registers hooks and
# carries Josh's permission strings — not version-controlled in the (public)
# hooks/ repo dir for that reason, so this backup is its only copy outside
# the laptop. keybindings.json is optional (only exists if Josh has
# customized shortcuts). Kept in their own subdir, mirroring CLAUDE.md above.
# web-jam-tools#304: settings.json can end up holding a credential-shaped
# literal in permissions.allow — Claude Code persists an approved Bash
# command VERBATIM, secret included, if one was ever passed as a literal
# argument (the actual 2026-05-22 incident: a live Gemini API key sat here
# for ~2 months, replicated to Dropbox by this very script twice daily).
# Refuse to copy settings.json in that state rather than faithfully
# replicating a leak on a schedule; everything else in this script still
# runs. Reuses scripts/scan-settings-for-secrets.sh (exit 1 = found) so this
# guard and the standalone scanner never disagree about what counts as a
# "credential-shaped literal" — never prints the matched value, only its
# shape name.
mkdir -p "$DST/claude-config"
if [ -f "$CLAUDE_DIR/settings.json" ]; then
  if scan_warning=$(CLAUDE_SETTINGS_PATH="$CLAUDE_DIR/settings.json" "$REPO_DIR/scripts/scan-settings-for-secrets.sh" 2>&1 >/dev/null); then
    rclone copyto "$CLAUDE_DIR/settings.json" "$DST/claude-config/settings.json"
  else
    echo "$(ts) REFUSED settings.json backup: credential-shaped literal found in permissions (web-jam-tools#304). Run scripts/scan-settings-for-secrets.sh, remove the entry, and rotate the credential." | tee -a "$LOG" >&2
    echo "$scan_warning" >&2
  fi
fi
rclone copyto "$CLAUDE_DIR/CLAUDE.md" "$DST/claude-config/CLAUDE.md"
if [ -f "$CLAUDE_DIR/keybindings.json" ]; then
    rclone copyto "$CLAUDE_DIR/keybindings.json" "$DST/claude-config/keybindings.json"
fi

# Append-only log (Dropbox revisions handle the per-run audit trail).
echo "$(ts) claude-memory backup ok" >> "$LOG"
