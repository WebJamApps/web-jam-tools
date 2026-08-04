#!/usr/bin/env bash
# PreToolUse guard (Bash|Edit|Write): block attempts to export or store
# registered human-only credentials (from hooks/human-only-credentials.yaml).
# Exit 2 = block (stderr is shown to the model).
set -euo pipefail

input=$(cat)

HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
printf '%s' "$input" | deno run --allow-env --allow-read "$HOOK_DIR/lib/detect_human_only_credentials.ts"
