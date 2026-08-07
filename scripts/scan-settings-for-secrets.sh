#!/usr/bin/env bash
# scan-settings-for-secrets.sh — web-jam-tools#304 Layer 2.
#
# hooks/block-secret-literals.sh stops NEW credential literals from being
# approved into permissions.allow. This scanner catches anything that slipped
# through BEFORE that hook existed — the actual 2026-07-29 discovery was a
# live Gemini API key sitting as allow rule #104, `Bash(export
# GEMINI_API_KEY="<key>")`, undetected for ~2 months.
#
# What it does: reads ~/.claude/settings.json (or $CLAUDE_SETTINGS_PATH /
# --settings-path), walks every string under permissions.allow (and, for
# belt-and-suspenders, permissions.deny/ask if present), and reports loudly —
# by RULE INDEX and credential TYPE NAME only — for any entry containing a
# credential-shaped literal. NEVER prints the matched value or the full rule
# text, only its position and shape, so running this scanner cannot itself
# leak the secret it finds.
#
# Usage: scripts/scan-settings-for-secrets.sh [--settings-path PATH]
#   Exit 0: no credential-shaped literal found (or settings.json doesn't exist).
#   Exit 1: at least one was found — reported to stderr.
#
# Intended use: run manually, from a SessionStart hook, or on a schedule.
# This repo does not wire it into install-hooks.sh's SessionStart list yet
# (that would require decrementing the same session start-up cost every
# single session for a check that only ever needs to catch drift once) —
# Josh can add it there if he wants it automatic; today it's callable and
# tested, and README/AGENTS documents how to run it.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS_PATH="${CLAUDE_SETTINGS_PATH:-$HOME/.claude/settings.json}"

while [ $# -gt 0 ]; do
  case "$1" in
    --settings-path)
      SETTINGS_PATH="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

deno run --allow-read --allow-env "$REPO_DIR/scripts/scan_settings_for_secrets.ts" "$SETTINGS_PATH"
