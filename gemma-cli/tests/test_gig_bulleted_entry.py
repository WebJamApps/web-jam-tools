"""Regression tests for the structured bulleted-entry gig dispatcher path.

No pytest in this venv — run directly:
    .venv/bin/python -m tests.test_gig_bulleted_entry

Covers the 2026-05-28 gap: a fully-specified "Update the gig booking
spreadsheet / Add or update entry for <Venue>: - Contact/Email/Phone/Status/
Notes" task must (a) be detected as a gig task, (b) yield the venue, and
(c) collect into a pending dict with explicit_notes + contact/email/phone so
the REPL skips gemma and pre-renders the save.
"""

from __future__ import annotations

from unittest import mock

from gemma_cli import cli

TASK = """Update the gig booking spreadsheet

Add or update entry for Grandin Farmers Market:
- Contact: Connie Kenny, Food Access Manager
- Email: connie@leapforlocalfood.org
- Phone: 540.339.6531
- Status: PASSED — no music budget this year, tip jar only offered
- Notes: Warm relationship, keep on list for future years when budget available"""


def test_detection_and_venue():
    assert cli._is_email_reply_gig_task(TASK), "should detect as a gig task"
    assert cli._extract_venue_from_email_reply_task(TASK) == "Grandin Farmers Market"


def test_collector_builds_pending_and_skips_gemma():
    # Don't touch the real xlsx — pretend Grandin is a new venue.
    with mock.patch.object(cli, "lookup_venue_contact", return_value={"found": False}):
        augmented, cancel, pending = cli._collect_email_reply_inputs(TASK)

    assert cancel is None
    assert pending is not None, "should return a pending dict"
    # explicit_notes present => REPL fast path fires and gemma is NOT invoked.
    assert pending["explicit_notes"].startswith("Status: PASSED")
    assert "Warm relationship" in pending["explicit_notes"]
    assert pending["email"] == "connie@leapforlocalfood.org"
    assert pending["contact"] == "Connie Kenny, Food Access Manager"
    assert pending["phone"] == "540.339.6531"
    assert pending["venue_name"] == "Grandin Farmers Market"
    # Task body returned unchanged (no marker instructions appended) — the
    # explicit_notes path means there's no language work for gemma.
    assert augmented == TASK
    print("✓ bulleted entry collected to pending; gemma skipped")


def test_bare_contact_line_does_not_fast_path():
    """A lone contact line (no status/notes) must NOT trigger the fast path —
    there's nothing meaningful to write, so let the normal flow handle it."""
    fields = cli._extract_bulleted_gig_fields("- Contact: Someone")
    assert fields == {"contact": "Someone"}
    assert not (fields.get("status") or fields.get("notes"))
    print("✓ bare contact line correctly skips the fast path")


if __name__ == "__main__":
    test_detection_and_venue()
    test_collector_builds_pending_and_skips_gemma()
    test_bare_contact_line_does_not_fast_path()
    print("\nALL PASSED")
