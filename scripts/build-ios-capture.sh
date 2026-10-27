#!/usr/bin/env bash
# Builds the macOS iPhone screen-capture helper (native/macos/ios-capture).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/macos/ios-capture"
OUT="$ROOT/native/macos/build"
[[ "$(uname)" == "Darwin" ]] || { echo "ios-capture is macOS only; skipping"; exit 0; }
mkdir -p "$OUT"
# Universal (Apple Silicon + Intel) so one helper serves both DMGs.
# The Info.plist is embedded so macOS can show the camera permission prompt.
for arch in arm64 x86_64; do
  xcrun swiftc -O -target "$arch-apple-macos13.0" -o "$OUT/ios-capture-$arch" "$SRC/main.swift" "$ROOT/native/shared/AacEncoder.swift" \
    -framework AVFoundation -framework CoreMediaIO -framework VideoToolbox -framework CoreMedia \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SRC/Info.plist"
done
lipo -create -output "$OUT/ios-capture" "$OUT/ios-capture-arm64" "$OUT/ios-capture-x86_64"
rm -f "$OUT/ios-capture-arm64" "$OUT/ios-capture-x86_64"
echo "Built $OUT/ios-capture"
