#!/usr/bin/env bash
# install-agy-config.sh — symlink Antigravity's mcp_config.json to the master copy in web-jam-tools (web-jam-tools#604).
#
# Symlinks ~/.gemini/config/mcp_config.json -> <repo>/agy/config/mcp_config.json.
# Idempotent: an already-correct symlink is left alone. An existing REAL file is
# backed up to ~/.gemini/config/mcp_config.json.bak-<stamp>; if the master copy in the repo
# does not exist yet, it is copied into the repo first so nothing is lost.
#
# Refuses to install (and exits non-zero) if the mastered file contains any
# credential-shaped literal, using hooks/lib/detect_credential_literal.ts.
#
# Usage: scripts/install-agy-config.sh [--mcp-config-path PATH]
#   --mcp-config-path PATH   Install symlink at PATH instead of
#                             $HOME/.gemini/config/mcp_config.json (also
#                             settable via AGY_MCP_CONFIG_PATH). For testing
#                             without touching the real config.
#   --mcp-src-path PATH      Source master config at PATH instead of
#                             <repo>/agy/config/mcp_config.json (also
#                             settable via AGY_MCP_SRC_CONFIG).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [ -n "${AGY_MCP_SRC_CONFIG:-}" ]; then
  SRC_CONFIG="$AGY_MCP_SRC_CONFIG"
else
  SRC_CONFIG="$REPO_DIR/agy/config/mcp_config.json"
fi

if [ -n "${AGY_MCP_CONFIG_PATH:-}" ]; then
  DEST_CONFIG="$AGY_MCP_CONFIG_PATH"
else
  DEST_CONFIG="$HOME/.gemini/config/mcp_config.json"
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --mcp-config-path)
      DEST_CONFIG="$2"
      shift 2
      ;;
    --mcp-src-path)
      SRC_CONFIG="$2"
      shift 2
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# If a real dest file exists, preserve its contents in the master repo copy
if [ -f "$DEST_CONFIG" ] && [ ! -L "$DEST_CONFIG" ]; then
  if [ ! -e "$SRC_CONFIG" ]; then
    mkdir -p "$(dirname "$SRC_CONFIG")"
    cp -p "$DEST_CONFIG" "$SRC_CONFIG"
  else
    # Reconcile any servers or top-level keys in DEST_CONFIG not already in SRC_CONFIG
    deno eval '
      const destPath = Deno.args[0];
      const srcPath = Deno.args[1];
      try {
        const destRaw = Deno.readTextFileSync(destPath);
        const destJson = JSON.parse(destRaw);
        const srcRaw = Deno.readTextFileSync(srcPath);
        const srcJson = JSON.parse(srcRaw);
        let modified = false;

        if (destJson && typeof destJson === "object" && srcJson && typeof srcJson === "object") {
          if (destJson.mcpServers && typeof destJson.mcpServers === "object") {
            if (!srcJson.mcpServers || typeof srcJson.mcpServers !== "object") {
              srcJson.mcpServers = {};
              modified = true;
            }
            for (const [key, val] of Object.entries(destJson.mcpServers)) {
              if (!(key in srcJson.mcpServers)) {
                srcJson.mcpServers[key] = val;
                modified = true;
              }
            }
          }
          for (const [key, val] of Object.entries(destJson)) {
            if (key !== "mcpServers" && !(key in srcJson)) {
              srcJson[key] = val;
              modified = true;
            }
          }
        }
        if (modified) {
          Deno.writeTextFileSync(srcPath, JSON.stringify(srcJson, null, 2) + "\n");
        }
      } catch {
        // If parsing fails, let backup preservation handle it
      }
    ' "$DEST_CONFIG" "$SRC_CONFIG"
  fi
fi

if [ ! -f "$SRC_CONFIG" ]; then
  echo "error: master config not found at $SRC_CONFIG" >&2
  exit 1
fi

# Verify master config contains no credential-shaped literals
MATCH=$(CMD_FOR_PY="$(cat "$SRC_CONFIG")" deno run --allow-env "$REPO_DIR/hooks/lib/detect_credential_literal.ts" 2>/dev/null || true)
if [ -n "$MATCH" ]; then
  echo "error: $SRC_CONFIG contains a credential-shaped literal ($MATCH)" >&2
  echo "Refusing to install symlink. No entry may store a secret; tokens must be referenced from the environment at launch." >&2
  exit 1
fi

# Ensure destination directory exists
mkdir -p "$(dirname "$DEST_CONFIG")"

# Already the correct symlink → nothing to do.
if [ -L "$DEST_CONFIG" ] && [ "$(readlink -f "$DEST_CONFIG")" = "$(readlink -f "$SRC_CONFIG")" ]; then
  echo "agy: mcp_config.json: ok (already linked)"
  exit 0
fi

if [ -e "$DEST_CONFIG" ] || [ -L "$DEST_CONFIG" ]; then
  mv "$DEST_CONFIG" "$DEST_CONFIG.bak-$STAMP"
  ln -s "$SRC_CONFIG" "$DEST_CONFIG"
  echo "agy: mcp_config.json: linked (previous version backed up to $(basename "$DEST_CONFIG").bak-$STAMP)"
else
  ln -s "$SRC_CONFIG" "$DEST_CONFIG"
  echo "agy: mcp_config.json: linked (new)"
fi
