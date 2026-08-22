#!/usr/bin/env bash
# statusline.sh — web-jam-tools#688
#
# Model-aware Claude Code status line. Reads the status-line JSON payload
# Claude Code writes to stdin (NOT the hook payload — that carries no model
# field; this is the one surface where the model arrives for free, via
# `.model.display_name`), prints a color-coded tier badge in front of it,
# then passes the SAME payload through unmodified to the existing
# cost/usage status line command so today's display is preserved exactly —
# the badge is a prefix, not a replacement.
#
# stdin can only be consumed once, so it is captured into $payload here and
# reused for both the badge extraction below and the downstream pass-through.
#
# Tier match is on the family WORD in display_name (opus / sonnet / haiku),
# matched case-insensitively, so a version bump ("Opus 5" -> "Opus 6") keeps
# matching without a script change. An unrecognized display_name, a missing
# `.model` key, or malformed JSON on stdin must all still produce a usable,
# non-empty status line rather than erroring or going blank — this script is
# not allowed to make Claude Code's status line disappear.
set -uo pipefail

payload="$(cat)"

# jq exits non-zero (and prints nothing to stdout) both when the input isn't
# valid JSON at all and when `.model` / `.model.display_name` is simply
# absent — either way display_name ends up empty here, which the fallback
# branch below turns into usable, uncolored output instead of an error.
display_name="$(printf '%s' "$payload" | jq -r '.model.display_name // empty' 2>/dev/null)"

RESET=$'\033[0m'
COLOR_OPUS=$'\033[1;35m'   # bold magenta
COLOR_SONNET=$'\033[1;36m' # bold cyan
COLOR_HAIKU=$'\033[1;32m'  # bold green

tier_label=""
color=""
if [ -n "$display_name" ]; then
  lc_name="$(printf '%s' "$display_name" | tr '[:upper:]' '[:lower:]')"
  case "$lc_name" in
    *opus*) tier_label="Opus"; color="$COLOR_OPUS" ;;
    *sonnet*) tier_label="Sonnet"; color="$COLOR_SONNET" ;;
    *haiku*) tier_label="Haiku"; color="$COLOR_HAIKU" ;;
  esac
fi

if [ -n "$tier_label" ]; then
  badge="${color}[${tier_label}]${RESET}"
else
  # Unrecognized tier, missing .model key, or malformed JSON on stdin: print
  # the raw display_name uncolored (or a plain placeholder when there is no
  # display_name to show at all) rather than erroring or printing nothing.
  fallback_text="${display_name:-unknown}"
  badge="[${fallback_text}]"
fi

printf '%s ' "$badge"

# STATUSLINE_DOWNSTREAM_CMD lets a test substitute a fast, offline stand-in
# for the real downstream command — the real one shells out to `npx`, which
# hits the network and is unsuitable to invoke from an automated test.
# Every real invocation uses the default, unchanged.
downstream_cmd="${STATUSLINE_DOWNSTREAM_CMD:-npx -y ccusage statusline}"
printf '%s' "$payload" | bash -c "$downstream_cmd"

# The badge above has already been printed to stdout by this point, so the
# status line is usable regardless of how the downstream command fared. With
# `set -uo pipefail`, this script's own exit status would otherwise become
# the downstream command's (e.g. `npx -y ccusage statusline` failing offline
# or on a resolve failure) — this script must not depend on how Claude Code
# treats a non-zero status-line command, so it always exits 0 here. Only the
# exit status is overridden; the downstream's stdout/stderr are untouched.
exit 0
