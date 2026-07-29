#!/usr/bin/env python3
"""merge-hooks-into-settings.py — web-jam-tools#265

Idempotently merges SessionStart, Stop, and PreToolUse/PostToolUse (any
matcher) hook commands into a Claude Code settings.json. Pulled out of
install-hooks.sh's old embedded heredoc into its own file so the merge logic
can be unit-tested in isolation, against a fixture settings.json, WITHOUT
ever running install-hooks.sh itself (which also symlinks hooks/*.sh into a
real ~/.claude/hooks — see web-jam-tools#273 for why that's dangerous to
trigger outside a real install).

Usage:
    merge-hooks-into-settings.py SETTINGS_PATH -- SESSION_START_CMD... \\
        --stop STOP_CMD... \\
        --pre-tool-use "MATCHER::CMD"... \\
        --post-tool-use "MATCHER::CMD"...

Stop hooks (web-jam-tools#290) are merged the same shape as SessionStart —
a flat list, no matcher, deduped by command — since Stop fires unconditionally
at the end of a turn, same as SessionStart fires unconditionally at the start
of a session.

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
    stop_cmds: list[str] = []
    pre_tool_use_pairs: list[tuple[str, str]] = []

    post_tool_use_pairs: list[tuple[str, str]] = []

    if "--" in args:
        sep_idx = args.index("--")
        rest = args[sep_idx + 1 :]

        # Split the tail on the optional section flags. Everything before the
        # first recognized section flag is SessionStart; --stop
        # (web-jam-tools#290), --pre-tool-use, and --post-tool-use
        # (web-jam-tools#272) are each parsed as their own section so a hook
        # can be wired to any of these events without a hand-edit.
        def _section(names: list[str], src: list[str]) -> tuple[list[str], dict]:
            idxs = {n: src.index(n) for n in names if n in src}
            first = min(idxs.values()) if idxs else len(src)
            head = src[:first]
            sections: dict = {}
            ordered = sorted(idxs.items(), key=lambda kv: kv[1])
            for pos, (name, start) in enumerate(ordered):
                end = ordered[pos + 1][1] if pos + 1 < len(ordered) else len(src)
                sections[name] = src[start + 1 : end]
            return head, sections

        session_start_cmds, sections = _section(
            ["--stop", "--pre-tool-use", "--post-tool-use"], rest
        )
        stop_cmds = list(sections.get("--stop", []))
        for pair in sections.get("--pre-tool-use", []):
            matcher, cmd = pair.split("::", 1)
            pre_tool_use_pairs.append((matcher, cmd))
        for pair in sections.get("--post-tool-use", []):
            matcher, cmd = pair.split("::", 1)
            post_tool_use_pairs.append((matcher, cmd))

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

    hooks = data.setdefault("hooks", {})

    # Merge a flat (no-matcher) hook event — SessionStart and Stop both fire
    # unconditionally, so both are a plain list of {"hooks": [...]} entries,
    # deduped by command, rather than the matcher-keyed shape PreToolUse/
    # PostToolUse use below.
    def merge_flat_hooks(kind: str, cmds: list[str]) -> list[str]:
        bucket = hooks.setdefault(kind, [])
        existing = set()
        for entry in bucket:
            for h in entry.get("hooks", []):
                c = h.get("command")
                if c:
                    existing.add(c)

        added: list[str] = []
        for cmd in cmds:
            if cmd not in existing:
                bucket.append({"hooks": [{"type": "command", "command": cmd}]})
                existing.add(cmd)
                added.append(cmd)
        return added

    added_session = merge_flat_hooks("SessionStart", session_start_cmds)
    added_stop = merge_flat_hooks("Stop", stop_cmds)

    # Merge PreToolUse hooks, keyed by matcher (web-jam-tools#265 —
    # generalized from a Bash-only merge so ANY PreToolUse matcher can be
    # wired: an exact tool name, an alternation like "Edit|Write", or a
    # regex like "mcp__.*__issue_write"). Idempotent per (matcher, command)
    # pair: re-running never duplicates an entry, and an existing matcher
    # entry with unrelated commands is left alone.
    def merge_matcher_hooks(kind: str, pairs: list[tuple[str, str]]):
        bucket = hooks.setdefault(kind, [])
        matcher_entries = {}
        for entry in bucket:
            m = entry.get("matcher")
            if m is not None:
                matcher_entries[m] = entry

        added: list[tuple[str, str]] = []
        for matcher, cmd in pairs:
            entry = matcher_entries.get(matcher)
            if entry is None:
                entry = {"matcher": matcher, "hooks": []}
                bucket.append(entry)
                matcher_entries[matcher] = entry

            existing = {
                h.get("command") for h in entry.get("hooks", []) if h.get("command")
            }
            if cmd not in existing:
                entry["hooks"].append({"type": "command", "command": cmd})
                added.append((matcher, cmd))
        return added

    added_pre_tool_use = merge_matcher_hooks("PreToolUse", pre_tool_use_pairs)
    added_post_tool_use = merge_matcher_hooks("PostToolUse", post_tool_use_pairs)

    if (
        not added_session
        and not added_stop
        and not added_pre_tool_use
        and not added_post_tool_use
    ):
        print(
            "settings.json: SessionStart, Stop, PreToolUse and PostToolUse "
            "hooks already up to date (no-op)"
        )
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
    for cmd in added_stop:
        print(f"settings.json: added Stop hook {cmd}")
    for matcher, cmd in added_pre_tool_use:
        print(f"settings.json: added PreToolUse hook ({matcher}) {cmd}")
    for matcher, cmd in added_post_tool_use:
        print(f"settings.json: added PostToolUse hook ({matcher}) {cmd}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: merge-hooks-into-settings.py SETTINGS_PATH -- ...", file=sys.stderr)
        sys.exit(1)
    sys.exit(merge(sys.argv[1], sys.argv[2:]))
