"""Email-template tool: render venue-outreach emails from Josh's approved templates.

Q4 Llama 3.3 70B drifts toward marketing-copy phrasing when asked to write a
venue-outreach email "in Josh's style" — even when the system prompt contains
voice rules. Protocol-layer fix: move template rendering into code so the model
picks a template + supplies slot values, and the prose is locked.

THE TEMPLATES BELOW MIRROR JOSH'S CANONICAL APPROVED PITCH EMAIL FILES IN DRIVE
(My Drive/JoshMariaMusic, last edited 2026-05-11):

  - Pitch Email – Originals Venues.txt        id 1m6MGI9EQGBl0sOTpKH9zguOn7N6Xecfw
  - Pitch Email – MidRange Cafe Bar.txt       id 1ik4rvZtlTyY5t0mw56u09sJFodKj4Fa1
  - Pitch Email – Pub Festival Brewery.txt    id 1Yz3FqDNNnY82epfk1q6Q-OxlZg0KvKGv

When Josh edits the Drive copy, this module must be updated to match — or vice
versa. The code is the runtime source of truth; the Drive files are the human-
readable canonical copies that Josh approves. See
reference_approved_pitch_email_templates.md in Opus's memory for the full
context on which set is canonical.

Slot design:
  - template (required, enum: 'originals' / 'midrange' / 'pub_brewery')
  - venue_name (required)
  - contact_name (optional; if empty, greeting is "Hi," instead of "Hi <name>,")
  - date_range (optional, default 'June 26, 27, or 28')

Subjects are hardcoded per template (mirrors the Drive files). The phone, URL,
song links, venue history paragraph, and 12-year experience claim are all part
of the locked prose.
"""

from __future__ import annotations

import re
from typing import Any

from gemma_cli.llm import Tool


# A "concrete" date_range must contain at least one digit (a day number).
# Phrases like "late summer or fall" or "this summer" have no digits and are
# silently disallowed at the protocol layer — the LLM cannot bypass this rule
# the way it ignores prompt-level instructions. Forces llama to ask Josh for
# specific days before the tool will accept the call.
_DATE_DIGIT_RE = re.compile(r"\d")


# The originals + midrange subjects are static; pub_brewery's subject depends on
# the booking_period slot and is built dynamically inside the handler below.
_SUBJECT_STATIC = {
    "originals": "Performance Inquiry: Josh and Maria (Original Americana/Roots Duo)",
    "midrange": "Performance Inquiry: Josh and Maria (Husband-Wife Acoustic Duo)",
}


_TEMPLATE_ORIGINALS = (
    "Hi {greeting_name},\n"
    "\n"
    "My name is Josh Sherman, and I perform with my wife Maria as the husband-wife acoustic duo \"Josh and Maria.\" We are based in Salem, VA, and we are long-time admirers of {venue_name}'s commitment to showcasing original music.\n"
    "\n"
    "We are currently booking our {booking_period} run and would love to be considered for a slot on {date_range}. As an established regional act with over 12 years of experience, we offer a professional, tight set of original Americana and roots music that we think would be a perfect fit for your listening room environment.\n"
    "\n"
    "Maria and I have spent over eleven years honing our acoustic duo sound — close-harmony Americana and roots music built around our original songwriting. We've released live recordings of songs like Dark Light, Misty Rainy Morning, and Good Enough, and have built a steady following across southwest Virginia at venues that take songwriting seriously. Listening rooms are where we feel most at home.\n"
    "\n"
    "A few live samples of our original songwriting:\n"
    "- Dark Light (Original) - live at Salem Farmers Market: https://web-jam.com/music/songs?id=69fdcc4b586f5175c6db44a7\n"
    "- Misty Rainy Morning (Original): https://web-jam.com/music/songs?id=5f5e6b7d13772f0004a091ad\n"
    "- Good Enough (Original) - live at Salem Farmers Market: https://web-jam.com/music/songs?id=69fdcf2b586f5175c6db44ab\n"
    "\n"
    "You can find our full repertoire and performance history at https://www.joshandmariamusic.com.\n"
    "\n"
    "Thank you for your time and for everything you do to champion original music in our region.\n"
    "\n"
    "Best,\n"
    "\n"
    "Josh & Maria\n"
    "540-494-8035\n"
    "https://www.joshandmariamusic.com\n"
)


