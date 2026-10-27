#!/usr/bin/env bash
# Packages the staged parts into a DMG. electron-builder works in a folder
# outside ~/Desktop and ~/Documents: macOS adds extended attributes to files
# there, and code signing refuses them. The DMG is copied to release/dist.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${ARCH:-$(uname -m | sed s/x86_64/x64/)}"
WORK="${MIRROR_PACKAGE_DIR:-$HOME/Library/Caches/mirror-release}/$ARCH"
rm -rf "$WORK" && mkdir -p "$WORK" "$ROOT/release/dist"
cd "$ROOT/apps/desktop"
npx electron-vite build
# CSC_NAME names a Developer ID Application certificate (in the keychain, or
# in CSC_LINK): the build is signed with it and the hardened runtime.
# Otherwise it is signed ad hoc.
SIGNING=()
if [[ -n "${CSC_NAME:-}" ]]; then
  SIGNING=(-c.mac.identity="$CSC_NAME" -c.mac.hardenedRuntime=true)
fi
CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}" \
  npx electron-builder --mac "--$ARCH" --publish never -c.directories.output="$WORK" ${SIGNING[@]+"${SIGNING[@]}"}
cp "$WORK"/*.dmg "$ROOT/release/dist/"
ls -lh "$ROOT/release/dist/"*.dmg
