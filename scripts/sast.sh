#!/usr/bin/env bash
# sast.sh — web-jam-tools#84
#
# Static analysis (SAST) of the TypeScript source with Semgrep. Invoke as
# `deno task sast`.
#
# Uses the `semgrep` BINARY if it's on PATH (CI / `circleci local execute`),
# otherwise falls back to the Semgrep Docker image (typical local dev — you only
# need Docker). Curated OSS rulesets (no login/token); `--error` exits non-zero
# on a blocking finding; metrics disabled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEMGREP_IMAGE="semgrep/semgrep:latest"
SEMGREP_ARGS=(scan --config p/default --config p/typescript --error --metrics off --disable-version-check src/)

echo "[sast] Semgrep scan of src/ …"
cd "$ROOT"
if command -v semgrep >/dev/null 2>&1; then
  semgrep "${SEMGREP_ARGS[@]}"
else
  docker run --rm -v "$ROOT:/src" -w /src "$SEMGREP_IMAGE" semgrep "${SEMGREP_ARGS[@]}"
fi

echo "[sast] OK — no blocking findings."
