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
# Coding chats must work when Finder launches the app with its minimal PATH.
# Install the locked SDK dependencies at build time instead of downloading
# them on the user's first launch (which can also pick up a broken npm mirror).
npm ci --prefix sdk-chat --ignore-scripts --no-audit --no-fund

app="desktop/bin/Muxterm.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/sdk-chat"
cp desktop/build/Info.plist "$app/Contents/Info.plist"
cp desktop/build/Muxterm.icns "$app/Contents/Resources/Muxterm.icns"
cp -L "$(command -v node)" "$app/Contents/MacOS/node"
cp sdk-chat/sidecar.mjs sdk-chat/codex-stream.mjs sdk-chat/acp-stream.mjs sdk-chat/package.json "$app/Contents/Resources/sdk-chat/"
cp -R sdk-chat/node_modules "$app/Contents/Resources/sdk-chat/node_modules"
go build -o "$app/Contents/MacOS/muxterm-server" ./cmd/muxterm
(cd desktop && go build -tags production -o "../$app/Contents/MacOS/muxterm" .)
plutil -lint "$app/Contents/Info.plist"
codesign --force --sign - "$app/Contents/MacOS/node"
codesign --force --sign - "$app/Contents/MacOS/muxterm-server"
codesign --force --sign - "$app"
echo "Built $app"
