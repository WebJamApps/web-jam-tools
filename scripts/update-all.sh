#!/usr/bin/env bash

# Master Update Script for WebJamApps Development Environment
# Updates Claude Code, Antigravity (agy), OpenAI Codex, and REAPER in sequence:
#   1. claude update
#   2. agy update
#   3. codex update
#   4. reaper-update
#
# Usage:
#   ./scripts/update-all.sh [OPTIONS]
#
# Options:
#   -h, --help            Show this help message and exit
#   -n, --dry-run         Print update commands without executing them
#   -s, --strict, --fail-on-missing
#                         Fail (exit 1) if any tool is missing
#
# Environment variable overrides:
#   CLAUDE_BIN            Command or path for Claude CLI (default: claude)
#   AGY_BIN               Command or path for Antigravity CLI (default: agy)
#   CODEX_BIN             Command or path for Codex CLI (default: codex)
#   REAPER_UPDATE_BIN     Command or path for REAPER updater (default: reaper-update or scripts/reaper-update.sh)

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Overridable binary names or paths
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
AGY_BIN="${AGY_BIN:-agy}"
CODEX_BIN="${CODEX_BIN:-codex}"
REAPER_UPDATE_BIN="${REAPER_UPDATE_BIN:-}"

DRY_RUN=false
FAIL_ON_MISSING=false

log() {
	echo "[update-all] $*"
}

warn() {
	echo "[update-all] WARNING: $*" >&2
}

error() {
	echo "[update-all] ERROR: $*" >&2
}

show_help() {
	cat <<'EOF'
Usage: update-all.sh [OPTIONS]

Master update script for WebJamApps developer tools and environment.
Executes the following updates in sequence:
  1. claude update  (Anthropic Claude Code CLI)
  2. agy update     (Google Antigravity CLI)
  3. codex update   (OpenAI Codex CLI)
  4. reaper-update  (Cockos REAPER digital audio workstation)

Options:
  -h, --help             Show this help message and exit
  -n, --dry-run          Display the commands that would run without executing them
  -s, --strict, --fail-on-missing
                         Exit with non-zero status if any tool is missing

Invocation:
  update-all             (when symlinked to ~/.local/bin/update-all)
  deno task update:all   (from web-jam-tools repository)
  deno task update       (from web-jam-tools repository)
  bash scripts/update-all.sh

Environment Variables:
  CLAUDE_BIN             Command/path for Claude CLI (default: claude)
  AGY_BIN                Command/path for Antigravity CLI (default: agy)
  CODEX_BIN              Command/path for Codex CLI (default: codex)
  REAPER_UPDATE_BIN      Command/path for REAPER updater (default: reaper-update or scripts/reaper-update.sh)

Tool Installation Quick Reference (Linux):
  Claude Code:           curl -fsSL https://claude.ai/install.sh | bash
  Antigravity (agy):     Place binary in ~/.local/bin/agy and run: agy install
  OpenAI Codex:          curl -fsSL https://chatgpt.com/codex/install.sh | sh
  REAPER:                bash scripts/reaper-update.sh
EOF
}

# Parse options
while [ $# -gt 0 ]; do
	case "$1" in
		-h|--help)
			show_help
			exit 0
			;;
		-n|--dry-run)
			DRY_RUN=true
			shift
			;;
		-s|--strict|--fail-on-missing)
			FAIL_ON_MISSING=true
			shift
			;;
		*)
			error "Unknown option '$1'"
			echo "Run '$0 --help' for usage." >&2
			exit 1
			;;
	esac
done

resolve_reaper_cmd() {
	if [ -n "$REAPER_UPDATE_BIN" ]; then
		if command -v "$REAPER_UPDATE_BIN" >/dev/null 2>&1 || [ -f "$REAPER_UPDATE_BIN" ]; then
			echo "$REAPER_UPDATE_BIN"
			return 0
		else
			return 1
		fi
	fi
	if command -v reaper-update >/dev/null 2>&1; then
		echo "reaper-update"
		return 0
	fi
	if [ -f "$SCRIPT_DIR/reaper-update.sh" ]; then
		echo "$SCRIPT_DIR/reaper-update.sh"
		return 0
	fi
	return 1
}

STATUS_CLAUDE="PENDING"
STATUS_AGY="PENDING"
STATUS_CODEX="PENDING"
STATUS_REAPER="PENDING"

FAILED_COUNT=0
MISSING_COUNT=0
SUCCESS_COUNT=0

log "Starting WebJamApps developer tools update..."

# ------------------------------------------------------------------------------
# 1. Claude Code: claude update
# ------------------------------------------------------------------------------
log "------------------------------------------------------------"
log "[1/4] Checking Claude Code ($CLAUDE_BIN)..."
if ! command -v "$CLAUDE_BIN" >/dev/null 2>&1 && [ ! -f "$CLAUDE_BIN" ]; then
	warn "Claude Code CLI not found (install via 'curl -fsSL https://claude.ai/install.sh | bash')"
	STATUS_CLAUDE="SKIPPED (not installed)"
	MISSING_COUNT=$((MISSING_COUNT + 1))
elif [ "$DRY_RUN" = true ]; then
	log "(dry-run) Would execute: $CLAUDE_BIN update"
	STATUS_CLAUDE="DRY-RUN"
