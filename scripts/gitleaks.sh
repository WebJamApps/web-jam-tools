#!/usr/bin/env bash
# gitleaks.sh — web-jam-tools#658, updated web-jam-tools#1403
# Run gitleaks detect with repository configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"
GITLEAKS_IMAGE="zricethezav/gitleaks:latest"

TARGET_REPO="$ROOT"
PASSED_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      if [ $# -lt 2 ]; then
        echo "ERROR: --repo requires a directory argument" >&2
        exit 1
      fi
      TARGET_REPO="$2"
      shift 2
      ;;
    --repo=*)
      TARGET_REPO="${1#--repo=}"
      shift
      ;;
    *)
      PASSED_ARGS+=("$1")
      shift
      ;;
  esac
done

if [ ! -d "$TARGET_REPO" ]; then
  echo "ERROR: target repository directory does not exist: $TARGET_REPO" >&2
  exit 1
fi
TARGET_REPO="$(cd "$TARGET_REPO" && pwd)"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: gitleaks config file does not exist: $CONFIG" >&2
  exit 1
fi

ARGS=()
if [ ${#PASSED_ARGS[@]} -eq 0 ]; then
  ARGS=("--no-git")
else
  ARGS=("${PASSED_ARGS[@]}")
fi

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  CONFIG_MOUNT=("-v" "$CONFIG:/gitleaks.toml:ro")
  TARGET_MOUNT=("-v" "$TARGET_REPO:/scan")
  EXTRA_MOUNTS=()
  if [ -f "$TARGET_REPO/.git" ]; then
    COMMON_DIR="$(git -C "$TARGET_REPO" rev-parse --git-common-dir 2>/dev/null || true)"
    if [ -n "$COMMON_DIR" ]; then
      COMMON_DIR="$(cd "$TARGET_REPO" && cd "$COMMON_DIR" && pwd)"
      if [ -d "$COMMON_DIR" ]; then
        EXTRA_MOUNTS+=("-v" "$COMMON_DIR:$COMMON_DIR:ro")
      fi
    fi
    GIT_DIR="$(git -C "$TARGET_REPO" rev-parse --git-dir 2>/dev/null || true)"
    if [ -n "$GIT_DIR" ]; then
      GIT_DIR="$(cd "$TARGET_REPO" && cd "$GIT_DIR" && pwd)"
      if [ -d "$GIT_DIR" ] && [ "$GIT_DIR" != "$COMMON_DIR" ] && [[ "$GIT_DIR" != "$COMMON_DIR"/* ]]; then
        EXTRA_MOUNTS+=("-v" "$GIT_DIR:$GIT_DIR:ro")
      fi
    fi
  fi

  exec docker run --rm -i --pull=always \
    "${TARGET_MOUNT[@]}" \
    "${CONFIG_MOUNT[@]}" \
    "${EXTRA_MOUNTS[@]}" \
    -w /scan \
    "$GITLEAKS_IMAGE" \
    detect \
    --config=/gitleaks.toml \
    --source . \
    --no-banner \
    --redact=100 \
    --exit-code=2 \
    --ignore-gitleaks-allow \
    -v \
    "${ARGS[@]}" </dev/null
elif command -v gitleaks >/dev/null 2>&1; then
  cd "$TARGET_REPO"
  exec gitleaks detect \
    --config="$CONFIG" \
    --source . \
    --no-banner \
    --redact=100 \
    --exit-code=2 \
    --ignore-gitleaks-allow \
    -v \
    "${ARGS[@]}" </dev/null
else
  echo "ERROR: Docker is required to run gitleaks (or gitleaks binary must be installed on PATH). Neither a running Docker daemon nor gitleaks was found." >&2
  exit 1
fi