_TEMPLATE_MIDRANGE = (
    "Hi {greeting_name},\n"
    "\n"
    "My name is Josh Sherman, and I perform with my wife Maria as the acoustic duo \"Josh and Maria.\" We are a regional act based in Salem, VA, and we are currently booking our {booking_period} run and would love to be considered for a slot at {venue_name}.\n"
    "\n"
    "We have {date_range} available. We've been performing together for over 12 years, offering a tight, professional set that balances original singer-songwriter material with select covers. We pride ourselves on being reliable, easy to work with, and a great fit for rooms that appreciate harmony-driven Americana.\n"
    "\n"
    "Maria and I have been writing and performing together for over eleven years — the kind of close harmony that comes from a shared kitchen table — balancing our own songwriting with a careful selection of covers. We've built a steady regional following with regular shows at Stave & Cork in Salem; two summers running at the Pete Dye River Course clubhouse in Blacksburg; the Salem farmers market summer after summer; and repeat appearances at Music in the Park in Marion. We take care of our audience and the room.\n"
    "\n"
    "A few live samples from our repertoire:\n"
    "- Proud Mary (CCR) - live at Olde Salem Brewing: https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3\n"
    "- Country Roads (John Denver) - live at Gusto's Pizza: https://www.web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e\n"
    "- Dark Light (Original) - live at Salem Farmers Market: https://web-jam.com/music/songs?id=69fdcc4b586f5175c6db44a7\n"
    "\n"
    "Full music links and performance history available at https://www.joshandmariamusic.com.\n"
    "\n"
    "Let me know if any of those dates work — happy to talk through details.\n"
    "\n"
    "Best,\n"
    "\n"
    "Josh & Maria\n"
    "540-494-8035\n"
    "https://www.joshandmariamusic.com\n"
)


_TEMPLATE_PUB_BREWERY = (
    "Hi {greeting_name},\n"
    "\n"
    "My name is Josh Sherman — my wife and I play as Josh and Maria, a professional husband-wife acoustic duo based in Salem, VA. We still have a few {booking_period} dates open and would love to bring our energetic acoustic set to {venue_name}.\n"
    "\n"
    "We have {date_range} available and are looking to book a 2-3 hour set. We've spent over 12 years performing at festivals, breweries, and venues throughout Southwest Virginia, providing a versatile mix of original Americana and crowd-pleasing covers.\n"
    "\n"
    "Beyond the originals, we know how to read a room. We've built our live set across the Roanoke Valley — regular shows at Stave & Cork in Salem, two summers running at the Pete Dye River Course clubhouse in Blacksburg, the Salem farmers market summer after summer, and Music in the Park up in Marion — so we're equally comfortable filling a dance floor on a Saturday night and holding a quiet room at a Sunday brunch. We bring our own PA.\n"
    "\n"
    "A few live samples from our set:\n"
    "- Proud Mary (CCR) - live at Olde Salem Brewing: https://www.web-jam.com/music/songs?id=66a0ec5fd1005f8095f3cef3\n"
    "- I'm Yours (Jason Mraz) - live at Salem Farmers Market: https://web-jam.com/music/songs?id=69fdcd7a586f5175c6db44a9\n"
    "- Country Roads (John Denver) - live at Gusto's Pizza: https://www.web-jam.com/music/songs?id=6728e8bb25cc2073a9395c4e\n"
    "- Misty Rainy Morning (Original): https://web-jam.com/music/songs?id=5f5e6b7d13772f0004a091ad\n"
    "\n"
    "Our full performance history and music can be found at https://www.joshandmariamusic.com.\n"
    "\n"
    "Let me know if any of those dates work — happy to talk through details.\n"
    "\n"
    "Best,\n"
    "\n"
    "Josh & Maria\n"
    "540-494-8035\n"
    "https://www.joshandmariamusic.com\n"
)


_TEMPLATE_BODIES = {
    "originals": _TEMPLATE_ORIGINALS,
    "midrange": _TEMPLATE_MIDRANGE,
    "pub_brewery": _TEMPLATE_PUB_BREWERY,
}


def generate_venue_email_from_template(
    template: str,
    venue_name: str,
    date_range: str,
    booking_period: str,
    contact_name: str = "",
) -> dict[str, Any]:
    """Render a venue-outreach email using one of Josh's approved templates.

    Returns `subject`, `body`, and `template_used`. On invalid input returns
    `{"error": "..."}` so the model can self-correct in the same turn.
    """
    t = template.strip().lower().replace("-", "_")
    if t not in _TEMPLATE_BODIES:
        return {
            "error": (
                f"Unknown template '{template}'. Use one of: "
                "'originals' (listening rooms / original-music venues), "
                "'midrange' (cafes / bars / mid-range venues), "
                "'pub_brewery' (breweries / pubs / festivals)."
            ),
        }
    vname = venue_name.strip()
    if not vname:
        return {"error": "venue_name is required and must be non-empty."}
    drange = date_range.strip()
    if not drange:
        return {
            "error": (
                "date_range is required. ASK Josh which dates to offer for "
                "this venue — different venues may get different dates. Josh's "
                "current booking window changes over the year (do NOT guess "
                "or use a placeholder). Example acceptable values: "
                "'August 28, 29, or 30', 'any Saturday in August', 'the last "
                "weekend of August'."
            ),
        }
    if not _DATE_DIGIT_RE.search(drange):
        # No digit anywhere → date_range is a vague phrase like "late summer or
        # fall" or "this summer". Reject it at the protocol layer so the LLM
        # cannot bypass the GEMMA.md rule by hallucinating a vague string.
        return {
            "error": (
                f"date_range '{drange}' has no day numbers in it — it is too "
                "vague to use in a venue-outreach email. Acceptable values "
                "must contain specific calendar days, e.g. 'August 14-16', "
                "'August 28, 29, or 30', 'September 5 or 6'. Phrases like "
                "'late summer or fall', 'this fall', 'summer dates', "
                "'sometime in August' are NOT acceptable. ASK Josh for the "
                "specific days he wants to offer for this venue, then call "
                "this tool again."
            ),
        }
    bperiod = booking_period.strip()
    if not bperiod:
        return {
            "error": (
                "booking_period is required. ASK Josh which booking window to "
                "reference (e.g. 'August', 'fall', 'late summer', 'September'). "
                "Josh's open booking window changes over the year — do NOT "
                "guess or hardcode a month. Use the same word in the body and "
                "subject."
            ),
        }
    if any(ch.isdigit() for ch in bperiod) or "/" in bperiod or len(bperiod) > 30:
        # booking_period should be a clean noun/adjective like "August", "fall",
        # "September". Digits (a year), slashes, or excessive length signal a
        # vague concatenation like "late summer/fall 2026" that the LLM tried
        # to pass instead of asking Josh for a clean month name.
        return {
            "error": (
                f"booking_period '{bperiod}' is malformed. It must be a clean "
                "short noun or adjective like 'August', 'September', 'fall', "
                "or 'late summer' — NO year, NO slashes, NO multiple seasons "
                "concatenated. ASK Josh which single booking window he means "
                "(it should match the month name in his date_range answer)."
            ),
        }
    greeting_name = contact_name.strip() or "there"
    body = _TEMPLATE_BODIES[t].format(
        greeting_name=greeting_name,
        venue_name=vname,
        date_range=drange,
        booking_period=bperiod,
    )
    if t == "pub_brewery":
        subject = (
            f"Booking Inquiry: Josh and Maria (Acoustic Duo) - "
            f"{bperiod.title()} Dates"
        )
    else:
        subject = _SUBJECT_STATIC[t]
    return {
        "subject": subject,
        "body": body,
        "template_used": t,
    }


