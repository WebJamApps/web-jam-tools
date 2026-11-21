#!/usr/bin/env bash
# track-subagent-stop.sh — web-jam-tools#708
#
# SubagentStop hook (Claude Code only). Removes the finished subagent from the session's
# running-subagent list, which frees its slot for the next launch that hooks/cap-concurrent-subagents.sh
# counts. The list is shared with the mid-turn message queue (web-jam-tools#1065).
#
# Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0),
# "Subagents and the work queue".
#
# Workflow guard: an unreadable session id or list is reported in a systemMessage and the entry is
# left to expire after 30 minutes of transcript silence. The workflow off-switch (guard name
# track-subagent-stop) skips recording.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
CHECK_LIB="$HOOK_DIR/lib/check_agent_concurrency.ts"

exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name track-subagent-stop --event Stop \
  --allow-with-note "track-subagent-stop: the tracker could not run; the finished subagent's entry was left to expire." \
  deno run --no-config --allow-read --allow-write --allow-env "$CHECK_LIB" stop
