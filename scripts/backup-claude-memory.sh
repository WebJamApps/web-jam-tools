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
# Scheduled via crontab at 06:55 ET daily (5 min before drive-cleanup at 07:00).
# Manual: just run this script.

set -euo pipefail

SRC_PROJECTS="$HOME/.claude/projects"
SRC_SHARED="$HOME/.claude/shared-memory"
DST="$HOME/Dropbox/web-jam-llms/claude-backup"
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
rclone copyto "$HOME/.claude/CLAUDE.md" "$DST/CLAUDE.md"

# Append-only log (Dropbox revisions handle the per-run audit trail).
echo "$(ts) claude-memory backup ok" >> "$LOG"
