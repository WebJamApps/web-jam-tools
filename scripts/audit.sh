#!/usr/bin/env bash
# audit.sh — web-jam-tools#84
#
# Dependency vulnerability scan (Trivy, npm deps via a package-lock bridge) +
# secret scan. Invoke as `deno task audit`.
#
# Uses the `trivy` BINARY if it's on PATH (CI / `circleci local execute`),
# otherwise falls back to the Trivy Docker image (typical local dev — you only
# need Docker, not Trivy installed). Same scan either way.
#
# Fail policy:
#   - vuln:   fail on HIGH + CRITICAL (warn-only below — they still print)
#   - secret: fail on any finding
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIVY_IMAGE="aquasec/trivy:0.71.0"

# trivy_fs <host-path> <trivy fs flags...>
trivy_fs() {
  local target="$1"
  shift
  if command -v trivy >/dev/null 2>&1; then
    trivy fs "$@" "$target"
  else
    docker run --rm -v "$target:/scan" "$TRIVY_IMAGE" fs "$@" /scan
  fi
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[audit] generating npm manifest from deno.lock…"
deno run --allow-read --allow-write \
  "$ROOT/scripts/audit/gen-npm-manifest.ts" "$ROOT/deno.lock" "$TMP"

echo "[audit] resolving package-lock.json…"
( cd "$TMP" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null )

echo "[audit] Trivy vulnerability scan (npm deps) — fails on HIGH/CRITICAL…"
trivy_fs "$TMP" --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress

echo "[audit] Trivy secret scan (repo) — fails on any finding…"
trivy_fs "$ROOT" --scanners secret --exit-code 1 --no-progress \
  --skip-dirs .git --skip-dirs node_modules

echo "[audit] OK — no HIGH/CRITICAL vulns and no secrets."
