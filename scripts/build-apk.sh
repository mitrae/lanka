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
# Output (copied next to the gradle artifact, so dev+prod coexist on disk;
# <version> comes from android/version.properties):
#   android/app/build/outputs/apk/debug/lanka-kiosk-<version>-DEV.apk
#   android/app/build/outputs/apk/debug/lanka-kiosk-<version>-PROD.apk

DEV_URL="${LANKA_DEV_URL:-http://100.123.113.86:5100}"
PROD_URL="${LANKA_PROD_URL:-http://100.79.177.86}"
PIN_ARG=()
# Fall back to .env (gitignored) so the PIN never has to be typed or exported —
# a build without it silently ships NO escape hatch. Parsed with grep rather
# than `source`, because .env holds unquoted values (e.g. MAIL_FROM=Lanka
# <no-reply@...>) that make the shell choke on redirection syntax.
if [[ -z "${LANKA_KIOSK_PIN:-}" && -f "$(dirname "$0")/../.env" ]]; then
  LANKA_KIOSK_PIN="$(grep -E '^LANKA_KIOSK_PIN=' "$(dirname "$0")/../.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
if [[ -n "${LANKA_KIOSK_PIN:-}" ]]; then
  PIN_ARG=(-PKIOSK_PIN="$LANKA_KIOSK_PIN")
else
  echo "!! LANKA_KIOSK_PIN unset and not in .env — this APK will have NO PIN escape hatch." >&2
fi

cd "$(dirname "$0")/../android"
OUT_DIR="app/build/outputs/apk/debug"
# The version lives in android/version.properties (gradle reads the same file),
# so the output name can carry it: readable in a file picker, and a hint the
# dashboard pre-fills from. The server still reads the manifest -- the name is a
# label, never the truth.
VERSION="$(grep -E '^versionName=' version.properties | cut -d= -f2 | tr -d ' \r')"
[[ -n "$VERSION" ]] || { echo "!! versionName missing from android/version.properties" >&2; exit 1; }

build() {
  local label="$1" url="$2"
  echo "==> APK ($label, $VERSION) → $url"
  ./gradlew :app:assembleDebug -PLANKA_SERVER_URL="$url" "${PIN_ARG[@]}" --console=plain
  local out="$OUT_DIR/lanka-kiosk-${VERSION}-${label}.apk"
  cp "$OUT_DIR/app-debug.apk" "$out"
  echo "    → $out"
}

case "${1:-both}" in
  dev)   build DEV  "$DEV_URL" ;;
  prod)  build PROD "$PROD_URL" ;;
  both)  build DEV  "$DEV_URL"; build PROD "$PROD_URL" ;;
  http*) build CUSTOM "$1" ;;
  *)     echo "usage: $0 [dev|prod|both|<http(s)-url>]" >&2; exit 1 ;;
esac