TOOLS: list[Tool] = [
    Tool(
        name="generate_venue_email_from_template",
        description=(
            "Render a venue-outreach email using one of Josh's APPROVED templates. "
            "Use this INSTEAD of writing the email body from scratch. Three templates, "
            "picked by venue type:\n"
            "  - 'originals' — listening rooms, venues focused on original songwriter "
            "music. Pitches the original repertoire (Dark Light, Misty Rainy Morning, "
            "Good Enough) and the close-harmony Americana identity.\n"
            "  - 'midrange' — cafes, bars, mid-range venues. Pitches harmony-driven "
            "Americana with a mix of originals + select covers (Proud Mary, Country "
            "Roads, Dark Light samples).\n"
            "  - 'pub_brewery' — breweries, pubs, festivals. Pitches the energetic "
            "crowd-pleasing set with covers + originals (Proud Mary, I'm Yours, "
            "Country Roads samples). Bring-own-PA, 2-3 hour set focus.\n"
            "Returns subject + body. After calling, PRINT the returned body to Josh "
            "in your reply and wait for explicit approval before calling "
            "gmail_draft_email. This tool exists because writing email prose from "
            "scratch produces marketing-copy that does not match Josh's voice."
        ),
        parameters={
            "type": "object",
            "properties": {
                "template": {
                    "type": "string",
                    "enum": ["originals", "midrange", "pub_brewery"],
                    "description": (
                        "Venue type: 'originals' (listening room / songwriter), "
                        "'midrange' (cafe / bar / mid-range), "
                        "'pub_brewery' (brewery / pub / festival)."
                    ),
                },
                "venue_name": {
                    "type": "string",
                    "description": (
                        "Name of the venue exactly as it should appear in the email "
                        "(e.g. 'Solstice Farm Brewery', 'The Floyd Country Store')."
                    ),
                },
                "contact_name": {
                    "type": "string",
                    "description": (
                        "Optional: the booker's name for the greeting line. If left "
                        "empty, the greeting will be 'Hi there,'. Use the booker's "
                        "name when the task supplies it (e.g. 'Bobby' becomes "
                        "'Hi Bobby,'); otherwise leave empty."
                    ),
                },
                "date_range": {
                    "type": "string",
                    "description": (
                        "REQUIRED. The specific dates Josh is offering, as a "
                        "natural-language fragment that fits the sentence "
                        "pattern in the template (e.g. 'August 28, 29, or 30', "
                        "'the last weekend of August', 'any Saturday in "
                        "August'). ASK JOSH for this value BEFORE calling the "
                        "tool — do not guess, do not substitute a placeholder, "
                        "do not use 'TBD' or '(date range)'. Josh's current "
                        "booking window changes over the year."
                    ),
                },
                "booking_period": {
                    "type": "string",
                    "description": (
                        "REQUIRED. The booking window referenced in the body "
                        "and (for pub_brewery) subject — a short noun or "
                        "adjective that fits patterns like 'our {X} run' and "
                        "'a few {X} dates open'. Examples: 'August', 'fall', "
                        "'late summer', 'September'. ASK JOSH for this value "
                        "BEFORE calling the tool — Josh's open booking window "
                        "changes over the year, do not guess or hardcode a "
                        "month."
                    ),
                },
            },
            "required": ["template", "venue_name", "date_range", "booking_period"],
        },
        handler=generate_venue_email_from_template,
    ),
]
