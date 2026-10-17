#!/usr/bin/env bash
# Builds android-server into a dex jar runnable with app_process. No Gradle needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
PLATFORM="${ANDROID_PLATFORM:-android-36}"
BUILD_TOOLS="${ANDROID_BUILD_TOOLS:-$(ls "$SDK/build-tools" | sort -V | tail -1)}"
ANDROID_JAR="$SDK/platforms/$PLATFORM/android.jar"
OUT="$ROOT/android-server/build"

[[ -f "$ANDROID_JAR" ]] || { echo "Missing $ANDROID_JAR (set ANDROID_HOME / ANDROID_PLATFORM)" >&2; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT/classes"
# Hidden framework interfaces are compiled from stubs but not packaged: the
# device's boot classpath provides the real ones.
javac --release 11 -Xlint:-options -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find "$ROOT/android-server/src" "$ROOT/android-server/stubs" -name '*.java')
"$SDK/build-tools/$BUILD_TOOLS/d8" --release --min-api 26 --lib "$ANDROID_JAR" \
  --output "$OUT/mirror-server.jar" $(find "$OUT/classes/com" -name '*.class')
echo "Built $OUT/mirror-server.jar"
