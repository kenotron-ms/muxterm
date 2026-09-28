#!/usr/bin/env bash
#
# Build an installable .deb of the muxterm desktop app.
#
# WHY A .deb AND NOT AN AppImage
#
# The desktop app is a WebKitGTK program. An AppImage would have to carry
# WebKitGTK itself -- and WebKitGTK is not one .so: it ships out-of-process
# helper binaries (WebKitNetworkProcess, WebKitWebProcess), a GIO module
# search path, GTK immodules and an icon/mime cache, all resolved through
# absolute paths at runtime. Bundling that correctly is a project on its own,
# and the result is a ~200 MB image that still breaks when the host's GL or
# dbus stack differs.
#
# A .deb declares those as dependencies and lets apt resolve them against the
# distribution's own, already-patched copies. The package is ~15 MB, installs
# with one double-click through any GUI package installer, and puts the
# .desktop entry and the icons exactly where the freedesktop spec says the
# application menu looks for them. Debian/Ubuntu is also what this project
# already targets.
#
# The cost, named: this .deb installs on Debian/Ubuntu family distributions
# only, and only on those new enough to ship the WebKit2GTK 4.1 ABI (Debian 12+,
# Ubuntu 24.04+). Fedora/Arch users need an .rpm/PKGBUILD or an AppImage; both
# are later work.
#
# BUILD REQUIREMENTS (not installed by this script):
#   apt install libgtk-3-dev libwebkit2gtk-4.1-dev libpam0g-dev dpkg-dev
#   plus Go >= 1.25 and a built web/dist (run `make web` first).
#
# USAGE
#   desktop/packaging/linux/build-deb.sh
#   VERSION=0.52.0 OUT_DIR=/tmp/out desktop/packaging/linux/build-deb.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

OUT_DIR="${OUT_DIR:-$REPO_ROOT/bin}"
WEBKIT_TAG="${WEBKIT_TAG:-webkit2_41}"
VERSION="${VERSION:-$(git -C "$REPO_ROOT" describe --tags --always --dirty 2>/dev/null || echo 0.0.0)}"

# Debian versions must begin with a digit; `git describe` gives v0.51.0-3-gabc.
DEB_VERSION="${VERSION#v}"
case "$DEB_VERSION" in
  [0-9]*) ;;
  *) DEB_VERSION="0.0.0+${DEB_VERSION}" ;;
esac
# '-' separates the Debian revision, so an upstream version may hold only one.
DEB_VERSION="$(printf '%s' "$DEB_VERSION" | sed 's/-/~/g')"

ARCH="$(dpkg --print-architecture)"
PKG="muxterm-desktop"

if [ ! -d "$REPO_ROOT/web/dist" ]; then
  echo "build-deb: web/dist is missing -- run 'make web' first (the binary embeds it)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"

echo "==> building $PKG $DEB_VERSION ($ARCH)"

# ---------------------------------------------------------------------------
# 1. the binary
#
# Same tags `make desktop` uses. `desktop` is also this repo's own constraint
# that keeps desktop/ out of `go build ./...` on machines with no GTK headers.
#
# The update.PackageManager stamp turns OFF in-app self-update for this build.
# dpkg owns /usr/bin/muxterm-desktop; rewriting it in place would desync the
# package database, and the published release asset is the muxterm CLI, so a
# "successful" self-update would replace the desktop app with a binary that has
# no window. The UI already renders this state -- the same muted, non-actionable
# note a Homebrew install gets.
mkdir -p "$STAGE/usr/bin"
( cd "$REPO_ROOT" && go build -tags "desktop,production,$WEBKIT_TAG" \
    -ldflags "-s -w -X main.version=$VERSION -X github.com/kenotron-ms/muxterm/internal/update.PackageManager=dpkg" \
    -o "$STAGE/usr/bin/$PKG" ./desktop )

# ---------------------------------------------------------------------------
# 2. app identity: the .desktop entry and the icon theme
mkdir -p "$STAGE/usr/share/applications"
install -m 0644 "$HERE/$PKG.desktop" "$STAGE/usr/share/applications/$PKG.desktop"

for size in 16 24 32 48 64 128 256 512; do
  dir="$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  install -m 0644 "$HERE/icons/$PKG-${size}.png" "$dir/$PKG.png"
