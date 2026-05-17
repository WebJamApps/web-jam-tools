"""Drive tool implementations.

Read operations are unrestricted. Write operations pass through file-discipline guards
(see guards.py) before hitting the Drive API.
"""

from __future__ import annotations

from typing import Any

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload
import io

from gemma_cli.auth import load_credentials
from gemma_cli.guards import check_filename, check_protected_write, GuardError
from gemma_cli.llm import Tool

# Known folder IDs from project memory.
KNOWN_FOLDERS = {
    "CLAUDE": "1ZcyzNFUD92QZfkMa9pMqW12HDsjGOFaB",
    "GEMINI": "1VLKSJvhJwlTDdR_nK0z2Ob2yRQ_oHYaO",
    "JoshMariaMusic": "1iS3KQwJwjAWjsPuvDntgvLemlPTIv9db",
    "MariaParty": "1vulNrPX61XlW3vMBdWusKsrjvzKiTbpZ",
}

_service = None


def _drive():
    global _service
    if _service is None:
        _service = build("drive", "v3", credentials=load_credentials(), cache_discovery=False)
    return _service


def _resolve_folder(folder: str | None) -> str | None:
    if folder is None:
        return None
    return KNOWN_FOLDERS.get(folder, folder)


def list_files(folder: str | None = None, query: str | None = None, limit: int = 25) -> dict[str, Any]:
    folder_id = _resolve_folder(folder)
    clauses: list[str] = ["trashed = false"]
    if folder_id:
        clauses.append(f"'{folder_id}' in parents")
    if query:
        clauses.append(f"name contains '{query}'")
    q = " and ".join(clauses)
    resp = (
        _drive()
        .files()
        .list(q=q, pageSize=limit, fields="files(id,name,mimeType,modifiedTime,parents)")
        .execute()
    )
    return {"files": resp.get("files", [])}


def update_text_file(file_id: str, content: str, force: bool = False) -> dict[str, Any]:
    try:
        check_protected_write(file_id, force=force)
    except GuardError as exc:
        return {"error": str(exc), "guard": "protected-file"}

    media = MediaIoBaseUpload(io.BytesIO(content.encode("utf-8")), mimetype="text/plain")
    f = (
        _drive()
        .files()
        .update(fileId=file_id, media_body=media, fields="id,name,modifiedTime")
        .execute()
    )
    return {"id": f["id"], "name": f["name"], "modifiedTime": f["modifiedTime"]}


def _fetch_full_text(file_id: str) -> str:
    content = _drive().files().get_media(fileId=file_id).execute()
    if isinstance(content, bytes):
        content = content.decode("utf-8", errors="replace")
    return content


def read_text_file(file_id: str) -> dict[str, Any]:
    return {"id": file_id, "content": _fetch_full_text(file_id)}


def read_text_file_lines(
    file_id: str, start_line: int = 1, max_lines: int = 40
) -> dict[str, Any]:
    full = _fetch_full_text(file_id)
    lines = full.split("\n")
    start_idx = max(0, start_line - 1)
    selected = lines[start_idx : start_idx + max_lines]
    end_line = start_idx + len(selected)
    return {
        "file_id": file_id,
        "start_line": start_line,
        "end_line": end_line,
        "total_lines": len(lines),
        "content": "\n".join(selected),
        "more_available": end_line < len(lines),
    }


def search_in_file(
    file_id: str, query: str, max_matches: int = 6, context_lines: int = 2
) -> dict[str, Any]:
    full = _fetch_full_text(file_id)
    lines = full.split("\n")
    q = query.lower()
    matches: list[dict[str, Any]] = []
    for i, line in enumerate(lines):
        if q in line.lower():
            start = max(0, i - context_lines)
            end = min(len(lines), i + context_lines + 1)
            matches.append({"line_number": i + 1, "context": "\n".join(lines[start:end])})
            if len(matches) >= max_matches:
                break
    return {
        "file_id": file_id,
        "query": query,
        "match_count": len(matches),
        "matches": matches,
    }


