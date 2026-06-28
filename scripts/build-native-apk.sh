#!/usr/bin/env bash
set -euo pipefail

# Build the native (Lanka-vs / ExoPlayer) kiosk APK. The server URL is
# compile-time (BuildConfig.LANKA_SERVER_URL), so "dev" and "prod" are separate
# builds pointed at different servers.
#
# Usage:
#   scripts/build-native-apk.sh            # both (dev + prod)
#   scripts/build-native-apk.sh dev        # dev only
#   scripts/build-native-apk.sh prod       # prod only
#   scripts/build-native-apk.sh http://host:port   # an explicit URL
#
# Override the baked-in target URLs via env:
#   LANKA_DEV_URL  (default http://100.123.113.86:5100 — dev box: local dev server on the tailnet, :5100)
#   LANKA_PROD_URL (default http://100.79.177.86        — prod box: Hetzner, nginx tailnet block :80)
# If a target's tailnet IP changes, pass the env override or edit the default here.
#
# Output (copied next to the gradle artifact, so dev+prod coexist on disk):
#   android/app/build/outputs/apk/native/debug/app-native-debug-DEV.apk
#   android/app/build/outputs/apk/native/debug/app-native-debug-PROD.apk
# Both share applicationId ai.lanka.kiosk.vs, so only ONE can be installed on a
# given box at a time (install with: adb install -r <apk>).

DEV_URL="${LANKA_DEV_URL:-http://100.123.113.86:5100}"
PROD_URL="${LANKA_PROD_URL:-http://100.79.177.86}"

cd "$(dirname "$0")/../android"
OUT_DIR="app/build/outputs/apk/native/debug"

build() {
  local label="$1" url="$2"
  echo "==> native APK ($label) → $url"
  ./gradlew :app:assembleNativeDebug -PLANKA_SERVER_URL="$url" --console=plain
  cp "$OUT_DIR/app-native-debug.apk" "$OUT_DIR/app-native-debug-${label}.apk"
  echo "    → $OUT_DIR/app-native-debug-${label}.apk"
}

case "${1:-both}" in
  dev)   build DEV  "$DEV_URL" ;;
  prod)  build PROD "$PROD_URL" ;;
  both)  build DEV  "$DEV_URL"; build PROD "$PROD_URL" ;;
  http*) build CUSTOM "$1" ;;
  *)     echo "usage: $0 [dev|prod|both|<http(s)-url>]" >&2; exit 1 ;;
esac