done
mkdir -p "$STAGE/usr/share/icons/hicolor/scalable/apps"
install -m 0644 "$HERE/icons/$PKG.svg" "$STAGE/usr/share/icons/hicolor/scalable/apps/$PKG.svg"

mkdir -p "$STAGE/usr/share/doc/$PKG"
install -m 0644 "$REPO_ROOT/LICENSE" "$STAGE/usr/share/doc/$PKG/copyright"

# ---------------------------------------------------------------------------
# 3. dependencies, computed from the binary rather than guessed
#
# dpkg-shlibdeps reads the actual DT_NEEDED entries and maps each to the
# package and minimum version that provides it, so the GTK/WebKitGTK/PAM
# runtime is resolved by apt on the user's machine instead of bundled.
mkdir -p "$WORK/debian"
cat > "$WORK/debian/control" <<EOF
Source: $PKG
Package: $PKG
Architecture: $ARCH
EOF
SHLIB_DEPS="$(cd "$WORK" && dpkg-shlibdeps -O --ignore-missing-info "$STAGE/usr/bin/$PKG" 2>/dev/null \
  | sed -n 's/^shlibs:Depends=//p')"
if [ -z "$SHLIB_DEPS" ]; then
  echo "build-deb: dpkg-shlibdeps produced no dependencies" >&2
  exit 1
fi

# Anything the binary does not link but still needs at runtime has to be added
# by hand, because dpkg-shlibdeps only reads DT_NEEDED. Each is appended only
# when the computed list does not already cover it, so the Depends field never
# names the same package twice.
DEPS="$SHLIB_DEPS"
add_dep() {
  case ", $DEPS," in
    *", $1"[,\ ]*) return 0 ;;
  esac
  DEPS="$DEPS, $1"
}
# WebKitGTK is already linked, but name it explicitly: it is the one dependency
# whose absence turns the app into a window that never paints.
add_dep libwebkit2gtk-4.1-0
# GSettings schemas. GTK reads org.gnome.desktop.interface at startup; without
# the schema set installed GTK aborts rather than falling back.
add_dep gsettings-desktop-schemas
# The default GTK icon theme, so the window's own chrome has icons to draw.
add_dep adwaita-icon-theme

mkdir -p "$STAGE/DEBIAN"
cat > "$STAGE/DEBIAN/control" <<EOF
Package: $PKG
Version: $DEB_VERSION
Section: utils
Priority: optional
Architecture: $ARCH
Depends: $DEPS
Maintainer: muxterm maintainers <noreply@github.com>
Homepage: https://github.com/kenotron-ms/muxterm
Description: muxterm in a native desktop window
 muxterm is a terminal multiplexer whose sessions outlive the window that
 shows them. This package is the desktop app: one native window, muxterm's
 own UI, launched from the application menu.
 .
 It is self-contained and needs no muxterm CLI install. The app starts its
 own session daemon and its own loopback server; nothing listens off the
 machine and no port or URL is ever typed by hand.
 .
 If a muxterm CLI is already installed and its daemon is running, the app
 attaches to that daemon and your existing terminals appear in the window.
 This package deliberately installs no file named "muxterm", so it can
 neither shadow nor be shadowed by a CLI install on PATH.
EOF

# ---------------------------------------------------------------------------
# 4. maintainer scripts
#
# desktop-file-utils and libgtk-3-0 register dpkg triggers on these two
# directories, so on a normal desktop the caches refresh themselves. Doing it
# explicitly costs nothing and makes the package correct on a minimal system
# where neither trigger provider happens to be installed.
cat > "$STAGE/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -f /usr/share/icons/hicolor || true
  fi
fi
exit 0
EOF
cat > "$STAGE/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -f /usr/share/icons/hicolor || true
  fi
fi
exit 0
EOF
chmod 0755 "$STAGE/DEBIAN/postinst" "$STAGE/DEBIAN/postrm"

# ---------------------------------------------------------------------------
# 5. the package
mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/${PKG}_${DEB_VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$STAGE" "$DEB" >/dev/null

echo "==> $DEB"
dpkg-deb --info "$DEB" | sed -n '1,12p'
echo "==> contents"
dpkg-deb --contents "$DEB" | awk '{print $1, $6}'
