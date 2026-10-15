#!/usr/bin/env bash
# probe-agy-tools.sh — shell wrapper around scripts/probe-agy-tools.ts (web-jam-tools#1055).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DENO_BIN="${DENO_BIN:-}"
if [ -z "$DENO_BIN" ]; then
  if command -v deno >/dev/null 2>&1; then
    DENO_BIN="deno"
  elif [ -x "$HOME/.deno/bin/deno" ]; then
    DENO_BIN="$HOME/.deno/bin/deno"
  elif [ -x "/usr/local/bin/deno" ]; then
    DENO_BIN="/usr/local/bin/deno"
  else
    DENO_BIN="deno"
  fi
fi

# Match the CLI's log selection before granting access. Resolve the environment fallback here
# and pass it explicitly, so the Deno process needs no environment permission.
LOG_PATH="${AGY_HOOK_RECORD_PATH:-/tmp/agy-hook-invocations.jsonl}"
probe_args=("$@")
for ((i = 0; i < ${#probe_args[@]}; i++)); do
  case "${probe_args[i]}" in
    --log|-l)
      LOG_PATH="${probe_args[i + 1]:-}"
      i=$((i + 1))
      ;;
    --log=*|-l=*) LOG_PATH="${probe_args[i]#*=}" ;;
    -l?*) LOG_PATH="${probe_args[i]:2}" ;;
    --) break ;;
  esac
done

read_paths=("$REPO_DIR/scripts/probe-agy-tools.ts" "$REPO_DIR/deno.json")
if [ -n "$LOG_PATH" ]; then
  read_paths+=("$LOG_PATH")
  if command -v realpath >/dev/null 2>&1; then
    canonical_log="$(realpath -m -- "$LOG_PATH" 2>/dev/null || true)"
    if [ -n "$canonical_log" ] && [ "$canonical_log" != "$LOG_PATH" ]; then
      read_paths+=("$canonical_log")
    fi
  fi
fi

ALLOW_READ=""
for target in "${read_paths[@]}"; do
  ALLOW_READ+="${ALLOW_READ:+,}${target//,/,,}"
done

exec "$DENO_BIN" run --allow-read="$ALLOW_READ" \
  "$REPO_DIR/scripts/probe-agy-tools.ts" --log "$LOG_PATH" "$@"
