#!/usr/bin/env bash
# ubuntu-health.sh — applies the Ubuntu security/efficiency design on one system.
#
# Josh runs this with sudo, once on the laptop and once in WSL on the desktop; no agent runs it as
# root. It installs the weekly job and everything that job runs as root-owned copies under
# /usr/local/lib/ubuntu-health/, so the scheduled root job never runs a file from the repository,
# a home folder or an agent-writable path. Running it again changes nothing that is already right.
#
#   sudo scripts/ubuntu-health.sh           apply: refresh the root-owned copies, enable the timer
#   scripts/ubuntu-health.sh --check        change nothing; name every drift; exit 1 if any
#
# UBUNTU_HEALTH_ROOT stands in for "/" so tests never touch the real system.
# Design: Operations/ubuntu-security-efficiency-design-2026-10-15.md in the web-jam-llms folder.
set -euo pipefail

ROOT="${UBUNTU_HEALTH_ROOT:-}"
LIB="$ROOT/usr/local/lib/ubuntu-health"
UNIT_DIR="$ROOT/etc/systemd/system"
ENV_FILE="$ROOT/etc/ubuntu-health/gmail-send.env"
TIMER="ubuntu-health-weekly.timer"

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
# In the repository the support files sit in scripts/ubuntu-health/; the installed copy has them
# flat beside it.
SUPPORT="$SELF_DIR"
[ ! -d "$SELF_DIR/ubuntu-health" ] || SUPPORT="$SELF_DIR/ubuntu-health"

# The test harness stands in for root, so ownership is checked against the current user there.
WANT_UID=0
[ -z "$ROOT" ] || WANT_UID="$(id -u)"

MODE=""

usage() {
  echo "usage: ubuntu-health.sh [--check]" >&2
  exit 2
}

detect_mode() {
  local out
  out="$(systemd-detect-virt 2>/dev/null)" || true
  case "$out" in
    none) MODE="laptop" ;;
    wsl) MODE="wsl" ;;
    *)
      echo "ubuntu-health: refusing to run: systemd-detect-virt failed or printed \"$out\"; expected \"none\" (laptop) or \"wsl\"" >&2
      exit 2
      ;;
  esac
  echo "mode: $MODE"
}

# One line per file the system must hold: step|source|destination|mode
wanted_files() {
  local f
  echo "job-files|$SELF|$LIB/ubuntu-health.sh|755"
  for f in weekly.sh gmail-send.sh; do
    echo "job-files|$SUPPORT/$f|$LIB/$f|755"
  done
  for f in ubuntu-health-weekly.service ubuntu-health-weekly.timer; do
    echo "job-files|$SUPPORT/$f|$LIB/$f|644"
    echo "unit-files|$SUPPORT/$f|$UNIT_DIR/$f|644"
  done
}

check() {
  local drift=0 step src dst mode state
  report() {
    echo "DRIFT $1: $2"
    drift=1
  }

  while IFS='|' read -r step src dst mode; do
    if [ ! -f "$dst" ]; then
      report "$step" "$dst is missing"
    elif ! cmp -s "$src" "$dst"; then
      report "$step" "$dst differs from $(basename "$src")"
    elif [ "$(stat -c %a "$dst")" != "$mode" ]; then
      report "$step" "$dst has mode $(stat -c %a "$dst"), expected $mode"
    elif [ "$(stat -c %u "$dst")" != "$WANT_UID" ]; then
      report "$step" "$dst is not owned by root"
    fi
  done < <(wanted_files)

  state="$(systemctl is-enabled "$TIMER" 2>/dev/null)" || true
  [ "$state" = "enabled" ] || report timer "$TIMER is not enabled"
  state="$(systemctl is-active "$TIMER" 2>/dev/null)" || true
  [ "$state" = "active" ] || report timer "$TIMER is not active"

  if [ ! -f "$ENV_FILE" ]; then
    report email-login "$ENV_FILE is missing; make the send-only Gmail login from the runbook"
  elif (((8#$(stat -c %a "$ENV_FILE") & ~8#600) != 0)); then
    report email-login "$ENV_FILE has mode $(stat -c %a "$ENV_FILE"), wider than 600"
  elif [ "$(stat -c %u "$ENV_FILE")" != "$WANT_UID" ]; then
    report email-login "$ENV_FILE is not owned by root"
  fi

  [ "$drift" -eq 0 ] && echo "no drift"
  return "$drift"
}

apply() {
  local step src dst mode units_changed=0
  if [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then
    echo "ubuntu-health: run this with sudo, or use --check" >&2
    exit 2
  fi

  install -d -m 0755 "$LIB" "$UNIT_DIR" "$(dirname "$ENV_FILE")"
  chown root:root "$LIB" "$(dirname "$ENV_FILE")"
  while IFS='|' read -r step src dst mode; do
    if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst" || [ "$(stat -c %a "$dst")" != "$mode" ]; then
      install -m "$mode" "$src" "$dst"
      echo "wrote $dst"
      [ "$step" != "unit-files" ] || units_changed=1
    fi
    chown root:root "$dst"
  done < <(wanted_files)

  [ "$units_changed" -eq 0 ] || systemctl daemon-reload
  if [ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" != "enabled" ] ||
    [ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" != "active" ]; then
    systemctl enable --now "$TIMER"
    echo "enabled $TIMER"
  fi

  if [ ! -f "$ENV_FILE" ]; then
    echo "NOTE: $ENV_FILE is missing, so the weekly job cannot email until you make it (runbook)"
  fi
}

case "${1:-}" in
  "")
    detect_mode
    apply
    ;;
  --check)
    [ "$#" -eq 1 ] || usage
    detect_mode
    check
    ;;
  *) usage ;;
esac
