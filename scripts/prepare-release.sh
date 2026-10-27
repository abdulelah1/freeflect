#!/usr/bin/env bash
# Builds every part of the macOS app and stages it in release/staging for
# electron-builder (apps/desktop/electron-builder.yml):
#   native addon, Android server, iPhone capture helper, adb, and the Mirror
#   iPhone app project (with its generated Xcode project) that the desktop
#   app builds and installs on the user's iPhone.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ARCH=arm64 (Apple Silicon) or x64 (Intel); defaults to this Mac's.
ARCH="${ARCH:-$(uname -m | sed s/x86_64/x64/)}"
case "$ARCH" in
  arm64) RUST_TARGET=aarch64-apple-darwin ;;
  x64) RUST_TARGET=x86_64-apple-darwin ;;
  *) echo "Unknown ARCH $ARCH (use arm64 or x64)" >&2; exit 1 ;;
esac
STAGE="$ROOT/release/staging"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
[[ "$(uname)" == "Darwin" ]] || { echo "The macOS release builds on a Mac" >&2; exit 1; }

cd "$ROOT"
(cd crates/node-bindings && npx napi build --platform --release --target "$RUST_TARGET")
pnpm build:server
pnpm build:ios-capture

rm -rf "$STAGE" && mkdir -p "$STAGE/native" "$STAGE/platform-tools" "$STAGE/companion/native/ios"
cp android-server/build/mirror-server.jar "$STAGE/"
cp native/macos/build/ios-capture "$STAGE/"
cp "crates/node-bindings/mirror-native.darwin-$ARCH.node" "$STAGE/native/"

# adb: from the SDK, or Google's platform-tools download (CI).
if [[ ! -x "$SDK/platform-tools/adb" ]]; then
  curl -fsSL -o "$ROOT/release/platform-tools.zip" https://dl.google.com/android/repository/platform-tools-latest-darwin.zip
  unzip -q -o "$ROOT/release/platform-tools.zip" -d "$ROOT/release"
  SDK="$ROOT/release"
fi
cp "$SDK/platform-tools/adb" "$STAGE/platform-tools/"
cp "$SDK/platform-tools/NOTICE.txt" "$STAGE/platform-tools/" 2>/dev/null || true

# The iPhone app project. XcodeGen writes the Xcode project once here, so
# users only need Xcode, not XcodeGen.
command -v xcodegen >/dev/null || { echo "Install XcodeGen: brew install xcodegen" >&2; exit 1; }
(cd native/ios/MirrorCompanion && xcodegen generate --quiet)
rsync -a --exclude 'xcuserdata' --exclude '*.xcuserstate' native/ios/MirrorCompanion "$STAGE/companion/native/ios/"
rsync -a native/shared "$STAGE/companion/native/"
xattr -cr "$STAGE"
echo "Staged $ARCH in $STAGE"
