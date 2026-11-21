#!/usr/bin/env bash
# track-subagent-start.sh — web-jam-tools#708
#
# SubagentStart hook (Claude Code only). Records the started subagent in the session's
# running-subagent list that hooks/cap-concurrent-subagents.sh counts: the slot reserved when the
# launch was admitted becomes a running entry. An entry whose subagent transcript has been silent
# for 30 minutes without a Stop event is dropped, so a helper that crashed never blocks a launch.
# The list is shared with the mid-turn message queue (web-jam-tools#1065).
#
# Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0),
# "Subagents and the work queue".
#
# Workflow guard: an unreadable session id or list is reported in a systemMessage and nothing is
# recorded. The workflow off-switch (guard name track-subagent-start) skips recording.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
CHECK_LIB="$HOOK_DIR/lib/check_agent_concurrency.ts"

exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name track-subagent-start --event Stop \
  --allow-with-note "track-subagent-start: the tracker could not run; the started subagent was not recorded." \
  deno run --no-config --allow-read --allow-write --allow-env "$CHECK_LIB" start
