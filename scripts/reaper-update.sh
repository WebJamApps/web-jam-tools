#!/usr/bin/env bash

# REAPER Updater
# Download and install the latest REAPER version to a specified prefix
# Usage: ./reaper-update.sh
# Environment variables:
#   REAPER_PREFIX (default: /home/joshua/opt)

set -euo pipefail

# Configuration
REAPER_PREFIX="${REAPER_PREFIX:-/home/joshua/opt}"
REAPER_PATH="$REAPER_PREFIX/REAPER"
WHATSNEW="$REAPER_PATH/whatsnew.txt"
BASE_URL="https://www.reaper.fm/files/7.x"

# Cleanup on exit
# shellcheck disable=SC2317
cleanup() {
	if [ -n "${tmpdir:-}" ] && [ -d "$tmpdir" ]; then
		rm -rf "$tmpdir"
	fi
}
trap cleanup EXIT

# Helper functions
log() {
	echo "[reaper-update] $*"
}

error() {
	echo "[reaper-update] ERROR: $*" >&2
	exit 1
}

# Check if REAPER installation exists
if [ ! -f "$WHATSNEW" ]; then
	error "REAPER not found at $REAPER_PATH"
fi

# Extract installed version from whatsnew.txt
# Expected format: "v7.77 - July 7 2026"
if ! installed_version=$(head -1 "$WHATSNEW" | grep -oE 'v[0-9]+\.[0-9]+' | sed 's/v//'); then
	error "Could not determine installed REAPER version from $WHATSNEW"
fi

log "Installed version: $installed_version"

# Fetch the latest version info from REAPER download page
# We look for the reaper###_linux_x86_64.tar.xz pattern
log "Checking for latest version..."
page_content=$(curl -s "https://www.reaper.fm/download.php" | grep -oE 'reaper[0-9]+_linux_x86_64\.tar\.xz' | head -1 || true)

if [ -z "$page_content" ]; then
	error "Could not find latest REAPER download link. Please check https://www.reaper.fm/download.php"
fi

# Extract version number from filename (e.g., reaper778 -> 7.78)
filename="$page_content"
version_num=$(echo "$filename" | grep -oE '[0-9]+' | head -1)
if [ -z "$version_num" ] || [ ${#version_num} -lt 3 ]; then
	error "Could not parse version number from $filename"
fi

# Convert version number to dotted format (e.g., 778 -> 7.78)
# Split into major (first digit) and minor (rest of digits)
# shellcheck disable=SC2001
latest_version=$(echo "$version_num" | sed 's/\(.\)\(.*\)/\1.\2/')

log "Latest version: $latest_version"

# Check if already up to date
if [ "$installed_version" = "$latest_version" ]; then
	log "REAPER is already up to date ($installed_version)"
	exit 0
fi

# Safety check: ensure REAPER is not running
if pgrep -x reaper >/dev/null 2>&1; then
	error "REAPER is currently running. Please quit REAPER before updating."
fi

# Create temporary directory for download and extraction
tmpdir=$(mktemp -d -t reaper-update-XXXXXX)
log "Using temporary directory: $tmpdir"

# Download the tarball
tarball_url="$BASE_URL/reaper${version_num}_linux_x86_64.tar.xz"
tarball_path="$tmpdir/reaper.tar.xz"

log "Downloading from $tarball_url"
if ! curl -f -L -o "$tarball_path" "$tarball_url"; then
	error "Failed to download REAPER from $tarball_url"
fi

log "Verifying download..."
if [ ! -f "$tarball_path" ]; then
	error "Download file not found: $tarball_path"
fi

# Extract tarball
extract_dir="$tmpdir/reaper-extract"
mkdir -p "$extract_dir"
log "Extracting tarball..."
if ! tar -xf "$tarball_path" -C "$extract_dir"; then
	error "Failed to extract tarball"
fi

# The tarball structure is: reaper_linux_x86_64/REAPER/...
# Find the actual REAPER directory
reaper_dir=$(find "$extract_dir" -maxdepth 2 -type d -name "REAPER" | head -1)
if [ -z "$reaper_dir" ] || [ ! -d "$reaper_dir" ]; then
	error "Could not find REAPER directory in extracted tarball"
fi

# Run the installer script with the prefix
log "Installing REAPER to $REAPER_PREFIX..."
install_script="$(dirname "$reaper_dir")/install-reaper.sh"

if [ ! -f "$install_script" ]; then
	error "Could not find install-reaper.sh in tarball"
fi

if ! bash "$install_script" --install "$REAPER_PREFIX" --quiet; then
	error "Installation failed. Check $REAPER_PATH for any partial changes."
fi

log "Installation complete!"
log "Updated REAPER from $installed_version to $latest_version"
log "Config preserved in ~/.config/REAPER"

exit 0
