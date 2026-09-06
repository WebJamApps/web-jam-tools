#!/usr/bin/env bash
# block-agy-gmail-send-delete.sh — unconditional PreToolUse deny for
# send_email / delete_email / batch_delete_emails on the Antigravity (Flash)
# surface (web-jam-tools#432 scope item 3).
#
# Registered ONLY on the agy surface, wrapped by hooks/agy-hook-shim.sh, with
# a matcher restricted to those three raw MCP tool names (agy exposes Gmail
# MCP tool names unprefixed — no `mcp__gmail__` prefix, that convention is
# Claude Code-specific). Because the matcher already scopes this hook to
# exactly those three verbs, the hook itself denies unconditionally — no
# further inspection of the payload is needed. Read, label, and archive
# tooling (search_emails, read_email, list_email_labels, modify_email, ...)
# are NOT matched and stay available.
#
# This is independent of hooks/agy-model-guard.sh: even once a session is
# confirmed on an allowed Flash model, sending/deleting mail stays blocked —
# Flash never gets outbound mail identity or delete capability on Josh's
# personal inbox (issue non-goals).
set -euo pipefail

cat >/dev/null || true

echo "BLOCKED (agy gmail send/delete fence): sending or deleting Gmail messages is not permitted on the Antigravity (Flash) surface." >&2
echo "Read, label, and archive tooling remain available. Sending/deleting requires Claude Code's draft-only Gmail policy, or Josh directly." >&2
echo "(web-jam-tools#432 — Flash never gets outbound mail identity or delete capability)" >&2
exit 2
