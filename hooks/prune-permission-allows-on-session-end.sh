#!/usr/bin/env bash
# SessionEnd: prune offending local permission allow rules on session end (web-jam-tools#818).
#
# Behavior:
#   - Target files absent or clean -> left unmodified, exits 0.
#   - Offending rules detected -> pruned in-place, backed up, exits 0.
#   - The prune tool's report is always printed to stdout (not silent), in
#     both cases above.
#   - Backup rotation (web-jam-tools#934): after the run, for every target
#     the prune tool's own report names via a "File: <path>" line, sibling
#     backups matching exactly "<path>.bak-*" are rotated, keeping only the
#     PRUNE_BACKUP_RETAIN newest by mtime (default 10; a non-positive-integer
#     value falls back to the default) and deleting the rest. The target list
#     is parsed from that output, never hardcoded, so it can never drift from
#     getDefaultTargetFiles() in prune.ts; if the report format ever changes,
#     parsing finds nothing and rotation safely does nothing. Nothing outside
#     a target's own directory, and nothing but its ".bak-*" siblings, is
#     ever touched.
#   - Never blocks, hangs, or fails session teardown (always exits 0).
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

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

rotate_backups() {
  local target="$1"
  local retain="${PRUNE_BACKUP_RETAIN:-}"
  if ! [[ "$retain" =~ ^[1-9][0-9]*$ ]]; then
    retain=10
  fi

  local dir base
  dir="$(dirname -- "$target")"
  base="$(basename -- "$target")"
  [ -d "$dir" ] || return 0

  local files=()
  local f
  for f in "$dir/$base".bak-*; do
    [ -f "$f" ] && files+=("$f")
  done

  local count="${#files[@]}"
  [ "$count" -gt "$retain" ] || return 0

  local ranked
  ranked="$(
    for f in "${files[@]}"; do
      mtime="$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null || echo 0)"
      printf '%s\t%s\n' "$mtime" "$f"
    done | sort -n -k1,1
  )"

  local to_delete=$((count - retain))
  local i=0
  while IFS=$'\t' read -r _ path; do
    [ -z "${path:-}" ] && continue
    if [ "$i" -lt "$to_delete" ]; then
      rm -f -- "$path"
    fi
    i=$((i + 1))
  done <<<"$ranked"

  return 0
}

set +e
PRUNE_OUTPUT="$("$DENO_BIN" run --allow-read --allow-write --allow-env "$HOOK_DIR/../src/prune-local-permission-allows/cli.ts" --apply "$@")"
set -e

if [ -n "$PRUNE_OUTPUT" ]; then
  printf '%s\n' "$PRUNE_OUTPUT"
fi

while IFS= read -r line; do
  case "$line" in
  "File: "*)
    rotate_backups "${line#File: }" || true
    ;;
  esac
done <<<"$PRUNE_OUTPUT"

exit 0
