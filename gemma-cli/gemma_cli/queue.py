"""Persistent task queue support — model-aware.

Used by the REPL `/next` and `/done` commands. Reads/writes the right queue
file deterministically via the Drive REST API so the model never has to (and
can't hallucinate) the contents of its own queue.

As of 2026-05-15 there are TWO queues, one per laptop role:
  - llama-tasks.txt → Coordinator (Llama 3.3 70B on the desktop)
  - gemma-tasks.txt → Media Specialist (Gemma 4 on the laptop)

Lookup is by model tag. Unknown models default to gemma-tasks.txt for safety.
"""

from __future__ import annotations

import json
import os
import re

import requests

TASKS_FILE_IDS = {
    "llama3.3:70b": "1PiobgF2vPhimDtTpQnjkWSaNQ6zaYI-g",  # llama-tasks.txt (Coordinator)
    "gemma4:e4b": "15bfIDf4pJVEwbDIO4dMejLGg0hB-xFMP",  # gemma-tasks.txt (Media Specialist)
}
DEFAULT_FALLBACK_FILE_ID = "15bfIDf4pJVEwbDIO4dMejLGg0hB-xFMP"
DRIVE_TOKEN_PATH = os.path.expanduser("~/.config/google-drive-mcp/tokens.json")
DRIVE_KEYS_PATH = os.path.expanduser("~/.config/google-drive-mcp/gcp-oauth.keys.json")
TASK_LINE_RE = re.compile(r"^task\s+\d+", re.IGNORECASE)


def _file_id_for_model(model: str) -> str:
    return TASKS_FILE_IDS.get(model, DEFAULT_FALLBACK_FILE_ID)


def _drive_access_token() -> str:
    with open(DRIVE_TOKEN_PATH) as f:
        tokens = json.load(f)
    with open(DRIVE_KEYS_PATH) as f:
        keys_raw = json.load(f)
    keys = keys_raw.get("installed") or keys_raw.get("web") or {}
    resp = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": keys["client_id"],
            "client_secret": keys["client_secret"],
            "refresh_token": tokens["refresh_token"],
            "grant_type": "refresh_token",
        },
        timeout=30,
    )
    resp.raise_for_status()
    new_token = resp.json()["access_token"]
    tokens["access_token"] = new_token
    with open(DRIVE_TOKEN_PATH, "w") as f:
        json.dump(tokens, f, indent=2)
    return new_token


def _download(model: str) -> str:
    token = _drive_access_token()
    file_id = _file_id_for_model(model)
    resp = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"alt": "media"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.text


def _upload(model: str, content: str) -> None:
    token = _drive_access_token()
    file_id = _file_id_for_model(model)
    resp = requests.patch(
        f"https://www.googleapis.com/upload/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
        params={"uploadType": "media"},
        data=content.encode("utf-8"),
        timeout=30,
    )
    resp.raise_for_status()


def _parse_tasks(text: str) -> list[tuple[int, str]]:
    lines = text.splitlines(keepends=False)
    starts = [i for i, line in enumerate(lines) if TASK_LINE_RE.match(line.strip())]
    out: list[tuple[int, str]] = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        out.append((start, "\n".join(lines[start:end]).rstrip()))
    return out


def get_next_task(model: str) -> tuple[str | None, int]:
    """Return (next_task_text_or_None, total_count_in_queue) for this model's queue."""
    text = _download(model)
    tasks = _parse_tasks(text)
    if not tasks:
        return None, 0
    return tasks[0][1], len(tasks)


def delete_first_task(model: str) -> int:
    """Delete the first task from this model's queue. Return remaining count."""
    text = _download(model)
    tasks = _parse_tasks(text)
    if not tasks:
        return 0
    lines = text.splitlines(keepends=False)
    start, _ = tasks[0]
    end = tasks[1][0] if len(tasks) > 1 else len(lines)
    while end < len(lines) and lines[end].strip() == "":
        end += 1
    new_lines = lines[:start] + lines[end:]
    while new_lines and new_lines[-1].strip() == "":
        new_lines.pop()
    new_text = "\n".join(new_lines) + "\n"
    _upload(model, new_text)
    return len(tasks) - 1
