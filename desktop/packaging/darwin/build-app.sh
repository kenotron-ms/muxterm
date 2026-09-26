#!/usr/bin/env bash
#
# Build muxterm.app -- the macOS bundle of the muxterm desktop app.
#
# WHY THIS SCRIPT AND NOT `wails build`
#
# The Linux target (`make desktop`) is a plain `go build` with build tags, not
# a Wails CLI invocation: desktop/ is an ordinary package of the one muxterm
# module, guarded by `//go:build desktop`. `wails build` would need a
# wails.json describing a frontend directory it is expected to build itself,
# which is a second, divergent description of a frontend the Makefile already
# builds. This script keeps macOS on exactly the Linux compile line and adds
# only the two things macOS genuinely requires that Linux does not: an .app
# bundle with an Info.plist, and a code signature.
#
# WHY THERE IS A SIGNATURE AT ALL, GIVEN THIS IS AN UNSIGNED BUILD
#
# On Apple silicon the kernel refuses to exec a Mach-O with NO signature --
# this is not Gatekeeper, it is dyld, and it applies even to a binary you
# compiled yourself. The answer is an AD-HOC signature (`codesign -s -`):
# a hash of the bundle with no identity and no certificate behind it. Go's own
# linker already applies one to each darwin/arm64 binary it produces; `lipo`
# and the bundle around it do not, so this script re-applies it to the finished
# bundle.
#
# An ad-hoc signature is NOT a Developer ID signature. It makes the app RUN; it
# does nothing whatsoever for Gatekeeper, which will still refuse the first
# open of a downloaded copy. Developer ID signing and notarization need a paid
# Apple Developer account and are deliberately not attempted here -- see PR
# #215 for the costs.
#
# NSAppTransportSecurity, AND WHY IT IS NOT OPTIONAL HERE
#
# The window loads `http://127.0.0.1:<ephemeral>/` -- muxterm's real server,
# in-process (see desktop/main.go). App Transport Security blocks cleartext
# HTTP in WKWebView by default, so the plist below carries an explicit
# loopback exception. Without it the webview can refuse the one origin the
# whole app is built around, and the failure mode is a window that paints the
# background colour and nothing else. Linux has no equivalent gate, which is
# why this is the first place it could bite.
#
# BUILD REQUIREMENTS (not installed by this script):
#   Xcode Command Line Tools  (xcode-select --install)
#   Go >= 1.25
#   a built web/dist          (run `make web` first -- the binary embeds it)
#
# USAGE
#   desktop/packaging/darwin/build-app.sh
#   MACOS_ARCHS="arm64"   desktop/packaging/darwin/build-app.sh   # single slice
#   VERSION=0.52.0 OUT_DIR=/tmp/out desktop/packaging/darwin/build-app.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/bin}"
VERSION="${VERSION:-$(git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null || echo 0.0.0)}"

# Both slices by default. An Intel Mac cannot run an arm64-only build and an
# Apple silicon Mac runs an amd64-only build only through Rosetta 2, so a
# universal bundle is the only artifact that is correct to hand to someone
# whose hardware you have not asked about.
MACOS_ARCHS="${MACOS_ARCHS:-arm64 amd64}"

APP_NAME="muxterm"
EXE_NAME="muxterm-desktop"
BUNDLE_ID="com.github.kenotron-ms.muxterm"
ICON_SRC="$REPO_ROOT/desktop/packaging/linux/icons"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build-app: this must run ON macOS." >&2
  echo "build-app: Wails links Cocoa and WKWebView through cgo, so a macOS app" >&2
  echo "build-app: cannot be cross-compiled from Linux. Use the desktop-macos" >&2
  echo "build-app: GitHub Actions workflow, or a Mac." >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/web/dist" ]; then
  echo "build-app: web/dist is missing -- run 'make web' first (the binary embeds it)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

APP="$OUT_DIR/$APP_NAME.app"
CONTENTS="$APP/Contents"

echo "==> building $APP_NAME.app $VERSION (${MACOS_ARCHS// /+})"

# ---------------------------------------------------------------------------
# 1. the binary, one slice per architecture
#
# Exactly the tags `make desktop` uses, minus webkit2_41: that tag selects the
# WebKit2GTK ABI and has no meaning outside Linux. `desktop` is this repo's own
# constraint keeping desktop/ out of `go build ./...`; `production` is Wails'
# own, and without it the darwin build keeps the devtools inspector wired in.
#
# CGO_ENABLED=1 is mandatory: the darwin frontend is Objective-C.
SLICES=()
for arch in $MACOS_ARCHS; do
  echo "--> go build darwin/$arch"
  out="$WORK/$EXE_NAME.$arch"
  ( cd "$REPO_ROOT" && CGO_ENABLED=1 GOOS=darwin GOARCH="$arch" \
      go build -tags "desktop,production" \
        -ldflags "-s -w -X main.version=$VERSION" \
        -o "$out" ./desktop )
  SLICES+=("$out")
