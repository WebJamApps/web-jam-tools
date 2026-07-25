#!/usr/bin/env bash
# install-hooks.sh — make this repo the single source of truth for Claude Code hooks.
#
# 1. For every *.sh under <repo>/hooks/, symlink ~/.claude/hooks/<name> -> it.
#    Idempotent: already-correct symlinks are left alone. An existing REAL
#    file is backed up (never deleted) to ~/.claude/hooks/<name>.bak-<date>.
#
# 2. Idempotently merges the SessionStart hook(s) listed in
#    SESSION_START_HOOKS below into ~/.claude/settings.json (only adding
#    entries that aren't already there; every other key — permissions,
#    other hook events, etc. — is left untouched). settings.json is backed
#    up to settings.json.bak-<date> immediately before any write, and only
#    if a write is actually happening.
#
# Note: most of this repo's hooks (PreToolUse guards/reminders) were wired
# into settings.json manually, one time, directly on the laptop, before this
# script could do it — settings.json itself is intentionally NOT
# version-controlled in this public repo (it contains Josh's permission
# strings); it's backed up privately instead, alongside Claude Code memory
# (see scripts/backup-claude-memory.sh). SESSION_START_HOOKS below is the
# list of hooks THIS script keeps registered automatically; add a new
# SessionStart hook's script name there and re-run to wire it up with no
# manual settings edit (web-jam-tools#163).
#
# Usage: scripts/install-hooks.sh [--settings-path PATH]
#   --settings-path PATH   Merge into PATH instead of $HOME/.claude/settings.json
#                           (also settable via CLAUDE_SETTINGS_PATH). Mainly for
#                           testing the merge without touching a real settings file.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOKS_SRC="$REPO_DIR/hooks"
HOOKS_DEST="$HOME/.claude/hooks"
STAMP="$(date +%Y%m%d-%H%M%S)"
SETTINGS_PATH="${CLAUDE_SETTINGS_PATH:-$HOME/.claude/settings.json}"

# SessionStart hooks this installer keeps registered in settings.json.
# Script names only (must exist under hooks/); the merge step below turns
# each into the literal command string "$HOME/.claude/hooks/<name>" (expanded
# by the shell that runs the hook, not by this installer — matches the style
# of the hooks already wired into settings.json).
SESSION_START_HOOKS=(notes-sync-reminder.sh)

# PreToolUse Bash hooks this installer keeps registered in settings.json.
# These hooks run before Bash tool execution; script names only.
PRE_TOOL_USE_BASH_HOOKS=(semver-push-reminder.sh block-secret-dumps.sh block-dangerous-git-deploy.sh authorization-check.sh fmt-push-guard.sh block-agy-non-flash-model.sh)

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

[ -d "$HOOKS_SRC" ] || { echo "error: $HOOKS_SRC not found" >&2; exit 1; }
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

# --- Merge SESSION_START_HOOKS and PRE_TOOL_USE_BASH_HOOKS into settings.json (idempotent) ---
merge_session_start_args=()
for name in "${SESSION_START_HOOKS[@]}"; do
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in SESSION_START_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_session_start_args+=('$HOME/.claude/hooks/'"$name")
done

merge_bash_hooks_args=()
for name in "${PRE_TOOL_USE_BASH_HOOKS[@]}"; do
  [ -e "$HOOKS_SRC/$name" ] || { echo "error: $HOOKS_SRC/$name not found (listed in PRE_TOOL_USE_BASH_HOOKS)" >&2; exit 1; }
  # shellcheck disable=SC2016 # literal $HOME on purpose: expanded by the
  # shell that runs the hook later, not by this installer (see header note).
  merge_bash_hooks_args+=('$HOME/.claude/hooks/'"$name")
done

python3 - "$SETTINGS_PATH" "--" "${merge_session_start_args[@]}" "--bash-hooks" "${merge_bash_hooks_args[@]}" <<'PYEOF'
import json
import os
import shutil
import sys
import datetime

settings_path = sys.argv[1]
args = sys.argv[2:]

# Parse arguments: session_start_cmds -- bash_hook_cmds
session_start_cmds = []
bash_hook_cmds = []

if "--" in args:
    sep_idx = args.index("--")
    if "--bash-hooks" in args[sep_idx:]:
        bash_sep_idx = args.index("--bash-hooks", sep_idx)
        session_start_cmds = args[sep_idx + 1:bash_sep_idx]
        bash_hook_cmds = args[bash_sep_idx + 1:]
    else:
        session_start_cmds = args[sep_idx + 1:]

if os.path.exists(settings_path):
    with open(settings_path) as f:
        raw = f.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        print(f"error: {settings_path} is not valid JSON, refusing to touch it: {e}", file=sys.stderr)
        sys.exit(1)
else:
    data = {}

# Merge SessionStart hooks
hooks = data.setdefault("hooks", {})
session_start = hooks.setdefault("SessionStart", [])

existing_session = set()
for entry in session_start:
    for h in entry.get("hooks", []):
        c = h.get("command")
        if c:
            existing_session.add(c)

added_session = []
for cmd in session_start_cmds:
    if cmd not in existing_session:
        session_start.append({"hooks": [{"type": "command", "command": cmd}]})
        existing_session.add(cmd)
        added_session.append(cmd)

# Merge PreToolUse Bash hooks
pre_tool_use = hooks.setdefault("PreToolUse", [])
bash_matcher_entry = None
for entry in pre_tool_use:
    if entry.get("matcher") == "Bash":
        bash_matcher_entry = entry
        break

if bash_hook_cmds and not bash_matcher_entry:
    bash_matcher_entry = {"matcher": "Bash", "hooks": []}
    pre_tool_use.append(bash_matcher_entry)

existing_bash = set()
if bash_matcher_entry:
    for h in bash_matcher_entry.get("hooks", []):
        c = h.get("command")
        if c:
            existing_bash.add(c)

added_bash = []
if bash_matcher_entry:
    for cmd in bash_hook_cmds:
        if cmd not in existing_bash:
            bash_matcher_entry["hooks"].append({"type": "command", "command": cmd})
            existing_bash.add(cmd)
            added_bash.append(cmd)

if not added_session and not added_bash:
    print("settings.json: SessionStart and Bash PreToolUse hooks already up to date (no-op)")
    sys.exit(0)

if os.path.exists(settings_path):
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{settings_path}.bak-{stamp}"
    shutil.copy2(settings_path, backup)
    print(f"settings.json: backed up previous version to {os.path.basename(backup)}")

os.makedirs(os.path.dirname(settings_path) or ".", exist_ok=True)
with open(settings_path, "w") as f:
    json.dump(data, f, indent=2)
    f.write("\n")

for cmd in added_session:
    print(f"settings.json: added SessionStart hook {cmd}")
for cmd in added_bash:
    print(f"settings.json: added Bash PreToolUse hook {cmd}")
PYEOF
