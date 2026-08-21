#!/usr/bin/env bash
# gitleaks.sh — web-jam-tools#658
# Run gitleaks detect with repository configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"

GITLEAKS="$(command -v gitleaks || echo "$HOME/.local/bin/gitleaks")"

if [ -x "$GITLEAKS" ] || command -v gitleaks >/dev/null 2>&1; then
  exec "$GITLEAKS" detect --config="$CONFIG" --no-banner --redact=100 "$@"
elif command -v docker >/dev/null 2>&1; then
  exec docker run --rm -v "$ROOT:/scan" zricethezav/gitleaks:v8.24.0 detect --config=/scan/.gitleaks.toml --no-banner --redact=100 -s /scan "$@"
else
  echo "ERROR: gitleaks binary or docker is required to run gitleaks scan" >&2
  exit 1
fi
