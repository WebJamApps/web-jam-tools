#!/usr/bin/env bash
# scripts/sheet-music-check-lyrics.sh — scoped launcher for lyric verification (web-jam-tools#1013)
#
# Inspects CLI arguments, resolves required input file paths, allocates an isolated temporary
# output directory for OCR rendering, and invokes Deno with strictly scoped permissions:
#   --allow-read=<module files, temporary output directory, resolved input files, dictionary>
#   --allow-write=<temporary output directory>
#   --allow-run=pdftoppm,tesseract
#
# AGENTS.md Rule 21 compliant: zero bare --allow-read or --allow-write permissions.
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

MODULE_READ_DIR="$REPO_DIR/src/sheet-music"
CONFIG_FILE="$REPO_DIR/deno.json"

is_help=false
custom_temp_dir=""
dict_specified=false
read_targets=()
passthrough_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      is_help=true
      passthrough_args+=("$1")
      shift
      ;;
    -s|--song|-i|--input)
      if [[ $# -gt 1 ]]; then
        read_targets+=("$2")
        passthrough_args+=("$1" "$2")
        shift 2
      else
        passthrough_args+=("$1")
        shift
      fi
      ;;
    --song=*|--input=*)
      read_targets+=("${1#*=}")
      passthrough_args+=("$1")
      shift
      ;;
    -s=*|-i=*)
      read_targets+=("${1#*=}")
      passthrough_args+=("$1")
      shift
      ;;
    -j|--json)
      if [[ $# -gt 1 ]]; then
        passthrough_args+=("$1" "$2")
        shift 2
      else
        passthrough_args+=("$1")
        shift
      fi
      ;;
    --json=*|-j=*)
      passthrough_args+=("$1")
      shift
      ;;
    -p|--pdf|--scan)
      if [[ $# -gt 1 ]]; then
        read_targets+=("$2")
        passthrough_args+=("$1" "$2")
        shift 2
      else
        passthrough_args+=("$1")
        shift
      fi
      ;;
    --pdf=*|--scan=*)
      read_targets+=("${1#*=}")
      passthrough_args+=("$1")
      shift
      ;;
    -p=*)
      read_targets+=("${1#*=}")
      passthrough_args+=("$1")
      shift
      ;;
    --image)
      if [[ $# -gt 1 ]]; then
        read_targets+=("$2")
        passthrough_args+=("$1" "$2")
        shift 2
      else
        passthrough_args+=("$1")
        shift
      fi
      ;;
    --image=*)
      read_targets+=("${1#*=}")
      passthrough_args+=("$1")
      shift
      ;;
    -v|--vision)
      if [[ $# -gt 1 ]]; then
        read_targets+=("$2")
        passthrough_args+=("$1" "$2")
        shift 2
      else
        passthrough_args+=("$1")
        shift
      fi
      ;;
    --vision=*|-v=*)
      read_targets+=("${1#*=}")
      passthrough_args+=("$1")
      shift
      ;;
    -d|--dict)
      if [[ $# -gt 1 ]]; then
        read_targets+=("$2")
        dict_specified=true
        passthrough_args+=("$1" "$2")
        shift 2
      else
        passthrough_args+=("$1")
        shift
      fi
      ;;
    --dict=*|-d=*)
      read_targets+=("${1#*=}")
      dict_specified=true
      passthrough_args+=("$1")
      shift
      ;;
    --temp-dir)
      if [[ $# -gt 1 ]]; then
        custom_temp_dir="$2"
        passthrough_args+=("$1" "$2")
        shift 2
      else
        passthrough_args+=("$1")
        shift
      fi
      ;;
    --temp-dir=*)
      custom_temp_dir="${1#*=}"
      passthrough_args+=("$1")
      shift
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        read_targets+=("$1")
        passthrough_args+=("$1")
        shift
      done
      break
      ;;
    *)
      if [[ "$1" != -* ]]; then
        read_targets+=("$1")
      fi
      passthrough_args+=("$1")
      shift
      ;;
  esac
done

if [ "$is_help" = true ]; then
  exec "$DENO_BIN" run \
    --allow-read="${MODULE_READ_DIR//,/,,},${CONFIG_FILE//,/,,}" \
    "$REPO_DIR/src/sheet-music/lyric_check.ts" "${passthrough_args[@]}"
fi

created_temp=false
if [ -n "$custom_temp_dir" ]; then
  TEMP_DIR="$custom_temp_dir"
  mkdir -p "$TEMP_DIR"
else
  TEMP_DIR="$(mktemp -d -t lyric-check-XXXXXX 2>/dev/null || mktemp -d /tmp/lyric-check-XXXXXX)"
  created_temp=true
  passthrough_args+=("--temp-dir" "$TEMP_DIR")
fi

cleanup() {
  if [ "$created_temp" = true ] && [ -d "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

read_paths=("$MODULE_READ_DIR" "$CONFIG_FILE" "$TEMP_DIR")

if [ "$dict_specified" = false ]; then
  read_paths+=("/usr/share/dict/american-english" "/usr/share/dict")
fi

for target in "${read_targets[@]}"; do
  [ -z "$target" ] && continue
  read_paths+=("$target")
  if command -v realpath >/dev/null 2>&1; then
    canon="$(realpath -m "$target" 2>/dev/null || true)"
    if [ -n "$canon" ] && [ "$canon" != "$target" ]; then
      read_paths+=("$canon")
    fi
  fi
done

declare -A seen_paths
unique_paths=()
for p in "${read_paths[@]}"; do
  if [ -z "${seen_paths["$p"]:-}" ]; then
    seen_paths["$p"]=1
    # Deno separates permission paths with commas; doubled commas encode a literal comma.
    unique_paths+=("${p//,/,,}")
  fi
done

IFS=','
ALLOW_READ="${unique_paths[*]}"
unset IFS

set +e
"$DENO_BIN" run \
  --allow-read="$ALLOW_READ" \
  --allow-write="${TEMP_DIR//,/,,}" \
  --allow-run=pdftoppm,tesseract \
  "$REPO_DIR/src/sheet-music/lyric_check.ts" \
  "${passthrough_args[@]}"
EXIT_CODE=$?
set -e

exit "$EXIT_CODE"
