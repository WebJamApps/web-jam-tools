#!/usr/bin/env bash
# gitleaks.sh — web-jam-tools#658
# Run gitleaks detect with repository configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"
GITLEAKS_IMAGE="zricethezav/gitleaks:v8.24.0"

cd "$ROOT"
if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks detect --config="$CONFIG" --no-banner --redact=100 "$@"
elif [ -x "$HOME/.local/bin/gitleaks" ]; then
  exec "$HOME/.local/bin/gitleaks" detect --config="$CONFIG" --no-banner --redact=100 "$@"
elif [ -x "/usr/local/bin/gitleaks" ]; then
  exec "/usr/local/bin/gitleaks" detect --config="$CONFIG" --no-banner --redact=100 "$@"
elif command -v docker >/dev/null 2>&1; then
  exec docker run --rm -v "$ROOT:/scan" "$GITLEAKS_IMAGE" detect --config=/scan/.gitleaks.toml --no-banner --redact=100 -s /scan "$@"
else
  echo "ERROR: gitleaks binary or docker is required to run gitleaks scan" >&2
  exit 1
fi
