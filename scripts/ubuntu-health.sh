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
# Apply also records a root-owned checksum of every file it installs (manifest.sha256). The weekly
# job runs the INSTALLED --check, whose "source" would be the installed files themselves, so it
# verifies content against that manifest instead and reads nothing from the repository or a home
# folder. Run from the repository, --check compares against the repository files as well.
#
# On the laptop (not in WSL) apply also makes SSH accept a key only and the firewall admit only
# Tailscale: a drop-in under /etc/ssh/sshd_config.d/ sets "PasswordAuthentication no" (ssh.service
# is restarted until the restart succeeds), and ufw denies incoming traffic by default, allows everything
# arriving on tailscale0, and is switched on. ufw asks you to confirm "ufw enable" itself. --check
# refuses to switch the firewall on while it already admits SSH off Tailscale. --check
# reads the same state from files and reports it drifting; the parts that need root say so instead
# of guessing. WSL runs no SSH server (Windows' own SSH server reaches it), so both steps are skipped.
# On the laptop it also installs Chrome's managed notification allowlist and extension blocklist.
# The policy and its root-owned reference are checksummed; --check names changed entries. WSL
# skips Chrome. The policy comparison uses Ubuntu's system Python 3 and its JSON standard library.
#
# UBUNTU_HEALTH_ROOT stands in for "/" so tests never touch the real system.
# Design: Operations/ubuntu-security-efficiency-design-2026-10-15.md in the web-jam-llms folder.
set -euo pipefail

ROOT="${UBUNTU_HEALTH_ROOT:-}"
LIB="$ROOT/usr/local/lib/ubuntu-health"
UNIT_DIR="$ROOT/etc/systemd/system"
ENV_FILE="$ROOT/etc/ubuntu-health/gmail-send.env"
MANIFEST="$LIB/manifest.sha256"
TIMER="ubuntu-health-weekly.timer"
# Sorts before any other drop-in: sshd keeps the FIRST value it reads for a setting.
SSHD_CONFIG="$ROOT/etc/ssh/sshd_config"
SSHD_DROPIN="$ROOT/etc/ssh/sshd_config.d/00-ubuntu-health.conf"
# Exists from just before the drop-in is written until ssh.service has restarted, so a restart
# that failed, or a run that stopped first, is retried by the next apply and named by --check.
SSH_PENDING="$LIB/ssh-restart-pending"
UFW_CONF="$ROOT/etc/ufw/ufw.conf"
UFW_DEFAULTS="$ROOT/etc/default/ufw"
UFW_RULE_FILES=("$ROOT/etc/ufw/user.rules" "$ROOT/etc/ufw/user6.rules")
CHROME_POLICY="$ROOT/etc/opt/chrome/policies/managed/ubuntu-health.json"

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
SELF_DIR="$(dirname "$SELF")"
# True when this is the installed copy (the weekly job's), not the one in the repository.
FROM_INSTALLED=0
[ "$SELF_DIR" != "$(readlink -f "$LIB" 2>/dev/null || true)" ] || FROM_INSTALLED=1
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
  [ "$MODE" != "laptop" ] || echo "ssh|$SUPPORT/ubuntu-health-sshd.conf|$SSHD_DROPIN|644"
  if [ "$MODE" = "laptop" ]; then
    for f in ubuntu-health-chrome.json check-chrome-policy.py; do
      echo "job-files|$SUPPORT/$f|$LIB/$f|644"
    done
    echo "chrome|$SUPPORT/ubuntu-health-chrome.json|$CHROME_POLICY|644"
  fi
}

wsl_skip() {
  echo "skipped: SSH and firewall steps (WSL runs no SSH server; Windows' own SSH server reaches it)"
  echo "skipped: Chrome policy (WSL has no Chrome)"
}

# The JSON parser names the changed entries as well as the file-level checksum drift. Python 3 is
# part of Ubuntu; the installed weekly job reads only its root-owned support copies beside it.
check_chrome() {
  local detail
  [ -f "$CHROME_POLICY" ] || return 0 # wanted_files already reports a missing policy.
  if ! detail="$(python3 "$SUPPORT/check-chrome-policy.py" "$SUPPORT/ubuntu-health-chrome.json" "$CHROME_POLICY" 2>&1)"; then
    report chrome "${detail:-could not inspect $CHROME_POLICY}"
  fi
}

# --- firewall and SSH state, read from files so --check needs no ufw or sshd call -----------------

# The value of KEY in a KEY=value file such as ufw.conf, lowercase and without quotes.
conf_value() {
  sed -n "s/^$2=//p" "$1" 2>/dev/null | head -n 1 | tr -d '"' | tr '[:upper:]' '[:lower:]'
}

ufw_enabled() { [ "$(conf_value "$UFW_CONF" ENABLED)" = "yes" ]; }

