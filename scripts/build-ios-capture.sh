#!/usr/bin/env bash
# Builds the macOS iPhone screen-capture helper (native/macos/ios-capture).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos/ios-capture"
OUT="$ROOT/native/macos/build"
[[ "$(uname)" == "Darwin" ]] || { echo "ios-capture is macOS only; skipping"; exit 0; }
mkdir -p "$OUT"
# The Info.plist is embedded so macOS can show the camera permission prompt.
xcrun swiftc -O -o "$OUT/ios-capture" "$SRC/main.swift" "$ROOT/native/shared/AacEncoder.swift" \
  -framework AVFoundation -framework CoreMediaIO -framework VideoToolbox -framework CoreMedia \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SRC/Info.plist"
echo "Built $OUT/ios-capture"
