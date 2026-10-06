#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "Build this app on the Mac where it will run." >&2
  exit 1
fi

cd "$(dirname "$0")"
app="bin/Muxterm.app"
mkdir -p "$app/Contents/MacOS"
cp build/Info.plist "$app/Contents/Info.plist"
go build -tags production -o "$app/Contents/MacOS/muxterm" .
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - "$app"
echo "Built $app"
