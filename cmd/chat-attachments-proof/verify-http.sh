#!/usr/bin/env bash
# Exercise the real attachment routes with an isolated proof listener on 8453.
# All evidence is kept outside the repository; the data store uses its own XDG root.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
evidence_dir=/home/ken/artifacts/attachments-backend
proof_dir=$(mktemp -d /tmp/muxterm-attachments-8453.XXXXXXXX)
server_pid=

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p "$evidence_dir"
cp "$repo_root/web/public/favicon-32.png" "$evidence_dir/image.png"
cat > "$evidence_dir/note.txt" <<'EOF'
SDK chat attachment HTTP proof: this is a real non-image file.
EOF
truncate -s $((20 * 1024 * 1024 + 1)) "$proof_dir/oversized.bin"

(
  cd "$repo_root"
  go build -o "$proof_dir/proof-server" ./cmd/chat-attachments-proof
)
token=$(openssl rand -hex 32)
export XDG_DATA_HOME="$proof_dir/data"
MUXTERM_ATTACHMENT_PROOF_TOKEN="$token" "$proof_dir/proof-server" \
  -addr 127.0.0.1:8453 >"$evidence_dir/server.log" 2>&1 &
server_pid=$!

base=http://127.0.0.1:8453/api/sdk-chat-attachments
transcript="$evidence_dir/transcript.txt"
: > "$transcript"
printf 'Proof listener: 127.0.0.1:8453\nData root: %s/muxterm/sdk-chat-attachments\n' \
  "$XDG_DATA_HOME" | tee -a "$transcript"

for fixture in image.png note.txt; do
  case "$fixture" in
    image.png) content_type=image/png ;;
    note.txt) content_type=text/plain ;;
  esac
  printf '\nPOST %s (file=%s)\n' "$base" "$fixture" | tee -a "$transcript"
  status=$(curl --silent --show-error --retry 5 --retry-connrefused --retry-delay 0 \
    -o "$evidence_dir/$fixture.response.json" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $token" \
    -H 'X-Muxterm-Chat-Attachment: 1' \
    -F "file=@$evidence_dir/$fixture;type=$content_type" "$base")
  printf 'HTTP %s\n' "$status" | tee -a "$transcript"
  tee -a "$transcript" < "$evidence_dir/$fixture.response.json"
  [[ "$status" == 201 ]]

  id=$(jq -r '.id' "$evidence_dir/$fixture.response.json")
  kind=$(jq -r '.kind' "$evidence_dir/$fixture.response.json")
  [[ "$id" =~ ^[0-9a-f]{32}$ ]]
  if [[ "$fixture" == image.png ]]; then [[ "$kind" == image ]]; fi
  if [[ "$fixture" == note.txt ]]; then [[ "$kind" == file ]]; fi

  printf 'GET %s/%s\n' "$base" "$id" | tee -a "$transcript"
  status=$(curl --silent --show-error \
    -o "$evidence_dir/$fixture.download" -w '%{http_code}' \
    -H "Authorization: Bearer $token" "$base/$id")
  printf 'HTTP %s\n' "$status" | tee -a "$transcript"
  [[ "$status" == 200 ]]

  printf 'ResolvePath(%s)\n' "$id" | tee -a "$transcript"
  "$proof_dir/proof-server" -root "$XDG_DATA_HOME/muxterm/sdk-chat-attachments" \
    -resolve "$id" | tee -a "$transcript" > "$evidence_dir/$fixture.resolved.json"
  resolved_path=$(jq -r '.path' "$evidence_dir/$fixture.resolved.json")
  [[ "$resolved_path" = /* && -f "$resolved_path" ]]

  printf 'SHA-256 upload:   ' | tee -a "$transcript"
  sha256sum "$evidence_dir/$fixture" | tee -a "$transcript"
  printf 'SHA-256 download: ' | tee -a "$transcript"
  sha256sum "$evidence_dir/$fixture.download" | tee -a "$transcript"
  printf 'SHA-256 resolved: ' | tee -a "$transcript"
  sha256sum "$resolved_path" | tee -a "$transcript"
  cmp "$evidence_dir/$fixture" "$evidence_dir/$fixture.download"
  cmp "$evidence_dir/$fixture" "$resolved_path"
done

printf '\nPOST %s (file=oversized.bin, 20 MiB + 1 byte)\n' "$base" | tee -a "$transcript"
status=$(curl --silent --show-error -o "$evidence_dir/oversized.response.json" \
  -w '%{http_code}' -H "Authorization: Bearer $token" \
  -H 'X-Muxterm-Chat-Attachment: 1' \
  -F "file=@$proof_dir/oversized.bin;type=application/octet-stream" "$base")
printf 'HTTP %s\n' "$status" | tee -a "$transcript"
tee -a "$transcript" < "$evidence_dir/oversized.response.json"
[[ "$status" == 413 ]]
[[ "$(jq -r '.error' "$evidence_dir/oversized.response.json")" == attachment_too_large ]]
printf '\nAll HTTP, resolver, byte comparison, and size rejection checks passed.\n' | tee -a "$transcript"
