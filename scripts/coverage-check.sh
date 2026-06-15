#!/usr/bin/env bash
# coverage-check.sh (web-jam-tools#69)
#
# Runs the Deno test suite with coverage and FAILS if the "All files" line
# coverage drops below the threshold (default 80%). `deno coverage` has no
# built-in --fail-under, so we parse its summary table. Wired into the CI gate
# as `deno task coverage:check`.
#
# Threshold is 80% now; stretch goal is 90% — ratchet COVERAGE_THRESHOLD up as
# coverage improves (override via the env var without editing this file).
set -euo pipefail

THRESHOLD="${COVERAGE_THRESHOLD:-80}"

rm -rf cov_profile
deno test --allow-env --coverage=cov_profile >/dev/null
report="$(deno coverage cov_profile 2>/dev/null)"
echo "$report"

# "All files" row: | All files | <branch> | <func> | <line> |  — take the Line %
# (4th data column), stripping ANSI color codes deno emits on a TTY.
pct="$(
  printf '%s\n' "$report" \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | awk -F'|' '/All files/ { gsub(/ /, "", $5); print $5 }' \
    | tail -1
)"

if [ -z "$pct" ]; then
  echo "[coverage] ERROR: could not parse all-files line coverage from the report" >&2
  exit 1
fi

# Decimal-safe comparison without bc.
if awk -v p="$pct" -v t="$THRESHOLD" 'BEGIN { exit !(p + 0 >= t + 0) }'; then
  echo "[coverage] OK: all-files line coverage ${pct}% >= ${THRESHOLD}% threshold"
else
  echo "[coverage] FAIL: all-files line coverage ${pct}% < ${THRESHOLD}% threshold" >&2
  exit 1
fi
