#!/usr/bin/env bash
# Integration verification in a disposable GitHub Actions VM. Never run this
# on a workstation: it installs user systemd units and replaces its own binary.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || -z "${RUNNER_TEMP:-}" ]]; then
  echo 'automatic update DTU requires a disposable GitHub Actions runner' >&2
  exit 2
fi

work="$RUNNER_TEMP/muxterm-auto-update-dtu"
mkdir -p "$work/bin" "$work/release" "$work/cache"

for version in 0.1.0 0.2.0 0.3.0; do
  go build -ldflags "-X main.version=$version -X main.releaseBuild=true" \
    -o "$work/bin/muxterm-$version" ./cmd/muxterm
done
cp "$work/bin/muxterm-0.1.0" "$work/bin/muxterm"
binary="$work/bin/muxterm"

publish_release() {
  local version="$1"
  cp "$work/bin/muxterm-$version" "$work/release/muxterm"
  tar -czf "$work/release/muxterm_linux_amd64.tar.gz" -C "$work/release" muxterm
  (cd "$work/release" && sha256sum muxterm_linux_amd64.tar.gz > checksums.txt)
  python3 - "$work/release/latest.json" "$version" <<'PY'
import json, sys
path, version = sys.argv[1:]
assets = [
    {'name': name, 'browser_download_url': 'http://127.0.0.1:8320/' + name}
    for name in ('muxterm_linux_amd64.tar.gz', 'checksums.txt')
]
with open(path, 'w') as out:
    json.dump({'tag_name': 'v' + version, 'assets': assets}, out)
PY
}

api() { curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:8318$1"; }
set_auto() {
  curl --fail --silent --show-error --max-time 5 -X PUT \
    -H 'Content-Type: application/json' --data "{\"enabled\":$1}" \
    http://127.0.0.1:8318/api/update/automatic >/dev/null
}
wait_health() {
  for _ in $(seq 1 90); do
    if api /api/health >/dev/null 2>&1; then return; fi
    sleep 2
  done
  echo 'muxterm systemd service did not become healthy' >&2
  systemctl --user status muxterm.service muxterm-sessiond.service --no-pager || true
  exit 1
}
wait_phase() {
  local wanted="$1" message="$2" state
  for _ in $(seq 1 90); do
    state="$(api /api/update/automatic 2>/dev/null || true)"
    if jq -e --arg phase "$wanted" --arg message "$message" \
      '.phase == $phase and (.message | contains($message))' <<<"$state" >/dev/null 2>&1; then
      echo "$state"
      return
    fi
    sleep 2
  done
  echo "automatic update did not reach $wanted ($message); last state: $state" >&2
  exit 1
}
wait_version() {
  local wanted="$1" status
  for _ in $(seq 1 90); do
    status="$(api /api/update/status 2>/dev/null || true)"
    if jq -e --arg version "$wanted" '.currentVersion == $version' <<<"$status" >/dev/null 2>&1; then
      echo "$status"
      return
    fi
    sleep 2
  done
  echo "systemd update did not reach $wanted; last status: $status" >&2
  systemctl --user status muxterm.service muxterm-sessiond.service --no-pager || true
  exit 1
}

publish_release 0.2.0
python3 -m http.server 8320 --bind 127.0.0.1 --directory "$work/release" \
  >"$work/release-http.log" 2>&1 &
release_pid=$!
trap 'kill "$release_pid" 2>/dev/null || true' EXIT

# The runner VM has no live muxterm. Start its own user manager and install
# through the exact supported path so the real generated units are exercised.
sudo loginctl enable-linger "$USER"
sudo systemctl start "user@$(id -u).service"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
for _ in $(seq 1 30); do
  if systemctl --user show-environment >/dev/null 2>&1; then break; fi
  sleep 1
done
systemctl --user show-environment >/dev/null
mkdir -p "$HOME/.config/systemd/user/muxterm.service.d" \
  "$HOME/.config/systemd/user/muxterm-sessiond.service.d"
cat > "$HOME/.config/systemd/user/muxterm.service.d/fixture.conf" <<EOF
[Service]
Environment=MUXTERM_UPDATE_API_URL=http://127.0.0.1:8320/latest.json
Environment=MUXTERM_UPDATE_CACHE_DIR=$work/cache
Environment=CI=
EOF
cat > "$HOME/.config/systemd/user/muxterm-sessiond.service.d/fixture.conf" <<'EOF'
[Service]
Environment=SHELL=/bin/bash
EOF
"$binary" install --addr 127.0.0.1:8318
wait_health
systemctl --user is-active --quiet muxterm.service muxterm-sessiond.service
api /api/update/automatic | jq -e '.enabled == false and .eligible == true'
prepared="$(curl --fail --silent --show-error -X POST http://127.0.0.1:8318/api/update/prepare)"
token="$(jq -r 'select(.safe == true) | .token' <<<"$prepared")"
[[ "$token" =~ ^[0-9]+$ ]]
curl --fail --silent --show-error -X POST -H 'Content-Type: application/json' \
  --data "{\"token\":$token}" http://127.0.0.1:8318/api/update/release >/dev/null

workspace="$("$binary" workspace create auto-update-dtu --json | jq -r .workspaceId)"
"$binary" pane create --workspace "$workspace"
"$binary" pane send 1 --workspace "$workspace" --text 'sleep 120' --keys Enter
sleep 1
set_auto true
wait_phase deferred busy
[[ "$("$binary" version)" == *'0.1.0'* ]]

"$binary" pane send 1 --workspace "$workspace" --keys C-c
sleep 1
set_auto false
set_auto true
wait_version 0.2.0
wait_phase current 'Updated to version 0.2.0'
systemctl --user is-active --quiet muxterm.service muxterm-sessiond.service
restored="$("$binary" workspace list --json | jq -r '.[] | select(.name == "auto-update-dtu" and .paneCount == 1) | .workspaceId')"
[[ -n "$restored" ]]
"$binary" read-screen 1 --workspace "$restored" | tee "$work/restored-screen.txt"
grep -q 'restored' "$work/restored-screen.txt"

publish_release 0.3.0
printf '%064d  muxterm_linux_amd64.tar.gz\n' 0 > "$work/release/checksums.txt"
curl --fail --silent --show-error -X POST http://127.0.0.1:8318/api/update/check >/dev/null
set_auto false
set_auto true
wait_phase error 'checksum mismatch'
[[ "$("$binary" version)" == *'0.2.0'* ]]

(cd "$work/release" && sha256sum muxterm_linux_amd64.tar.gz > checksums.txt)
curl --fail --silent --show-error -X POST http://127.0.0.1:8318/api/update/check >/dev/null
set_auto false
set_auto true
wait_version 0.3.0
wait_phase current 'Updated to version 0.3.0'
systemctl --user is-active --quiet muxterm.service muxterm-sessiond.service
echo 'DTU PASS: busy defer, systemd update and restore, checksum failure, recovery to 0.3.0'
