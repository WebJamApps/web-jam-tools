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
from gemma_cli.tools.drive import download_pdf_text, find_pdf_by_name
from gemma_cli.tools.gmail import TOOLS as GMAIL_TOOLS
from gemma_cli.tools.gmail import draft_email
from gemma_cli.tools.memory import TOOLS as MEMORY_TOOLS
from gemma_cli.tools.templates import TOOLS as TEMPLATE_TOOLS
from gemma_cli.tools.templates import generate_venue_email_from_template
from gemma_cli.tools.venue_contacts import TOOLS as VENUE_CONTACT_TOOLS
from gemma_cli.tools.venue_contacts import (
    lookup_venue_contact,
    lookup_venue_email_on_web,
    update_venue_contact,
)

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
    max_turns: int | None = None,
):
    # chat() now streams model output to stdout as it arrives — see llm.py.
    # Do NOT print result.final_text here or we'd double-print everything that
    # was already streamed. The fallback / synthesized-text paths inside chat()
    # print their own explicit lines for the cases where nothing was streamed.
    kwargs: dict = {}
    if max_turns is not None:
        kwargs["max_turns"] = max_turns
    return chat(
        user_prompt=prompt,
        tools=tools if tools is not None else ALL_TOOLS,
        system=system if system is not None else SYSTEM_PROMPT,
        model=model,
        verbose=verbose,
        history=history,
        **kwargs,
    )


def _resolve_system_prompt() -> str:
    """Load SHARED.md + Coordinator memory from Drive. Fall back to hardcoded SYSTEM_PROMPT on failure."""
    drive_memory = load_memory()
    if drive_memory is None:
        print("[memory] Could not load Drive memory — using hardcoded SYSTEM_PROMPT fallback.")
        return SYSTEM_PROMPT
    print(f"[memory] Loaded Drive memory ({len(drive_memory)} chars).")
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

# Standing CC list for all venue-outreach drafts (Josh's preference 2026-05-18).
# Maria (chemmariasherman@gmail.com) gets a copy of every booking pitch, and
# Josh's primary inbox (joshua.v.sherman@gmail.com) gets one for personal record.
_OUTREACH_CC = "chemmariasherman@gmail.com, joshua.v.sherman@gmail.com"


# PDF references in task bodies — llama is text-only, so the dispatcher
# pre-extracts PDF text via pdftotext and inlines it into the task before
# dispatch. Drive URLs are the supported path; direct .pdf URLs detected
# but not fetched (warning emitted so Josh knows to provide a Drive copy).
_PDF_DRIVE_FILE_URL_RE = re.compile(
    r"https?://drive\.google\.com/file/d/([A-Za-z0-9_-]{20,})",
    re.IGNORECASE,
)
_PDF_DRIVE_OPEN_URL_RE = re.compile(
    r"https?://drive\.google\.com/open\?id=([A-Za-z0-9_-]{20,})",
    re.IGNORECASE,
)
_PDF_DIRECT_URL_RE = re.compile(
    r"https?://[^\s\)\]<>'\"]+\.pdf\b",
    re.IGNORECASE,
)
# Bare PDF filename, e.g. `Apocalypse_Ale_Works_Booking_Confirmation.pdf`.
# Allowed chars match what survives a "type the filename in plain English"
# task: alphanumerics, underscores, dots (other than the extension dot),
# hyphens, and spaces ARE NOT included here — filenames with spaces would
# need quoting in the task body and we don't try to handle that yet.
# URL matches are scrubbed before this regex runs, so it won't pick up the
# tail of a URL like `https://x.org/foo.pdf`.
_PDF_FILENAME_RE = re.compile(r"\b([A-Za-z0-9_.-]+\.pdf)\b", re.IGNORECASE)
# Per-PDF and total truncation caps (chars). Ollama default num_ctx is ~4k
# tokens; SHARED.md + GEMMA.md already consume a large slice. Keep PDF
# content tight so the original task and system prompt aren't squeezed out.
_PDF_PER_FILE_MAX_CHARS = 8000
_PDF_TOTAL_MAX_CHARS = 20000