done

mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
if [ "${#SLICES[@]}" -gt 1 ]; then
  lipo -create "${SLICES[@]}" -output "$CONTENTS/MacOS/$EXE_NAME"
else
  cp "${SLICES[0]}" "$CONTENTS/MacOS/$EXE_NAME"
fi
chmod 0755 "$CONTENTS/MacOS/$EXE_NAME"

# ---------------------------------------------------------------------------
# 2. the icon
#
# iconutil is the only supported way to produce an .icns, and it reads an
# .iconset directory whose filenames encode size and scale. The source PNGs are
# the same ones the .deb installs into the hicolor theme, so the Mac dock icon
# and the Linux menu icon are the same rendered mark, from the same script.
#
# There is no 1024x1024 source, so icon_512x512@2x is absent: macOS falls back
# to scaling the 512 for that one slot rather than failing.
ICONSET="$WORK/$EXE_NAME.iconset"
mkdir -p "$ICONSET"
cp "$ICON_SRC/$EXE_NAME-16.png"  "$ICONSET/icon_16x16.png"
cp "$ICON_SRC/$EXE_NAME-32.png"  "$ICONSET/icon_16x16@2x.png"
cp "$ICON_SRC/$EXE_NAME-32.png"  "$ICONSET/icon_32x32.png"
cp "$ICON_SRC/$EXE_NAME-64.png"  "$ICONSET/icon_32x32@2x.png"
cp "$ICON_SRC/$EXE_NAME-128.png" "$ICONSET/icon_128x128.png"
cp "$ICON_SRC/$EXE_NAME-256.png" "$ICONSET/icon_128x128@2x.png"
cp "$ICON_SRC/$EXE_NAME-256.png" "$ICONSET/icon_256x256.png"
cp "$ICON_SRC/$EXE_NAME-512.png" "$ICONSET/icon_256x256@2x.png"
cp "$ICON_SRC/$EXE_NAME-512.png" "$ICONSET/icon_512x512.png"
iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/$EXE_NAME.icns"

# ---------------------------------------------------------------------------
# 3. Info.plist
#
# CFBundleShortVersionString must be dotted digits or Finder shows nothing, and
# `git describe` gives v0.51.0-3-gabc on any commit past a tag -- so the
# marketing version is truncated to its numeric core and the full describe
# string goes in CFBundleVersion, which has no such constraint.
SHORT_VERSION="$(printf '%s' "${VERSION#v}" | sed -E 's/^([0-9]+(\.[0-9]+){0,2}).*/\1/')"
case "$SHORT_VERSION" in
  [0-9]*) ;;
  *) SHORT_VERSION="0.0.0" ;;
esac

cat > "$CONTENTS/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleName</key><string>$APP_NAME</string>
	<key>CFBundleDisplayName</key><string>$APP_NAME</string>
	<key>CFBundleExecutable</key><string>$EXE_NAME</string>
	<key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
	<key>CFBundleIconFile</key><string>$EXE_NAME</string>
	<key>CFBundleShortVersionString</key><string>$SHORT_VERSION</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleSignature</key><string>????</string>
	<key>LSMinimumSystemVersion</key><string>10.15.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSHumanReadableCopyright</key><string>muxterm maintainers</string>
	<!-- The window loads muxterm's own in-process server over loopback HTTP.
	     Without this exception App Transport Security refuses that origin in
	     WKWebView and the window never leaves its background colour. -->
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsLocalNetworking</key><true/>
		<key>NSExceptionDomains</key>
		<dict>
			<key>127.0.0.1</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
				<key>NSIncludesSubdomains</key><false/>
			</dict>
			<key>localhost</key>
			<dict>
				<key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
				<key>NSIncludesSubdomains</key><false/>
			</dict>
		</dict>
	</dict>
</dict>
</plist>
EOF
printf 'APPL????' > "$CONTENTS/PkgInfo"
plutil -lint "$CONTENTS/Info.plist"

# ---------------------------------------------------------------------------
# 4. ad-hoc signature -- see the header. This is what makes the bundle
#    EXECUTABLE on Apple silicon. It is not a Developer ID signature and
#    Gatekeeper is not satisfied by it.
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

# ---------------------------------------------------------------------------
# 5. report, from the artifact rather than from intent
echo "==> $APP"
echo "architectures : $(lipo -archs "$CONTENTS/MacOS/$EXE_NAME")"
echo "bundle size   : $(du -sh "$APP" | cut -f1)"
echo "signature     : $(codesign -dv "$APP" 2>&1 | sed -n 's/^Signature=//p')"
echo "identifier    : $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CONTENTS/Info.plist")"
echo "version       : $SHORT_VERSION ($VERSION)"
