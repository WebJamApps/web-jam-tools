#!/usr/bin/env python3
"""merge-hooks-into-settings.py — web-jam-tools#265

Idempotently merges SessionStart, Stop, and PreToolUse/PostToolUse (any
matcher) hook commands, plus a flat list of `permissions.deny` patterns,
into a Claude Code settings.json. Pulled out of install-hooks.sh's old
embedded heredoc into its own file so the merge logic can be unit-tested
in isolation, against a fixture settings.json, WITHOUT ever running
install-hooks.sh itself (which also symlinks hooks/*.sh into a real
~/.claude/hooks — see web-jam-tools#273 for why that's dangerous to
trigger outside a real install).

Prunes stale hook entries when a hook's matcher changes (web-jam-tools#293):
when installing a hook with a new matcher, any existing entry for the same
script (in any other matcher) is removed, keeping only one entry per managed
hook script.

Usage:
    merge-hooks-into-settings.py SETTINGS_PATH -- SESSION_START_CMD... \\
        --stop STOP_CMD... \\
        --pre-tool-use "MATCHER::CMD"... \\
        --post-tool-use "MATCHER::CMD"... \\
        --deny "PATTERN"...

Stop hooks (web-jam-tools#290) are merged the same shape as SessionStart —
a flat list, no matcher, deduped by command — since Stop fires unconditionally
at the end of a turn, same as SessionStart fires unconditionally at the start
of a session.

--deny (web-jam-tools#308) merges a flat list of Bash permission-pattern
strings into permissions.deny, deduped by exact string, appended in order.
It is PURELY ADDITIVE: permissions.allow and permissions.ask are never read
or written, and any pre-existing permissions.deny entries (hand-added or
from a previous run) are kept, never reordered or removed.

Every other settings.json key (permissions.allow, permissions.ask, other
hook events, etc.) is left untouched. Backs up settings.json to
settings.json.bak-<date> immediately before any write, and only if a write
is actually happening.
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
    deny_patterns: list[str] = []

    if "--" in args:
        sep_idx = args.index("--")
        rest = args[sep_idx + 1 :]

        # Split the tail on the optional section flags. Everything before the
        # first recognized section flag is SessionStart; --stop
        # (web-jam-tools#290), --pre-tool-use, --post-tool-use
        # (web-jam-tools#272), and --deny (web-jam-tools#308) are each parsed
        # as their own section so a hook or deny pattern can be wired without
        # a hand-edit.
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
            ["--stop", "--pre-tool-use", "--post-tool-use", "--deny"], rest
        )
        stop_cmds = list(sections.get("--stop", []))
        for pair in sections.get("--pre-tool-use", []):
            matcher, cmd = pair.split("::", 1)
            pre_tool_use_pairs.append((matcher, cmd))
        for pair in sections.get("--post-tool-use", []):
            matcher, cmd = pair.split("::", 1)
            post_tool_use_pairs.append((matcher, cmd))
        deny_patterns = list(sections.get("--deny", []))

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
    #
    # web-jam-tools#293: prunes stale entries when a hook's matcher changes.
    # When installing (matcher, cmd), any existing entry for the same script
    # path in other matchers is removed, keeping only one entry per script.
    def extract_script_path(cmd: str) -> str:
        """Extract the script path (first whitespace-separated token) from a command."""
        return cmd.split()[0] if cmd else cmd

    def merge_matcher_hooks(kind: str, pairs: list[tuple[str, str]]):
        bucket = hooks.setdefault(kind, [])
        matcher_entries = {}
        for entry in bucket:
            m = entry.get("matcher")
            if m is not None:
                matcher_entries[m] = entry

        # Build a set of script paths being installed this run.
        scripts_being_installed = set()
        for _matcher, cmd in pairs:
            scripts_being_installed.add(extract_script_path(cmd))

        added: list[tuple[str, str]] = []
        pruned: list[tuple[str, str]] = []  # (script_path, old_matcher)

        for matcher, cmd in pairs:
            script_path = extract_script_path(cmd)
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

            # Prune this script from any other matcher (web-jam-tools#293).
            # Only prune scripts that are being installed this run (conservative).
            for other_matcher, other_entry in list(matcher_entries.items()):
                if other_matcher == matcher:
                    continue
                other_hooks = other_entry.get("hooks", [])
                remaining = []
                for h in other_hooks:
                    h_cmd = h.get("command")
                    if h_cmd and extract_script_path(h_cmd) == script_path:
                        # This hook has the same script path; prune it.
                        pruned.append((script_path, other_matcher))
                    else:
                        remaining.append(h)
                other_entry["hooks"] = remaining

                # Delete the entry if it's now empty.
                if not remaining:
                    bucket.remove(other_entry)
                    del matcher_entries[other_matcher]

        return added, pruned

    added_pre_tool_use, pruned_pre_tool_use = merge_matcher_hooks("PreToolUse", pre_tool_use_pairs)
    added_post_tool_use, pruned_post_tool_use = merge_matcher_hooks("PostToolUse", post_tool_use_pairs)

    # Merge permissions.deny (web-jam-tools#308): a flat list of Bash
    # permission-pattern strings, deduped by exact string, appended in
    # order. PURELY ADDITIVE — permissions.allow and permissions.ask are
    # never touched, and any pre-existing permissions.deny entries (hand-
    # added, or from a previous run) are kept exactly as-is: this only ever
    # appends new entries, never reorders or removes existing ones.
    def merge_deny(patterns: list[str]) -> list[str]:
        if not patterns:
            # Nothing to add: don't even touch/create the "permissions" or
            # "deny" keys — a settings.json with no permissions.deny key at
            # all must stay that way when this run carries no --deny args.
            return []
        permissions = data.setdefault("permissions", {})
        deny_list = permissions.setdefault("deny", [])
        existing = set(deny_list)
        added: list[str] = []
        for pattern in patterns:
            if pattern not in existing:
                deny_list.append(pattern)
                existing.add(pattern)
                added.append(pattern)
        return added

    added_deny = merge_deny(deny_patterns)

    target_filename = os.path.basename(settings_path)

    if (
        not added_session
        and not added_stop
        and not added_pre_tool_use
        and not added_post_tool_use
        and not pruned_pre_tool_use
        and not pruned_post_tool_use
        and not added_deny
    ):
        print(
            f"{target_filename}: SessionStart, Stop, PreToolUse, PostToolUse hooks "
            "and permissions.deny already up to date (no-op)"
        )
        return 0

    if os.path.exists(settings_path):
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = f"{settings_path}.bak-{stamp}"
        shutil.copy2(settings_path, backup)
        print(f"{target_filename}: backed up previous version to {os.path.basename(backup)}")

    os.makedirs(os.path.dirname(settings_path) or ".", exist_ok=True)
    with open(settings_path, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")

    for cmd in added_session:
        print(f"{target_filename}: added SessionStart hook {cmd}")
    for cmd in added_stop:
        print(f"{target_filename}: added Stop hook {cmd}")
    for matcher, cmd in added_pre_tool_use:
        print(f"{target_filename}: added PreToolUse hook ({matcher}) {cmd}")
    for matcher, cmd in added_post_tool_use:
        print(f"{target_filename}: added PostToolUse hook ({matcher}) {cmd}")
    for script_path, old_matcher in pruned_pre_tool_use:
        print(f"{target_filename}: PreToolUse {script_path}: replaced stale matcher ({old_matcher})")
    for script_path, old_matcher in pruned_post_tool_use:
        print(f"{target_filename}: PostToolUse {script_path}: replaced stale matcher ({old_matcher})")
    for pattern in added_deny:
        print(f"{target_filename}: added permissions.deny rule {pattern}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: merge-hooks-into-settings.py SETTINGS_PATH -- ...", file=sys.stderr)
        sys.exit(1)
    sys.exit(merge(sys.argv[1], sys.argv[2:]))
