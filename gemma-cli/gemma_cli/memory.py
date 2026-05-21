"""Drive-backed memory for the Coordinator (gemma4:26b post-2026-05-20 swap).

Reads SHARED.md (cross-AI rules) and GEMMA.md (Coordinator-specific rules) from
Drive at REPL startup so the Coordinator has consistent context across sessions
and editing the rules doesn't require a code change. Provides append_memory()
for adding facts mid-session via the /remember REPL command or the remember_fact
tool — with code-level deduplication so the model can't pollute GEMMA.md by
calling remember_fact on a fact that's already saved.

Locations:
- SHARED.md: at Drive root (My Drive/SHARED.md). Whitelisted in drive-cleanup.
- GEMMA.md: in My Drive/GEMMA/ folder (renamed from LLAMA/GEMMA.md on 2026-05-20).
  Drive file ID is unchanged; only the display name changed.
"""

from __future__ import annotations

import io
import re
from datetime import datetime, timezone
from typing import Any

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload

from gemma_cli.auth import load_credentials

# Drive IDs (set 2026-05-16 when files were created).
SHARED_MD_ID = "1X48-YCTaYScEIEJNaD4__imsMfWwMoRr"
GEMMA_MD_ID = "1C0UV0wi_H6y5YAAojVUf7F1_hjW0xsLp"
# Backward-compat alias — code references LLAMA_MD_ID in a few spots; keep until cleanup is complete.
LLAMA_MD_ID = GEMMA_MD_ID

_service = None

# Matches a REMEMBERED FACTS line prefix: "- 2026-05-16 11:26 UTC: "
_TIMESTAMP_PREFIX = re.compile(
    r"^\s*-\s*\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*UTC:\s*"
)


def _drive():
    global _service
    if _service is None:
        _service = build("drive", "v3", credentials=load_credentials(), cache_discovery=False)
    return _service


def _read_file(file_id: str) -> str:
    content = _drive().files().get_media(fileId=file_id).execute()
    if isinstance(content, bytes):
        return content.decode("utf-8", errors="replace")
    return content


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


def find_duplicate(entry: str, file_id: str = LLAMA_MD_ID) -> str | None:
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
        current = _read_file(file_id)
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
    """Read SHARED.md + GEMMA.md from Drive and return the combined text.

    Returns None if either file fails to load (network issue, missing file),
    so callers can fall back to a hardcoded SYSTEM_PROMPT.
    """
    try:
        shared = _read_file(SHARED_MD_ID)
        coordinator = _read_file(GEMMA_MD_ID)
    except Exception:
        return None
    return f"{shared}\n\n---\n\n{coordinator}\n"


def append_memory(entry: str, file_id: str = LLAMA_MD_ID) -> dict[str, Any]:
    """Append a timestamped line to a memory file (default: GEMMA.md).

    Code-level deduplication: if a near-match already exists, skip the write and
    return {'saved': False, 'reason': 'already-saved', 'existing_entry': '<line>'}.
    Otherwise return {'saved': True, 'id': ..., 'name': ..., 'modifiedTime': ...}.

    The model can't be trusted to follow the prompt-level anti-duplication rule
    (it tends to call remember_fact even on RECALL questions about saved rules),
    so the rule is enforced here instead.
    """
    dup = find_duplicate(entry, file_id=file_id)
    if dup is not None:
        return {
            "saved": False,
            "reason": "already-saved",
            "existing_entry": dup,
        }
    current = _read_file(file_id)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    new_line = f"\n- {timestamp}: {entry}"
    new_content = current.rstrip() + new_line + "\n"
    media = MediaIoBaseUpload(io.BytesIO(new_content.encode("utf-8")), mimetype="text/markdown")
    f = (
        _drive()
        .files()
        .update(fileId=file_id, media_body=media, fields="id,name,modifiedTime")
        .execute()
    )
    return {
        "saved": True,
        "id": f["id"],
        "name": f["name"],
        "modifiedTime": f["modifiedTime"],
    }
