"""File-discipline guardrails.

Enforces two project rules in code (formerly prompt-trust only):
- "One master file per purpose, never version-suffix" — see MariaParty Gemini Instructions.
- "Protected files cannot be modified without explicit override" — covers the RSVP MASTER
  and other files the docs flag as DO-NOT-TOUCH.
"""

from __future__ import annotations

import re

_VERSION_SUFFIX = re.compile(r"\b[Vv]\d+\b|-(copy|new|backup|draft|old|tmp)\b", re.IGNORECASE)

# id -> human-readable reason. Sourced from project docs (MariaParty Gemini Instructions)
# and the canonical task-queue inventory at Drive root.
PROTECTED_FILES: dict[str, str] = {
    "1dVyXKVfl0G2fbA__2AOl22aWxjqcnwU9": (
        "MariaParty RSVP MASTER — DO NOT TOUCH without Josh's explicit instruction. "
        "This is the locked source of truth for the guest list. "
        "(Corrected id 2026-05-19 — previous entry 1ZpoXBxMZtV7I76AUBTMkiEkaO49JNWsE "
        "was a stale 2026-05-08 csv copy; live master is text/plain in MariaParty folder.)"
    ),
    "1sdHddtCyXlhv9ONaiD_kHV-hB3R520Yy": (
        "MariaParty Master Plan v2 — flagged DO NOT DELETE; edits allowed only with Josh's confirmation."
    ),
    "129j2LWzs8_0jSAkqLGe_Zw53CD16YxMX": (
        "MariaParty Banner Decision — flagged DO NOT DELETE."
    ),
    # Canonical task queues at Drive root. Each is the ONE source of truth for its model's
    # backlog. Never trash or move during cleanup passes — phone-authored siblings
    # (e.g. gemma-tasks-<timestamp>.txt) merge INTO these, not the other way around.
    "1Rz5yi81zy5ohwirUJsliF1KONIXUIQQL": (
        "claude-opus-tasks.txt at Drive root — canonical task queue for Claude Opus."
    ),
    "1PiobgF2vPhimDtTpQnjkWSaNQ6zaYI-g": (
        "gemma-tasks.txt at Drive root — canonical task queue for the Coordinator (gemma4:26b on OMEN). "
        "Renamed from llama-tasks.txt on 2026-05-20 during the Coordinator swap; Drive ID unchanged."
    ),
    "1ooDgwiatb66PGH40ae1KpRTb9WAvn-IZ": (
        "claude-sonnet-tasks.txt at Drive root — canonical task queue for Claude Sonnet on the phone app."
    ),
}


class GuardError(Exception):
    pass


def check_filename(name: str) -> None:
    if _VERSION_SUFFIX.search(name):
        raise GuardError(
            f"Filename '{name}' looks like a version/duplicate suffix. "
            "Project rule: edit the existing master file instead of creating a new version."
        )


def check_protected_write(file_id: str, force: bool = False) -> None:
    if force:
        return
    if file_id in PROTECTED_FILES:
        raise GuardError(
            f"File '{file_id}' is PROTECTED ({PROTECTED_FILES[file_id]}) "
            "Pass force=true ONLY if Josh has explicitly instructed you to modify it."
        )
