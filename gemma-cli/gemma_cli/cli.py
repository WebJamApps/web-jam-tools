"""`gemma` command entry point.

Usage:
    gemma                                # interactive REPL with full tool access
    gemma "draft a Floyd Country Store pitch and save to JoshMariaMusic"
    gemma --verbose "list files in MariaParty folder"
"""

from __future__ import annotations

import argparse
import re
import sys

from gemma_cli.llm import DEFAULT_MODEL, chat
from gemma_cli.memory import append_memory, load_memory
from gemma_cli.tools.calendar import TOOLS as CALENDAR_TOOLS
from gemma_cli.tools.drive import TOOLS as DRIVE_TOOLS
from gemma_cli.tools.gmail import TOOLS as GMAIL_TOOLS
from gemma_cli.tools.memory import TOOLS as MEMORY_TOOLS
from gemma_cli.tools.templates import TOOLS as TEMPLATE_TOOLS
from gemma_cli.tools.templates import generate_venue_email_from_template
from gemma_cli.tools.venue_contacts import TOOLS as VENUE_CONTACT_TOOLS
from gemma_cli.tools.venue_contacts import lookup_venue_contact, lookup_venue_email_on_web

ALL_TOOLS = DRIVE_TOOLS + CALENDAR_TOOLS + GMAIL_TOOLS + MEMORY_TOOLS + TEMPLATE_TOOLS + VENUE_CONTACT_TOOLS

SYSTEM_PROMPT = (
    "You are the Coordinator for Josh Sherman's personal projects (JoshMariaMusic "
    "gig booking and MariaParty retirement party)."
    "\n\nTOOL-USE POLICY (most important rule):"
    "\n\nDEFAULT BEHAVIOR: do NOT call tools. Reply to Josh directly using language."
    "\n\nUSE A TOOL ONLY when ALL THREE of these are true:"
    "\n  (a) Josh asks about a SPECIFIC, IDENTIFIABLE resource — a named Drive file, a named calendar event, a specific Gmail thread or sender — OR he explicitly asks for an action like 'list my drive', 'read claude-opus-tasks.txt', 'show today's events', 'search emails for X', 'create a calendar event for Y'."
    "\n  (b) The answer depends on live data only the tool can retrieve — current Drive contents, the real calendar, actual email contents. Not just topics he's mentioned in conversation."
    "\n  (c) You can identify exactly which tool and exactly what arguments to pass."
    "\n\nIF ANY of (a)(b)(c) IS UNCLEAR — do NOT call a tool. Reply conversationally, or ask Josh a clarifying question."
    "\n\nEXAMPLES — USE a tool:"
    "\n- 'list the files in my drive' → drive_list_files"
    "\n- 'read claude-opus-tasks.txt' → drive_list_files (to find ID) then drive_read_text_file"
    "\n- 'what's on my calendar today?' → calendar_list_events"
    "\n- 'create an event for Maria's party at 5pm on May 30' → calendar_create_event"
    "\n- 'search my emails for Bobby at Mac n Bob's' → gmail_search"
    "\n\nEXAMPLES — do NOT use a tool, reply with language:"
    "\n- 'how do you feel today?' → conversational reply"
    "\n- 'hi' / 'good morning' / 'thanks' → conversational reply"
    "\n- 'what are your operating rules?' → answer from this system prompt"
    "\n- 'draft a pitch email to Floyd Country Store, my son lives in Rustburg' → write the draft directly (Josh gave you the facts)"
    "\n- 'what is the capital of Italy?' → answer from training (Rome)"
    "\n- 'help me think through whether to play Saturday or Sunday' → reasoning in text"
    "\n\nHOW TO CALL A TOOL (when you do):"
    "\n- Tool calls are emitted in the structured `tool_calls` field of your response, NOT as text in your reply."
    "\n- Writing a tool name in your reply text is NEVER a tool call. It is plain text and NOTHING will execute."
    "\n- Do NOT describe a tool call in your reply text instead of actually emitting one. Before any tool has actually run and returned a result, your reply should not claim that one did."
    "\n- If you cannot or will not emit a structured tool_call, say so plainly — do not fake the result."
    "\n- If a file is large, use drive_read_text_file_lines or drive_search_in_file (NOT the full-read tool)."
    "\n- If unsure which tool, call drive_list_files first to find the file ID."
    "\n\nVOICE RULES (for any email/pitch drafting task):"
    "\n- Write as Josh in first person singular ('I', 'my wife Maria'). Never 'we are writing to' / 'we specialize in' / 'we are confident'."
    "\n- Open with 'Hi,' or 'Hi [name],' — NEVER 'Dear [title]' (e.g. 'Dear booking manager' is BANNED)."
    "\n- Banned words: exciting, opportunity, passionate, thrilled, reach out, circle back, truly admire, deep connection, great addition, perfect fit."
    "\n- Tone: like an email between two people who'd recognize each other in a coffee shop. Conversational. No marketing copy."
    "\n- ANTI-HALLUCINATION: If the user did NOT tell you a fact, do not invent it. In particular: do not invent musical genres, awards, past venues, follower counts, or experience claims. If you don't know, leave it out."
    "\n- USE any personal hook the user gives you (e.g. 'son lives in Rustburg'). Don't drop it."
    "\n- Avoid 'your spot'. Prefer 'your venue' / 'your stage' / the venue's actual name."
    "\n\nEXAMPLE PITCHES (match this style. Plain. Conversational. Only facts the user gave you.):"
    "\n  --- Example A (warm tone, returning-area venue) ---"
    "\n  Hi,"
    "\n  My wife Maria and I are an acoustic duo from Salem, VA. We're free the last two weeks"
    "\n  of June and would love to play a Saturday at your place. My son lives in Rustburg, so"
    "\n  we're in the area anyway and it would be a real treat to get on your stage."
    "\n  Let me know if any of those dates work."
    "\n  Thanks — Josh Sherman, joshandmariamusic.com"
    "\n  --- Example B (professional tone, new venue) ---"
    "\n  Hi,"
    "\n  I'm Josh Sherman — my wife and I play as Josh and Maria, an acoustic duo out of Salem,"
    "\n  VA. I came across your venue and wanted to ask about booking. We have Saturdays open"
    "\n  between June 14 and 28. Happy to send a short sample or talk through what we play."
    "\n  Thanks — Josh Sherman, joshandmariamusic.com"
    "\n  ---"
    "\nIf the user did NOT give you a fact (genre, style, prior venues, awards, follower counts), DO NOT mention it. Just leave it out. The examples above only mention facts that were given."
    "\n\nOPERATIONAL RULES (code-enforced — for reference):"
    "\n- CALENDAR CONFLICT: never schedule over an existing event without Josh's explicit override."
    "\n- EMAIL: always DRAFT, never send."
    "\n- FILES: never create a version-suffixed copy (V2, V3, -new, -copy) — edit the master."
    "\n- PROTECTED FILES (MariaParty RSVP MASTER, Master Plan v2, Banner Decision) cannot be modified without explicit Josh override."
    "\n\nSTANDARD EMAIL-DRAFTING FLOW (when the task is to draft an email):"
    "\n1. Compose the email and PRINT the full draft (To, Subject, Body) in your reply text. "
    "Format clearly so Josh can read it in the REPL."
    "\n2. Do NOT save the draft to Drive. Do NOT call gmail_draft_email yet. Just print and stop."
    "\n3. Josh will respond in chat — either approving (e.g. 'looks good, save as Gmail draft') "
    "or giving corrections ('change subject to X', 'make paragraph 2 shorter')."
    "\n4. If corrections, apply them and PRINT the updated draft again. Repeat as needed. "
    "Use session memory — remember what you wrote and apply Josh's edit on top, do not start from scratch."
    "\n5. ONLY when Josh explicitly approves with words like 'save as Gmail draft' or 'looks good, draft it', "
    "call gmail_draft_email ONCE with the final approved content. Then tell Josh: "
    "'Saved as Gmail draft — open Gmail Drafts to send.'"
    "\n\nRESPONSE FORMAT AFTER A TOOL ACTION (read carefully — this is how Josh sees your work):"
    "\n1. FIRST, report the actual content from the tool result. If drive_list_files returned 25 files, print all 25 file names. If drive_read_text_file returned a document body, paste the relevant content. If calendar_create_event returned an event ID, state the event details. The user must see the actual data, not a paraphrase."
    "\n2. THEN, on a new line at the bottom, write a one-line summary prefixed 'COORDINATOR REPORT:'. This footer is a FOOTER, not the entire response. A response that contains only a COORDINATOR REPORT line and no content above it is WRONG — Josh cannot use it."
)


