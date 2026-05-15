#!/usr/bin/env python3
"""Daily devotional sender (CollegeLutheran project).

Reads today's ELCA Prayer Ventures petition from Google Drive at
  My Drive/CollegeLutheran/devotional/PV_<YYYY-MM>/day-<NN>.txt
and emails it to Josh. Runs from cron at 06:00 America/New_York daily.

If today's file does not exist (e.g. gemma has not yet extracted this month's
PDF), the script logs and exits 0 — that is a not-yet-ready state, not a
failure.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gmail_helper import send_email  # noqa: E402

RECIPIENT = "joshua.v.sherman@gmail.com"
DRIVE_TOKEN_PATH = os.path.expanduser("~/.config/google-drive-mcp/tokens.json")
DRIVE_KEYS_PATH = os.path.expanduser("~/.config/google-drive-mcp/gcp-oauth.keys.json")
COLLEGELUTHERAN_FOLDER_ID = "1LsfEXCpEUFIaq7HgxDYuIb21B4qU97ky"


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
    return resp.json()["access_token"]


def _walk_drive_path(parent_id: str, segments: list[str], token: str) -> dict | None:
    current = parent_id
    last = None
    for seg in segments:
        q = f"name = '{seg}' and '{current}' in parents and trashed = false"
        resp = requests.get(
            "https://www.googleapis.com/drive/v3/files",
            headers={"Authorization": f"Bearer {token}"},
            params={"q": q, "fields": "files(id, name, mimeType)"},
            timeout=30,
        )
        resp.raise_for_status()
        files = resp.json().get("files", [])
        if not files:
            return None
        last = files[0]
        current = last["id"]
    return last


def _download_text(file_id: str, token: str) -> str:
    resp = requests.get(
        f"https://www.googleapis.com/drive/v3/files/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
        params={"alt": "media"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.text


def main() -> int:
    today = datetime.date.today()
    month_folder = f"PV_{today.strftime('%Y-%m')}"
    day_file = f"day-{today.day:02d}.txt"

    token = _drive_access_token()
    meta = _walk_drive_path(
        COLLEGELUTHERAN_FOLDER_ID, ["devotional", month_folder, day_file], token
    )
    if not meta:
        print(
            f"[devotional] no file at devotional/{month_folder}/{day_file}; "
            f"gemma may not have extracted this month yet — skipping",
            file=sys.stderr,
        )
        return 0

    petition = _download_text(meta["id"], token).strip()
    if not petition:
        print(f"[devotional] {day_file} is empty; skipping", file=sys.stderr)
        return 0

    subject = f"ELCA Prayer Ventures — {today.strftime('%B %-d, %Y')}"
    body = (
        f"{petition}\n\n"
        f"— From ELCA Prayer Ventures ({today.strftime('%B %Y')}). "
        f"Source: https://elca.org/resources/prayer-ventures\n"
    )
    message_id = send_email(RECIPIENT, subject, body)
    print(f"[devotional] sent {day_file} as Gmail message {message_id}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