ufw_denies_incoming() {
  case "$(conf_value "$UFW_DEFAULTS" DEFAULT_INPUT_POLICY)" in
    drop | reject) return 0 ;;
    *) return 1 ;;
  esac
}

# One line per incoming allow rule ufw holds:
# action|proto|port|interface|destination|source port|source address (interface empty = all).
# ufw writes a logged rule's action with the logging type appended (allow_log, limit_log-all), so
# that suffix is dropped before the action is classified.
ufw_tuples() {
  local f
  for f in "${UFW_RULE_FILES[@]}"; do
    [ -r "$f" ] || continue
    awk '/^### tuple ###/ {
      n = NF
      if ($n ~ /^comment=/) n--
      dir = $n
      action = $4
      sub(/_log(-all)?$/, "", action)
      if (action !~ /^(allow|limit)$/ || dir !~ /^in(_|$)/ || dir ~ /_out/) next
      iface = (dir == "in") ? "" : substr(dir, 4)
      print action "|" $5 "|" $6 "|" iface "|" $7 "|" $8 "|" $9
    }' "$f"
  done
}

# The blanket allowance "ufw allow in on tailscale0" writes: every protocol, port and address. A rule
# for tailscale0 that is restricted to one source, destination or port is not that allowance.
ufw_has_tailscale_rule() {
  ufw_tuples | grep -qE '^(allow|limit)\|any\|any\|tailscale0\|(0\.0\.0\.0/0|::/0)\|any\|(0\.0\.0\.0/0|::/0)$'
}

# True when a rule for protocol $1 and port field $2 (any, 22, 20:30 or 22,80) covers SSH.
admits_port22() {
  local p lo hi IFS=,
  case "$1" in tcp | any) ;; *) return 1 ;; esac
  [ "$2" != "any" ] || return 0
  for p in $2; do
    case "$p" in
      *:*)
        lo="${p%%:*}"
        hi="${p##*:}"
        if [ "$lo" -le 22 ] 2>/dev/null && [ "$hi" -ge 22 ] 2>/dev/null; then return 0; fi
        ;;
      22) return 0 ;;
    esac
  done
  return 1
}

# One line per ufw rule that admits port 22 off Tailscale. Loopback is not a network door, and
# tailscale0 is the one place SSH is meant to come in.
ufw_port22_exposures() {
  local action proto dport iface _rest
  while IFS='|' read -r action proto dport iface _rest; do
    case "$iface" in tailscale0 | lo) continue ;; esac
    admits_port22 "$proto" "$dport" || continue
    echo "port 22 is admitted on ${iface:-every interface} by an $action rule ($proto, port $dport)"
  done < <(ufw_tuples)
}

# Reads the whole sshd configuration, following Include lines in order (relative ones from
# /etc/ssh). SSHD_RESULT is the first PasswordAuthentication outside any Match block, as
# "value|file": the one sshd keeps. A Match block applies only to a condition, so its setting is
# not that value, but one that is not "no" can still switch passwords on for the connections it
# matches; the first such setting is kept in SSHD_MATCH_RESULT. Once a Match line is read, every
# later line in every file counts as conditional, whether or not sshd has closed the block.
SSHD_RESULT=""
SSHD_MATCH_RESULT=""
SSHD_IN_MATCH=0
SSHD_UNREADABLE=()