else
	log "Executing: $CLAUDE_BIN update"
	claude_exit=0
	"$CLAUDE_BIN" update || claude_exit=$?
	if [ "$claude_exit" -eq 0 ]; then
		STATUS_CLAUDE="SUCCESS"
		SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
	else
		error "Claude Code update failed with exit code $claude_exit"
		STATUS_CLAUDE="FAILED"
		FAILED_COUNT=$((FAILED_COUNT + 1))
	fi
fi

# ------------------------------------------------------------------------------
# 2. Antigravity: agy update
# ------------------------------------------------------------------------------
log "------------------------------------------------------------"
log "[2/4] Checking Antigravity CLI ($AGY_BIN)..."
if ! command -v "$AGY_BIN" >/dev/null 2>&1 && [ ! -f "$AGY_BIN" ]; then
	warn "Antigravity CLI not found (configure ~/.local/bin/agy and run 'agy install')"
	STATUS_AGY="SKIPPED (not installed)"
	MISSING_COUNT=$((MISSING_COUNT + 1))
elif [ "$DRY_RUN" = true ]; then
	log "(dry-run) Would execute: $AGY_BIN update"
	STATUS_AGY="DRY-RUN"
else
	log "Executing: $AGY_BIN update"
	agy_exit=0
	"$AGY_BIN" update || agy_exit=$?
	if [ "$agy_exit" -eq 0 ]; then
		STATUS_AGY="SUCCESS"
		SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
	else
		error "Antigravity update failed with exit code $agy_exit"
		STATUS_AGY="FAILED"
		FAILED_COUNT=$((FAILED_COUNT + 1))
	fi
fi

# ------------------------------------------------------------------------------
# 3. OpenAI Codex: codex update
# ------------------------------------------------------------------------------
log "------------------------------------------------------------"
log "[3/4] Checking OpenAI Codex CLI ($CODEX_BIN)..."
if ! command -v "$CODEX_BIN" >/dev/null 2>&1 && [ ! -f "$CODEX_BIN" ]; then
	warn "OpenAI Codex CLI not found (install via 'curl -fsSL https://chatgpt.com/codex/install.sh | sh')"
	STATUS_CODEX="SKIPPED (not installed)"
	MISSING_COUNT=$((MISSING_COUNT + 1))
elif [ "$DRY_RUN" = true ]; then
	log "(dry-run) Would execute: $CODEX_BIN update"
	STATUS_CODEX="DRY-RUN"
else
	log "Executing: $CODEX_BIN update"
	codex_exit=0
	"$CODEX_BIN" update || codex_exit=$?
	if [ "$codex_exit" -eq 0 ]; then
		STATUS_CODEX="SUCCESS"
		SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
	else
		error "OpenAI Codex update failed with exit code $codex_exit"
		STATUS_CODEX="FAILED"
		FAILED_COUNT=$((FAILED_COUNT + 1))
	fi
fi

# ------------------------------------------------------------------------------
# 4. REAPER: reaper-update
# ------------------------------------------------------------------------------
log "------------------------------------------------------------"
log "[4/4] Checking REAPER updater..."
if ! reaper_cmd=$(resolve_reaper_cmd); then
	warn "REAPER updater not found (run via 'bash scripts/reaper-update.sh' or symlink to ~/.local/bin/reaper-update)"
	STATUS_REAPER="SKIPPED (not installed)"
	MISSING_COUNT=$((MISSING_COUNT + 1))
elif [ "$DRY_RUN" = true ]; then
	log "(dry-run) Would execute: $reaper_cmd"
	STATUS_REAPER="DRY-RUN"
else
	log "Executing: $reaper_cmd"
	reaper_exit=0
	if [ -f "$reaper_cmd" ] && [ ! -x "$reaper_cmd" ]; then
		bash "$reaper_cmd" || reaper_exit=$?
	else
		"$reaper_cmd" || reaper_exit=$?
	fi

	if [ "$reaper_exit" -eq 0 ]; then
		STATUS_REAPER="SUCCESS"
		SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
	else
		error "REAPER update failed with exit code $reaper_exit"
		STATUS_REAPER="FAILED"
		FAILED_COUNT=$((FAILED_COUNT + 1))
	fi
fi

# ------------------------------------------------------------------------------
# Summary and Exit
# ------------------------------------------------------------------------------
log "==================== Summary ===================="
printf "[update-all] %-16s %s\n" "claude update:" "$STATUS_CLAUDE"
printf "[update-all] %-16s %s\n" "agy update:" "$STATUS_AGY"
printf "[update-all] %-16s %s\n" "codex update:" "$STATUS_CODEX"
printf "[update-all] %-16s %s\n" "reaper-update:" "$STATUS_REAPER"
log "================================================="

if [ "$FAILED_COUNT" -gt 0 ]; then
	error "Update completed with $FAILED_COUNT failure(s)."
	exit 1
fi

if [ "$MISSING_COUNT" -eq 4 ]; then
	error "No developer tools were found to update."
	exit 1
fi

if [ "$FAIL_ON_MISSING" = true ] && [ "$MISSING_COUNT" -gt 0 ]; then
	error "Strict mode failed: $MISSING_COUNT tool(s) missing or not installed."
	exit 1
fi

if [ "$DRY_RUN" = true ]; then
	log "Dry run completed successfully."
else
	log "All available developer tool updates completed successfully ($SUCCESS_COUNT succeeded)."
fi

exit 0
