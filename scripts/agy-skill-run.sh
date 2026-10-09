#!/usr/bin/env bash
# agy-skill-run.sh — run a skill command handed by the agy skill-run hook
# (web-jam-tools#1319).
#
# Takes one command as a single argument and runs it with `bash -c` in the
# current working directory, passing the output and exit status back unchanged.
set -u

if [ "$#" -ne 1 ]; then
  echo "Usage: agy-skill-run.sh <command>" >&2
  exit 1
fi

exec bash -c "$1"
