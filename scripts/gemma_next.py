#!/usr/bin/env python3
"""Process the next task from gemma-tasks.txt on Drive.

Why this exists: gemma cannot reliably read its own queue — it hallucinates
file contents. This script reads the queue deterministically (Drive REST API)
and either prints the next task or pipes ONE task at a time to gemma as a
focused prompt.

Usage:
  gemma_next.py            # show the next task (no side effects)
  gemma_next.py --run      # show + pipe a focused prompt to `gemma`
  gemma_next.py --done     # delete the first task from the file (after approval)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

import requests

TASKS_FILE_ID = "15bfIDf4pJVEwbDIO4dMejLGg0hB-xFMP"
DRIVE_TOKEN_PATH = os.path.expanduser("~/.config/google-drive-mcp/tokens.json")
DRIVE_KEYS_PATH = os.path.expanduser("~/.config/google-drive-mcp/gcp-oauth.keys.json")
TASK_LINE_RE = re.compile(r"^task\s+\d+", re.IGNORECASE)


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


def _download(file_id: str) -> str:
    token = _drive_access_token()
    resp = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"alt": "media"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.text


def _upload(file_id: str, content: str) -> None:
    token = _drive_access_token()
    resp = requests.patch(
        f"https://www.googleapis.com/upload/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
        params={"uploadType": "media"},
        data=content.encode("utf-8"),
        timeout=30,
    )
    resp.raise_for_status()


def parse_tasks(text: str) -> list[tuple[int, str]]:
    """Return [(start_line_index, task_block_text), ...] for each task block.

    Header text before the first `task N:` line is treated as instructions
    and excluded.
    """
    lines = text.splitlines(keepends=False)
    starts = [i for i, line in enumerate(lines) if TASK_LINE_RE.match(line.strip())]
    out: list[tuple[int, str]] = []
    for idx, start in enumerate(starts):
        end = starts[idx + 1] if idx + 1 < len(starts) else len(lines)
        out.append((start, "\n".join(lines[start:end]).rstrip()))
    return out


def cmd_show(text: str) -> int:
    tasks = parse_tasks(text)
    if not tasks:
        print("(queue empty)")
        return 0
    print("=== Next task ===")
    print(tasks[0][1])
    print(f"\n(of {len(tasks)} total in queue)")
    return 0


def cmd_run(text: str) -> int:
    tasks = parse_tasks(text)
    if not tasks:
        print("(queue empty)")
        return 0
    block = tasks[0][1]
    print("=== Sending this task to gemma ===")
    print(block)
    print()
    prompt = (
        "You have ONE specific task to complete. Do not look for or ask about "
        "other tasks; this is the only task in your scope. Use your tools to "
        "execute the steps described. Report what you actually did and any data "
        "you found. Do not fabricate. Here is the task:\n\n"
        f"{block}"
    )
    return subprocess.call(["gemma", "--verbose", prompt])


def cmd_done(text: str) -> int:
    tasks = parse_tasks(text)
    if not tasks:
        print("(queue already empty)")
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
    _upload(TASKS_FILE_ID, new_text)
    print(f"Removed task. Remaining in queue: {len(tasks) - 1}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    g = p.add_mutually_exclusive_group()
    g.add_argument("--run", action="store_true", help="Pipe the next task to gemma")
    g.add_argument("--done", action="store_true", help="Remove the first task from the file")
    args = p.parse_args()
    text = _download(TASKS_FILE_ID)
    if args.done:
        return cmd_done(text)
    if args.run:
        return cmd_run(text)
    return cmd_show(text)


if __name__ == "__main__":
    sys.exit(main())
