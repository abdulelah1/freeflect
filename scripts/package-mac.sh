#!/usr/bin/env bash
# Packages the staged parts into a DMG. electron-builder works in a folder
# outside ~/Desktop and ~/Documents: macOS adds extended attributes to files
# there, and code signing refuses them. The DMG is copied to release/dist.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${MIRROR_PACKAGE_DIR:-$HOME/Library/Caches/mirror-release}"
rm -rf "$WORK" && mkdir -p "$WORK" "$ROOT/release/dist"
cd "$ROOT/apps/desktop"
npx electron-vite build
CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}" \
  npx electron-builder --mac --publish never -c.directories.output="$WORK"
cp "$WORK"/*.dmg "$ROOT/release/dist/"
ls -lh "$ROOT/release/dist/"*.dmg
