#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "Build this app on the Mac where it will run." >&2
  exit 1
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
if [ ! -d web/node_modules ]; then
  npm ci --prefix web
fi
NODE_OPTIONS="--max-old-space-size=6144 ${NODE_OPTIONS:-}" npm run build --prefix web

app="desktop/bin/Muxterm.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp desktop/build/Info.plist "$app/Contents/Info.plist"
cp desktop/build/Muxterm.icns "$app/Contents/Resources/Muxterm.icns"
go build -o "$app/Contents/MacOS/muxterm-server" ./cmd/muxterm
(cd desktop && go build -tags production -o "../$app/Contents/MacOS/muxterm" .)
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - "$app/Contents/MacOS/muxterm-server"
codesign --force --sign - "$app"
echo "Built $app"
