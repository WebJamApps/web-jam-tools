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

# Reconcile local-only entries and validate credential guard in-memory BEFORE touching disk
deno eval '
  const srcPath = Deno.args[0];
  const destPath = Deno.args[1];
  const detectLibPath = Deno.args[2];

  const { findCredentialLiteral } = await import("file://" + detectLibPath);

  let srcExists = false;
  let srcJson: Record<string, unknown> = {};
  let srcRaw = "";
  try {
    srcRaw = Deno.readTextFileSync(srcPath);
    srcJson = JSON.parse(srcRaw);
    srcExists = true;
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.error(`error: ${srcPath} is not valid JSON: ${e}`);
      Deno.exit(1);
    }
  }

  let destIsRealFile = false;
  let destJson: Record<string, unknown> = {};
  let destRaw = "";
  try {
    const lstat = Deno.lstatSync(destPath);
    if (lstat.isFile && !lstat.isSymlink) {
      destIsRealFile = true;
      destRaw = Deno.readTextFileSync(destPath);
      try {
        destJson = JSON.parse(destRaw);
      } catch {
        // Non-JSON destination file — will be preserved in .bak backup
      }
    }
  } catch {
    // destPath does not exist
  }

  if (!srcExists && !destIsRealFile) {
    console.error(`error: master config not found at ${srcPath}`);
    Deno.exit(1);
  }

  let candidateJson: Record<string, unknown> = {};
  let modified = false;

  if (!srcExists && destIsRealFile) {
    candidateJson = destJson;
    modified = true;
  } else {
    candidateJson = JSON.parse(JSON.stringify(srcJson));
    if (destIsRealFile && destJson && typeof destJson === "object") {
      if (destJson.mcpServers && typeof destJson.mcpServers === "object") {
        if (!candidateJson.mcpServers || typeof candidateJson.mcpServers !== "object") {
          candidateJson.mcpServers = {};
          modified = true;
        }
        const candidateServers = candidateJson.mcpServers as Record<string, unknown>;
        for (const [key, val] of Object.entries(destJson.mcpServers as Record<string, unknown>)) {
          if (!(key in candidateServers)) {
            candidateServers[key] = val;
            modified = true;
          }
        }
      }
      for (const [key, val] of Object.entries(destJson)) {
        if (key !== "mcpServers" && !(key in candidateJson)) {
          candidateJson[key] = val;
          modified = true;
        }
      }
    }
  }

  // Check candidate config for credential-shaped literals BEFORE writing to srcPath
  const candidateText = JSON.stringify(candidateJson, null, 2) + "\n";
  const match = findCredentialLiteral(candidateText);
  if (match) {
    console.error(`error: ${srcPath} contains a credential-shaped literal (${match})`);
    console.error("Refusing to install symlink. No entry may store a secret; tokens must be referenced from the environment at launch.");
    Deno.exit(1);
  }

  // Only update srcPath once verified clean
  if (modified) {
    const dir = srcPath.slice(0, srcPath.lastIndexOf("/"));
    if (dir) Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(srcPath, candidateText);
  }
' "$SRC_CONFIG" "$DEST_CONFIG" "$REPO_DIR/hooks/lib/detect_credential_literal.ts"

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
