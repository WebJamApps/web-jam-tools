#!/usr/bin/env bash
# Historical filename retained for installed links. Supplies model context only;
# never refuses by model or infers approval. The separate mail fence governs actions.
set -euo pipefail
HOOK_DIR=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
exec "$HOOK_DIR/lib/run_hook.sh" --group workflow --name haiku-only-gmail-gate \
  --allow-with-note "Gmail model note: the session's model could not be read, so this call proceeds. If this is /handle-gmails on Opus, Fable or Astra, ask Josh the cost question first." \
  deno run --config "$HOOK_DIR/../deno.json" --allow-read --allow-env --allow-run=bash "$HOOK_DIR/lib/gmail_model_note.ts"
