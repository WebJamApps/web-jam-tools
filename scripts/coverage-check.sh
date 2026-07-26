#!/usr/bin/env bash
# coverage-check.sh (web-jam-tools#69)
#
# Runs the Deno test suite with coverage and FAILS if the "All files" line
# coverage drops below the threshold (default 90%, raised from 80% by
# web-jam-tools#152 once the suite cleared it). `deno coverage` has no
# built-in --fail-under, so we parse its summary table. Wired into the CI gate
# as `deno task coverage:check`.
set -euo pipefail

THRESHOLD="${COVERAGE_THRESHOLD:-90}"

rm -rf cov_profile
# web-jam-tools#275: do NOT redirect test output. This line used to end in
# `>/dev/null`, which sent every test name and every failure detail to the
# void — deno writes results to stdout and only its terminal `error: Test
# failed` to stderr. A failing CI build therefore showed a bare "Test failed"
# with no test name, and unrelated stderr `Download ...` lines directly above
# it read as the cause. That cost a whole wrong root-cause diagnosis.
deno test --allow-env --allow-run --allow-read --allow-write --coverage=cov_profile
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
