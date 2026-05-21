"""Local-FS-backed memory for the Coordinator (gemma4:26b post-2026-05-20 swap).

Reads SHARED.md (cross-AI rules) and GEMMA.md (Coordinator-specific rules) from
the local Dropbox-mirrored folder at REPL startup so the Coordinator has
consistent context across sessions and editing the rules doesn't require a
code change. Provides append_memory() for adding facts mid-session via the
/remember REPL command or the remember_fact tool — with code-level
deduplication so the model can't pollute GEMMA.md by calling remember_fact
on a fact that's already saved.

Migrated 2026-05-21 from Drive REST API to local filesystem reads. See
project-web-jam-llms-migration-plan for rationale and the cross-store bridge
that keeps Sonnet's writes flowing in. Files now live at:

  /home/joshua/Dropbox/web-jam-llms/SHARED.md
  /home/joshua/Dropbox/web-jam-llms/GEMMA.md

(symlinked into /home/joshua/WebJamApps/web-jam-llms/ for VSCode visibility).
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

# Local-FS memory store (migrated from Drive 2026-05-21). Paths mirror
# queue.py's QUEUE_DIR; kept duplicated rather than imported to avoid a
# cross-module dependency for a constant string.
MEMORY_DIR = "/home/joshua/Dropbox/web-jam-llms"
SHARED_MD_PATH = f"{MEMORY_DIR}/SHARED.md"
GEMMA_MD_PATH = f"{MEMORY_DIR}/GEMMA.md"

# Matches a REMEMBERED FACTS line prefix: "- 2026-05-16 11:26 UTC: "
_TIMESTAMP_PREFIX = re.compile(
    r"^\s*-\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*UTC:\s*"
)


def _read_file(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def _atomic_write(path: str, content: str) -> None:
    """Write `content` to `path` atomically: write to `<path>.tmp`, fsync, rename.

    Mirror of queue.py._atomic_write. See that docstring for rationale. Crash
    mid-write leaves either the original file intact or the new file fully
    written — never a partial state.
    """
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _normalize(text: str) -> str:
    """Lowercase, strip non-alphanumeric (except spaces), collapse whitespace.

    Used for near-duplicate detection so cosmetic differences (quotes, dashes,
    case) don't bypass the check.
    """
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", text.lower())).strip()


# Short common English words that carry little meaning. Filtered out before
# token-overlap comparison so paraphrases like "favorite venue to play at" vs
# "likes to play at" can be detected as referring to the same content.
_STOPWORDS = frozenset({
    "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
    "am", "do", "does", "did", "have", "has", "had",
    "at", "in", "on", "of", "to", "for", "from", "with", "by", "as", "into",
    "about", "over", "under", "after", "before",
    "and", "or", "but", "if", "that", "this", "these", "those",
    "i", "me", "my", "you", "your", "he", "she", "it", "his", "her", "its",
    "we", "our", "they", "their", "them",
    "what", "which", "who", "whom", "when", "where", "why", "how",
    "no", "not", "also", "all", "any", "some", "such", "so",
    "will", "would", "could", "should", "may", "might", "must", "can",
    "than", "then",
})


def _content_tokens(normalized_text: str) -> set[str]:
    """Tokenize a `_normalize`d string; drop stopwords and 1-char tokens.

    Returned set represents the content-bearing words of a fact, suitable for
    overlap comparison between two facts.
    """
    return {t for t in normalized_text.split() if len(t) > 1 and t not in _STOPWORDS}


def _extract_fact_body(line: str) -> str:
    """Strip leading bullet + timestamp prefix from a REMEMBERED FACTS line."""
    return _TIMESTAMP_PREFIX.sub("", line).strip()


def find_duplicate(entry: str, path: str = GEMMA_MD_PATH) -> str | None:
    """Return the existing line if `entry` is a near-duplicate of one already saved.

    Two heuristics in order; first match wins:

    1. Normalized substring containment — catches literal repeats and shorter-vs-
       longer-form versions of the same fact ("Sign emails as X" vs "Sign emails
       as X instead of Y").

    2. Content-token overlap — drops stopwords and short tokens, then compares
       remaining content words. If shared / smaller-set >= 0.6, treat as a near
       duplicate. Catches paraphrases like "Josh's favorite venue to play at is
       Stave & Cork" vs "Josh likes to play at Stave & Cork" — same fact, different
       wording, no literal substring overlap.

    Returns the existing line (with timestamp) on match, else None.
    """
    try:
        current = _read_file(path)
    except Exception:
        return None
    normalized_new = _normalize(entry)
    if len(normalized_new) < 5:
        return None
    new_tokens = _content_tokens(normalized_new)
    for line in current.splitlines():
        line = line.rstrip()
        if not line.lstrip().startswith("-"):
            continue
        body = _extract_fact_body(line)
        normalized_existing = _normalize(body)
        if len(normalized_existing) < 5:
            continue
        if normalized_new in normalized_existing or normalized_existing in normalized_new:
            return line
        if len(new_tokens) >= 2:
            existing_tokens = _content_tokens(normalized_existing)
            if len(existing_tokens) >= 2:
                shared = new_tokens & existing_tokens
                smaller = min(len(new_tokens), len(existing_tokens))
                if len(shared) / smaller >= 0.6:
                    return line
    return None


def load_memory() -> str | None:
    """Read SHARED.md + GEMMA.md from local FS and return the combined text.

    Returns None if either file fails to load (missing, permission, etc.),
    so callers can fall back to a hardcoded SYSTEM_PROMPT.
    """
    try:
        shared = _read_file(SHARED_MD_PATH)
        coordinator = _read_file(GEMMA_MD_PATH)
    except Exception:
        return None
    return f"{shared}\n\n---\n\n{coordinator}\n"


def append_memory(entry: str, path: str = GEMMA_MD_PATH) -> dict[str, Any]:
    """Append a timestamped line to a memory file (default: GEMMA.md).

    Code-level deduplication: if a near-match already exists, skip the write and
    return {'saved': False, 'reason': 'already-saved', 'existing_entry': '<line>'}.
    Otherwise return {'saved': True, 'path': ..., 'modifiedTime': ...}.

    The model can't be trusted to follow the prompt-level anti-duplication rule
    (it tends to call remember_fact even on RECALL questions about saved rules),
    so the rule is enforced here instead.

    Writes are atomic — see _atomic_write. Concurrent writes from another
    process (e.g. an editor saving the same file) could race; the last writer
    wins. In practice gemma-cli is the only writer and Dropbox handles cross-
    machine sync with conflict-copy semantics.
    """
    dup = find_duplicate(entry, path=path)
    if dup is not None:
        return {
            "saved": False,
            "reason": "already-saved",
            "existing_entry": dup,
        }
    try:
        current = _read_file(path)
    except FileNotFoundError:
        current = ""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    new_line = f"\n- {timestamp}: {entry}"
    new_content = current.rstrip() + new_line + "\n"
    _atomic_write(path, new_content)
    return {
        "saved": True,
        "path": path,
        "modifiedTime": datetime.now(timezone.utc).isoformat(),
    }
