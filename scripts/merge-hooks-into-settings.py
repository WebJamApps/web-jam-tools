#!/usr/bin/env python3
"""merge-hooks-into-settings.py — web-jam-tools#265

Idempotently merges SessionStart and PreToolUse (any matcher) hook commands
into a Claude Code settings.json. Pulled out of install-hooks.sh's old
embedded heredoc into its own file so the merge logic can be unit-tested in
isolation, against a fixture settings.json, WITHOUT ever running
install-hooks.sh itself (which also symlinks hooks/*.sh into a real
~/.claude/hooks — see web-jam-tools#273 for why that's dangerous to trigger
outside a real install).

Usage:
    merge-hooks-into-settings.py SETTINGS_PATH -- SESSION_START_CMD... \\
        --pre-tool-use "MATCHER::CMD"...

Every other settings.json key (permissions, other hook events, etc.) is left
untouched. Backs up settings.json to settings.json.bak-<date> immediately
before any write, and only if a write is actually happening.
"""
import datetime
import json
import os
import shutil
import sys


def merge(settings_path: str, args: list[str]) -> int:
    # Parse arguments: session_start_cmds -- "<matcher>::<cmd>" pairs
    session_start_cmds: list[str] = []
    pre_tool_use_pairs: list[tuple[str, str]] = []

    if "--" in args:
        sep_idx = args.index("--")
        if "--pre-tool-use" in args[sep_idx:]:
            pre_sep_idx = args.index("--pre-tool-use", sep_idx)
            session_start_cmds = args[sep_idx + 1 : pre_sep_idx]
            for pair in args[pre_sep_idx + 1 :]:
                matcher, cmd = pair.split("::", 1)
                pre_tool_use_pairs.append((matcher, cmd))
        else:
            session_start_cmds = args[sep_idx + 1 :]

    if os.path.exists(settings_path):
        with open(settings_path) as f:
            raw = f.read()
        try:
            data = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError as e:
            print(
                f"error: {settings_path} is not valid JSON, refusing to touch it: {e}",
                file=sys.stderr,
            )
            return 1
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

    # Merge PreToolUse hooks, keyed by matcher (web-jam-tools#265 —
    # generalized from a Bash-only merge so ANY PreToolUse matcher can be
    # wired: an exact tool name, an alternation like "Edit|Write", or a
    # regex like "mcp__.*__issue_write"). Idempotent per (matcher, command)
    # pair: re-running never duplicates an entry, and an existing matcher
    # entry with unrelated commands is left alone.
    pre_tool_use = hooks.setdefault("PreToolUse", [])
    matcher_entries = {}
    for entry in pre_tool_use:
        m = entry.get("matcher")
        if m is not None:
            matcher_entries[m] = entry

    added_pre_tool_use: list[tuple[str, str]] = []
    for matcher, cmd in pre_tool_use_pairs:
        entry = matcher_entries.get(matcher)
        if entry is None:
            entry = {"matcher": matcher, "hooks": []}
            pre_tool_use.append(entry)
            matcher_entries[matcher] = entry

        existing = {h.get("command") for h in entry.get("hooks", []) if h.get("command")}
        if cmd not in existing:
            entry["hooks"].append({"type": "command", "command": cmd})
            added_pre_tool_use.append((matcher, cmd))

    if not added_session and not added_pre_tool_use:
        print("settings.json: SessionStart and PreToolUse hooks already up to date (no-op)")
        return 0

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
    for matcher, cmd in added_pre_tool_use:
        print(f"settings.json: added PreToolUse hook ({matcher}) {cmd}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: merge-hooks-into-settings.py SETTINGS_PATH -- ...", file=sys.stderr)
        sys.exit(1)
    sys.exit(merge(sys.argv[1], sys.argv[2:]))
