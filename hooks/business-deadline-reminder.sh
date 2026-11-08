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
#
# Table format (primary):
#   | Item | Due Date | Amount | Where Paid | Warn Days | Last Paid Date | Confirmation |
#   |---|---|---|---|---|---|---|
#   | Virginia SCC Annual Registration Fee | 2027-01-31 | $50.00 | https://cis.scc.virginia.gov | 30 | 2026-01-20 | 1701531000 |
#   | City of Salem Business License | 2027-03-01 | TBD | City of Salem Commissioner of Revenue | 30 | - | - |
#
# Block format (alternative):
#   ## Virginia SCC Annual Registration Fee
#   - Due: 2027-01-31
#   - Amount: $50.00
#   - Where: https://cis.scc.virginia.gov
#   - Warn: 30
#   - Last Paid: 2026-01-20
#   - Confirmation: 1701531000
#
# Recording a valid Last Paid Date (and optional confirmation number) for the
# current cycle marks the obligation as paid and ends the reminder.
# ==============================================================================
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
"$HOOK_DIR/lib/run_hook.sh" --check-only >/dev/null 2>&1 || true

exec deno run --allow-read --allow-env "$HOOK_DIR/lib/check_business_deadline_reminder.ts" "$@"
