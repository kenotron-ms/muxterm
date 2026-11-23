#!/usr/bin/env bash
# End-to-end updater verification on a disposable signed-app Mac CI runner.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "$(uname -s)" != Darwin || -z "${RUNNER_TEMP:-}" ]]; then
  echo 'signed Mac update verification requires a disposable Mac Actions runner' >&2
  exit 2
fi

source_app="${1:?pass the signed 0.1.0 app}"
release_zip="${2:?pass the signed 0.2.0 updater ZIP}"
release_checksums="${3:?pass the 0.2.0 checksums file}"
home="/tmp/ma-${GITHUB_RUN_ID}"
app="$home/Muxterm.app"
support="$home/Library/Application Support/muxterm-desktop"
fixture="$RUNNER_TEMP/muxterm-mac-update-fixture"
log="$RUNNER_TEMP/muxterm-mac-auto-update.log"
mkdir -p "$home" "$support/local/runtime" "$fixture/repos/kenotron-ms/muxterm/releases"
ditto "$source_app" "$app"
codesign --verify --deep --strict "$app"
[[ "$(plutil -extract CFBundleVersion raw -o - "$app/Contents/Info.plist")" == '0.1.0' ]]

state="$support/automatic-updates.json"
printf '{"enabled":true,"phase":"waiting"}\n' > "$state"
printf '{"keepSessionsOnQuit":true}\n' > "$support/settings.json"
cp "$release_zip" "$fixture/$(basename "$release_zip")"
cp "$release_checksums" "$fixture/macos-checksums.txt"
python3 - "$fixture/repos/kenotron-ms/muxterm/releases/latest" \
  "$(basename "$release_zip")" "$(stat -f %z "$release_zip")" <<'PY'
import json, sys
path, name, size = sys.argv[1:]
assets = [
    {'id': 1, 'name': name, 'size': int(size), 'content_type': 'application/zip',
     'browser_download_url': 'http://127.0.0.1:8320/' + name},
    {'id': 2, 'name': 'macos-checksums.txt', 'size': 0, 'content_type': 'text/plain',
     'browser_download_url': 'http://127.0.0.1:8320/macos-checksums.txt'},
]
with open(path, 'w') as out:
    json.dump({'tag_name': 'v0.2.0', 'name': 'isolated signed Mac update', 'assets': assets}, out)
PY
python3 -m http.server 8320 --bind 127.0.0.1 --directory "$fixture" \
  > "$RUNNER_TEMP/muxterm-mac-release-http.log" 2>&1 &
http_pid=$!
trap 'kill "$http_pid" 2>/dev/null || true' EXIT

# The bundled host needs a real daemon for the safety handshake. Keep its
# Unix socket path short, as in the existing Mac Quit integration check.
runtime="$support/local/runtime"
env HOME="$home" XDG_RUNTIME_DIR="$runtime" \
  XDG_CONFIG_HOME="$support/local/config" XDG_DATA_HOME="$support/local/data" \
  SHELL=/bin/bash "$app/Contents/MacOS/muxterm-server" sessiond \
  > "$RUNNER_TEMP/muxterm-mac-auto-sessiond.log" 2>&1 &
socket="$runtime/muxterm/sessiond.sock"
for _ in {1..50}; do
  [[ -S "$socket" ]] && break
  sleep 0.2
done
[[ -S "$socket" ]]
server="$app/Contents/MacOS/muxterm-server"
workspace="$(env HOME="$home" XDG_RUNTIME_DIR="$runtime" "$server" workspace create mac-auto-dtu --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["workspaceId"])')"
env HOME="$home" XDG_RUNTIME_DIR="$runtime" "$server" pane create --workspace "$workspace"
env HOME="$home" XDG_RUNTIME_DIR="$runtime" "$server" pane send 1 --workspace "$workspace" --text 'sleep 120' --keys Enter
sleep 1

launch_app() {
  open -n --env "HOME=$home" --env 'GITHUB_ACTIONS=true' \
    --env 'MUXTERM_MAC_UPDATE_FIXTURE_BASE_URL=http://127.0.0.1:8320' \
    --env 'MUXTERM_MAC_AUTO_VERIFY_HIDDEN=1' \
    --stdout "$log" --stderr "$log" -a "$app"
}
state_matches() {
  python3 - "$state" "$1" "$2" <<'PY'
import json, sys
try:
    state = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    raise SystemExit(1)
phase, message = sys.argv[2:]
raise SystemExit(0 if state.get('enabled') and state.get('phase') == phase
                 and message in state.get('message', '') else 1)
PY
}
updated_state_matches() {
  python3 - "$state" <<'PY'
import json, sys
try:
    state = json.load(open(sys.argv[1]))
except (OSError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if state.get('enabled') and state.get('phase') == 'current'
                 and state.get('latestVersion') == '0.2.0' and state.get('lastUpdate') else 1)
PY
}

launch_app
deferred=false
for _ in {1..120}; do
  if state_matches deferred busy; then deferred=true; break; fi
  sleep 2
done
if [[ "$deferred" != true ]]; then
  echo 'signed Mac app did not defer the foreground job' >&2
  cat "$state" >&2 || true
  tail -100 "$log" >&2 || true
  exit 1
fi
[[ "$(plutil -extract CFBundleVersion raw -o - "$app/Contents/Info.plist")" == '0.1.0' ]]
echo 'MAC DEFER PASS: signed app left foreground pane and 0.1.0 in place'
env HOME="$home" XDG_RUNTIME_DIR="$runtime" "$server" pane send 1 --workspace "$workspace" --keys C-c
sleep 1
osascript -e 'tell application id "io.ampbox.muxterm.desktop" to quit'
for _ in {1..50}; do
  if ! ps -axo command= | grep -F "$app/Contents/MacOS/muxterm" | grep -v grep >/dev/null; then break; fi
  sleep 0.2
done
printf '{"enabled":true,"phase":"waiting"}\n' > "$state"
launch_app

for _ in {1..120}; do
  version="$(plutil -extract CFBundleVersion raw -o - "$app/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$version" == '0.2.0' ]] && updated_state_matches; then
    codesign --verify --deep --strict "$app"
    echo 'MAC PASS: signed 0.1.0 app deferred a foreground job, then installed and relaunched signed 0.2.0 without a browser window'
    cat "$state"
    exit 0
  fi
  sleep 2
done

echo "signed Mac update did not finish; bundle version=$version" >&2
cat "$state" >&2 || true
tail -100 "$log" >&2 || true
tail -100 "$RUNNER_TEMP/muxterm-mac-auto-sessiond.log" >&2 || true
exit 1