def _run_once(
    prompt: str,
    model: str,
    verbose: bool,
    history: list | None = None,
    system: str | None = None,
    tools: list | None = None,
):
    # chat() now streams model output to stdout as it arrives — see llm.py.
    # Do NOT print result.final_text here or we'd double-print everything that
    # was already streamed. The fallback / synthesized-text paths inside chat()
    # print their own explicit lines for the cases where nothing was streamed.
    return chat(
        user_prompt=prompt,
        tools=tools if tools is not None else ALL_TOOLS,
        system=system if system is not None else SYSTEM_PROMPT,
        model=model,
        verbose=verbose,
        history=history,
    )


def _resolve_system_prompt() -> str:
    """Load SHARED.md + LLAMA.md from Drive. Fall back to hardcoded SYSTEM_PROMPT on failure."""
    drive_memory = load_memory()
    if drive_memory is None:
        print("[memory] Could not load SHARED.md + LLAMA.md from Drive — using hardcoded SYSTEM_PROMPT fallback.")
        return SYSTEM_PROMPT
    print(f"[memory] Loaded SHARED.md + LLAMA.md from Drive ({len(drive_memory)} chars).")
    return drive_memory


# Smalltalk gate (added 2026-05-17). Llama 3.3 70B Q4 ignores prompt-level rules
# forbidding tool use on greetings — the tool schemas in the request body act as a
# strong attractor and the model fires drive_list_files({}) on "hi". Hardcoded
# prompt strengthening, temp 0.0, num_ctx 16384, and the NO-COORDINATOR-REPORT
# rule all failed to suppress it. Pragmatic fix: detect smalltalk client-side and
# call the model WITHOUT tools attached for those turns. Removes the attractor at
# the protocol layer instead of relying on the model to follow instructions.
_SMALLTALK_EXACT = frozenset({
    "hi", "hello", "hey", "yo", "sup", "howdy",
    "thanks", "thank you", "thx", "ty",
    "bye", "goodbye", "cya", "later",
    "ok", "okay", "k", "kk", "cool", "nice", "got it", "gotcha",
    "yes", "yeah", "yep", "no", "nope", "nah",
    "lol", "haha",
})

