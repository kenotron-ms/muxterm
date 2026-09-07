#!/usr/bin/env bash
# up.sh -- the harness for web/e2e/markdown-stream.mjs.
#
# WHAT THIS DOES NOT START, deliberately: no muxterm server, and no sessiond.
#
# AGENTS.md forbids hand-rolling a scratch muxterm instance on this host, and it
# is right to: a server that resolves one path without consulting XDG_* walks
# straight out of the sandbox, and a pkill aimed at "just my scratch process"
# matches production too. It points at `make dev-local` instead -- but that
# starts a real sessiond on a FIXED, worktree-independent socket path, which is
# shared with every other worktree on this machine and is not this lane's to
# take.
#
# Neither is needed here. The change under test is entirely in the browser:
# <mux-cos> renders from cos-store, and the evidence script drives cos-store
# directly with the frames internal/server/cos.go sends. So the harness is a
# frontend dev server and a browser -- vite binds a port and serves modules, and
# Chrome runs in a throwaway profile. Nothing here reads muxterm's config, its
# runtime dir, its sessiond socket, or the crash-restore snapshot, because
# nothing here is muxterm.
#
# Ports are 5199 and 9333. Never 9090, never 8311, and not 8313 either -- that
# is `make dev-local`'s, and another lane may be using it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN="${TMPDIR:-/tmp}/muxterm-mdstream"

mkdir -p "$RUN/log" "$RUN/chrome"

echo "harness (no muxterm server, no sessiond):"
echo "  vite dev      http://127.0.0.1:5199   (serves web/src modules)"
echo "  chrome cdp    http://127.0.0.1:9333   (throwaway profile in $RUN/chrome)"
echo "  production    127.0.0.1:9090 + :8311  -- no process here can reach it"

cd "$ROOT/web"
nohup npx vite --port 5199 --strictPort --host 127.0.0.1 > "$RUN/log/vite.log" 2>&1 &
echo $! > "$RUN/vite.pid"

nohup google-chrome --headless=new --remote-debugging-port=9333 \
  --user-data-dir="$RUN/chrome" --no-first-run --no-default-browser-check \
  --disable-gpu --no-sandbox --window-size=1280,1600 about:blank \
  > "$RUN/log/chrome.log" 2>&1 &
echo $! > "$RUN/chrome.pid"

for _ in $(seq 1 60); do
  ok=1
  curl -sf "http://127.0.0.1:5199/" -o /dev/null || ok=0
  curl -sf "http://127.0.0.1:9333/json/version" -o /dev/null || ok=0
  [ "$ok" = 1 ] && break
  sleep 0.5
done

echo
echo "up:  vite $(cat "$RUN/vite.pid")   chrome $(cat "$RUN/chrome.pid")"
curl -sf "http://127.0.0.1:9333/json/version" | head -c 90 || echo "  chrome NOT ready"
echo
