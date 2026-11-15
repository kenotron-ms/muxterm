#!/bin/bash
set -euo pipefail

# This runs only on the disposable macos-15 GitHub runner, after build-mac.sh.
# HOME isolates the app's own Application Support and runtime directories.
export HOME="/tmp/mq-${GITHUB_RUN_ID}"
mkdir -p "$HOME/Library/Application Support/muxterm-desktop/local/runtime"
settings="$HOME/Library/Application Support/muxterm-desktop/settings.json"
socket="$HOME/Library/Application Support/muxterm-desktop/local/runtime/muxterm/sessiond.sock"
server="$(pwd)/desktop/bin/Muxterm.app/Contents/MacOS/muxterm-server"
bundle="$(pwd)/desktop/bin/Muxterm.app"
app="$bundle/Contents/MacOS/muxterm"

diagnose_failure() {
  local result=$?
  if [[ "$result" -ne 0 ]]; then
    echo "Mac Quit verification failed (exit $result)" >&2
    if [[ -n "${app_pid:-}" ]]; then
      ps -p "$app_pid" -o pid=,state=,command= >&2 || true
    fi
    if [[ -n "${keep:-}" ]]; then
      cat "$RUNNER_TEMP/muxterm-quit-app-$keep.log" >&2 || true
    fi
  fi
}
trap diagnose_failure EXIT

socket_alive() {
  python3 - "$socket" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX)
s.settimeout(0.2)
try:
    s.connect(sys.argv[1])
except OSError:
    sys.exit(1)
finally:
    s.close()
PY
}

socket_dead() { ! socket_alive; }

app_exited() {
  state="$(ps -p "$1" -o state= 2>/dev/null | tr -d ' ')"
  [[ -z "$state" || "$state" == Z* ]]
}

app_registered() {
  [[ "$(osascript -e 'tell application id "io.ampbox.muxterm.desktop" to get running' 2>/dev/null)" == true ]]
}

find_app_pid() {
  app_pid="$(ps -axo pid=,command= | awk -v app="$app" '$2 == app { print $1; exit }')"
  [[ -n "$app_pid" ]]
}

wait_for() {
  local description="$1"; shift
  for _ in {1..100}; do
    if "$@"; then return 0; fi
    sleep 0.1
  done
  echo "Timed out waiting for $description" >&2
  return 1
}

wait_for_quick_exit() {
  local app_pid="$1"
  for _ in {1..30}; do
    if app_exited "$app_pid"; then return 0; fi
    sleep 0.1
  done
  echo 'Mac app did not quit within 3 seconds' >&2
  return 1
}

printf '{"keepSessionsOnQuit":true}\n' > "$settings"
env XDG_RUNTIME_DIR="$HOME/Library/Application Support/muxterm-desktop/local/runtime" \
  XDG_CONFIG_HOME="$HOME/Library/Application Support/muxterm-desktop/local/config" \
  XDG_DATA_HOME="$HOME/Library/Application Support/muxterm-desktop/local/data" \
  "$server" sessiond > "$RUNNER_TEMP/muxterm-quit-sessiond.log" 2>&1 &
wait_for 'private sessiond socket' socket_alive || {
  cat "$RUNNER_TEMP/muxterm-quit-sessiond.log" >&2
  exit 1
}

for keep in true false; do
  socket_alive || { echo 'Private session daemon stopped before Quit verification' >&2; exit 1; }
  printf '{"keepSessionsOnQuit":%s}\n' "$keep" > "$settings"
  rm -f "$HOME/Library/Application Support/muxterm-desktop/local/runtime/muxterm/server.url"
  open -n --env "HOME=$HOME" \
    --stdout "$RUNNER_TEMP/muxterm-quit-app-$keep.log" \
    --stderr "$RUNNER_TEMP/muxterm-quit-app-$keep.log" -a "$bundle"
  wait_for 'Mac app process' find_app_pid
  wait_for 'Mac app window and local server' test -e "$HOME/Library/Application Support/muxterm-desktop/local/runtime/muxterm/server.url"
  if ! wait_for 'Mac app registration' app_registered; then
    cat "$RUNNER_TEMP/muxterm-quit-app-$keep.log" >&2
    exit 1
  fi
  if app_exited "$app_pid"; then
    echo 'Mac app exited before Quit was requested' >&2
    exit 1
  fi
  quit_started="$(python3 -c 'import time; print(time.monotonic_ns())')"
  osascript -e 'tell application id "io.ampbox.muxterm.desktop" to quit'
  wait_for_quick_exit "$app_pid"
  python3 - "$quit_started" <<'PY'
import sys, time
seconds = (time.monotonic_ns() - int(sys.argv[1])) / 1_000_000_000
print(f'Mac app quit in {seconds:.2f}s')
if seconds > 3:
    raise SystemExit('Mac app took longer than 3 seconds to quit')
PY
  if [[ "$keep" == true ]]; then
    socket_alive || { echo 'Session daemon stopped despite Keep Running' >&2; exit 1; }
  else
    wait_for 'private sessiond shutdown' socket_dead
  fi
  echo "Mac Quit completed with keepSessionsOnQuit=$keep"
done
