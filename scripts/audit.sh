#!/usr/bin/env bash
# audit.sh — web-jam-tools#84
#
# Dependency vulnerability scan (Trivy, npm deps via a package-lock bridge) +
# secret scan. Runs via Docker so it's byte-for-byte identical locally and in
# CircleCI. Invoke as `deno task audit`.
#
# Fail policy:
#   - vuln:   fail on HIGH + CRITICAL (warn-only below — they still print)
#   - secret: fail on any finding
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TRIVY_IMAGE="aquasec/trivy:latest"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "[audit] generating npm manifest from deno.lock…"
deno run --allow-read --allow-write \
  "$ROOT/scripts/audit/gen-npm-manifest.ts" "$ROOT/deno.lock" "$TMP"

echo "[audit] resolving package-lock.json…"
( cd "$TMP" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund >/dev/null )

echo "[audit] Trivy vulnerability scan (npm deps) — fails on HIGH/CRITICAL…"
docker run --rm -v "$TMP:/scan" "$TRIVY_IMAGE" fs \
  --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --no-progress /scan

echo "[audit] Trivy secret scan (repo) — fails on any finding…"
docker run --rm -v "$ROOT:/scan" "$TRIVY_IMAGE" fs \
  --scanners secret --exit-code 1 --no-progress \
  --skip-dirs .git --skip-dirs node_modules /scan

echo "[audit] OK — no HIGH/CRITICAL vulns and no secrets."
