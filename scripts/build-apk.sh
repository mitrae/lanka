#!/usr/bin/env bash
set -euo pipefail

# Build the Lanka kiosk APK (one package, both player surfaces — the surface is
# chosen per box from the dashboard). The server URL is compile-time
# (BuildConfig.LANKA_SERVER_URL), so "dev" and "prod" are separate builds.
#
# Usage:
#   scripts/build-apk.sh            # both (dev + prod)
#   scripts/build-apk.sh dev        # dev only
#   scripts/build-apk.sh prod       # prod only
#   scripts/build-apk.sh http://host:port   # an explicit URL
#
# Env:
#   LANKA_DEV_URL   (default http://100.123.113.86:5100 — dev box: local dev server on the tailnet, :5100)
#   LANKA_PROD_URL  (default http://100.79.177.86        — prod box: Hetzner, nginx tailnet block :80)
#   LANKA_KIOSK_PIN (optional; 4+ digits → baked PIN escape hatch, see android/README.md)
#
# Output (copied next to the gradle artifact, so dev+prod coexist on disk):
#   android/app/build/outputs/apk/debug/app-debug-DEV.apk
#   android/app/build/outputs/apk/debug/app-debug-PROD.apk

DEV_URL="${LANKA_DEV_URL:-http://100.123.113.86:5100}"
PROD_URL="${LANKA_PROD_URL:-http://100.79.177.86}"
PIN_ARG=()
if [[ -n "${LANKA_KIOSK_PIN:-}" ]]; then PIN_ARG=(-PKIOSK_PIN="$LANKA_KIOSK_PIN"); fi

cd "$(dirname "$0")/../android"
OUT_DIR="app/build/outputs/apk/debug"

build() {
  local label="$1" url="$2"
  echo "==> APK ($label) → $url"
  ./gradlew :app:assembleDebug -PLANKA_SERVER_URL="$url" "${PIN_ARG[@]}" --console=plain
  cp "$OUT_DIR/app-debug.apk" "$OUT_DIR/app-debug-${label}.apk"
  echo "    → $OUT_DIR/app-debug-${label}.apk"
}

case "${1:-both}" in
  dev)   build DEV  "$DEV_URL" ;;
  prod)  build PROD "$PROD_URL" ;;
  both)  build DEV  "$DEV_URL"; build PROD "$PROD_URL" ;;
  http*) build CUSTOM "$1" ;;
  *)     echo "usage: $0 [dev|prod|both|<http(s)-url>]" >&2; exit 1 ;;
esac
