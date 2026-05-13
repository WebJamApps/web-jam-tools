"""Gmail send helper. Reuses the gmail-mcp OAuth tokens at ~/.gmail-mcp/.

Shared by:
  - send_daily_devotional.py (CollegeLutheran)
  - any future JoshMariaMusic / MariaParty send flows
"""

from __future__ import annotations

import base64
import json
import os
from email.message import EmailMessage

import requests

GMAIL_MCP_DIR = os.path.expanduser("~/.gmail-mcp")
TOKEN_PATH = os.path.join(GMAIL_MCP_DIR, "credentials.json")
KEYS_PATH = os.path.join(GMAIL_MCP_DIR, "gcp-oauth.keys.json")
TOKEN_URL = "https://oauth2.googleapis.com/token"
SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"


def _read_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def _refresh_access_token() -> str:
    tokens = _read_json(TOKEN_PATH)
    keys = _read_json(KEYS_PATH).get("installed") or _read_json(KEYS_PATH).get("web") or {}
    resp = requests.post(
        TOKEN_URL,
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
    with open(TOKEN_PATH, "w") as f:
        json.dump(tokens, f, indent=2)
    return new_token


def _build_raw(to: str, subject: str, body: str, cc: str = "", bcc: str = "") -> str:
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    if cc:
        msg["Cc"] = cc
    if bcc:
        msg["Bcc"] = bcc
    msg.set_content(body)
    return base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")


def send_email(
    to: str, subject: str, body: str, cc: str = "", bcc: str = ""
) -> str:
    raw = _build_raw(to, subject, body, cc, bcc)
    token = _read_json(TOKEN_PATH).get("access_token") or _refresh_access_token()

    def _post(t: str) -> requests.Response:
        return requests.post(
            SEND_URL,
            headers={"Authorization": f"Bearer {t}", "Content-Type": "application/json"},
            json={"raw": raw},
            timeout=30,
        )

    resp = _post(token)
    if resp.status_code == 401:
        token = _refresh_access_token()
        resp = _post(token)
    resp.raise_for_status()
    return resp.json()["id"]