def _extract_pdf_refs(task: str) -> list[dict]:
    """Find PDF references in a task body.

    Returns a list of {"kind", "ref", "match"}:
      - kind="drive":    ref is a Drive file ID; match is the original URL string
      - kind="url":      ref is a direct PDF URL (NOT fetched — warning only)
      - kind="filename": ref is a bare filename (e.g. `foo.pdf`); the dispatcher
                         resolves it to a Drive file_id at inline time

    De-duplicates by ref so the same PDF referenced twice is inlined once.
    Filename refs that match a URL already detected (URL tail like `foo.pdf`)
    are suppressed via pre-scrubbing.
    """
    seen: set[str] = set()
    refs: list[dict] = []
    for m in _PDF_DRIVE_FILE_URL_RE.finditer(task):
        file_id = m.group(1)
        if file_id in seen:
            continue
        seen.add(file_id)
        refs.append({"kind": "drive", "ref": file_id, "match": m.group(0)})
    for m in _PDF_DRIVE_OPEN_URL_RE.finditer(task):
        file_id = m.group(1)
        if file_id in seen:
            continue
        seen.add(file_id)
        refs.append({"kind": "drive", "ref": file_id, "match": m.group(0)})
    for m in _PDF_DIRECT_URL_RE.finditer(task):
        url = m.group(0)
        if "drive.google.com" in url.lower():
            # Already handled by the Drive regexes above.
            continue
        if url in seen:
            continue
        seen.add(url)
        refs.append({"kind": "url", "ref": url, "match": url})

    # Bare filenames — scrub all URL matches first so a URL's `.pdf` tail
    # isn't double-counted as a filename.
    scrubbed = _PDF_DRIVE_FILE_URL_RE.sub(" ", task)
    scrubbed = _PDF_DRIVE_OPEN_URL_RE.sub(" ", scrubbed)
    scrubbed = _PDF_DIRECT_URL_RE.sub(" ", scrubbed)
    for m in _PDF_FILENAME_RE.finditer(scrubbed):
        name = m.group(1)
        if name in seen:
            continue
        seen.add(name)
        refs.append({"kind": "filename", "ref": name, "match": name})
    return refs


def _inline_pdf_content(task: str) -> tuple[str, list[str]]:
    """Pre-extract PDF text and append it to the task body.

    Llama 3.3 70B is text-only and cannot read PDFs; the dispatcher does the
    extraction so llama sees plain text. Each PDF is fetched via
    `download_pdf_text` (Drive + pdftotext) and inlined as a clearly-delimited
    block after the original body.

    Returns (augmented_task, notices). `notices` is a list of human-readable
    lines (one per PDF) that the caller should print so Josh sees what was
    inlined or skipped. If no PDFs are referenced, returns (task, []).
    """
    refs = _extract_pdf_refs(task)
    if not refs:
        return task, []

    notices: list[str] = []
    blocks: list[str] = []
    total_chars = 0

    for ref in refs:
        if ref["kind"] == "url":
            notices.append(
                f"[pdf] skipped non-Drive PDF URL (not yet supported): {ref['ref']}"
            )
            continue
        if total_chars >= _PDF_TOTAL_MAX_CHARS:
            notices.append(
                f"[pdf] skipped {ref['match']} — total PDF inline budget "
                f"({_PDF_TOTAL_MAX_CHARS} chars) exhausted"
            )
            continue
        if ref["kind"] == "filename":
            resolved = find_pdf_by_name(ref["ref"])
            if "error" in resolved:
                notices.append(
                    f"[pdf] could not resolve filename {ref['ref']}: {resolved['error']}"
                )
                continue
            if resolved.get("warning"):
                notices.append(f"[pdf] {resolved['warning']}")
            file_id = resolved["file_id"]
        else:
            file_id = ref["ref"]
        result = download_pdf_text(file_id)
        if "error" in result:
            notices.append(
                f"[pdf] could not extract {result.get('name') or ref['ref']}: "
                f"{result['error']}"
            )
            continue
        text = result["text"]
        name = result.get("name") or ref["ref"]
        truncated = False
        if len(text) > _PDF_PER_FILE_MAX_CHARS:
            text = text[:_PDF_PER_FILE_MAX_CHARS]
            truncated = True
        if total_chars + len(text) > _PDF_TOTAL_MAX_CHARS:
            allowed = _PDF_TOTAL_MAX_CHARS - total_chars
            text = text[:allowed]
            truncated = True
        total_chars += len(text)
        header = f"=== PDF CONTENT: {name} (id={ref['ref']}) ==="
        if truncated:
            header += " [TRUNCATED]"
        blocks.append(f"\n\n{header}\n{text}\n=== END PDF ===")
        notices.append(
            f"[pdf] inlined {name} ({len(text)} chars"
            + (", truncated" if truncated else "")
            + ")"
        )

    if not blocks:
        return task, notices
    directive = (
        "\n\n[DISPATCHER NOTE — the dispatcher already extracted the content of "
        "the PDF(s) referenced in this task. Their full text is inlined below in "
        "=== PDF CONTENT ... === blocks. Do NOT call drive_read_text_file, "
        "drive_read_text_file_lines, drive_search_in_file, or any other "
        "file-reading tool for those PDFs — those tools cannot decode PDF bytes "
        "anyway. Use the inlined text directly.]"
    )
    return task + directive + "".join(blocks), notices


