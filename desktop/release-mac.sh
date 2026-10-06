#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Run this script on macOS.' >&2
  exit 1
fi

: "${MACOS_DEVELOPER_ID_P12_BASE64:?Missing Developer ID certificate}"
: "${MACOS_DEVELOPER_ID_P12_PASSWORD:?Missing certificate export password}"
: "${APPLE_APP_PASSWORD:?Missing Apple ID app-specific password}"
: "${APPLE_NOTARY_APPLE_ID:?Missing Apple ID for notarization}"
: "${APPLE_TEAM_ID:?Missing Apple Developer team ID}"

version="${1:?Pass the release version without its leading v}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="$root/desktop/bin/Muxterm.app"
dmg="$root/desktop/bin/Muxterm-${version}-macos-arm64.dmg"
work="$(mktemp -d)"
keychain="$work/release.keychain-db"
previous_default="$(security default-keychain -d user | sed -e 's/^ *"//' -e 's/"$//')"

cleanup() {
  if [[ -n "$previous_default" ]]; then
    security default-keychain -d user -s "$previous_default" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

printf '%s' "$MACOS_DEVELOPER_ID_P12_BASE64" | base64 -D > "$work/developer-id.p12"
security create-keychain -p '' "$keychain"
security default-keychain -d user -s "$keychain"
security unlock-keychain -p '' "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security import "$work/developer-id.p12" \
  -k "$keychain" -P "$MACOS_DEVELOPER_ID_P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple: -s -k '' "$keychain" >/dev/null
rm "$work/developer-id.p12"

identity="$(security find-identity -v -p codesigning "$keychain" | awk -v team="$APPLE_TEAM_ID" '$0 ~ "Developer ID Application:" && index($0, team) { print $2; exit }')"
if [[ -z "$identity" ]]; then
  echo 'The certificate contains no Developer ID Application identity for this team.' >&2
  exit 1
fi

bash "$root/desktop/build-mac.sh"
plutil -replace CFBundleVersion -string "$version" "$app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
codesign --force --options runtime --timestamp \
  --sign "$identity" "$app/Contents/MacOS/muxterm-server"
codesign --force --options runtime --timestamp \
  --sign "$identity" "$app/Contents/MacOS/node"
codesign --force --deep --options runtime --timestamp \
  --sign "$identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

ditto -c -k --keepParent "$app" "$work/Muxterm.zip"
xcrun notarytool submit "$work/Muxterm.zip" \
  --apple-id "$APPLE_NOTARY_APPLE_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 20m
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"

mkdir -p "$work/dmg"
ditto "$app" "$work/dmg/Muxterm.app"
ln -s /Applications "$work/dmg/Applications"
hdiutil create -volname Muxterm -srcfolder "$work/dmg" \
  -ov -format UDZO "$dmg"
codesign --timestamp --sign "$identity" "$dmg"
codesign --verify --verbose=2 "$dmg"
echo "Created $dmg"
