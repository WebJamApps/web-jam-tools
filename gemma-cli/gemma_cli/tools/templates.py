"""Email-template tool: render venue-outreach emails from Josh's approved scaffolds.

Q4 Llama 3.3 70B drifts toward marketing-copy phrasing when asked to write a venue
outreach email "in Josh's style" — even when SHARED.md's EXAMPLE PITCHES are loaded
in the system prompt, the model attends weakly to them and produces "I came across X
while looking for..." / "We look forward to hearing from you" style output. The
templates are visible to the model but not strong enough attractors against the
model's training-data prior for "professional outreach email".

Protocol-layer fix (same pattern as the smalltalk gate in cli.py): move template
rendering into code. The model picks a template ('A' or 'B') and supplies slot
values; this handler returns a fully-formed email body that matches Josh's approved
templates byte-for-byte. The model cannot drift on tone because the model isn't
writing the prose — it's picking a template and extracting slot values from the
venue task.

The two templates here MUST stay in sync with the EXAMPLE PITCHES section of
SHARED.md in Drive (Josh's source of truth for voice). If Josh edits SHARED.md to
revise the templates, this module must be updated as well — and vice versa.
"""

from __future__ import annotations

from typing import Any

from gemma_cli.llm import Tool

# Template A: warm tone, for venues where Josh has a personal hook to the area
# (a family member nearby, a prior visit, a friend, etc.). The hook is what makes
# this template feel personal rather than generic — without one, use Template B.
_TEMPLATE_A = (
    "Hi,\n"
    "My wife Maria and I are an acoustic duo from Salem, VA. We're free {date_range} "
    "and would love to play {day_of_week} at your place. {personal_hook}\n"
    "Let me know if any of those dates work.\n"
    "Thanks — Josh & Maria, joshandmariamusic.com"
)

# Template B: professional tone, for new venues with no personal hook. Keeps things
# concise and offers to send more material on request.
_TEMPLATE_B = (
    "Hi,\n"
    "I'm Josh Sherman — my wife and I play as Josh and Maria, an acoustic duo out of "
    "Salem, VA. I came across {venue_name} and wanted to ask about booking. We have "
    "{day_of_week} open between {date_range}. Happy to send a short sample or talk "
    "through what we play.\n"
    "Thanks — Josh & Maria, joshandmariamusic.com"
)


def generate_venue_email_from_template(
    template: str,
    venue_name: str,
    date_range: str,
    day_of_week: str = "Saturday",
    personal_hook: str = "",
) -> dict[str, Any]:
    """Render a venue-outreach email using one of Josh's approved templates.

    Returns a dict with `subject`, `body`, and `template_used`. On invalid input,
    returns `{"error": "..."}` so the model can self-correct in the same turn.
    """
    t = template.strip().upper()
    if t == "A":
        if not personal_hook.strip():
            return {
                "error": (
                    "Template A requires a non-empty personal_hook (e.g. "
                    "'My son lives in Rustburg, so we're in the area anyway'). "
                    "For new venues with no personal hook, use Template B instead."
                ),
            }
        body = _TEMPLATE_A.format(
            date_range=date_range.strip(),
            day_of_week=day_of_week.strip(),
            personal_hook=personal_hook.strip(),
        )
    elif t == "B":
        body = _TEMPLATE_B.format(
            venue_name=venue_name.strip(),
            date_range=date_range.strip(),
            day_of_week=day_of_week.strip(),
        )
    else:
        return {
            "error": (
                f"Unknown template '{template}'. Use 'A' (warm tone with a personal "
                "hook to the area) or 'B' (professional tone for a new venue)."
            ),
        }
    return {
        "subject": f"Live Music at {venue_name.strip()} — Josh and Maria",
        "body": body,
        "template_used": t,
    }


TOOLS: list[Tool] = [
    Tool(
        name="generate_venue_email_from_template",
        description=(
            "Render a venue-outreach email using one of Josh's APPROVED templates. "
            "Use this INSTEAD of writing the email body from scratch. Two templates:\n"
            "  - Template A (warm): when you can supply a personal_hook tying Josh "
            "to the venue's area (family nearby, prior visit, etc.).\n"
            "  - Template B (professional): for new venues with no personal hook.\n"
            "Returns subject + body. After calling, PRINT the returned body to Josh "
            "in your reply and wait for approval before calling gmail_draft_email. "
            "This tool exists because writing email prose from scratch produces "
            "marketing-copy that does not match Josh's voice."
        ),
        parameters={
            "type": "object",
            "properties": {
                "template": {
                    "type": "string",
                    "enum": ["A", "B"],
                    "description": (
                        "A = warm tone with a personal_hook to the area; "
                        "B = professional tone for a new venue with no hook."
                    ),
                },
                "venue_name": {
                    "type": "string",
                    "description": "Name of the venue exactly as Josh would address it (e.g. 'Solstice Farm Brewery').",
                },
                "date_range": {
                    "type": "string",
                    "description": (
                        "When Josh is available, in natural language as it would "
                        "appear in the email (e.g. 'the last two weeks of June', "
                        "'June 14 and 28', 'late summer or fall 2026')."
                    ),
                },
                "day_of_week": {
                    "type": "string",
                    "description": "Day of week being requested (e.g. 'Saturday'). Defaults to 'Saturday'.",
                },
                "personal_hook": {
                    "type": "string",
                    "description": (
                        "REQUIRED for Template A. A short sentence connecting Josh "
                        "to the venue's area (e.g. 'My son lives in Rustburg, so "
                        "we're in the area anyway and it would be a real treat to "
                        "get on your stage.'). Leave empty when using Template B."
                    ),
                },
            },
            "required": ["template", "venue_name", "date_range"],
        },
        handler=generate_venue_email_from_template,
    ),
]
