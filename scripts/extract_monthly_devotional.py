#!/usr/bin/env python3
"""Extract one month of ELCA Prayer Ventures into per-day Drive text files.

Source: ELCA Prayer Ventures monthly PDF
URL: https://cdn.elca.org/cdn/wp-content/uploads/PV_<MMYY>_letter.pdf
Output: My Drive/CollegeLutheran/devotional/PV_<YYYY-MM>/day-<NN>.txt

Companion to send_daily_devotional.py. Designed to run from cron on the 1st
of each month at ~05:00 ET, before the daily sender needs the data. Idempotent
— re-running updates existing day-NN.txt files in place rather than duplicating.

Uses pdftotext (poppler-utils) for PDF parsing. Reuses google-drive-mcp OAuth.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import argparse

import requests

DRIVE_TOKEN_PATH = os.path.expanduser("~/.config/google-drive-mcp/tokens.json")
DRIVE_KEYS_PATH = os.path.expanduser("~/.config/google-drive-mcp/gcp-oauth.keys.json")
COLLEGELUTHERAN_FOLDER_ID = "1LsfEXCpEUFIaq7HgxDYuIb21B4qU97ky"
PDF_URL_FMT = "https://cdn.elca.org/cdn/wp-content/uploads/PV_{mmyy}_letter.pdf"


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


def _find_or_create_folder(name: str, parent_id: str, token: str) -> str:
    q = (
        f"name = '{name}' and '{parent_id}' in parents and trashed = false "
        f"and mimeType = 'application/vnd.google-apps.folder'"
    )
    resp = requests.get(
        "https://www.googleapis.com/drive/v3/files",
        headers={"Authorization": f"Bearer {token}"},
        params={"q": q, "fields": "files(id)"},
        timeout=30,
    )
    resp.raise_for_status()
    files = resp.json().get("files", [])
    if files:
        return files[0]["id"]
    resp = requests.post(
        "https://www.googleapis.com/drive/v3/files",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["id"]


def _upsert_text_file(name: str, content: str, parent_id: str, token: str) -> str:
    q = f"name = '{name}' and '{parent_id}' in parents and trashed = false"
    resp = requests.get(
        "https://www.googleapis.com/drive/v3/files",
        headers={"Authorization": f"Bearer {token}"},
        params={"q": q, "fields": "files(id)"},
        timeout=30,
    )
    resp.raise_for_status()
    existing = resp.json().get("files", [])
    if existing:
        file_id = existing[0]["id"]
        resp = requests.patch(
            f"https://www.googleapis.com/upload/drive/v3/files/{file_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
            params={"uploadType": "media"},
            data=content.encode("utf-8"),
            timeout=30,
        )
        resp.raise_for_status()
        return file_id
    boundary = "----extract-devotional-boundary"
    metadata = json.dumps(
        {"name": name, "parents": [parent_id], "mimeType": "text/plain"}
    )
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: text/plain\r\n\r\n{content}\r\n"
        f"--{boundary}--"
    )
    resp = requests.post(
        "https://www.googleapis.com/upload/drive/v3/files",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": f"multipart/related; boundary={boundary}",
        },
        params={"uploadType": "multipart"},
        data=body.encode("utf-8"),
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["id"]


_FOOTER_PREFIXES = (
    "PRAYER VENTURES",
    "These petitions are offered",
    "This resource may be copied",
    "congregations of the Evangelical",
    "info@elca.org",
    "8765 W. Higgins",
    "Telephone:",
)
_MONTH_HEADER_RE = re.compile(r"^[A-Z]+ \d{4}\s*$")
_DAY_START_RE = re.compile(r"^\s*(\d{1,2})\s+(.+?)\s*$")


def parse_petitions(text: str, max_day: int) -> dict[int, str]:
    """Group lines into {day: petition_text} for days 1..max_day."""
    petitions: dict[int, list[str]] = {}
    current_day: int | None = None
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            if current_day is not None:
                petitions[current_day].append("")
            continue
        if any(stripped.startswith(p) for p in _FOOTER_PREFIXES):
            current_day = None
            continue
        if _MONTH_HEADER_RE.match(stripped):
            current_day = None
            continue
        m = _DAY_START_RE.match(raw_line)
        if m:
            day_num = int(m.group(1))
            if 1 <= day_num <= max_day and day_num not in petitions:
                current_day = day_num
                petitions[current_day] = [m.group(2)]
                continue
        if current_day is not None:
            petitions[current_day].append(stripped)
    return {
        day: re.sub(r"\n{3,}", "\n\n", "\n".join(parts).strip())
        for day, parts in petitions.items()
    }


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (datetime.date(year, month + 1, 1) - datetime.date(year, month, 1)).days


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--month", help="YYYY-MM (default: current month)")
    p.add_argument("--dry-run", action="store_true", help="Parse and print but do not upload")
    args = p.parse_args()

    if args.month:
        year, month = map(int, args.month.split("-"))
    else:
        today = datetime.date.today()
        year, month = today.year, today.month
    mmyy = f"{month:02d}{year % 100:02d}"
    yyyy_mm = f"{year:04d}-{month:02d}"
    max_day = _days_in_month(year, month)

    url = PDF_URL_FMT.format(mmyy=mmyy)
    print(f"[extract] fetching {url}", file=sys.stderr)
    pdf = requests.get(url, timeout=60)
    pdf.raise_for_status()
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf.content)
        pdf_path = f.name

    text = subprocess.check_output(["pdftotext", pdf_path, "-"], text=True)
    petitions = parse_petitions(text, max_day)
    os.unlink(pdf_path)

    missing = [d for d in range(1, max_day + 1) if d not in petitions]
    if missing:
        print(f"[extract] WARNING: missing days {missing}", file=sys.stderr)
    print(
        f"[extract] parsed {len(petitions)}/{max_day} days for {yyyy_mm}",
        file=sys.stderr,
    )

    if args.dry_run:
        for day in sorted(petitions):
            print(f"\n=== day-{day:02d}.txt ({len(petitions[day])} chars) ===")
            print(petitions[day])
        return 0

    token = _drive_access_token()
    devotional_id = _find_or_create_folder("devotional", COLLEGELUTHERAN_FOLDER_ID, token)
    month_id = _find_or_create_folder(f"PV_{yyyy_mm}", devotional_id, token)
    for day in sorted(petitions):
        name = f"day-{day:02d}.txt"
        _upsert_text_file(name, petitions[day], month_id, token)
        print(f"[extract] uploaded {name}", file=sys.stderr)
    print(f"[extract] done — {len(petitions)} files in My Drive/CollegeLutheran/devotional/PV_{yyyy_mm}/", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
