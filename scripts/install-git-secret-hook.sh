#!/usr/bin/env bash
# install-git-secret-hook.sh — install push-time secret scanner across WebJamApps repos (web-jam-tools#658).
#
# Child of JaMmusic#1315 "Prod calls http://localhost:7000 (Google login broken),
# credentials hardcoded in vite.config.ts, no push-time secret guard".
#
# Installs a gitleaks pre-push hook and shared .gitleaks.toml config into a
# target git repository.
#
# Repo type auto-detection:
#   - Node repos (contains package.json): installs into .husky/pre-push
#   - Deno / standard git repos (contains deno.json or no package.json): installs into .git/hooks/pre-push
#
# Usage:
#   scripts/install-git-secret-hook.sh [--repo <path>] [--check] [--force]
#
# Flags:
#   --repo PATH   Target repository directory (defaults to current working directory)
#   --check       Drift check mode: exits 0 if installed and in sync, 1 if missing or drifted
#   --force       Force overwriting without backup
#   --help, -h    Show this help message
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_SRC="$REPO_DIR/.gitleaks.toml"

TARGET_REPO_ARG=""
CHECK_MODE=0
FORCE_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)
      if [ -z "${2:-}" ]; then
        echo "ERROR: --repo requires a path argument" >&2
        exit 1
      fi
      TARGET_REPO_ARG="$2"
      shift 2
      ;;
    --check)
      CHECK_MODE=1
      shift
      ;;
    --force)
      FORCE_MODE=1
      shift
      ;;
    --help|-h)
      sed -n '2,17p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

TARGET_DIR="${TARGET_REPO_ARG:-$PWD}"
if [ ! -d "$TARGET_DIR" ]; then
  echo "ERROR: target directory does not exist: $TARGET_DIR" >&2
  exit 1
fi
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

if ! git -C "$TARGET_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  echo "ERROR: target directory is not a git repository: $TARGET_DIR" >&2
  exit 1
fi

