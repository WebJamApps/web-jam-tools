"""Gmail tool implementations.

Workflow rule: drafts are the default. Josh reviews and sends from his phone or laptop;
the Coordinator never sends without an explicit Josh instruction.
"""

from __future__ import annotations

import base64
from email.message import EmailMessage
from typing import Any

from googleapiclient.discovery import build

from gemma_cli.auth import load_gmail_credentials
from gemma_cli.llm import Tool

_service = None


def _gmail():
    global _service
    if _service is None:
        _service = build(
            "gmail", "v1", credentials=load_gmail_credentials(), cache_discovery=False
        )
    return _service


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


def draft_email(
    to: str, subject: str, body: str, cc: str = "", bcc: str = ""
) -> dict[str, Any]:
    raw = _build_raw(to, subject, body, cc, bcc)
    d = (
        _gmail()
        .users()
        .drafts()
        .create(userId="me", body={"message": {"raw": raw}})
        .execute()
    )
    return {
        "draft_id": d["id"],
        "message_id": d["message"]["id"],
        "thread_id": d["message"].get("threadId"),
        "note": "Draft created. Open Gmail Drafts to review and send.",
    }


def search_emails(query: str, max_results: int = 10) -> dict[str, Any]:
    resp = (
        _gmail()
        .users()
        .messages()
        .list(userId="me", q=query, maxResults=max_results)
        .execute()
    )
    messages = resp.get("messages", [])
    out: list[dict[str, Any]] = []
    for m in messages:
        full = (
            _gmail()
            .users()
            .messages()
            .get(userId="me", id=m["id"], format="metadata", metadataHeaders=["From", "Subject", "Date"])
            .execute()
        )
        headers = {h["name"]: h["value"] for h in full.get("payload", {}).get("headers", [])}
        out.append(
            {
                "id": full["id"],
                "thread_id": full.get("threadId"),
                "from": headers.get("From"),
                "subject": headers.get("Subject"),
                "date": headers.get("Date"),
                "snippet": full.get("snippet", ""),
            }
        )
    return {"messages": out}


TOOLS: list[Tool] = [
    Tool(
        name="gmail_draft_email",
        description=(
            "Create a Gmail DRAFT. Drafts are the default for venue outreach — Josh reviews "
            "and sends from his phone or laptop. NEVER send without Josh's explicit instruction; "
            "this tool only drafts."
        ),
        parameters={
            "type": "object",
            "properties": {
                "to": {"type": "string", "description": "Recipient email"},
                "subject": {"type": "string"},
                "body": {"type": "string", "description": "Plain-text body"},
                "cc": {"type": "string"},
                "bcc": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
        handler=draft_email,
    ),
    Tool(
        name="gmail_search",
        description=(
            "Search Gmail using standard Gmail search syntax "
            "(e.g. 'from:floyd subject:booking newer_than:30d'). Returns metadata for matching messages."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Gmail search query"},
                "max_results": {"type": "integer", "description": "Default 10"},
            },
            "required": ["query"],
        },
        handler=search_emails,
    ),
]
