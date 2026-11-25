#!/usr/bin/env bash
# ==============================================================================
# hooks/business-deadline-reminder.sh — Claude Code SessionStart deadline reminder
#
# Reads the private Web Jam LLC deadline list and emits a SessionStart JSON
# systemMessage when any deadline is due within its warning window (default 30
# days) or overdue and unpaid.
#
# Surfaces:
#   - Claude Code: registered under SessionStart in scripts/install-hooks.sh.
#   - agy: not registered; agy does not run start-of-session hooks.
#
# Environment variables:
#   - BUSINESS_DEADLINES_PATH (or WEB_JAM_LLC_DEADLINES_PATH): path to the deadlines
#     markdown list. Defaults to:
#     $HOME/Dropbox/web-jam-llms/songwriting/web-jam-llc-deadlines.md
#   - BUSINESS_DEADLINES_NOW: optional ISO date string (YYYY-MM-DD) overriding the
#     current date for deterministic testing.
#
# Guard outcomes:
#   - Due within warning window (default 30 days) and unpaid -> shown
#   - Due today and unpaid -> shown
#   - Overdue and unpaid -> shown
#   - Due in > warning window (e.g. 31 days) -> silent (exits 0, no output)
#   - Overdue and paid -> silent (exits 0, no output)
#   - List file missing or unreadable -> silent (exits 0, no output)
#   - Malformed entry -> named in output; other valid entries still shown
#
# ------------------------------------------------------------------------------
# Deadlines List Entry Format Specification:
#
# The file (~/Dropbox/web-jam-llms/songwriting/web-jam-llc-deadlines.md) is a
# Markdown document containing one or more business deadlines.
#
# Each entry specifies:
#   1. What is due (Item): name or description of the obligation
#   2. When it is due (Due Date): ISO date YYYY-MM-DD
#   3. The amount (Amount): dollar amount or fee description (e.g. "$50.00")
#   4. Where it is paid (Where Paid): payment URL, portal, or instructions
#   5. How many days ahead to warn (Warn Days): integer days (default: 30)
#   6. Date of last payment (Last Paid Date): ISO date YYYY-MM-DD, or '-' / empty
#   7. Confirmation number (Confirmation): confirmation code, or '-' / empty
#   8. Paid through cycle (Paid Through): ISO date YYYY-MM-DD or year YYYY (optional)
#
# Table format (primary):
#   | Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation | Paid Through |
#   |---|---|---|---|---|---|---|---|
#   | Virginia SCC Annual Registration Fee | 2027-01-31 | $50.00 | https://cis.scc.virginia.gov | 30 | 2026-01-20 | 1701531000 | 2026-01-31 |
#   | City of Salem Business License | 2027-03-01 | TBD | City of Salem Commissioner of Revenue | 30 | - | - | - |
#
# Block format (alternative):
#   ## Virginia SCC Annual Registration Fee
#   - Due: 2027-01-31
#   - Amount: $50.00
#   - Where: https://cis.scc.virginia.gov
#   - Warn: 30
#   - Last Paid: 2026-01-20
#   - Confirmation: 1701531000
#   - Paid Through: 2026-01-31
#
#   Block entries may also be written naturally (headings ##, ### or ####):
#   ## Virginia SCC Annual Registration Fee
#   - **Due:** 2028-01-31 (the last day of January, the LLC's anniversary month)
#   - **Warn:** 30 days ahead
#   - **Paid through:** 2027 (the 2025-01-31 payment covered 2025, 2026 and 2027)
#   - **Last payment:** 2025-01-31. Receipt saved in Correspondence.
#
#   - Key labels may be wrapped in * or _, with the colon inside (**Due:**) or
#     outside (**Due**:). "Last payment" is read like "Last paid".
#   - Date fields (Due, Due date, When, Last paid, Last paid date, Last payment,
#     Paid) take a leading YYYY-MM-DD, optionally followed by whitespace,
#     . , ; — - or a parenthetical note.
#   - Paid through (Paid cycle, Paid for) takes a leading YYYY-MM-DD or YYYY,
#     with the same optional trailing note.
#   - Warn (Warn days) takes a non-negative integer, optionally followed by
#     day, days, days ahead or days before.
#
#   Any entry with a missing or invalid due date, an invalid warn value, an
#   invalid last-paid date or an invalid paid-through value is named as
#   malformed; other valid entries are still evaluated.
#
# Cycle and payment association:
#   An obligation is marked paid (ending the reminder) if:
#     1. An explicit Paid Through date/year is specified and covers the current
#        due cycle (Paid Through >= Due Date, or matching year).
#     2. Or when Paid Through is omitted, Last Paid Date is after the prior
#        cycle's due date (i.e. paid for the current cycle, whether on-time, late,
#        or months in advance).
#   A payment on or before the prior cycle's due date belongs to the previous
#   cycle and does not suppress the upcoming reminder.
# ==============================================================================
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
"$HOOK_DIR/lib/run_hook.sh" --check-only >/dev/null 2>&1 || true

exec deno run --allow-read --allow-env "$HOOK_DIR/lib/check_business_deadline_reminder.ts" "$@"
