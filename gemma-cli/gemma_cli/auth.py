"""Load Google OAuth credentials by reusing the existing google-drive-mcp token.

The Drive MCP token already has the scopes we need (drive, calendar, calendar.events,
documents, spreadsheets, drive.file). We piggy-back on it rather than running our own
OAuth dance.
"""

from __future__ import annotations

import json
from pathlib import Path

from google.oauth2.credentials import Credentials

DRIVE_MCP_DIR = Path.home() / ".config" / "google-drive-mcp"
GMAIL_MCP_DIR = Path.home() / ".gmail-mcp"


def _load(token_path: Path, keys_path: Path) -> Credentials:
    token_data = json.loads(token_path.read_text())
    keys_data = json.loads(keys_path.read_text())
    installed = keys_data.get("installed") or keys_data.get("web") or {}
    return Credentials(
        token=token_data["access_token"],
        refresh_token=token_data.get("refresh_token"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=installed.get("client_id"),
        client_secret=installed.get("client_secret"),
        scopes=token_data.get("scope", "").split(),
    )


def load_credentials() -> Credentials:
    return _load(DRIVE_MCP_DIR / "tokens.json", DRIVE_MCP_DIR / "gcp-oauth.keys.json")


def load_gmail_credentials() -> Credentials:
    return _load(GMAIL_MCP_DIR / "credentials.json", GMAIL_MCP_DIR / "gcp-oauth.keys.json")
