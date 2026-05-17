"""Google Calendar tool implementations.

Enforces the MANDATORY Calendar Conflict Rule from GEMINI.md:
- Before any create_event, list existing events in the target window.
- If a conflict exists, refuse and return the conflict details.
- Only proceed when `force=True` is explicitly passed (which Gemma must justify
  via Josh's explicit instruction).
"""

from __future__ import annotations

from typing import Any

from googleapiclient.discovery import build

from gemma_cli.auth import load_credentials
from gemma_cli.llm import Tool

DEFAULT_CALENDAR = "primary"

_service = None


def _cal():
    global _service
    if _service is None:
        _service = build(
            "calendar", "v3", credentials=load_credentials(), cache_discovery=False
        )
    return _service


def list_events(
    time_min: str,
    time_max: str,
    calendar_id: str = DEFAULT_CALENDAR,
    max_results: int = 25,
) -> dict[str, Any]:
    resp = (
        _cal()
        .events()
        .list(
            calendarId=calendar_id,
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,
            orderBy="startTime",
            maxResults=max_results,
        )
        .execute()
    )
    return {
        "events": [
            {
                "id": ev["id"],
                "summary": ev.get("summary", "(no title)"),
                "start": ev["start"].get("dateTime") or ev["start"].get("date"),
                "end": ev["end"].get("dateTime") or ev["end"].get("date"),
                "location": ev.get("location"),
            }
            for ev in resp.get("items", [])
        ]
    }


def _conflicts_for_window(time_min: str, time_max: str, calendar_id: str) -> list[dict[str, Any]]:
    return list_events(time_min, time_max, calendar_id)["events"]


def create_event(
    summary: str,
    start: str,
    end: str,
    location: str = "",
    description: str = "",
    calendar_id: str = DEFAULT_CALENDAR,
    force: bool = False,
) -> dict[str, Any]:
    if not force:
        conflicts = _conflicts_for_window(start, end, calendar_id)
        if conflicts:
            return {
                "error": "CALENDAR_CONFLICT",
                "message": (
                    "Existing event(s) overlap this window. Per GEMINI.md, STOP and "
                    "ask Josh which event takes priority before rescheduling."
                ),
                "conflicts": conflicts,
            }

    body: dict[str, Any] = {
        "summary": summary,
        "start": {"dateTime": start},
        "end": {"dateTime": end},
    }
    if location:
        body["location"] = location
    if description:
        body["description"] = description

    ev = _cal().events().insert(calendarId=calendar_id, body=body).execute()
    return {
        "id": ev["id"],
        "summary": ev["summary"],
        "start": ev["start"].get("dateTime"),
        "end": ev["end"].get("dateTime"),
        "htmlLink": ev.get("htmlLink"),
    }


TOOLS: list[Tool] = [
    Tool(
        name="calendar_list_events",
        description=(
            "List events in a time window. `time_min` and `time_max` must be RFC3339 "
            "timestamps with timezone offset (e.g. '2026-06-20T00:00:00-04:00')."
        ),
        parameters={
            "type": "object",
            "properties": {
                "time_min": {"type": "string", "description": "RFC3339 start of window"},
                "time_max": {"type": "string", "description": "RFC3339 end of window"},
                "calendar_id": {
                    "type": "string",
                    "description": "Calendar ID, defaults to 'primary'",
                },
                "max_results": {"type": "integer", "description": "Default 25"},
            },
            "required": ["time_min", "time_max"],
        },
        handler=list_events,
    ),
    Tool(
        name="calendar_create_event",
        description=(
            "Create a calendar event. MANDATORY conflict check runs first; if any existing "
            "event overlaps, the call returns a CALENDAR_CONFLICT error — STOP and ask Josh "
            "which event takes priority. Only set `force=true` if Josh has EXPLICITLY told "
            "you to schedule over an existing event."
        ),
        parameters={
            "type": "object",
            "properties": {
                "summary": {"type": "string", "description": "Event title"},
                "start": {"type": "string", "description": "RFC3339 start time"},
                "end": {"type": "string", "description": "RFC3339 end time"},
                "location": {"type": "string"},
                "description": {"type": "string"},
                "calendar_id": {"type": "string", "description": "Default 'primary'"},
                "force": {
                    "type": "boolean",
                    "description": "Skip conflict check. Default false. Only set true on explicit Josh override.",
                },
            },
            "required": ["summary", "start", "end"],
        },
        handler=create_event,
    ),
]
