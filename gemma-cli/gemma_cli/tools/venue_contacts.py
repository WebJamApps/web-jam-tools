"""Venue contacts tools: lookup, web-derive, update against Josh's xlsx.

Three tools wired through to Josh's canonical venue contacts spreadsheet at
`~/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx` (per CLAUDE.md
"XLSX TRACKING SPREADSHEET" — the Dropbox path is the authoritative master).

  - `lookup_venue_contact(venue_name)` — find an existing row in the xlsx by
    venue name. Returns contact details (booker name, email, phone, status) or
    a not-found marker.
  - `lookup_venue_email_on_web(website_url)` — fetch the venue's website
    (homepage + /contact + /booking + /about), extract email addresses with a
    regex, return the best candidate. Used when the xlsx lookup misses.
  - `update_venue_contact(venue_name, ...)` — write contact details back to
    the xlsx. Updates an existing row if found by name, otherwise appends a new
    row. Persists immediately to disk.

The xlsx has a multi-section layout: row 1 = header row ('Name', 'Contact',
'email', 'phone #', 'type of gig', 'last played', 'comments', ...) and then
sub-headers appear at section breaks ('Current Gigs', 'Venue', etc.). Lookup
iterates ALL rows and matches on column-1 substring (case-insensitive); the
section-header rows have short generic strings that won't collide with real
venue names.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
from openpyxl import load_workbook

from gemma_cli.llm import Tool


XLSX_PATH = "/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx"

# Column indexes in the xlsx (1-based per openpyxl). Verified 2026-05-18 by
# reading the sheet headers in Sheet1 row 1: 'Name', 'Contact', 'email',
# 'phone #', 'type of gig', 'last played', 'comments', 'location', 'Status',
# 'Date called', 'Notes', 'Callback', 'Venue Name', 'Date verified', 'Phone'.
_COL_NAME = 1
_COL_CONTACT = 2
_COL_EMAIL = 3
_COL_PHONE = 4
_COL_TYPE_OF_GIG = 5
_COL_LAST_PLAYED = 6
_COL_COMMENTS = 7
_COL_LOCATION = 8
_COL_STATUS = 9
_COL_DATE_CALLED = 10
_COL_NOTES = 11
_COL_CALLBACK = 12

# Section-header rows whose col-1 values are generic words, not real venue
# names. Used to skip false matches during lookup.
_SECTION_HEADER_TOKENS = frozenset({
    "name", "venue", "current gigs", "venues to contact", "contact",
    "previously played", "future leads",
})

# Email regex — RFC-lite. Matches the common forms found on venue websites.
_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

# Common venue-website pages where booking emails tend to live. Tried in order.
_CONTACT_PATHS = ("/", "/contact", "/contact-us", "/contact/", "/booking", "/book", "/booking/", "/about", "/about-us")

# Emails we should never propose as a venue booker. Common webhost / privacy /
# generic-platform addresses that appear on many sites without being the venue.
_EMAIL_BLOCKLIST_DOMAINS = frozenset({
    "wixpress.com", "sentry.io", "godaddy.com", "wordpress.com", "squarespace.com",
    "gravatar.com", "example.com", "example.org",
})
_EMAIL_BLOCKLIST_LOCALPARTS = frozenset({
    "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster", "abuse",
    "webmaster", "privacy", "security", "support@wix",
})


def _is_section_header(name_cell: Any) -> bool:
    """True if a row's col-1 value looks like a section header rather than a venue."""
    if not isinstance(name_cell, str):
        return False
    return name_cell.strip().lower() in _SECTION_HEADER_TOKENS


def _normalize(s: Any) -> str:
    return str(s).strip().lower() if s is not None else ""


def lookup_venue_contact(venue_name: str) -> dict[str, Any]:
    """Look up a venue in the xlsx by name (case-insensitive substring match)."""
    target = venue_name.strip().lower()
    if not target:
        return {"found": False, "error": "venue_name is required."}
    try:
        wb = load_workbook(XLSX_PATH, read_only=True, data_only=True)
    except Exception as exc:
        return {"found": False, "error": f"Could not open xlsx: {type(exc).__name__}: {exc}"}
    try:
        ws = wb.active
        for row in ws.iter_rows(min_row=1, values_only=True):
            if not row:
                continue
            name = row[_COL_NAME - 1]
            if not name or _is_section_header(name):
                continue
            if target in _normalize(name):
                return {
                    "found": True,
                    "venue_name": str(name).strip(),
                    "contact": _str_or_empty(row, _COL_CONTACT),
                    "email": _str_or_empty(row, _COL_EMAIL),
                    "phone": _str_or_empty(row, _COL_PHONE) or _str_or_empty(row, 15),  # col 15 = 'Phone' fallback
                    "type_of_gig": _str_or_empty(row, _COL_TYPE_OF_GIG),
                    "last_played": _str_or_empty(row, _COL_LAST_PLAYED),
                    "comments": _str_or_empty(row, _COL_COMMENTS),
                    "location": _str_or_empty(row, _COL_LOCATION),
                    "status": _str_or_empty(row, _COL_STATUS),
                    "notes": _str_or_empty(row, _COL_NOTES),
                }
        return {
            "found": False,
            "venue_name": venue_name,
            "note": (
                f"No row in the xlsx matched '{venue_name}'. Next step: call "
                "`lookup_venue_email_on_web` with the venue's website URL, then "
                "(if a booker email is found) call `update_venue_contact` to "
                "add the venue to the xlsx for next time."
            ),
        }
    finally:
        wb.close()