_SMALLTALK_PATTERNS = (
    re.compile(r"^good\s+(morning|afternoon|evening|night|day)[.! ]*$", re.IGNORECASE),
    re.compile(r"^how\s+(are|is|was)\s+(you|it|things|your\s+day)[?.! ]*$", re.IGNORECASE),
    re.compile(r"^(what'?s\s+up|whats?up|wassup)[?.! ]*$", re.IGNORECASE),
    re.compile(r"^(how'?s\s+it\s+going|hows\s+it\s+going)[?.! ]*$", re.IGNORECASE),
)


# Detector for venue-outreach email tasks. When /next dispatches one of these,
# llama MUST call generate_venue_email_from_template — writing email body prose
# from scratch is forbidden because Q4 70B drifts to marketing-copy when given
# the chance. See _check_email_task_used_template_tool for the runtime hook.
_EMAIL_TASK_RE = re.compile(
    r"\bVenue\s+Outreach\s+Email\b|\bPitch\s+Email\b",
    re.IGNORECASE,
)

# Heuristic for "the model produced email-shaped content" — used to detect when
# llama bypassed the template tool and wrote prose. Looks for a Subject: line
# AND a greeting-style opening on a line by itself. False positives are fine —
# the worst outcome is one extra re-prompt.
_EMAIL_SHAPE_RE = re.compile(r"^\s*Subject\s*:", re.IGNORECASE | re.MULTILINE)


def _check_email_task_used_template_tool(
    task_text: str, tool_invocations: list, final_text: str
) -> bool:
    """Return True if the model produced email content without using the template tool.

    Only flags when ALL of these are true:
      - the task is a venue-outreach / pitch-email task (regex match)
      - the model's reply contains email-shaped content (Subject: line found)
      - the model did NOT call generate_venue_email_from_template this turn

    When True, the caller should re-prompt with a strong corrective message.
    """
    if not _EMAIL_TASK_RE.search(task_text):
        return False
    if not _EMAIL_SHAPE_RE.search(final_text or ""):
        return False
    used = any(
        inv.get("name") == "generate_venue_email_from_template"
        for inv in tool_invocations
    )
    return not used


# Pre-dispatch collector for venue-outreach email tasks (added 2026-05-18).
# Yesterday's protocol-layer fixes (template tool + validators + runtime hook)
# stopped llama from inventing prose but NOT from inventing dates — Q4 70B will
# reliably make up a plausible-looking date_range rather than ask Josh for one.
# The fix removes the opportunity: the REPL collects venue/dates/template from
# Josh BEFORE dispatching to llama, and injects them as exact values the model
# must use verbatim. See memory: project_llama_dispatcher_date_design.

# Broader keyword trigger that fires on tasks lacking the explicit
# `_EMAIL_TASK_RE` category labels. Tag-style match (Venue Outreach Email /
# Pitch Email) is preferred; this is the fallback for natural-language tasks.
_OUTREACH_KEYWORD_RE = re.compile(
    r"\bdraft\s+(an?\s+)?(email|outreach|pitch)\b"
    r"|\bwrite\s+(an?\s+)?(email|pitch)\s+to\b"
    r"|\b(outreach|pitch)\s+email\b"
    r"|\bemail\s+(to|for)\s+(?!confirm|cancel)",
    re.IGNORECASE,
)

