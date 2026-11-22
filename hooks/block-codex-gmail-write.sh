#!/usr/bin/env bash
# Codex-only PreToolUse Gmail safety fence. The shared classifier owns the policy.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
exec "$HOOK_DIR/lib/run_hook.sh" --group safety --name block-codex-gmail-write \
  --event PreToolUse deno run --no-config "$HOOK_DIR/lib/check_codex_gmail_write.ts"
