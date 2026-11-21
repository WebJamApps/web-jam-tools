#!/usr/bin/env bash
# cap-concurrent-subagents.sh — web-jam-tools#708
#
# PreToolUse hook on the `Agent` tool (Claude Code only). At most two Anthropic-billed subagents run
# at once: a launch while two are running is refused and written to the session's durable queue, a
# launch with a slot free is admitted. An explicit `fable` launch, and a fork or other launch that
# would inherit Fable from a Fable session, is refused and never queued. An explicit or inherited
# Opus coding helper takes one slot like any other helper.
#
# Design: ~/Dropbox/web-jam-llms/AI_Misbehaves/delegation-gate-design.md (revision 1.3.0),
# "Subagents and the work queue" and "Opus coding and Josh’s choice of Fable".
#
# Workflow guard: when hooks/lib/check_agent_concurrency.ts cannot run, or cannot read the session
# id, the running-subagent list or the session model, the launch is allowed with a note. The
# workflow off-switch (deno task workflow-switch --guard cap-concurrent-subagents) releases it.
#
# agy and Codex do not register this hook: a helper they start is not an Anthropic-billed subagent.
set -euo pipefail

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
CHECK_LIB="$HOOK_DIR/lib/check_agent_concurrency.ts"

exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name cap-concurrent-subagents \
  --allow-with-note "Subagent cap: the cap checker could not run; the launch was allowed by workflow default." \
  deno run --no-config --allow-read --allow-write --allow-env "$CHECK_LIB" check
