#!/usr/bin/env bash
# agy-only Gmail safety adapter. Classification is shared with future surface adapters.
# Installed via scripts/install-hooks.sh and agy-hook-shim.sh, never Claude settings.json.
# No live agy ask prompt has been proven: Trash refuses until that proof exists.
# Safety guards never consult the workflow off-switch.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
status=0
result=$("$HOOK_DIR/lib/run_hook.sh" --group safety --name block-agy-gmail-send-delete deno run --no-config "$HOOK_DIR/lib/check_gmail_write.ts" 2>/dev/null) || status=$?
if [ "$status" -ne 0 ]; then
  echo "BLOCKED (agy Gmail safety fence): classifier unavailable — refusing unreadable safety input. Ask Josh to repair the classifier." >&2
  exit 2
fi
case "$result" in
  allow|unrelated) exit 0 ;;
  trash)
    echo "BLOCKED (agy Gmail safety fence): moving mail to Trash requires a real permission prompt; agy's prompt is unverified, so this call is refused. Ask Josh to use a surface with a verified Trash approval prompt." >&2
    ;;
  *)
    echo "BLOCKED (agy Gmail safety fence): protected send/deletion or unclassifiable safety input. Stop and report this refusal to Josh; do not retry the action through another route." >&2
    ;;
esac
exit 2
