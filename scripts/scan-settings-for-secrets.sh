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

[ -f "$SETTINGS_PATH" ] || { echo "no settings.json at $SETTINGS_PATH — nothing to scan"; exit 0; }

SETTINGS_PATH="$SETTINGS_PATH" HOOKS_LIB_DIR="$REPO_DIR/hooks/lib" python3 - <<'PYEOF'
import json
import os
import sys

# hooks/lib is not on sys.path by default; HOOKS_LIB_DIR points at it (this
# script lives at <repo>/scripts/, hooks/lib is a sibling of scripts/).
sys.path.insert(0, os.environ["HOOKS_LIB_DIR"])
from detect_credential_literal import find_credential_literal  # noqa: E402

path = os.environ["SETTINGS_PATH"]
with open(path, encoding="utf-8") as f:
    data = json.load(f)

findings = []  # (section, index, type_name) — never the matched value or full string
permissions = data.get("permissions", {})
for section in ("allow", "deny", "ask"):
    entries = permissions.get(section)
    if not isinstance(entries, list):
        continue
    for i, entry in enumerate(entries):
        if not isinstance(entry, str):
            continue
        match = find_credential_literal(entry)
        if match:
            findings.append((section, i, match))

if findings:
    print("CREDENTIAL-SHAPED LITERAL(S) FOUND in permissions of " + path, file=sys.stderr)
    for section, i, match in findings:
        print(f"  permissions.{section}[{i}]: {match}", file=sys.stderr)
    print("These entries are also FUNCTIONALLY USELESS — allow/deny/ask match literally,", file=sys.stderr)
    print("so a rule containing a secret only ever matched that one exact command with", file=sys.stderr)
    print("that one exact secret value. Remove the entry and rotate the credential.", file=sys.stderr)
    print("(rule: web-jam-tools#304)", file=sys.stderr)
    sys.exit(1)

print(f"no credential-shaped literals found in {path}")
sys.exit(0)
PYEOF
