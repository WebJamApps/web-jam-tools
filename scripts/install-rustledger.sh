#!/usr/bin/env bash
# Install rustledger's `rledger` for Linux into <dest-dir>, from the pinned release download,
# after checking it against the SHA-256 checksum published beside that download
# (web-jam-music-media-design.md, "The program" and "Testing the accounting commands";
# web-jam-tools#1865). CircleCI installs it with this script, and the accounting tests unpack
# it into a temporary directory with it, so both run the same release.
#
# Usage: scripts/install-rustledger.sh <dest-dir>
set -euo pipefail

VERSION="v0.24.0"
TARGET="x86_64-unknown-linux-gnu"

dest="${1:-}"
if [ -z "$dest" ]; then
  echo "usage: install-rustledger.sh <dest-dir>" >&2
  exit 2
fi

name="rustledger-${VERSION}-${TARGET}.tar.gz"
url="https://github.com/rustledger/rustledger/releases/download/${VERSION}/${name}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() {
  curl -fsSL --retry 3 --retry-all-errors --retry-delay 3 \
    --connect-timeout 15 --max-time 300 -o "$2" "$1"
}

fetch "$url" "$work/$name"
fetch "$url.sha256" "$work/$name.sha256"

expected="$(awk 'NR == 1 { print $1 }' "$work/$name.sha256")"
if ! [[ "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "install-rustledger: the published checksum for $name cannot be read; nothing installed." >&2
  exit 1
fi
actual="$(sha256sum "$work/$name" | awk '{ print $1 }')"
if [ "$actual" != "$expected" ]; then
  echo "install-rustledger: $name does not match its published checksum; nothing installed." >&2
  exit 1
fi

tar -xzf "$work/$name" -C "$work" rledger
mkdir -p "$dest"
install -m 0755 "$work/rledger" "$dest/rledger"
"$dest/rledger" --version
