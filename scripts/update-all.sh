#!/usr/bin/env bash

# Master Update Script for WebJamApps Development Environment
# Updates Claude Code, Antigravity (agy), OpenAI Codex, REAPER and GitHub MCP in sequence:
#   1. claude update
#   2. agy update
#   3. codex update
#   4. reaper-update
#   5. latest github-mcp-server release (checksum verified, installed to ~/.local/bin)
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

# Resolve the ~/.local/bin/update-all symlink so the reaper-update.sh fallback finds scripts/.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

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
  5. github-mcp-server (latest Linux release, verified against release checksums)

Options:
  -h, --help             Show this help message and exit
  -n, --dry-run          Display the commands that would run without executing them
  -s, --strict, --fail-on-missing
                         Exit with non-zero status if any tool is missing

Invocation:
  update-all             (when symlinked to ~/.local/bin/update-all)
  deno task update:all   (from web-jam-tools repository)
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
  GitHub MCP:            Installed automatically to ~/.local/bin/github-mcp-server
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

# Stage on the destination filesystem so the final rename is atomic. No installed
# program is touched until both downloads, checksum verification and extraction pass.
update_github_mcp() (
	local stage archive platform archive_url checksums_url checksum
	case "$(uname -s):$(uname -m)" in
		Linux:x86_64) platform=x86_64 ;;
		Linux:aarch64|Linux:arm64) platform=arm64 ;;
		Linux:i386|Linux:i686) platform=i386 ;;
		*) warn "GitHub MCP update supports Linux x86_64, arm64 and i386 only"; return 1 ;;
	esac
	archive="github-mcp-server_Linux_${platform}.tar.gz"
	mkdir -p "$HOME/.local/bin" || return 1
	stage=$(mktemp -d "$HOME/.local/bin/.github-mcp-update.XXXXXX") || return 1
	trap 'rm -rf -- "$stage"' EXIT
	curl --fail --silent --show-error --location --connect-timeout 10 --max-time 120 \
		-o "$stage/release.json" https://api.github.com/repos/github/github-mcp-server/releases/latest || return 1
	archive_url=$(jq -er --arg name "$archive" \
		'[.assets[] | select(.name == $name) | .browser_download_url] | if length == 1 then .[0] else error("missing or duplicate archive") end' \
		"$stage/release.json") || return 1
	checksums_url=$(jq -er \
		'[.assets[] | select(.name | test("^github-mcp-server_[0-9][^/]*_checksums\\.txt$")) | .browser_download_url] | if length == 1 then .[0] else error("missing or duplicate checksums") end' \
		"$stage/release.json") || return 1
	# Only release assets from the official repository are accepted.
	case "$archive_url" in https://github.com/github/github-mcp-server/releases/download/*) ;; *) return 1 ;; esac
	case "$checksums_url" in https://github.com/github/github-mcp-server/releases/download/*) ;; *) return 1 ;; esac
	curl --fail --silent --show-error --location --connect-timeout 10 --max-time 120 \
		-o "$stage/$archive" "$archive_url" || return 1
	curl --fail --silent --show-error --location --connect-timeout 10 --max-time 120 \
		-o "$stage/checksums.txt" "$checksums_url" || return 1
	checksum=$(awk -v name="$archive" '
		{ sub(/^\*/, "", $2) }
		$2 == name && length($1) == 64 && $1 ~ /^[[:xdigit:]]+$/ { hash = $1; count++ }
		END { if (count != 1) exit 1; print hash }
	' "$stage/checksums.txt") || return 1
	printf '%s  %s\n' "$checksum" "$archive" > "$stage/verify.txt" || return 1
	(cd "$stage" && sha256sum --check --status verify.txt) || return 1
	tar -xzf "$stage/$archive" -C "$stage" --no-same-owner --no-same-permissions github-mcp-server || return 1
	[ -f "$stage/github-mcp-server" ] && [ ! -L "$stage/github-mcp-server" ] || return 1
	chmod 755 "$stage/github-mcp-server" || return 1
	mv -f -- "$stage/github-mcp-server" "$HOME/.local/bin/github-mcp-server" || return 1
)

STATUS_CLAUDE="PENDING"
STATUS_AGY="PENDING"
STATUS_CODEX="PENDING"
STATUS_REAPER="PENDING"
STATUS_GITHUB_MCP="PENDING"

FAILED_COUNT=0
MISSING_COUNT=0
SUCCESS_COUNT=0

log "Starting WebJamApps developer tools update..."

# ------------------------------------------------------------------------------
# 1. Claude Code: claude update
# ------------------------------------------------------------------------------
log "------------------------------------------------------------"
log "[1/5] Checking Claude Code ($CLAUDE_BIN)..."
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
log "[2/5] Checking Antigravity CLI ($AGY_BIN)..."
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
log "[3/5] Checking OpenAI Codex CLI ($CODEX_BIN)..."
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
log "[4/5] Checking REAPER updater..."
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
# 5. GitHub MCP: latest official Linux release, token-free public downloads
# ------------------------------------------------------------------------------
log "------------------------------------------------------------"
log "[5/5] Checking GitHub MCP server..."
github_mcp_missing=false
for dependency in curl jq sha256sum tar; do
	if ! command -v "$dependency" >/dev/null 2>&1; then
		warn "GitHub MCP updater requires $dependency"
		github_mcp_missing=true
	fi
done
if [ "$github_mcp_missing" = true ]; then
	STATUS_GITHUB_MCP="SKIPPED (missing dependencies)"
	MISSING_COUNT=$((MISSING_COUNT + 1))
elif [ "$DRY_RUN" = true ]; then
	log "(dry-run) Would download and checksum-verify the latest GitHub MCP Linux release to ~/.local/bin/github-mcp-server"
	STATUS_GITHUB_MCP="DRY-RUN"
elif update_github_mcp; then
	STATUS_GITHUB_MCP="SUCCESS"
	SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
else
	warn "GitHub MCP update failed; keeping the installed program (if any). Continuing."
	STATUS_GITHUB_MCP="FAILED"
	FAILED_COUNT=$((FAILED_COUNT + 1))
fi

# ------------------------------------------------------------------------------
# Summary and Exit
# ------------------------------------------------------------------------------
log "==================== Summary ===================="
printf "[update-all] %-16s %s\n" "claude update:" "$STATUS_CLAUDE"
printf "[update-all] %-16s %s\n" "agy update:" "$STATUS_AGY"
printf "[update-all] %-16s %s\n" "codex update:" "$STATUS_CODEX"
printf "[update-all] %-16s %s\n" "reaper-update:" "$STATUS_REAPER"
printf "[update-all] %-16s %s\n" "github-mcp:" "$STATUS_GITHUB_MCP"
log "================================================="

if [ "$FAILED_COUNT" -gt 0 ]; then
	error "Update completed with $FAILED_COUNT failure(s)."
	exit 1
fi

if [ "$MISSING_COUNT" -eq 5 ]; then
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
