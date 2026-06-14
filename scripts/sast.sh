#!/usr/bin/env bash
# sast.sh — web-jam-tools#84
#
# Static analysis (SAST) of the TypeScript source with Semgrep, via Docker so
# it's identical locally and in CircleCI. Invoke as `deno task sast`.
#
# Uses the curated OSS rulesets (no login/token needed); `--error` makes Semgrep
# exit non-zero when it finds a blocking issue. Metrics are disabled.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SEMGREP_IMAGE="semgrep/semgrep:latest"

echo "[sast] Semgrep scan of src/ …"
docker run --rm -v "$ROOT:/src" -w /src "$SEMGREP_IMAGE" \
  semgrep scan \
  --config p/default --config p/typescript \
  --error --metrics off --disable-version-check \
  src/

echo "[sast] OK — no blocking findings."