def _str_or_empty(row: tuple, col_1based: int) -> str:
    """Return a stripped string for row[col-1], or empty string if None / out-of-bounds."""
    idx = col_1based - 1
    if idx < 0 or idx >= len(row):
        return ""
    val = row[idx]
    return str(val).strip() if val is not None else ""


def _is_useful_email(email: str, website_domain: str | None = None) -> bool:
    """Filter out obvious non-venue emails (webhost, noreply, etc.)."""
    email_lower = email.lower().strip()
    local, _, domain = email_lower.partition("@")
    if not domain:
        return False
    if domain in _EMAIL_BLOCKLIST_DOMAINS:
        return False
    if local in _EMAIL_BLOCKLIST_LOCALPARTS:
        return False
    if any(local.startswith(bad) for bad in ("noreply", "no-reply", "donotreply")):
        return False
    return True


def lookup_venue_email_on_web(website_url: str) -> dict[str, Any]:
    """Fetch the venue's website and extract email addresses from common contact pages."""
    url = website_url.strip()
    if not url:
        return {"found": False, "error": "website_url is required."}
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    parsed = urlparse(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    domain = parsed.netloc.lower().lstrip("www.")

    headers = {
        "User-Agent": (
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
        ),
    }
    emails_found: dict[str, str] = {}  # email -> source URL

    for path in _CONTACT_PATHS:
        candidate = urljoin(base, path)
        try:
            resp = requests.get(candidate, headers=headers, timeout=10, allow_redirects=True)
        except Exception:
            continue
        if resp.status_code != 200:
            continue
        # Search the raw HTML body + any mailto: links via BeautifulSoup.
        html = resp.text
        for match in _EMAIL_RE.findall(html):
            if match not in emails_found and _is_useful_email(match, domain):
                emails_found[match] = candidate
        try:
            soup = BeautifulSoup(html, "html.parser")
            for a in soup.select('a[href^="mailto:"]'):
                href = a.get("href", "")
                addr = href.replace("mailto:", "").split("?")[0].strip()
                if addr and _is_useful_email(addr, domain) and addr not in emails_found:
                    emails_found[addr] = candidate
        except Exception:
            pass
        if emails_found:
            break  # found at least one — stop early; no need to scrape more pages

    if not emails_found:
        return {
            "found": False,
            "website_url": url,
            "note": (
                f"No usable booker email found on {url} or its common contact "
                "pages. Ask Josh for the booker email directly."
            ),
        }
    # Prefer emails whose domain matches the venue's website domain (likeliest
    # real booker email) over generic gmail/yahoo addresses found on the page.
    sorted_emails = sorted(
        emails_found.items(),
        key=lambda kv: (0 if kv[0].split("@", 1)[1].lower() == domain else 1, kv[0]),
    )
    primary = sorted_emails[0]
    return {
        "found": True,
        "website_url": url,
        "best_email": primary[0],
        "source_page": primary[1],
        "all_emails_found": [{"email": e, "source": s} for e, s in sorted_emails],
    }


def update_venue_contact(
    venue_name: str,
    email: str = "",
    contact: str = "",
    phone: str = "",
    location: str = "",
    notes: str = "",
) -> dict[str, Any]:
    """Update or insert a venue contact row in the xlsx and save."""
    name = venue_name.strip()
    if not name:
        return {"updated": False, "error": "venue_name is required."}
    try:
        wb = load_workbook(XLSX_PATH)  # NOT read_only — we need to write.
    except Exception as exc:
        return {"updated": False, "error": f"Could not open xlsx: {type(exc).__name__}: {exc}"}
    try:
        ws = wb.active
        target = name.lower()
        existing_row = None
        for row_idx, row in enumerate(ws.iter_rows(values_only=True), start=1):
            if not row:
                continue
            cell_name = row[_COL_NAME - 1]
            if not cell_name or _is_section_header(cell_name):
                continue
            if target in _normalize(cell_name):
                existing_row = row_idx
                break

        if existing_row is not None:
            action = "updated"
            row_idx = existing_row
            if email:
                ws.cell(row=row_idx, column=_COL_EMAIL).value = email.strip()
            if contact:
                ws.cell(row=row_idx, column=_COL_CONTACT).value = contact.strip()
            if phone:
                ws.cell(row=row_idx, column=_COL_PHONE).value = phone.strip()
            if location:
                ws.cell(row=row_idx, column=_COL_LOCATION).value = location.strip()
            if notes:
                # Append rather than overwrite if notes already present.
                existing_notes = ws.cell(row=row_idx, column=_COL_NOTES).value
                merged = f"{existing_notes}; {notes.strip()}" if existing_notes else notes.strip()
                ws.cell(row=row_idx, column=_COL_NOTES).value = merged
        else:
            action = "created"
            row_idx = ws.max_row + 1
            ws.cell(row=row_idx, column=_COL_NAME).value = name
            if contact:
                ws.cell(row=row_idx, column=_COL_CONTACT).value = contact.strip()
            if email:
                ws.cell(row=row_idx, column=_COL_EMAIL).value = email.strip()
            if phone:
                ws.cell(row=row_idx, column=_COL_PHONE).value = phone.strip()
            if location:
                ws.cell(row=row_idx, column=_COL_LOCATION).value = location.strip()
            if notes:
                ws.cell(row=row_idx, column=_COL_NOTES).value = notes.strip()

        wb.save(XLSX_PATH)
        return {
            "updated": True,
            "action": action,
            "row": row_idx,
            "venue_name": name,
            "note": (
                f"Venue {action} in xlsx at row {row_idx}. The file at "
                f"{XLSX_PATH} is saved."
            ),
        }
    finally:
        wb.close()


TOOLS: list[Tool] = [
    Tool(
        name="lookup_venue_contact",
        description=(
            "Look up a venue's contact details (booker name, email, phone, status) "
            "in Josh's Gig Booking Worksheet xlsx. This is the FIRST step when you "
            "need a TO address for a venue-outreach email — check here before "
            "asking Josh or scraping the web. Returns {found: True, email: ..., "
            "...} if the venue is in the xlsx, otherwise {found: False, note: "
            "'next step is web lookup'}."
        ),
        parameters={
            "type": "object",
            "properties": {
                "venue_name": {
                    "type": "string",
                    "description": (
                        "The venue's name as it would appear in the spreadsheet "
                        "(e.g. 'Solstice Farm Brewery'). Case-insensitive "
                        "substring match — 'Solstice' alone would also match."
                    ),
                },
            },
            "required": ["venue_name"],
        },
        handler=lookup_venue_contact,
    ),
    Tool(
        name="lookup_venue_email_on_web",
        description=(
            "Fetch a venue's website and extract booker email addresses from the "
            "homepage and common contact pages (/contact, /booking, /about). Use "
            "this AFTER lookup_venue_contact returns found=False, when you have "
            "the venue's website URL from the task. Returns {found: True, "
            "best_email: 'info@venue.com', source_page: '...'} or {found: "
            "False, note: 'ask Josh'}. Filters out webhost / noreply / privacy "
            "addresses automatically."
        ),
        parameters={
            "type": "object",
            "properties": {
                "website_url": {
                    "type": "string",
                    "description": (
                        "The venue's website URL (with or without https://). "
                        "Comes from the task's VENUE DETAILS section."
                    ),
                },
            },
            "required": ["website_url"],
        },
        handler=lookup_venue_email_on_web,
    ),
    Tool(
        name="update_venue_contact",
        description=(
            "Write venue contact details to the Gig Booking Worksheet xlsx. "
            "Updates an existing row if the venue is already in the sheet, "
            "otherwise appends a new row. Use this AFTER lookup_venue_email_on_web "
            "finds a booker email for a venue that wasn't in the xlsx — saves it "
            "so next session it's a lookup hit. Returns {updated: True, action: "
            "'updated' or 'created', row: N}."
        ),
        parameters={
            "type": "object",
            "properties": {
                "venue_name": {
                    "type": "string",
                    "description": "Venue name (matches an existing row, or creates a new row if not present).",
                },
                "email": {
                    "type": "string",
                    "description": "Booker email address to save.",
                },
                "contact": {
                    "type": "string",
                    "description": "Optional: booker name.",
                },
                "phone": {
                    "type": "string",
                    "description": "Optional: phone number.",
                },
                "location": {
                    "type": "string",
                    "description": "Optional: city/area (e.g. 'Catawba, VA').",
                },
                "notes": {
                    "type": "string",
                    "description": (
                        "Optional: short note about where the email came from "
                        "(e.g. 'derived from website 2026-05-18'). Will be "
                        "appended to existing notes rather than overwriting."
                    ),
                },
            },
            "required": ["venue_name"],
        },
        handler=update_venue_contact,
    ),
]