# Prints the first directory on the way to Include pattern $1 that this user cannot search, or
# cannot list when expanding a wildcard. Expand one directory component at a time so inaccessible
# directories below wildcards cannot disappear into what looks like a pattern matching no file.
blocked_include_dir() {
  local parts part dir candidate i last needs_listing
  local -a dirs=("$ROOT") next_dirs
  IFS=/ read -ra parts <<<"${1#/}"
  last=$((${#parts[@]} - 1))
  for ((i = 0; i <= last; i++)); do
    part="${parts[$i]}"
    needs_listing=0
    case "$part" in *[\*\?\[]*) needs_listing=1 ;; esac
    next_dirs=()
    for dir in "${dirs[@]}"; do
      [ -d "${dir:-/}" ] || continue
      if [ ! -x "${dir:-/}" ] || { [ "$needs_listing" -eq 1 ] && [ ! -r "${dir:-/}" ]; }; then
        echo "${dir:-/}"
        return 0
      fi
      [ "$i" -lt "$last" ] || continue
      for candidate in "$dir"/$part; do
        [ -d "$candidate" ] || continue
        next_dirs+=("$candidate")
      done
    done
    dirs=("${next_dirs[@]}")
  done
  return 1
}

scan_sshd() {
  local file="$1" line key val pattern f blocked match_seen=0
  local LC_COLLATE=C
  [ -r "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    read -r key val <<<"$line" || true
    case "${key,,}" in
      "" | "#"*) continue ;;
      match)
        SSHD_IN_MATCH=1
        match_seen=0
        ;;
      passwordauthentication)
        if [ "$SSHD_IN_MATCH" -eq 0 ]; then
          [ -n "$SSHD_RESULT" ] || SSHD_RESULT="$val|${file#"$ROOT"}"
        elif [ "$match_seen" -eq 0 ]; then
          match_seen=1
          [ "${val,,}" = "no" ] || [ -n "$SSHD_MATCH_RESULT" ] || SSHD_MATCH_RESULT="$val|${file#"$ROOT"}"
        fi
        ;;
      include)
        for pattern in $val; do
          case "$pattern" in /*) ;; *) pattern="/etc/ssh/$pattern" ;; esac
          if blocked="$(blocked_include_dir "$pattern")"; then
            SSHD_UNREADABLE+=("$blocked")
          fi
          # A blocked sibling makes the scan incomplete, but readable matches can still reveal drift.
          for f in "$ROOT"$pattern; do
            [ -f "$f" ] || continue
            if [ -r "$f" ]; then scan_sshd "$f"; else SSHD_UNREADABLE+=("$f"); fi
          done
        done
        ;;
    esac
  done <"$file"
  return 0
}

check_ssh() {
  local result value f
  if [ -e "$SSH_PENDING" ]; then
    report ssh "ssh.service has not been restarted since $SSHD_DROPIN was written; run apply again"
  fi
  if [ ! -f "$SSHD_CONFIG" ]; then
    report ssh "$SSHD_CONFIG is missing, so sshd's login rules cannot be read"
    return 0
  fi
  if [ ! -r "$SSHD_CONFIG" ]; then
    echo "NOTE: SSH login rules not checked without sudo ($SSHD_CONFIG is not readable)"
    return 0
  fi
  SSHD_RESULT=""
  SSHD_MATCH_RESULT=""
  SSHD_IN_MATCH=0
  SSHD_UNREADABLE=()
  scan_sshd "$SSHD_CONFIG"
  for f in "${SSHD_UNREADABLE[@]}"; do
    echo "NOTE: SSH login rules not fully checked without sudo ($f is not readable, so a setting in it could not be seen)"
  done
  result="${SSHD_RESULT:-yes|the built-in default}"
  value="${result%%|*}"
  if [ "${value,,}" != "no" ]; then
    report ssh "PasswordAuthentication is effectively \"$value\" (${result#*|}); expected \"no\""
  elif [ -n "$SSHD_MATCH_RESULT" ]; then
    report ssh "a Match block sets PasswordAuthentication to \"${SSHD_MATCH_RESULT%%|*}\" (${SSHD_MATCH_RESULT#*|}), so a password can still be accepted for the connections it matches; key-only login is not confirmed"
  fi
}

check_firewall() {
  local f unreadable=0 policy msg
  if [ ! -f "$UFW_CONF" ]; then
    report firewall "firewall off: $UFW_CONF is missing (is ufw installed?)"
  elif ! ufw_enabled; then
    report firewall "firewall off: ENABLED is not yes in $UFW_CONF"
  fi
  if ! ufw_denies_incoming; then
    policy="$(conf_value "$UFW_DEFAULTS" DEFAULT_INPUT_POLICY)"
    report firewall "incoming traffic is not denied by default (DEFAULT_INPUT_POLICY=${policy:-unset} in $UFW_DEFAULTS)"
  fi
  for f in "${UFW_RULE_FILES[@]}"; do
    if [ -e "$f" ] && [ ! -r "$f" ]; then
      unreadable=1
      echo "NOTE: firewall rules not checked without sudo ($f is not readable)"
    fi
  done
  [ "$unreadable" -eq 0 ] || return 0
  ufw_has_tailscale_rule || report firewall "no rule allows incoming traffic on tailscale0"
  while IFS= read -r msg; do
    report firewall "$msg"
  done < <(ufw_port22_exposures)
}

# The checksum line the manifest holds for one installed file: "<sha256>  <path without ROOT>".
manifest_line() {
  echo "$(sha256sum "$1" | cut -d' ' -f1)  ${2#"$ROOT"}"
}

# The manifest apply would write: one line per wanted file, hashed from its repository source.
manifest_text() {
  local step src dst mode
  while IFS='|' read -r step src dst mode; do
    manifest_line "$src" "$dst"
  done < <(wanted_files)
}

check() {
  local drift=0 step src dst mode state
  report() {
    echo "DRIFT $1: $2"
    drift=1
  }

  if [ ! -f "$MANIFEST" ]; then
    report job-files "$MANIFEST is missing, so installed files cannot be verified"
  elif [ "$(stat -c %a "$MANIFEST")" != "644" ]; then
    report job-files "$MANIFEST has mode $(stat -c %a "$MANIFEST"), expected 644"
  elif [ "$(stat -c %u "$MANIFEST")" != "$WANT_UID" ]; then
    report job-files "$MANIFEST is not owned by root"
  fi

  while IFS='|' read -r step src dst mode; do
    if [ ! -f "$dst" ]; then
      report "$step" "$dst is missing"
    elif [ -f "$MANIFEST" ] && ! grep -qxF "$(manifest_line "$dst" "$dst")" "$MANIFEST"; then
      report "$step" "$dst differs from the checksum recorded at install"
    elif [ "$FROM_INSTALLED" -eq 0 ] && ! cmp -s "$src" "$dst"; then
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

  if [ "$MODE" = "laptop" ]; then
    check_ssh
    check_firewall
    check_chrome
  else
    wsl_skip
  fi

  [ "$drift" -eq 0 ] && echo "no drift"
  return "$drift"
}

apply() {
  local step src dst mode units_changed=0 manifest_new
  if [ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ]; then
    echo "ubuntu-health: run this with sudo, or use --check" >&2
    exit 2
  fi
  if [ "$FROM_INSTALLED" -eq 1 ]; then
    echo "ubuntu-health: run apply from the repository; the installed copy would record its own files as correct" >&2
    exit 2
  fi

  install -d -m 0755 "$LIB" "$UNIT_DIR" "$(dirname "$ENV_FILE")"
  chown root:root "$LIB" "$(dirname "$ENV_FILE")"
  [ "$MODE" != "laptop" ] || install -d -m 0755 "$(dirname "$SSHD_DROPIN")"
  if [ "$MODE" = "laptop" ]; then
    install -d -m 0755 "$(dirname "$CHROME_POLICY")"
    chown root:root "$(dirname "$CHROME_POLICY")"
  fi
  while IFS='|' read -r step src dst mode; do
    if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst" || [ "$(stat -c %a "$dst")" != "$mode" ]; then
      [ "$step" != "ssh" ] || : >"$SSH_PENDING"
      install -m "$mode" "$src" "$dst"
      echo "wrote $dst"
      [ "$step" != "unit-files" ] || units_changed=1
    fi
    chown root:root "$dst"
  done < <(wanted_files)

  manifest_new="$(mktemp)"
  manifest_text >"$manifest_new"
  if [ ! -f "$MANIFEST" ] || ! cmp -s "$manifest_new" "$MANIFEST" || [ "$(stat -c %a "$MANIFEST")" != "644" ]; then
    install -m 644 "$manifest_new" "$MANIFEST"
    echo "wrote $MANIFEST"
  fi
  rm -f "$manifest_new"
  chown root:root "$MANIFEST"

  [ "$units_changed" -eq 0 ] || systemctl daemon-reload
  if [ "$(systemctl is-enabled "$TIMER" 2>/dev/null || true)" != "enabled" ] ||
    [ "$(systemctl is-active "$TIMER" 2>/dev/null || true)" != "active" ]; then
    systemctl enable --now "$TIMER"
    echo "enabled $TIMER"
  fi

  if [ ! -f "$ENV_FILE" ]; then
    echo "NOTE: $ENV_FILE is missing, so the weekly job cannot email until you make it (runbook)"
  fi

  if [ "$MODE" = "laptop" ]; then
    apply_firewall
    [ ! -e "$SSH_PENDING" ] || restart_ssh
  else
    wsl_skip
  fi
}

# Tailscale is allowed first, so switching the firewall on never cuts the way in that stays open.
apply_firewall() {
  local exposed
  # A rule that already admits SSH off Tailscale survives every change below, so switching the
  # firewall on would report success while leaving the exposure. Nothing is deleted for you:
  # which rules to drop is your call.
  exposed="$(ufw_port22_exposures)"
  if [ -n "$exposed" ]; then
    {
      echo "ubuntu-health: not changing the firewall: ufw already admits SSH off Tailscale:"
      sed 's/^/  /' <<<"$exposed"
      echo "  List the rules with \"ufw status numbered\", remove each of these with \"ufw delete <number>\", then run this again."
    } >&2
    exit 1
  fi
  if ! ufw_has_tailscale_rule; then
    ufw allow in on tailscale0
    echo "allowed incoming traffic on tailscale0"
  fi
  if ! ufw_denies_incoming; then
    ufw default deny incoming
    echo "set incoming traffic to deny by default"
  fi
  if ! ufw_enabled; then
    ufw enable
    echo "enabled the firewall"
  fi
}

# On the real system a configuration sshd rejects is caught before the restart that would leave
# the phone and tablet with no way in.
restart_ssh() {
  if [ -z "$ROOT" ] && command -v sshd >/dev/null 2>&1 && ! sshd -t; then
    echo "ubuntu-health: sshd rejects its configuration; not restarting ssh.service" >&2
    exit 1
  fi
  systemctl restart ssh.service
  rm -f "$SSH_PENDING"
  echo "restarted ssh.service"
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