# Explicit `venue:` line in the task body — wins over title regex.
_VENUE_FIELD_RE = re.compile(r"^\s*venue\s*:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)

# Bullet-list "Name: X" field — phone Sonnet's task format puts the venue name
# under a "VENUE DETAILS:" section as "- Name: <venue>". Allow optional bullet
# (-, *, •) and optional indentation.
_VENUE_NAME_FIELD_RE = re.compile(
    r"^\s*[-*•]?\s*Name\s*:\s*(.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)

# Bullet-list "Website: X" field — same source as the Name field above. Used
# by the email-discovery chain to pass a URL to lookup_venue_email_on_web when
# the venue isn't in the xlsx yet.
_VENUE_WEBSITE_FIELD_RE = re.compile(
    r"^\s*[-*•]?\s*Website\s*:\s*(.+?)\s*$",
    re.IGNORECASE | re.MULTILINE,
)

# Title pattern `Task N — {Venue} — ...` (or colons / hyphens / en-dashes).
_TASK_TITLE_VENUE_RE = re.compile(
    r"^Task\s+\d+\s*[—–:\-]\s*(.+?)\s*[—–:\-]",
    re.IGNORECASE | re.MULTILINE,
)

# Verbs that suggest the regex grabbed the action phrase instead of a venue.
_VENUE_SUSPECT_VERBS_RE = re.compile(
    r"\b(draft|send|email|update|verify|write|compose|reach|contact|follow|book)\b",
    re.IGNORECASE,
)

# Month-name + nearby digit in the task body. Limited to 40 chars between the
# month name and the digit so we don't span sentences and grab unrelated numbers.
_DATES_IN_BODY_RE = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December"
    r"|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b[^.\n]{0,40}\d",
    re.IGNORECASE,
)

# Used by _parse_dates to pull out the month(s) and (optional) year.
_MONTH_NAME_RE = re.compile(
    r"\b(January|February|March|April|May|June|July|August|September|October|November|December"
    r"|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b",
    re.IGNORECASE,
)
_MONTH_FULL = {
    "jan": "January", "january": "January",
    "feb": "February", "february": "February",
    "mar": "March", "march": "March",
    "apr": "April", "april": "April",
    "may": "May",
    "jun": "June", "june": "June",
    "jul": "July", "july": "July",
    "aug": "August", "august": "August",
    "sep": "September", "sept": "September", "september": "September",
    "oct": "October", "october": "October",
    "nov": "November", "november": "November",
    "dec": "December", "december": "December",
}

# Template auto-detect — HIGH confidence (silent echo, no prompt).
_TEMPLATE_HIGH_CONFIDENCE = (
    (re.compile(r"\b(brewery|brewing|taproom|microbrewery|pub|tavern|alehouse)\b", re.IGNORECASE), "pub_brewery"),
    (re.compile(r"\blistening\s+room\b|\bcoffee\s*house\b|\bcoffeehouse\b", re.IGNORECASE), "originals"),
)
_TEMPLATE_CHOICES = ("originals", "midrange", "pub_brewery")
_TEMPLATE_DEFAULT = "midrange"


def _is_outreach_task(task: str) -> bool:
    """Trigger detection (A): explicit tag wins; broader keyword regex is fallback."""
    if _EMAIL_TASK_RE.search(task):
        return True
    return bool(_OUTREACH_KEYWORD_RE.search(task))


def _extract_venue(task: str) -> str | None:
    """Venue extraction (E): explicit `venue:` field wins; else `- Name:` bullet
    (phone Sonnet's task format); else `Task N — Venue — ...` title regex; else
    None. Suspect-result check rejects action-verb-shaped matches."""
    m = _VENUE_FIELD_RE.search(task)
    if m:
        return m.group(1).strip()
    m = _VENUE_NAME_FIELD_RE.search(task)
    if m:
        candidate = m.group(1).strip()
        if not _VENUE_SUSPECT_VERBS_RE.search(candidate):
            return candidate
    m = _TASK_TITLE_VENUE_RE.search(task)
    if m:
        candidate = m.group(1).strip()
        if not _VENUE_SUSPECT_VERBS_RE.search(candidate):
            return candidate
    return None


def _extract_dates_from_body(task: str) -> str | None:
    """Return the first date-bearing substring (month-name + nearby digit) or None."""
    m = _DATES_IN_BODY_RE.search(task)
    if not m:
        return None
    # Return the matched span trimmed of trailing whitespace.
    return m.group(0).strip()


def _parse_dates(date_input: str) -> tuple[str, str | None]:
    """Parse free-form dates into (date_range, booking_period).

    `date_range` is the verbatim input (validator only requires a digit).
    `booking_period` is the single month name extracted from the input — the
    template validator forbids digits, slashes, or strings >30 chars, so we
    can't include a year. Returns None if the input has multiple months or no
    month name; caller then prompts for it explicitly.
    """
    found = _MONTH_NAME_RE.findall(date_input)
    if not found:
        return date_input, None
    normalized: list[str] = []
    for raw in found:
        full = _MONTH_FULL.get(raw.lower())
        if full and full not in normalized:
            normalized.append(full)
    if len(normalized) != 1:
        return date_input, None
    return date_input, normalized[0]


def _detect_template_high_confidence(venue: str) -> str | None:
    """Return a template name if the venue name has an unambiguous keyword; else None."""
    for pattern, template in _TEMPLATE_HIGH_CONFIDENCE:
        if pattern.search(venue):
            return template
    return None


def _extract_website(task: str) -> str | None:
    """Pull a `Website: X` field out of the task body. Returns a https-prefixed
    URL, or None if no Website field is found."""
    m = _VENUE_WEBSITE_FIELD_RE.search(task)
    if not m:
        return None
    url = m.group(1).strip()
    if not url:
        return None
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _find_venue_email(venue: str, task: str) -> tuple[str | None, str, str | None]:
    """3-tier email discovery: xlsx -> web scrape -> Josh prompt.

    Returns (email, contact_name, cancel_reason). On success email is non-empty
    and cancel_reason is None. On cancel email is None and cancel_reason
    describes which prompt was cancelled.
    """
    # Tier 1 — xlsx
    contact = lookup_venue_contact(venue)
    if contact.get("found"):
        email = (contact.get("email") or "").strip()
        contact_name = (contact.get("contact") or "").strip()
        if email:
            print(f"Found in xlsx: {email}" + (f" ({contact_name})" if contact_name else ""))
            return email, contact_name, None
        print(f"({venue} is in the xlsx but has no email on file — trying web scrape)")
    else:
        print(f"({venue} not in xlsx — trying web scrape)")

    # Tier 2 — web scrape
    website = _extract_website(task)
    if not website:
        # No Website: field; let Josh provide one (or skip web scrape entirely).
        try:
            reply = input(
                f"What's {venue}'s website URL? "
                "(press Enter to skip web scrape and type the email directly, or 'cancel') "
            ).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None, "", "cancelled at website prompt"
        if reply.lower() == "cancel":
            return None, "", "cancelled at website prompt"
        if reply:
            if not reply.startswith(("http://", "https://")):
                reply = "https://" + reply
            website = reply
    if website:
        print(f"Searching {website} for contact email...")
        web = lookup_venue_email_on_web(website)
        email = (web.get("email") or "").strip() if isinstance(web, dict) else ""
        if email:
            print(f"Found email via web scrape: {email}")
            print("(consider running update_venue_contact later to save it to the xlsx)")
            return email, "", None
        print(f"(no usable email found at {website})")

    # Tier 3 — Josh prompt
    email = _prompt_with_cancel(f"What's the TO email for {venue}? (or 'cancel') ")
    if email is None:
        return None, "", "cancelled at email prompt"
    return email, "", None


def _prompt_with_cancel(prompt_text: str) -> str | None:
    """Ask Josh a question. Empty input re-prompts; `cancel` returns None.

    Returns the non-empty input string, or None if Josh typed cancel.
    """
    while True:
        try:
            reply = input(prompt_text).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if reply.lower() == "cancel":
            return None
        if reply:
            return reply
        # empty → silent re-prompt


def _collect_outreach_inputs(task: str) -> tuple[str | None, str | None, dict | None]:
    """For venue-outreach tasks, gather venue/dates/template from Josh, render
    the email by calling generate_venue_email_from_template DIRECTLY (Option B,
    2026-05-18), and return an augmented task body containing the pre-rendered
    draft. Llama's job shrinks to printing the draft and handling approval.

    Returns (augmented_task, cancel_reason, pre_rendered_data):
      - (augmented_task, None, pre_rendered) → dispatch a pre-rendered outreach task
      - (augmented_task, None, None)         → outreach task with rendering failure;
                                                falls back to the prior "use these
                                                EXACT values" prefix (llama renders)
      - (task,           None, None)         → not an outreach task; pass through unchanged
      - (None,           reason, None)       → Josh cancelled; caller should skip dispatch

    The pre_rendered_data dict contains keys: to, subject, body, venue,
    contact_name, template, date_range, booking_period. The caller uses
    pre_rendered_data is not None as the signal to suppress the
    _check_email_task_used_template_tool runtime hook (llama is NOT supposed
    to call the template tool when the dispatcher already rendered).
    """
    if not _is_outreach_task(task):
        return task, None, None

    # E — venue
    venue = _extract_venue(task)
    if venue is None:
        venue = _prompt_with_cancel("What's the venue name for this task? (or 'cancel') ")
        if venue is None:
            return None, "cancelled at venue prompt", None

    # Date detection in body, else dates prompt.
    # date_range MUST contain a digit (templates.py validator rejects vague phrases
    # without day numbers); body regex already requires this by construction, but
    # the explicit-prompt path needs to enforce it to avoid downstream rejection.
    body_dates = _extract_dates_from_body(task)
    if body_dates:
        print(f"Found dates in task: {body_dates} — using these.")
        date_input = body_dates
    else:
        while True:
            date_input = _prompt_with_cancel(
                f"Which dates do you want me to offer for {venue}? "
                "(e.g. 'the weekend of August 14-16', or 'cancel') "
            )
            if date_input is None:
                return None, "cancelled at dates prompt", None
            if any(ch.isdigit() for ch in date_input):
                break
            print("(needs at least one day number — e.g. 'August 14-16', "
                  "not 'any Saturday in August')")

    # B — parse
    date_range, booking_period = _parse_dates(date_input)
    if booking_period is None:
        print("(couldn't pick a single month name from that — needs an explicit booking_period)")
        bp = _prompt_with_cancel(
            "What's the booking window? (single noun, no digits, no slashes — "
            "e.g. 'August', 'fall', 'late summer', or 'cancel') "
        )
        if bp is None:
            return None, "cancelled at booking_period prompt", None
        # Soft sanity check — mirrors the templates.py validator at line 206.
        if any(ch.isdigit() for ch in bp) or "/" in bp or len(bp) > 30:
            print(f"(warning: '{bp}' will trip the template validator — sending anyway)")
        booking_period = bp

    # D — template
    template = _detect_template_high_confidence(venue)
    if template:
        print(f"Using template: {template} (matched on venue name '{venue}').")
    else:
        # Empty input ACCEPTS the default here (one-keystroke confirm UX),
        # so we don't use _prompt_with_cancel which re-prompts on empty.
        try:
            reply = input(
                f"No clear template signal for '{venue}'. Defaulting to {_TEMPLATE_DEFAULT} — "
                f"press Enter to confirm or type one of: {', '.join(_TEMPLATE_CHOICES)} (or 'cancel') "
            ).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None, "cancelled at template prompt", None
        reply_lower = reply.lower()
        if reply_lower == "cancel":
            return None, "cancelled at template prompt", None
        if not reply_lower:
            template = _TEMPLATE_DEFAULT
        elif reply_lower in _TEMPLATE_CHOICES:
            template = reply_lower
        else:
            print(f"(unrecognized template '{reply}' — using default {_TEMPLATE_DEFAULT})")
            template = _TEMPLATE_DEFAULT

    # Option B (2026-05-18): pre-render by calling tools directly. Removes llama
    # from the parameter-filling path entirely so it cannot hallucinate
    # template / booking_period / venue substitutions on a re-prompt.

    # Discover TO email via xlsx -> web -> prompt chain
    to_email, contact_name, cancel_reason = _find_venue_email(venue, task)
    if cancel_reason is not None:
        return None, cancel_reason, None

    # Render the email by calling the tool handler directly
    rendered = generate_venue_email_from_template(
        template=template,
        venue_name=venue,
        date_range=date_range,
        booking_period=booking_period,
        contact_name=contact_name,
    )
    if isinstance(rendered, dict) and "error" in rendered:
        # Defensive — shouldn't trip because our values already pass the validators
        # individually, but if the renderer rejects anything, fall back to the
        # prior "use these EXACT values" prefix and let llama call the tool.
        print(f"(template renderer rejected the inputs: {rendered['error']})")
        print("(falling back to legacy prefix — llama will call the template tool itself)")
        augmented = (
            f"{task}\n\n"
            f"Josh has specified: venue_name='{venue}', date_range='{date_range}', "
            f"booking_period='{booking_period}', template='{template}', "
            f"to='{to_email}'"
            f"{f', contact_name={contact_name!r}' if contact_name else ''}. "
            f"Use these EXACT values — do not modify or substitute."
        )
        return augmented, None, None

    subject = rendered["subject"]
    body = rendered["body"]

    augmented = (
        f"{task}\n\n"
        f"=== PRE-RENDERED EMAIL (do not modify; do not call generate_venue_email_from_template) ===\n"
        f"TO: {to_email}\n"
        f"SUBJECT: {subject}\n"
        f"BODY:\n{body}\n"
        f"=== END PRE-RENDERED ===\n\n"
        f"Josh has already chosen template={template}, venue_name={venue!r}, "
        f"date_range={date_range!r}, booking_period={booking_period!r}, "
        f"to={to_email!r}"
        f"{f', contact_name={contact_name!r}' if contact_name else ''}, "
        f"and the email above is the FINAL rendered draft (already generated by "
        f"the template tool — do NOT call generate_venue_email_from_template).\n\n"
        f"YOUR JOB:\n"
        f"1. PRINT the TO, SUBJECT, and BODY exactly as shown above in your reply text "
        f"so Josh can read the draft.\n"
        f"2. WAIT for Josh's reply.\n"
        f"3. If Josh approves (e.g. 'save as Gmail draft', 'looks good, ship it'), "
        f"call gmail_draft_email ONCE with these EXACT TO / SUBJECT / BODY values.\n"
        f"4. If Josh requests changes, apply the changes to the BODY in your reply "
        f"text and reprint — do NOT call generate_venue_email_from_template again "
        f"(the template would overwrite Josh's edits)."
    )

    pre_rendered = {
        "to": to_email,
        "subject": subject,
        "body": body,
        "venue": venue,
        "contact_name": contact_name,
        "template": template,
        "date_range": date_range,
        "booking_period": booking_period,
    }
    return augmented, None, pre_rendered


def _is_smalltalk(text: str) -> bool:
    """Return True for clear conversational openers that should NOT trigger tools.

    Conservative on purpose — only catches clean smalltalk. Anything ambiguous
    falls through to the normal tool-enabled path so the model can still use
    tools when there's actual work to do.
    """
    normalized = text.strip().rstrip(".!?").strip().lower()
    if not normalized:
        return False
    if normalized in _SMALLTALK_EXACT:
        return True
    return any(p.match(text.strip()) for p in _SMALLTALK_PATTERNS)


# Email-draft approval gate (added 2026-05-17). Same class of bug as the smalltalk
# gate: when /next dispatches a venue-email task, llama reaches for gmail_draft_email
# on turn 1 BEFORE Josh has reviewed the draft, violating the STANDARD EMAIL-DRAFTING
# FLOW (print draft → iterate with Josh → only call gmail_draft_email after explicit
# approval). Removing the tool from the request body on un-approved turns means the
# model physically cannot fire it.
_EMAIL_DRAFT_SAVE_TOOL_NAMES = frozenset({"gmail_draft_email"})

# Substrings that count as Josh authorizing the draft to be saved as a Gmail draft.
# Compared against `line.lower()` so any casing matches. Conservative — must contain
# an explicit "save / draft / send / ship / approve" word; a passive "looks fine" is
# not enough.
_APPROVAL_PHRASES = (
    "save as gmail draft",
    "save it as a gmail draft",
    "save the draft",
    "save it as gmail draft",
    "save as draft",
    "save it as draft",
    "save the email",
    "save to gmail",
    "save the gmail draft",
    "draft it",
    "draft this",
    "save it",
    "go ahead and save",
    "go ahead and draft",
    "go ahead, save",
    "go ahead, draft",
    "ship it",
    "send it",
    "looks good, save",
    "looks good, draft",
    "looks good draft",
    "looks good save",
    "approve",
    "approved",
    "i approve",
)


def _has_email_draft_approval(text: str) -> bool:
    """Return True if Josh's input authorizes calling gmail_draft_email.

    Conservative on purpose — without an explicit approval signal, the gate
    keeps gmail_draft_email out of the request body. Josh can always re-prompt
    with a clear "save as Gmail draft" to release the gate.
    """
    lower = text.lower().strip()
    if not lower:
        return False
    return any(phrase in lower for phrase in _APPROVAL_PHRASES)


def _strip_email_draft_save(tools: list) -> list:
    """Remove gmail_draft_email (and any other approval-gated save tools)."""
    return [t for t in tools if t.name not in _EMAIL_DRAFT_SAVE_TOOL_NAMES]


_NEXT_TASK_PREFIX = (
    "You have ONE specific task. Do not look for other tasks; this is your only scope. "
    "The task may have multiple numbered steps (STEP 1, STEP 2, ...). You MUST complete "
    "EVERY step before finishing — DO NOT stop after one tool call. After each tool call, "
    "re-read the task and continue with whatever step still needs work. "
    "Only write a final 'COORDINATOR REPORT' when EVERY step is genuinely done; do NOT "
    "write COORDINATOR REPORT after intermediate tool calls — the report is a finale, "
    "not a per-step status. "
    "Do NOT fabricate any data — if a tool returns nothing, say 'not found' rather than "
    "making up plausible-looking results. "
    "Here is the task:\n\n"
)


_VERIFICATION_TASK_PREFIX = (
    "VERIFICATION REQUEST (this is NOT an execution request).\n\n"
    "Josh already attempted this task earlier in this session. He wants to know "
    "whether it actually completed successfully. Your job is to CHECK, not to redo.\n\n"
    "What to do:\n"
    "1. Use ONLY the read-only tools available to you (the runtime has filtered the "
    "tool set — write tools are NOT present in this turn). Inspect the relevant Drive "
    "file, calendar event, or email to determine current state.\n"
    "2. Decide whether the task's intended outcome is already in place.\n"
    "3. Report in this exact format on three lines:\n"
    "   STATUS: COMPLETE | INCOMPLETE | UNCERTAIN\n"
    "   EVIDENCE: which resource you checked and what you found.\n"
    "   NEXT STEP: either 'Josh can run /done to mark this complete' (if COMPLETE) "
    "or 'requires re-execution because <reason>' (if INCOMPLETE/UNCERTAIN).\n\n"
    "Do NOT attempt to execute the task. Do NOT call any tool that writes, creates, "
    "updates, or saves anything (those tools are not available to you in this turn).\n"
    "Do NOT call remember_fact — this verification is session-scoped.\n\n"
    "Here is the task you previously attempted:\n\n"
)


# Tools that only read state. Used to build the verify-mode tool subset so a model
# in VERIFICATION mode can't accidentally execute the task.
_READ_ONLY_TOOL_NAMES = frozenset({
    "drive_list_files",
    "drive_read_text_file",
    "drive_read_text_file_lines",
    "drive_search_in_file",
    "calendar_list_events",
    "gmail_search",
})


def _wrapper_name_for_model(model: str) -> str:
    """Derive the conventional wrapper command name from the model tag.

    Matches the names of the wrappers under ~/.local/bin/ on the maintainer's
    machine: `llama` for Llama models, `gemma` for everything else.
    """
    return "llama" if model.startswith("llama") else "gemma"


def _role_for_model(model: str) -> str:
    """Map a model tag to its team role per CLAUDE.md AI TEAM STRUCTURE."""
    if model.startswith("gemma"):
        return "Media Specialist"
    return "Coordinator"


def _repl(model: str, verbose: bool) -> None:
    name = _wrapper_name_for_model(model)
    role = _role_for_model(model)
    system_prompt = _resolve_system_prompt()
    print(f"{name} ({role} REPL — {model}). Tools: Drive, Calendar, Gmail.")
    print("Commands: /next [--force] (run next queued task; re-runs auto-switch to read-only verify mode unless --force),")
    print("          /done (remove first queued task),")
    print("          /remember <text> (append fact to LLAMA.md), /memory (show current memory),")
    print("          /reset (clear session memory), verbose (toggle tool logging),")
    print("          exit / Ctrl-D (quit).\n")
    prompt = f"{name}> "
    history: list = []
    # Tracks the first ~80 chars of the most recently /next-ed task so we can
    # warn Josh if he runs /next twice without /done in between. In-session
    # only; doesn't survive REPL restart.
    last_next_task: str | None = None
    while True:
        try:
            line = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        if line.lower() in {"exit", "quit", "/bye"}:
            return
        if line.lower() == "verbose":
            verbose = not verbose
            print(f"(verbose = {verbose})")
            continue
        if line.lower() in {"/reset", "reset"}:
            history = []
            last_next_task = None
            print("(session memory cleared)")
            print()
            continue
        if line.lower().startswith("/remember"):
            text = line[len("/remember"):].strip()
            if not text:
                print("Usage: /remember <fact text>")
                print()
                continue
            try:
                result = append_memory(text)
                if result.get("saved"):
                    print(f"(remembered → {result['name']})")
                else:
                    existing = (result.get("existing_entry") or "").strip()
                    if len(existing) > 100:
                        existing = existing[:97] + "..."
                    print(f"(already saved — {existing or 'duplicate'})")
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        if line.lower() in {"/memory", "memory"}:
            try:
                m = load_memory()
                if m is None:
                    print("(could not load memory from Drive — check auth)")
                else:
                    print(m)
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        parts = line.lower().split()
        if parts and parts[0] in {"/next", "next"}:
            force = any(p in {"--force", "force"} for p in parts[1:])
            try:
                from gemma_cli.queue import get_next_task

                task, total = get_next_task(model)
                if not task:
                    print("(queue empty)")
                    print()
                    continue
                # Normalize for re-run detection: collapse whitespace, take first 80 chars.
                signature = " ".join(task.split())[:80]
                matches_last = (signature == last_next_task)
                is_rerun = matches_last and not force
                last_next_task = signature

                print(f"=== Next task (of {total} in queue) ===")
                print(task)
                print()

                if is_rerun:
                    print(
                        "(reminder: this task was already attempted in this session — "
                        "running VERIFICATION mode with read-only tools. To force a "
                        "real re-execute, type: /next --force)"
                    )
                    print()
                    verify_tools = [t for t in ALL_TOOLS if t.name in _READ_ONLY_TOOL_NAMES]
                    result = _run_once(
                        _VERIFICATION_TASK_PREFIX + task,
                        model=model,
                        verbose=verbose,
                        history=history,
                        system=system_prompt,
                        tools=verify_tools,
                    )
                else:
                    if matches_last and force:
                        print("(forced re-execute — bypassing verify mode)")
                        print()
                    # Pre-dispatch collector (added 2026-05-18): for venue-outreach
                    # tasks, ask Josh for venue/dates/template and PRE-RENDER the
                    # email by calling generate_venue_email_from_template +
                    # lookup_venue_contact directly (Option B). Llama receives the
                    # finished draft and just presents it / handles approval.
                    # See _collect_outreach_inputs docstring.
                    dispatched_task, cancel_reason, pre_rendered = _collect_outreach_inputs(task)
                    if cancel_reason is not None:
                        print(f"(task not dispatched — {cancel_reason}. Stays in queue; "
                              "run /next again when ready.)")
                        # Reset last_next_task so the next /next runs fresh (no
                        # spurious verify-mode trigger from this non-attempt).
                        last_next_task = None
                        print()
                        continue
                    # Email-draft approval gate: strip gmail_draft_email from the
                    # tool set on /next dispatch. The user CANNOT have approved a
                    # draft on the same turn they ran /next — gmail_draft_email
                    # belongs to the next turn (after Josh reviews + approves).
                    # See _has_email_draft_approval docstring.
                    next_tools = _strip_email_draft_save(ALL_TOOLS)
                    result = _run_once(
                        _NEXT_TASK_PREFIX + dispatched_task,
                        model=model,
                        verbose=verbose,
                        history=history,
                        system=system_prompt,
                        tools=next_tools,
                    )
                    # Runtime hook: if this was a venue-outreach email task and
                    # llama wrote email prose without calling the template tool,
                    # re-prompt once with a strong correction. Q4 70B regularly
                    # bypasses the LLAMA.md instruction to use the template tool;
                    # this hook is the protocol-layer backstop.
                    #
                    # Skipped on pre-rendered dispatches (Option B, 2026-05-18):
                    # the dispatcher already called the template tool, so llama
                    # is supposed to NOT call it — firing the hook would mis-fire
                    # on every successful pre-render.
                    if pre_rendered is None and _check_email_task_used_template_tool(
                        task, result.tool_invocations, result.final_text
                    ):
                        print(
                            "\n[runtime] email task: model wrote prose without "
                            "calling generate_venue_email_from_template — "
                            "re-prompting for tool-based render"
                        )
                        correction = (
                            "[Runtime correction — not from Josh]: That email "
                            "body was written from scratch, but for venue-outreach "
                            "email tasks you MUST use the "
                            "`generate_venue_email_from_template` tool — it is "
                            "the only way to produce the approved body (locked "
                            "prose, the right song links, the venue history "
                            "paragraph, the correct sign-off). Please redo: "
                            "(1) if you don't yet have CONCRETE dates from "
                            "Josh (month name + day numbers, NOT 'late summer' "
                            "or similar), ask him for them first; "
                            "(2) call lookup_venue_contact if you haven't already "
                            "to confirm the TO address; "
                            "(3) call generate_venue_email_from_template with "
                            "template, venue_name, date_range, and "
                            "booking_period — for a brewery task use "
                            "template='pub_brewery'; "
                            "(4) PRINT the returned subject + body to Josh "
                            "with the TO line. Do NOT compose email prose "
                            "yourself."
                        )
                        result = _run_once(
                            correction,
                            model=model,
                            verbose=verbose,
                            history=result.history,
                            system=system_prompt,
                            tools=next_tools,
                        )
                history = result.history
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        if line.lower() in {"/done", "done"}:
            try:
                from gemma_cli.queue import delete_first_task

                remaining = delete_first_task(model)
                last_next_task = None
                print(f"Removed first task. {remaining} remaining in queue.")
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        try:
            # Smalltalk gate: strip tool schemas for clear conversational openers
            # so the model can't fire drive_list_files({}) on "hi". See _is_smalltalk
            # docstring for rationale.
            #
            # Email-draft approval gate: independently, strip gmail_draft_email
            # from the tool set unless the user's input contains an approval phrase.
            # Prevents llama from saving a draft to Gmail before Josh reviews it.
            # See _has_email_draft_approval docstring.
            if _is_smalltalk(line):
                turn_tools: list | None = []
            elif _has_email_draft_approval(line):
                turn_tools = None  # full tool set; gmail_draft_email is allowed
            else:
                turn_tools = _strip_email_draft_save(ALL_TOOLS)
            result = _run_once(
                line,
                model=model,
                verbose=verbose,
                history=history,
                system=system_prompt,
                tools=turn_tools,
            )
            history = result.history
        except Exception as exc:
            print(f"[error] {type(exc).__name__}: {exc}")
        print()


def main() -> int:
    parser = argparse.ArgumentParser(prog="gemma", description="Local Gemma with Drive/Calendar/Gmail tools")
    parser.add_argument("prompt", nargs="*", help="What to do (natural language). Omit for interactive REPL.")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show tool calls")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Ollama model tag")
    args = parser.parse_args()

    if not args.prompt:
        _repl(model=args.model, verbose=args.verbose)
        return 0

    _run_once(
        " ".join(args.prompt),
        model=args.model,
        verbose=args.verbose,
        system=_resolve_system_prompt(),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
