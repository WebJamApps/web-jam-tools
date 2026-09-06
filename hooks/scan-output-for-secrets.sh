#!/usr/bin/env bash
# PostToolUse guard (Bash): scan tool OUTPUT for credential-shaped strings and
# raise the alarm immediately (web-jam-tools#272 Layer 2).
#
# WHY THIS EXISTS, AND WHAT IT CANNOT DO
# --------------------------------------
# The PreToolUse guards are blocklists: they enumerate dangerous COMMANDS
# (rclone/heroku/env/git config), dangerous FILE PATHS, and — since #272 — the
# expansion of credential-NAMED variables into an output command. Three
# credentials still leaked in two days, each in a shape nobody had enumerated:
#
#   2026-07-25  agy settings.json dumped   — file not on the path list
#   2026-07-25  tail -15 ~/.bashrc         — .bashrc not on the path list
#   2026-07-26  echo "${TOK:-...}"         — no rule of that shape existed
#
# A blocklist cannot cover the space of ways a secret reaches stdout. This hook
# attacks the problem from the other side: it does not care HOW the value got
# printed, only that something credential-SHAPED did.
#
# HONEST LIMITATION: a PostToolUse hook runs after the tool has produced its
# output, so it cannot retroactively remove the value from a transcript that
# already contains it. What it buys is IMMEDIATE, LOUD detection — the leak is
# announced in the same turn, naming the credential type and the rotation step,
# instead of depending on someone noticing. Prevention remains PreToolUse's job.
#
# This hook NEVER prints the matched value — only its shape name.
set -euo pipefail

input=$(cat)

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)

# Scan the tool's RESPONSE/OUTPUT only — not the whole hook payload. Command
# TEXT is already covered strictly earlier, by hooks/block-secret-literals.sh
# (PreToolUse), which extracts .tool_input.command and runs this same
# detector on it BEFORE the command executes — a guard that blocks, not just
# reports. This hook's only unique job is what the tool actually OUTPUT, so
# that is all it scans; scanning the input too just misattributes a match to
# a command that never printed it (the original defect here).
#
# tool_response shape varies by tool. Prefer the known stdout/stderr fields
# (what every Bash-shaped response — native or agy-shimmed, see
# docs/agy-hooks.md — carries); fall back to the whole tool_response object
# for any other tool shape (Edit/Write/Read/...) so a structural surprise is
# still scanned, never silently skipped. If tool_response is absent entirely
# (or jq itself fails to parse the payload), fail SAFE by scanning the whole
# input rather than going blind — over-scanning is the safe direction, never
# under-scanning.
output=$(printf '%s' "$input" | jq -r '
  (.tool_response.stdout // "") as $out |
  (.tool_response.stderr // "") as $err |
  if ($out != "" or $err != "") then
    ($out + "\n" + $err)
  elif (.tool_response != null) then
    (.tool_response | tostring)
  else
    empty
  end
' 2>/dev/null) || true

if [ -z "$output" ]; then
  output="$input"
fi

match=$(CMD_FOR_PY="$output" deno run --no-config --allow-env "$HOOK_DIR/lib/detect_credential_literal.ts" 2>/dev/null) || true

if [ -n "$match" ]; then
  echo "🔴 CREDENTIAL-SHAPED LITERAL DETECTED: a $match appeared in what this command printed." >&2
  echo "Whether the value is live is unverified — this is a shape match, not a liveness check." >&2
  echo "Do this now, in this turn:" >&2
  echo "  1. Tell Josh immediately — name the credential, do not bury it." >&2
  echo "  2. Verify whether it is a real, live credential (vs. a declared test fixture)." >&2
  echo "  3. If live: revoke/rotate it at the provider, then update ~/.bashrc, any CI env var, and KeePass." >&2
  echo "  4. Do NOT re-run the command, and do NOT print the value again." >&2
  echo "(rule: never-print-files-that-hold-secrets — web-jam-tools#272)" >&2
  exit 2
fi

exit 0