GIT_DIR="$(git -C "$TARGET_DIR" rev-parse --git-dir)"
if [[ "$GIT_DIR" != /* ]]; then
  GIT_DIR="$TARGET_DIR/$GIT_DIR"
fi

if [ -f "$TARGET_DIR/package.json" ]; then
  REPO_TYPE="node"
  HOOK_PATH="$TARGET_DIR/.husky/pre-push"
  HOOK_PARENT_DIR="$TARGET_DIR/.husky"
else
  REPO_TYPE="deno"
  HOOK_PARENT_DIR="$GIT_DIR/hooks"
  HOOK_PATH="$HOOK_PARENT_DIR/pre-push"
fi

TARGET_CONFIG="$TARGET_DIR/.gitleaks.toml"

if [ "$CHECK_MODE" -eq 1 ]; then
  DRIFT=0
  if [ ! -f "$TARGET_CONFIG" ]; then
    echo "DRIFT: .gitleaks.toml missing from $TARGET_DIR" >&2
    DRIFT=1
  elif ! cmp -s "$CONFIG_SRC" "$TARGET_CONFIG"; then
    echo "DRIFT: $TARGET_CONFIG differs from master $CONFIG_SRC" >&2
    DRIFT=1
  fi

  if [ ! -f "$HOOK_PATH" ]; then
    echo "DRIFT: pre-push hook missing at $HOOK_PATH" >&2
    DRIFT=1
  elif [ ! -x "$HOOK_PATH" ]; then
    echo "DRIFT: pre-push hook at $HOOK_PATH is not executable" >&2
    DRIFT=1
  elif ! grep -q "gitleaks detect" "$HOOK_PATH"; then
    echo "DRIFT: pre-push hook at $HOOK_PATH does not call gitleaks detect" >&2
    DRIFT=1
  fi

  if [ "$DRIFT" -eq 1 ]; then
    exit 1
  fi
  echo "OK: git-secret-hook is installed and in sync in $TARGET_DIR ($REPO_TYPE)"
  exit 0
fi

# Step 1: Install / update .gitleaks.toml
if [ ! -f "$CONFIG_SRC" ]; then
  echo "ERROR: master config not found at $CONFIG_SRC" >&2
  exit 1
fi

if [ ! -f "$TARGET_CONFIG" ] || ! cmp -s "$CONFIG_SRC" "$TARGET_CONFIG"; then
  cp "$CONFIG_SRC" "$TARGET_CONFIG"
  echo "Installed .gitleaks.toml in $TARGET_DIR"
else
  echo ".gitleaks.toml already in sync in $TARGET_DIR"
fi

# Step 2: Install / update pre-push hook
mkdir -p "$HOOK_PARENT_DIR"

cat << 'HOOK_EOF' > "$HOOK_PATH"
#!/usr/bin/env bash
# WebJamApps pre-push secret guard (gitleaks) — web-jam-tools#658
set -euo pipefail

ZERO_OID="0000000000000000000000000000000000000000"
SCAN_REQUIRED=0
LOG_OPTS=""

if [ -t 0 ]; then
  SCAN_REQUIRED=1
  LOG_OPTS="--log-opts=@{u}..HEAD"
else
  while read -r local_ref local_oid remote_ref remote_oid; do
    if [ "$local_oid" = "$ZERO_OID" ] || [ -z "$local_oid" ]; then
      continue
    fi
    if [ "$remote_oid" = "$ZERO_OID" ] || [ -z "$remote_oid" ]; then
      SCAN_REQUIRED=1
      REMOTE_COUNT=$(git for-each-ref --format='%(refname)' refs/remotes/ 2>/dev/null | wc -l || echo 0)
      if [ "$REMOTE_COUNT" -gt 0 ]; then
        LOG_OPTS="--log-opts=$local_oid --not --remotes"
      else
        LOG_OPTS="--log-opts=$local_oid"
      fi
    else
      SCAN_REQUIRED=1
      LOG_OPTS="--log-opts=$remote_oid..$local_oid"
    fi
  done
fi

if [ "$SCAN_REQUIRED" -eq 1 ]; then
  GITLEAKS="$(command -v gitleaks || echo "$HOME/.local/bin/gitleaks")"
  if [ ! -x "$GITLEAKS" ] && ! command -v gitleaks >/dev/null 2>&1; then
    echo "warning: gitleaks binary not found on PATH; skipping pre-push secret scan" >&2
    exit 0
  fi

  CONFIG_PATH=".gitleaks.toml"
  if [ ! -f "$CONFIG_PATH" ]; then
    REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
    if [ -f "$REPO_ROOT/.gitleaks.toml" ]; then
      CONFIG_PATH="$REPO_ROOT/.gitleaks.toml"
    elif [ -f "$HOME/WebJamApps/web-jam-tools/.gitleaks.toml" ]; then
      CONFIG_PATH="$HOME/WebJamApps/web-jam-tools/.gitleaks.toml"
    fi
  fi

  REPORT_FILE="$(mktemp /tmp/gitleaks-report-XXXXXX.json)"
  trap 'rm -f "$REPORT_FILE"' EXIT

  CONFIG_ARG=""
  if [ -f "$CONFIG_PATH" ]; then
    CONFIG_ARG="--config=$CONFIG_PATH"
  fi

  # Run gitleaks detect with redaction
  if ! "$GITLEAKS" detect $CONFIG_ARG --no-banner --redact=100 -f json -r "$REPORT_FILE" $LOG_OPTS >/dev/null 2>&1; then
    echo "🛑 PUSH REFUSED: credential-shaped literal detected in commit(s) being pushed." >&2
    echo "Findings (credential values redacted):" >&2
    if [ -f "$REPORT_FILE" ] && [ -s "$REPORT_FILE" ]; then
      if command -v jq >/dev/null 2>&1; then
        jq -r '.[] | "  - File: \(.File) (line \(.StartLine)) -> Rule: \(.RuleID) (\(.Description))"' "$REPORT_FILE" >&2 2>/dev/null || true
      else
        grep -o '"File":"[^"]*"' "$REPORT_FILE" | while read -r f; do
          echo "  - $f" >&2
        done
      fi
    fi
    echo "" >&2
    echo "Remove the credential literal from your commit before pushing." >&2
    echo "For legitimate test fixtures, use the fixture pragma '// webjam-fixture-ok'." >&2
    echo "(rule: web-jam-tools#658 / JaMmusic#1315)" >&2
    exit 1
  fi
fi
HOOK_EOF

chmod +x "$HOOK_PATH"
echo "Installed pre-push secret guard at $HOOK_PATH ($REPO_TYPE)"