def create_text_file(name: str, content: str, folder: str | None = None) -> dict[str, Any]:
    try:
        check_filename(name)
    except GuardError as exc:
        return {"error": str(exc), "guard": "file-discipline"}

    folder_id = _resolve_folder(folder)
    metadata: dict[str, Any] = {"name": name, "mimeType": "text/plain"}
    if folder_id:
        metadata["parents"] = [folder_id]
    media = MediaIoBaseUpload(io.BytesIO(content.encode("utf-8")), mimetype="text/plain")
    f = (
        _drive()
        .files()
        .create(body=metadata, media_body=media, fields="id,name,parents,webViewLink")
        .execute()
    )
    return {
        "id": f["id"],
        "name": f["name"],
        "parents": f.get("parents", []),
        "webViewLink": f.get("webViewLink"),
    }


TOOLS: list[Tool] = [
    Tool(
        name="drive_read_text_file",
        description=(
            "Read the FULL plain-text contents of a Drive file by ID. "
            "PREFER `drive_read_text_file_lines` or `drive_search_in_file` for files >50 lines — "
            "this tool returns the entire file which is hard to reason about in one pass. "
            "MUST be called when the user asks about file contents — never answer from memory."
        ),
        parameters={
            "type": "object",
            "properties": {"file_id": {"type": "string"}},
            "required": ["file_id"],
        },
        handler=read_text_file,
    ),
    Tool(
        name="drive_read_text_file_lines",
        description=(
            "Read a SPECIFIC RANGE of lines from a Drive text file (default: first 40 lines). "
            "Use this whenever you need to inspect part of a large file — much easier to reason "
            "about than the full file. Returns total_lines and more_available so you can paginate."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "start_line": {"type": "integer", "description": "1-indexed line number (default 1)"},
                "max_lines": {"type": "integer", "description": "Default 40"},
            },
            "required": ["file_id"],
        },
        handler=read_text_file_lines,
    ),
    Tool(
        name="drive_search_in_file",
        description=(
            "Find lines in a Drive text file that contain a substring (case-insensitive). "
            "Returns each match with surrounding context lines. Use this when looking for a "
            "specific fact in a long file (e.g. 'headcount', 'banner', 'pulled pork'). "
            "Far more efficient than reading the whole file."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "query": {"type": "string", "description": "Substring to search for"},
                "max_matches": {"type": "integer", "description": "Default 6"},
                "context_lines": {"type": "integer", "description": "Lines of context above+below each match. Default 2."},
            },
            "required": ["file_id", "query"],
        },
        handler=search_in_file,
    ),
    Tool(
        name="drive_update_text_file",
        description=(
            "Replace the contents of an existing plain-text Drive file (edit-in-place — "
            "this is how you respect the 'one master file per purpose' rule). "
            "Protected files (MariaParty RSVP MASTER, Master Plan v2, Banner Decision) "
            "require force=true and an explicit Josh override."
        ),
        parameters={
            "type": "object",
            "properties": {
                "file_id": {"type": "string"},
                "content": {"type": "string"},
                "force": {
                    "type": "boolean",
                    "description": "Override protected-file guard. Only true on explicit Josh instruction.",
                },
            },
            "required": ["file_id", "content"],
        },
        handler=update_text_file,
    ),
    Tool(
        name="drive_list_files",
        description=(
            "List files in Google Drive. `folder` accepts a known folder alias "
            "(CLAUDE, GEMINI, JoshMariaMusic, MariaParty) or a raw folder ID, or null for root search. "
            "`query` filters by filename substring."
        ),
        parameters={
            "type": "object",
            "properties": {
                "folder": {"type": "string", "description": "Folder alias or ID (optional)"},
                "query": {"type": "string", "description": "Filename substring (optional)"},
                "limit": {"type": "integer", "description": "Max files to return (default 25)"},
            },
        },
        handler=list_files,
    ),
    Tool(
        name="drive_create_text_file",
        description=(
            "Create a new plain-text file in Drive. `folder` is the alias or ID where the file lives. "
            "Filename must NOT match version-suffix patterns like 'V2', 'v3', '-copy', '-new' "
            "(project rule — every purpose has one master file)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Filename including any extension"},
                "content": {"type": "string", "description": "File contents as plain text"},
                "folder": {"type": "string", "description": "Target folder alias or ID"},
            },
            "required": ["name", "content"],
        },
        handler=create_text_file,
    ),
]
