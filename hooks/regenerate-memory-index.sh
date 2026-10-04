#!/usr/bin/env bash
# PostToolUse hook: regenerate MEMORY.md on any write into the memory folder
# (web-jam-tools#1236, Token Savings design).
#
# Three outcomes:
# 1. Path inside $HOME/.claude/projects/-home-joshua/memory: regenerate index.
# 2. Path outside memory folder or no file_path: exit 0 (no action).
# 3. Generator cannot run or exits non-zero: proceed (exit 0) and print one warning line.
set -euo pipefail

input=$(cat)

if [ -z "$input" ]; then
  exit 0
fi

file_path=$(printf '%s' "$input" | jq -r '(.tool_input.file_path // .tool_input.filePath // empty)' 2>/dev/null) || true
if [ -z "$file_path" ]; then
  exit 0
fi

payload_cwd=$(printf '%s' "$input" | jq -r '(.cwd // empty)' 2>/dev/null) || true

HOME_DIR="${HOME:-/home/joshua}"

# Normalize home references (~ and /home/joshua) to $HOME_DIR
if [[ "$file_path" == "~/"* ]]; then
  file_path="$HOME_DIR/${file_path#\~/}"
elif [[ "$file_path" == "~" ]]; then
  file_path="$HOME_DIR"
elif [[ "$file_path" == "/home/joshua/"* ]]; then
  file_path="$HOME_DIR/${file_path#/home/joshua/}"
elif [[ "$file_path" == "/home/joshua" ]]; then
  file_path="$HOME_DIR"
fi

if [[ "$file_path" != /* ]]; then
  if [[ "$payload_cwd" == "~/"* ]]; then
    payload_cwd="$HOME_DIR/${payload_cwd#\~/}"
  elif [[ "$payload_cwd" == "~" ]]; then
    payload_cwd="$HOME_DIR"
  elif [[ "$payload_cwd" == "/home/joshua/"* ]]; then
    payload_cwd="$HOME_DIR/${payload_cwd#/home/joshua/}"
  elif [[ "$payload_cwd" == "/home/joshua" ]]; then
    payload_cwd="$HOME_DIR"
  fi
  base_dir="${payload_cwd:-$(pwd)}"
  file_path="$base_dir/$file_path"
fi

resolved_path=$(realpath -m "$file_path" 2>/dev/null || echo "$file_path")
target_dir="$HOME_DIR/.claude/projects/-home-joshua/memory"
target_dir_resolved=$(realpath -m "$target_dir" 2>/dev/null || echo "$target_dir")

if [[ "$resolved_path" != "$target_dir_resolved" ]] && [[ "$resolved_path" != "$target_dir_resolved/"* ]]; then
  exit 0
fi

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
REPO_DIR="$(cd "$HOOK_DIR/.." && pwd)"
CLI_TS="$REPO_DIR/src/memory-index/cli.ts"

if [ ! -f "$CLI_TS" ]; then
  echo "warning: failed to regenerate memory index" >&2
  exit 0
fi

if ! deno run --allow-read --allow-write --allow-env "$CLI_TS" --dir "$target_dir_resolved" >/dev/null 2>&1; then
  echo "warning: failed to regenerate memory index" >&2
  exit 0
fi

exit 0