# --- Gig-tracking dispatcher (Task 36 Phase 1, added 2026-05-21) ---
#
# Trigger: 2026-05-20 live test of feat-pdf-pre-extraction on the Apocalypse Ale
# Works booking confirmation PDF. PDF inlining worked but llama drifted in
# follow-through: hallucinated an `add_gig_booking` tool, hunted for nonexistent
# "Gig Booking Records" files, wrote thin notes that missed phone-confirmed
# status / target dates / duration / texting follow-up, and skipped
# lookup_venue_contact. Same architectural pattern that worked for venue
# outreach in PR #11 applies: pre-render the tool call in Python, llama just
# presents and asks for approval, approval interceptor calls the tool directly.

# Triggers: explicit tags from phone Sonnet's task format win; broader keyword
# regex catches natural-language gig-tracking tasks (e.g. "update gig booking
# records after Apocalypse called").
_GIG_TRACKING_TASK_RE = re.compile(
    r"\bGig\s+Tracking\s+Update\b"
    r"|\bConfirmation\s+Ingestion\b"
    r"|\bbooking\s+confirmation\b"
    r"|\bgig\s+tracking\b"
    r"|\bupdate\s+(?:the\s+)?gig\s+booking\s+records?\b",
    re.IGNORECASE,
)

# PDF field regexes (from the Apocalypse Ale Works PDF format — reference impl).
# Each captures the value portion of a labeled line. Lines look like
# "Venue Name    Apocalypse Ale Works" (label and value separated by whitespace).
_GIG_VENUE_RE = re.compile(r"^\s*Venue\s+Name\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_GIG_LOCATION_RE = re.compile(r"^\s*Location\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_GIG_CONTACT_TEXT_RE = re.compile(
    r"^\s*Contact\s+Text\s+Line\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE
)
_GIG_TARGET_RE = re.compile(
    r"^\s*Target\s+Timeline\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE
)
_GIG_DURATION_RE = re.compile(r"^\s*Duration\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_GIG_STATUS_RE = re.compile(r"^\s*Status\s+(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
_GIG_ACTION_ITEMS_HEADER_RE = re.compile(
    r"^\s*Action\s+Items\s*:?\s*$", re.IGNORECASE
)
# Loose ALL-CAPS heading detector — used to terminate Action Items capture when
# the PDF moves on to the next section. 4+ uppercase letters (with optional
# spaces/colon) on a line by itself.
_GIG_HEADING_RE = re.compile(r"^[A-Z][A-Z\s]{3,}:?\s*$")
# Phone digits inside Contact Text Line value (e.g. "Apocalypse will text:
# 434-258-8761"). Captures the formatted phone for the notes callout.
_GIG_PHONE_RE = re.compile(r"\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b")

# PDF content block delimiters (produced by `_inline_pdf_content`). Extraction
# only reads from inside these blocks so we don't accidentally match labels in
# the task body proper.
_PDF_CONTENT_BLOCK_RE = re.compile(
    r"=== PDF CONTENT:.*?===\n(.*?)\n=== END PDF ===",
    re.DOTALL,
)


def _is_gig_tracking_task(task: str) -> bool:
    """Trigger detection: explicit tag wins; broader keyword regex is fallback."""
    return bool(_GIG_TRACKING_TASK_RE.search(task))


def _extract_action_items(content: str) -> str:
    """Capture Action Items block: lines after the header until blank line or
    next ALL-CAPS heading. Returns "" if no header found."""
    capturing = False
    items: list[str] = []
    for line in content.split("\n"):
        if not capturing:
            if _GIG_ACTION_ITEMS_HEADER_RE.match(line):
                capturing = True
            continue
        stripped = line.strip()
        if not stripped:
            break
        if _GIG_HEADING_RE.match(line):
            break
        items.append(stripped)
    return "\n".join(items)


def _extract_gig_tracking_fields(task: str) -> dict[str, str]:
    """Pull the 6 labeled fields + action items out of inlined PDF content.

    Reads ONLY from PDF content blocks (between `=== PDF CONTENT ===` and
    `=== END PDF ===`) so we don't accidentally match labels in the task body
    proper. Returns a dict with keys: venue_name, location, contact_text,
    phone, target_timeline, duration, status, action_items. Missing fields are
    empty strings (caller checks the count).
    """
    blocks = _PDF_CONTENT_BLOCK_RE.findall(task)
    content = "\n".join(blocks) if blocks else ""
    if not content:
        return {}

    fields: dict[str, str] = {}
    for key, pattern in (
        ("venue_name", _GIG_VENUE_RE),
        ("location", _GIG_LOCATION_RE),
        ("contact_text", _GIG_CONTACT_TEXT_RE),
        ("target_timeline", _GIG_TARGET_RE),
        ("duration", _GIG_DURATION_RE),
        ("status", _GIG_STATUS_RE),
    ):
        m = pattern.search(content)
        fields[key] = m.group(1).strip() if m else ""

    # Phone digits inside Contact Text Line (if any)
    if fields.get("contact_text"):
        m = _GIG_PHONE_RE.search(fields["contact_text"])
        fields["phone"] = m.group(1) if m else ""
    else:
        fields["phone"] = ""

    fields["action_items"] = _extract_action_items(content)
    return fields


def _count_extracted_fields(fields: dict[str, str]) -> int:
    """Count how many of the 6 primary fields auto-extracted. Used by the
    vendor-variation toleration check (need ≥ 3 to proceed without prompting)."""
    return sum(
        1 for key in ("venue_name", "location", "contact_text",
                      "target_timeline", "duration", "status")
        if fields.get(key)
    )


def _build_gig_tracking_notes(fields: dict[str, str]) -> str:
    """Compose a rich notes string from the extracted PDF fields.

    Includes status, target dates, duration, and action items verbatim. Always
    appends the manual texting callout ("Josh: please manually text X to lock
    weekend dates") until Task 35 (SMS tool) lands, at which point the callout
    becomes a `draft_text` call in the same preview.
    """
    import datetime as _dt

    parts: list[str] = []
    today = _dt.date.today().isoformat()
    parts.append(f"Booking confirmation ingested {today}.")
    if fields.get("status"):
        parts.append(f"Status: {fields['status']}.")
    if fields.get("target_timeline"):
        parts.append(f"Target: {fields['target_timeline']}.")
    if fields.get("duration"):
        parts.append(f"Duration: {fields['duration']}.")
    action = fields.get("action_items") or ""
    if action:
        # Collapse multi-line action items into a single semicolon-joined string
        # so the xlsx notes cell stays single-line-friendly.
        flat = "; ".join(s for s in action.split("\n") if s.strip())
        parts.append(f"Action items: {flat}.")
    phone = fields.get("phone") or ""
    if phone:
        parts.append(
            f"Josh: please manually text {phone} to lock weekend dates "
            "(SMS tool pending — Task 35)."
        )
    return " ".join(parts)


def _prompt_gig_tracking_fallback(venue_hint: str) -> dict[str, str] | None:
    """Vendor variation toleration: PDF didn't yield enough fields; prompt
    Josh for each one interactively. Returns dict or None on cancel.

    Per Task 36 spec: "Keep llama out of the extraction path entirely." So even
    on fallback, the dispatcher (not llama) handles the field collection.
    """
    print("(could not auto-extract enough fields from the PDF — falling back to prompts)")
    print("Type 'cancel' on any prompt to abort, or leave blank to skip an optional field.")

    venue_prompt = "Venue name"
    if venue_hint:
        venue_prompt += f" (hint from PDF: {venue_hint})"
    venue_prompt += ": "
    venue = _prompt_with_cancel(venue_prompt)
    if venue is None:
        return None

    def _optional(label: str) -> str | None:
        """Read an optional field — empty string is accepted; 'cancel' aborts."""
        try:
            reply = input(f"{label} (blank to skip, or 'cancel'): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if reply.lower() == "cancel":
            return None
        return reply

    location = _optional("Location (e.g. 'Forest, VA')")
    if location is None:
        return None
    phone = _optional("Phone (e.g. '434-258-8761')")
    if phone is None:
        return None
    target = _optional("Target timeline (e.g. 'Oct/Nov 2026 weekends')")
    if target is None:
        return None
    duration = _optional("Duration (e.g. '3-hour set')")
    if duration is None:
        return None
    status = _optional("Status (e.g. 'phone-confirmed, awaiting date lock')")
    if status is None:
        return None
    actions = _optional("Action items (semicolon-separated)")
    if actions is None:
        return None

    return {
        "venue_name": venue,
        "location": location,
        "contact_text": phone,  # synthesize Contact Text Line from phone
        "phone": phone,
        "target_timeline": target,
        "duration": duration,
        "status": status,
        "action_items": actions,
    }


def _collect_gig_tracking_inputs(task: str) -> tuple[str, str | None, dict | None]:
    """For gig-tracking tasks, extract booking fields from the inlined PDF and
    pre-build the `update_venue_contact` call args. Llama receives a finished
    preview and only handles presentation + approval.

    Returns (augmented_task, cancel_reason, pre_rendered_data):
      - (augmented_task, None, pre_rendered) → dispatch a pre-rendered gig task
      - (task,           None, None)         → not a gig-tracking task; pass through
      - (None,           reason, None)       → Josh cancelled the fallback prompts

    Mirrors `_collect_outreach_inputs` for the gig-tracking task type.
    """
    if not _is_gig_tracking_task(task):
        return task, None, None

    fields = _extract_gig_tracking_fields(task)
    if _count_extracted_fields(fields) < 3:
        # Vendor variation toleration — prompt Josh directly. Keep llama out.
        manual = _prompt_gig_tracking_fallback(fields.get("venue_name") or "")
        if manual is None:
            return None, "cancelled at gig-tracking fallback prompt", None
        fields = manual

    venue_name = fields.get("venue_name", "").strip()
    if not venue_name:
        # Shouldn't happen — extraction or fallback should have produced one.
        # Treat as cancel rather than save with an empty key.
        return None, "no venue name extracted from PDF or fallback", None

    # Pre-lookup: existing row vs new insert. Result feeds the preview.
    existing = lookup_venue_contact(venue_name)
    is_existing = bool(existing.get("found"))
    existing_email = (existing.get("email") or "").strip() if is_existing else ""
    existing_phone = (existing.get("phone") or "").strip() if is_existing else ""

    notes = _build_gig_tracking_notes(fields)
    phone = (fields.get("phone") or existing_phone or "").strip()
    location = (fields.get("location") or "").strip()

    # The args we'll pass to update_venue_contact on approval. We only overwrite
    # email if the PDF actually provided one (it usually doesn't — that's why
    # we don't auto-overwrite an existing email). Phone gets written if we
    # extracted one and there's none on file. Location gets written if we have
    # one. Notes ALWAYS get appended (the venue_contacts handler appends rather
    # than overwriting when an existing row has notes).
    pre_rendered = {
        "venue_name": venue_name,
        "email": "",  # don't overwrite — PDF doesn't supply this
        "contact": "",  # ditto
        "phone": "" if existing_phone else phone,
        "location": location,
        "notes": notes,
        "action": "update" if is_existing else "create",
    }

    action_label = "UPDATE existing row" if is_existing else "INSERT new row"
    augmented = (
        f"{task}\n\n"
        f"=== PRE-FILLED UPDATE (do not modify; do not call update_venue_contact) ===\n"
        f"ACTION: {action_label}\n"
        f"VENUE: {venue_name}\n"
        f"EMAIL: {existing_email or '(none on file; not changing)'}\n"
        f"PHONE: {phone or '(none)'}"
        f"{'  [already on file — not changing]' if existing_phone and phone == '' else ''}\n"
        f"LOCATION: {location or '(none)'}\n"
        f"NOTES (will append to existing notes column):\n"
        f"  {notes}\n"
        f"=== END PRE-FILLED ===\n\n"
        f"Josh has already pre-built this Gig Booking Worksheet update from the "
        f"booking confirmation PDF inlined above. The dispatcher determined the "
        f"action ({action_label}) by calling lookup_venue_contact.\n\n"
        f"YOUR JOB (do these in order — do NOT call any tool yet):\n"
        f"1. PRINT the PRE-FILLED UPDATE block above EXACTLY as shown so Josh "
        f"can review it.\n"
        f"2. End with a clear approval question on its own line — e.g.: "
        f"'Approve to save, or describe changes?'. It MUST explicitly invite "
        f"Josh to approve or request edits, and it MUST be the last thing in "
        f"your reply.\n"
        f"3. STOP. Do NOT call any tool on this turn. Wait for Josh's next "
        f"message.\n"
        f"4. When Josh approves (e.g. 'approve', 'looks good, save'), the REPL "
        f"will save the xlsx AUTOMATICALLY using the values above. You do NOT "
        f"call update_venue_contact yourself — the dispatcher intercepts the "
        f"approval and handles the save deterministically.\n"
        f"5. If Josh requests changes, apply them to the BODY in your reply "
        f"text and reprint with the approval question — do NOT call "
        f"update_venue_contact (the tool is stripped from your set anyway)."
    )
    return augmented, None, pre_rendered


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
        f"CC: {_OUTREACH_CC}\n"
        f"SUBJECT: {subject}\n"
        f"BODY:\n{body}\n"
        f"=== END PRE-RENDERED ===\n\n"
        f"Josh has already chosen template={template}, venue_name={venue!r}, "
        f"date_range={date_range!r}, booking_period={booking_period!r}, "
        f"to={to_email!r}"
        f"{f', contact_name={contact_name!r}' if contact_name else ''}, "
        f"and the email above is the FINAL rendered draft (already generated by "
        f"the template tool — do NOT call generate_venue_email_from_template).\n\n"
        f"YOUR JOB (do these in order — do NOT call any tool yet):\n"
        f"1. PRINT the TO, SUBJECT, and BODY exactly as shown above in your reply text "
        f"so Josh can read the draft.\n"
        f"2. After the draft, END your reply with a clear approval question on its "
        f"own line — e.g.: 'Let me know if this looks good — say \"save as Gmail "
        f"draft\" to save it, or tell me what to change.' Phrase it however feels "
        f"natural, but it MUST explicitly invite Josh to approve or request edits, "
        f"and it MUST be the last thing in your reply.\n"
        f"3. STOP. Do NOT call any tool on this turn. Wait for Josh's next message.\n"
        f"4. When Josh approves (e.g. 'save as Gmail draft', 'looks good, ship it'), "
        f"the REPL will save the draft AUTOMATICALLY using the exact values above. "
        f"You do NOT call gmail_draft_email yourself — the dispatcher intercepts "
        f"the approval and handles the save deterministically (so the saved draft "
        f"is always exactly what was shown to Josh, with no parameter substitution).\n"
        f"5. If Josh requests changes, apply the changes to the BODY in your reply "
        f"text and reprint with the approval question again — do NOT call "
        f"generate_venue_email_from_template again (the template would overwrite "
        f"Josh's edits)."
    )

    pre_rendered = {
        "to": to_email,
        "cc": _OUTREACH_CC,
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

# Task 36 Phase 1 (added 2026-05-21): write-tools stripped on /next dispatch.
# These never belong on the dispatch turn — the approval interceptors in _repl
# call them directly when Josh approves a pre-rendered draft. Mirrors PR #11's
# gmail_draft_email gate and extends it with update_venue_contact for gig
# tracking. Phase 2 P2-3 generalizes the per-turn idle strip; this constant
# remains the canonical "approval-gated writes" set.
_DISPATCH_SAVE_TOOL_NAMES = frozenset({
    "gmail_draft_email",
    "update_venue_contact",
})

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


def _strip_dispatch_saves(tools: list) -> list:
    """Remove all approval-gated save tools (gmail_draft_email + update_venue_contact).

    Used on /next dispatch so llama physically cannot save while presenting a
    pre-rendered draft. The approval interceptors in _repl call the underlying
    handlers directly when Josh approves.
    """
    return [t for t in tools if t.name not in _DISPATCH_SAVE_TOOL_NAMES]


# Task 36 Phase 2 P2-3 (added 2026-05-21): write tools stripped at the per-turn
# level whenever there is no active pre-rendered dispatch state. In idle
# conversation llama can read but cannot mutate Josh's data — period. That
# alone would have prevented the 2026-05-20 Solstice Farm Brewery destructive
# write (post-task drift that overwrote the email with a hallucinated address).
# remember_fact is intentionally NOT stripped — it's gemma-cli's own memory
# system and the existing tool description supports model-autonomous saves
# for cross-session facts. Drive write tools (create/update/trash/move) and
# calendar create are included because they all mutate user-visible state.
_IDLE_WRITE_TOOL_NAMES = frozenset({
    "gmail_draft_email",
    "update_venue_contact",
    "drive_create_text_file",
    "drive_update_text_file",
    "drive_trash_file",
    "drive_move_file",
    "calendar_create_event",
})


def _strip_idle_writes(tools: list) -> list:
    """Per-turn idle strip: remove all write-capable tools. Used when no
    pre-rendered dispatch state is pending and the user input does not contain
    an approval phrase."""
    return [t for t in tools if t.name not in _IDLE_WRITE_TOOL_NAMES]


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
    """Map a model tag to its team role per CLAUDE.md AI TEAM STRUCTURE.
    Post-2026-05-20 swap: gemma4:26b is the Coordinator (replaced Llama 3.3 70B).
    Older gemma4:e4b (laptop) had been the Media Specialist; that variant is retired."""
    return "Coordinator"


def _repl(model: str, verbose: bool) -> None:
    name = _wrapper_name_for_model(model)
    role = _role_for_model(model)
    system_prompt = _resolve_system_prompt()
    print(f"{name} ({role} REPL — {model}). Tools: Drive, Calendar, Gmail.")
    print("Commands: /next [--force] (run next queued task; re-runs auto-switch to read-only verify mode unless --force),")
    print("          /done (remove first queued task),")
    print("          /remember <text> (append fact to your persistent memory file in Drive), /memory (show current memory),")
    print("          /reset (clear session memory), verbose (toggle tool logging),")
    print("          exit / Ctrl-D (quit).\n")
    prompt = f"{name}> "
    history: list = []
    # Tracks the first ~80 chars of the most recently /next-ed task so we can
    # warn Josh if he runs /next twice without /done in between. In-session
    # only; doesn't survive REPL restart.
    last_next_task: str | None = None
    # Holds the pre-rendered email payload (to/subject/body/...) for the most
    # recent /next outreach dispatch — set after a successful pre-render and
    # cleared on approval-save, /next, /done, or /reset. When set, the next
    # approval-phrase input triggers the dispatcher to save to Gmail directly
    # (Option B follow-through, 2026-05-18) instead of letting llama call
    # gmail_draft_email with potentially-substituted parameters.
    last_pre_rendered: dict | None = None
    # Parallel state for gig-tracking pre-rendered xlsx updates (Task 36 Phase 1,
    # 2026-05-21). Holds the args to pass to update_venue_contact when Josh
    # approves; cleared on save / /next / /done / /reset. Mirrors
    # last_pre_rendered (email) above.
    last_pre_rendered_gig_update: dict | None = None
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
            last_pre_rendered = None
            last_pre_rendered_gig_update = None
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
                # Done on the ORIGINAL task (pre-PDF-inline) so the signature is
                # stable across runs — a re-run shouldn't be misidentified just
                # because PDF extraction produced slightly different bytes.
                signature = " ".join(task.split())[:80]
                matches_last = (signature == last_next_task)
                is_rerun = matches_last and not force
                last_next_task = signature

                # Pre-extract PDF text (added 2026-05-19): llama is text-only,
                # so any PDF referenced in the task gets its text inlined here
                # before dispatch. No-op when the task has no PDF references.
                task, pdf_notices = _inline_pdf_content(task)
                for notice in pdf_notices:
                    print(notice)
                if pdf_notices:
                    print()

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
                    # Task 36 Phase 1 (2026-05-21): gig-tracking dispatcher. Only
                    # runs when outreach didn't pre-render (the two task types
                    # are mutually exclusive in practice). Extracts booking
                    # fields from the inlined PDF and pre-builds the
                    # update_venue_contact args. See _collect_gig_tracking_inputs.
                    gig_pre_rendered: dict | None = None
                    if pre_rendered is None:
                        dispatched_task, cancel_reason, gig_pre_rendered = (
                            _collect_gig_tracking_inputs(dispatched_task)
                        )
                        if cancel_reason is not None:
                            print(f"(task not dispatched — {cancel_reason}. Stays in queue; "
                                  "run /next again when ready.)")
                            last_next_task = None
                            print()
                            continue
                    # Approval-gated save tools (gmail_draft_email +
                    # update_venue_contact) stripped on /next dispatch. The user
                    # CANNOT have approved a draft on the same turn they ran
                    # /next — those belong to the next turn (after Josh
                    # reviews). See _strip_dispatch_saves docstring.
                    next_tools = _strip_dispatch_saves(ALL_TOOLS)
                    # Task 36 Phase 2 P2-2 (2026-05-21): gig-tracking tasks get
                    # max_turns=3 instead of the default 8. Today's drift
                    # (Apocalypse run) consumed ~6 of 8 turns wandering; 3
                    # forces convergence or a clean stop. Outreach keeps the
                    # default — the template tool + pre-render keep that path
                    # tight already.
                    dispatch_max_turns = 3 if gig_pre_rendered is not None else None
                    result = _run_once(
                        _NEXT_TASK_PREFIX + dispatched_task,
                        model=model,
                        verbose=verbose,
                        history=history,
                        system=system_prompt,
                        tools=next_tools,
                        max_turns=dispatch_max_turns,
                    )
                    # Runtime hook: if this was a venue-outreach email task and
                    # llama wrote email prose without calling the template tool,
                    # re-prompt once with a strong correction. Q4 70B regularly
                    # bypasses the GEMMA.md instruction to use the template tool;
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
                # Stash the pre-rendered payload for the approval interceptor
                # below. Cleared on /done, /reset, next /next, or after save.
                # Warns if a previous draft was pending (silently overwritten).
                if pre_rendered is not None:
                    if last_pre_rendered is not None:
                        print("(warning: a previous pending draft was discarded; "
                              "new outreach task's draft is now the pending one)")
                    last_pre_rendered = pre_rendered
                    # New outreach /next clears any stale gig-update pending
                    last_pre_rendered_gig_update = None
                elif gig_pre_rendered is not None:
                    if last_pre_rendered_gig_update is not None:
                        print("(warning: a previous pending gig update was discarded; "
                              "new gig-tracking task's update is now the pending one)")
                    last_pre_rendered_gig_update = gig_pre_rendered
                    # New gig /next clears any stale email pending
                    last_pre_rendered = None
                else:
                    # Non-dispatch /next clears any stale pre-render (safety)
                    last_pre_rendered = None
                    last_pre_rendered_gig_update = None
                # Task 36 Phase 2 P2-5 (2026-05-21): false COORDINATOR REPORT
                # detection. If the model emitted a COORDINATOR REPORT but a
                # pre-rendered draft is now awaiting approval, the report is
                # premature — warn Josh so he knows the draft is still pending
                # and the report is misleading. State NOT cleared (the interceptor
                # below still fires on Josh's next approval phrase).
                if (last_pre_rendered is not None
                        or last_pre_rendered_gig_update is not None) and \
                        "COORDINATOR REPORT:" in (result.final_text or ""):
                    print(
                        "\n[runtime] WARNING: model emitted COORDINATOR REPORT, but a "
                        "pre-rendered draft is still awaiting your approval. The report is "
                        "premature — the dispatcher has NOT saved anything yet. Say "
                        "'approve' to save, or describe changes."
                    )
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        if line.lower() in {"/done", "done"}:
            try:
                from gemma_cli.queue import delete_first_task

                remaining = delete_first_task(model)
                last_next_task = None
                last_pre_rendered = None
                last_pre_rendered_gig_update = None
                print(f"Removed first task. {remaining} remaining in queue.")
            except Exception as exc:
                print(f"[error] {type(exc).__name__}: {exc}")
            print()
            continue
        # Approval interceptor (Option B follow-through, 2026-05-18):
        # If Josh approves a pending pre-rendered draft, the dispatcher saves it
        # to Gmail DIRECTLY using the stored values — llama is NOT invoked on
        # this turn. Removes the parameter-hallucination risk where llama would
        # substitute a different venue/email from session memory (Mac n Bobs
        # bobby@macandbobs.com for Solstice solsticefarmbrewery@gmail.com seen
        # in the 2026-05-18 live test).
        if last_pre_rendered is not None and _has_email_draft_approval(line):
            pr = last_pre_rendered
            cc = pr.get("cc", "")
            print(f"[draft] saving to Gmail directly — TO={pr['to']}"
                  + (f", CC={cc}" if cc else "")
                  + f", SUBJECT={pr['subject']!r}")
            try:
                saved = draft_email(
                    to=pr["to"],
                    subject=pr["subject"],
                    body=pr["body"],
                    cc=cc,
                )
                print(f"[draft] saved — draft_id={saved.get('draft_id')}")
                if saved.get("note"):
                    print(f"        {saved['note']}")
                last_pre_rendered = None
            except Exception as exc:
                print(f"[draft] save failed: {type(exc).__name__}: {exc}")
                print("(pre-rendered draft kept — say 'save as Gmail draft' "
                      "again to retry, or /next to abandon)")
            print()
            continue
        # Task 36 Phase 1 (2026-05-21) approval interceptor for gig-tracking:
        # mirrors the email-draft interceptor above. When Josh approves a
        # pending pre-rendered xlsx update, the dispatcher calls
        # update_venue_contact DIRECTLY with the stored args — llama is NOT
        # invoked on this turn. Removes the parameter-hallucination /
        # destructive-write risk seen in the 2026-05-20 Solstice run.
        if last_pre_rendered_gig_update is not None and _has_email_draft_approval(line):
            gu = last_pre_rendered_gig_update
            print(f"[gig-update] saving to xlsx directly — VENUE={gu['venue_name']!r}, "
                  f"ACTION={gu['action']}")
            try:
                saved = update_venue_contact(
                    venue_name=gu["venue_name"],
                    email=gu.get("email", ""),
                    contact=gu.get("contact", ""),
                    phone=gu.get("phone", ""),
                    location=gu.get("location", ""),
                    notes=gu.get("notes", ""),
                )
                if saved.get("updated"):
                    print(f"[gig-update] saved — {saved.get('action')} at row "
                          f"{saved.get('row')}")
                    if saved.get("note"):
                        print(f"            {saved['note']}")
                    last_pre_rendered_gig_update = None
                else:
                    print(f"[gig-update] save failed: {saved.get('error')}")
                    print("(pre-rendered update kept — say 'approve' again to retry, "
                          "or /next to abandon)")
            except Exception as exc:
                print(f"[gig-update] save failed: {type(exc).__name__}: {exc}")
                print("(pre-rendered update kept — say 'approve' again to retry, "
                      "or /next to abandon)")
            print()
            continue
        try:
            # Smalltalk gate: strip tool schemas for clear conversational openers
            # so the model can't fire drive_list_files({}) on "hi". See _is_smalltalk
            # docstring for rationale.
            #
            # Task 36 Phase 2 P2-3 (2026-05-21): per-turn idle write-tool gate.
            # In idle conversation (no pending dispatch state), strip ALL write
            # tools so llama can read but not mutate Josh's data. This is the
            # framework-level defense that would have prevented the 2026-05-20
            # Solstice destructive write. The interceptors above handle the
            # approval-and-dispatch path; this branch is only reached when no
            # interceptor fired (no pending state, OR pending state without an
            # approval phrase in the input).
            if _is_smalltalk(line):
                turn_tools: list | None = []
            else:
                turn_tools = _strip_idle_writes(ALL_TOOLS)
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
