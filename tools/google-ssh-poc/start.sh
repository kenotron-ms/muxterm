#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
mode="${1:-simulate}"
credential_file="${2:-}"
bind_address="${POC_BIND_ADDRESS:-127.0.0.1}"
port="${POC_SSH_PORT:-22213}"
name="${POC_CONTAINER_NAME:-muxterm-google-ssh-poc}"
runtime="${POC_RUNTIME_DIR:-/home/ken/artifacts/google-ssh-poc/run-$(date +%Y%m%d-%H%M%S)-$$}"
case "$mode" in
  simulate) arguments=(-simulate) ; mounts=() ;;
  google)
    [[ -f "$credential_file" ]] || { echo 'Supply the Desktop OAuth client JSON path.' >&2; exit 1; }
    arguments=(-credentials /credentials/client.json)
    mounts=(--mount "type=bind,src=$(realpath "$credential_file"),dst=/credentials/client.json,readonly")
    ;;
  *) echo 'Usage: ./start.sh simulate | ./start.sh google /absolute/client.json' >&2; exit 1 ;;
esac
mkdir -m 700 "$runtime"
docker build -t muxterm-google-ssh-poc:local .
docker run -d --name "$name" --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges --read-only \
  --pids-limit 64 --memory 128m \
  -p "$bind_address:$port:22213" \
  --mount "type=bind,src=$runtime,dst=/data" \
  "${mounts[@]}" muxterm-google-ssh-poc:local "${arguments[@]}"
for attempt in {1..50}; do
  if [[ -f "$runtime/host-key.pub" ]]; then break; fi
  sleep .1
done
docker logs "$name"
[[ "$(docker inspect --format '{{.State.Running}}' "$name")" == true ]] || {
  echo 'PoC could not start. Inspect the safe log above; use a fresh runtime for another attempt.' >&2
  exit 1
}
printf '\nPrivate runtime: %s\n' "$runtime"
printf 'Read the one-time SSH password yourself: cat %q/pairing-password\n' "$runtime"
printf 'On your LAPTOP, substitute the reachable server address:\n'
printf 'ssh -T -p %s -o ExitOnForwardFailure=yes -o PreferredAuthentications=password -o PubkeyAuthentication=no -o StrictHostKeyChecking=ask -L 127.0.0.1:18765:127.0.0.1:18765 connect@SERVER connect\n' "$port"
printf 'Verify the host fingerprint against the trusted server console before accepting.\n'
printf 'Inspect safe progress: docker logs %s\n' "$name"
printf 'After exit, remove only this PoC container: docker rm %s\n' "$name"
