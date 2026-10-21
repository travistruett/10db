#!/usr/bin/env bash
# Builds the Apple Silicon DMG into dist/release/ and writes dist/release/SHA256SUMS.
#   signed    Tauri signs the app and the DMG with the Developer ID certificate, and notarizes
#             and staples the app. This script then notarizes and staples the DMG, and checks
#             the DMG and the app inside it with Gatekeeper. Needs APPLE_CERTIFICATE,
#             APPLE_CERTIFICATE_PASSWORD, APPLE_API_KEY, APPLE_API_ISSUER, APPLE_API_KEY_PATH
#             and APPLE_TEAM_ID.
#   unsigned  No signing and no notarization, for dry runs. Gatekeeper rejects the result.
set -euo pipefail

usage() { echo "usage: build-macos.sh signed|unsigned" >&2; exit 2; }
fail() { echo "build-macos.sh: $*" >&2; exit 1; }

mode="${1:-}"
[ "$mode" = signed ] || [ "$mode" = unsigned ] || usage

if [ "$mode" = signed ]; then
  missing=0
  for name in APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH APPLE_TEAM_ID; do
    if [ -z "${!name:-}" ]; then
      echo "build-macos.sh: $name is not set" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || exit 1
  [ -f "$APPLE_API_KEY_PATH" ] || fail "APPLE_API_KEY_PATH does not point to a file"
fi

[ "$(uname -s)-$(uname -m)" = Darwin-arm64 ] || fail "needs an Apple Silicon Mac, got $(uname -s)-$(uname -m)"

root="$(cd "$(dirname "$0")/../.." && pwd)"
target=aarch64-apple-darwin
bundle="$root/apps/desktop/src-tauri/target/$target/release/bundle"
out="$root/dist/release"
rm -rf "$bundle" "$out"
mkdir -p "$out"

if [ "$mode" = signed ]; then
  pnpm --filter @10db/desktop tauri build --target "$target" --bundles dmg
else
  pnpm --filter @10db/desktop tauri build --target "$target" --bundles dmg --no-sign
fi

shopt -s nullglob
dmgs=("$bundle"/dmg/*.dmg)
[ "${#dmgs[@]}" -eq 1 ] || fail "expected one DMG in $bundle/dmg, found ${#dmgs[@]}"
dmg="$out/$(basename "${dmgs[0]}")"
cp "${dmgs[0]}" "$dmg"

team_of() { codesign --display --verbose=4 "$1" 2>&1 | sed -n 's/^TeamIdentifier=//p'; }
json_field() { node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).$2" "$1"; }

if [ "$mode" = signed ]; then
  codesign --verify --strict --verbose=2 "$dmg"
  [ "$(team_of "$dmg")" = "$APPLE_TEAM_ID" ] || fail "the DMG is not signed by team $APPLE_TEAM_ID"
  result="$(mktemp)"
  xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" \
    --issuer "$APPLE_API_ISSUER" --wait --output-format json > "$result"
  status="$(json_field "$result" status)"
  if [ "$status" != Accepted ]; then
    xcrun notarytool log "$(json_field "$result" id)" --key "$APPLE_API_KEY_PATH" \
      --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" >&2 || true
    fail "notarization of the DMG ended with status $status"
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"
fi

mount="$(mktemp -d)"
hdiutil attach -nobrowse -readonly -mountpoint "$mount" "$dmg" > /dev/null
trap 'hdiutil detach "$mount" -quiet || true' EXIT
apps=("$mount"/*.app)
[ "${#apps[@]}" -eq 1 ] || fail "expected one app in the DMG, found ${#apps[@]}"
app="${apps[0]}"
binaries=("$app"/Contents/MacOS/*)
[ "$(lipo -archs "${binaries[0]}")" = arm64 ] || fail "$(basename "${binaries[0]}") is not arm64-only"
if [ "$mode" = signed ]; then
  codesign --verify --deep --strict --verbose=2 "$app"
  [ "$(team_of "$app")" = "$APPLE_TEAM_ID" ] || fail "the app is not signed by team $APPLE_TEAM_ID"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=4 "$app"
fi
hdiutil detach "$mount" -quiet
trap - EXIT

(cd "$out" && shasum -a 256 -- *.dmg > SHA256SUMS)
echo "build-macos.sh: $mode build ready in dist/release/"
cat "$out/SHA256SUMS"
