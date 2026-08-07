#!/usr/bin/env bash
# prune-local-permission-allows.sh — web-jam-tools#341
#
# Prunes R-5, R-11, and R-20 allow rules from settings.local.json files.
#
# ORDERING CONSTRAINT:
# Run this script ONLY AFTER web-jam-tools#340 ("Apply the agreed permission
# rule set: gh, gh api, MCP writes, Heroku, and the draft-PR carve-out") has
# landed and been installed (via scripts/install-hooks.sh).
# With the primary deny/ask rules in place first, any later "don't ask again"
# approval in settings.local.json loses to the primary ask rule. If pruned before
# primary rules land, settings.local.json rebuilds without protection.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for arg in "$@"; do
  if [ "$arg" = "--help" ] || [ "$arg" = "-h" ]; then
    echo "Usage: scripts/prune-local-permission-allows.sh [--apply] [--help]"
    echo ""
    echo "Prunes R-5, R-11, and R-20 allow rules from settings.local.json files."
    echo ""
    echo "ORDERING CONSTRAINT:"
    echo "Run this script ONLY AFTER web-jam-tools#340 (\"Apply the agreed permission rule set: gh, gh api, MCP writes, Heroku, and the draft-PR carve-out\") has landed and been installed (via scripts/install-hooks.sh). With the primary deny/ask rules in place first, any later \"don't ask again\" approval in settings.local.json loses to the primary ask rule. If pruned before primary rules land, settings.local.json rebuilds without protection."
    echo ""
    echo "Options:"
    echo "  --apply   Apply changes to target files (backs up each file before writing)."
    echo "            Default is dry-run mode (modifies no files)."
    echo "  --help    Show this help message."
    echo ""
    echo "Target Files:"
    echo "  - ~/.claude/settings.local.json"
    echo "  - ~/WebJamApps/JaMmusic/.claude/settings.local.json"
    echo "  - ~/WebJamApps/WebJamSocketCluster/.claude/settings.local.json"
    echo "  - ~/WebJamApps/web-jam-back/.claude/settings.local.json"
    echo ""
    echo "Rules Pruned:"
    echo "  - R-5: Blanket wildcards (gh pr *, gh issue *, gh api *, gh repo *, gh label *, gh project *)"
    echo "  - R-11: GitHub MCP write allows (add_issue_comment, issue_write, sub_issue_write)"
    echo "  - R-20: create-draft-pr.sh rules (removes frozen strings & worktree path wildcards; keeps the 4 canonical path spellings)"
    exit 0
  fi
done

exec deno run --allow-read --allow-write --allow-env "$REPO_DIR/src/prune-local-permission-allows/cli.ts" "$@"
