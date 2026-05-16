"""Drive-backed memory for the llama Coordinator.

Reads SHARED.md (cross-AI rules) and LLAMA.md (Coordinator-specific rules) from
Drive at REPL startup so the Coordinator has consistent context across sessions
and editing the rules doesn't require a code change. Provides append_memory()
for adding facts mid-session via the /remember REPL command or the remember_fact
tool — with code-level deduplication so the model can't pollute LLAMA.md by
calling remember_fact on a fact that's already saved.

Locations (2026-05-16):
- SHARED.md: at Drive root (My Drive/SHARED.md). Whitelisted in drive-cleanup.
- LLAMA.md: in My Drive/LLAMA/ folder.
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
LLAMA_MD_ID = "1C0UV0wi_H6y5YAAojVUf7F1_hjW0xsLp"

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


def _extract_fact_body(line: str) -> str:
    """Strip leading bullet + timestamp prefix from a REMEMBERED FACTS line."""
    return _TIMESTAMP_PREFIX.sub("", line).strip()


def find_duplicate(entry: str, file_id: str = LLAMA_MD_ID) -> str | None:
    """Return the existing line if `entry` is a near-duplicate of one already in the file.

    Match heuristic: after normalization, treat as duplicate when the new entry is a
    substring of an existing fact OR an existing fact is a substring of the new entry.
    Catches both shorter-new vs longer-existing and the reverse.
    """
    try:
        current = _read_file(file_id)
    except Exception:
        return None
    normalized_new = _normalize(entry)
    if len(normalized_new) < 5:
        return None
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
    return None


def load_memory() -> str | None:
    """Read SHARED.md + LLAMA.md from Drive and return the combined text.

    Returns None if either file fails to load (network issue, missing file),
    so callers can fall back to a hardcoded SYSTEM_PROMPT.
    """
    try:
        shared = _read_file(SHARED_MD_ID)
        llama = _read_file(LLAMA_MD_ID)
    except Exception:
        return None
    return f"{shared}\n\n---\n\n{llama}\n"


def append_memory(entry: str, file_id: str = LLAMA_MD_ID) -> dict[str, Any]:
    """Append a timestamped line to a memory file (default: LLAMA.md).

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
