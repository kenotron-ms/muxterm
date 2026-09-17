#!/usr/bin/env bash
# VERIFICATION HARNESS - one scenario, end to end. See README.md.
#
#   bash tools/cos-repro/run.sh "s6-stream size:4194304"
#   MODE=s1 bash tools/cos-repro/run.sh "s6-histcap slow"
#
# Builds if needed, starts `muxterm serve` with repro-sidecar.py wired in via
# MUXTERM_COS_SIDECAR / MUXTERM_COS_PYTHON, drives one scenario, stops the
# server, prints where the artifacts landed.
#
# SAFETY: ports 9090 and 8311 are refused outright (default 9390), and every
# XDG_* var is pointed at a throwaway root, so a run cannot reach a real
# muxterm's state. The server is killed by the PID this script wrote.
#
# Env: PORT REPO BIN MODE OUT STATE BUILD TIMEOUT_MS SETTLE_MS.
# BIN defaults to one binary PER TREE, because web/dist is embedded in the
# binary and a shared path is how a baseline run ends up served by the fix.
set -uo pipefail

SCENARIO=${1:-s6-stream}
PORT=${PORT:-9390}
REPO=${REPO:-$PWD}
MODE=${MODE:-plain}
HARNESS="$REPO/tools/cos-repro"
SLUG=$(printf '%s' "$MODE-$SCENARIO" | tr -c 'A-Za-z0-9' '-' | sed 's/--*/-/g; s/^-//; s/-$//')
OUT=${OUT:-/tmp/cos-repro/$(date +%Y%m%d-%H%M%S)-$SLUG}
STATE=${STATE:-/tmp/cos-repro-state}

if [ "$PORT" = "9090" ] || [ "$PORT" = "8311" ]; then
  echo "refusing to bind $PORT: those belong to a real muxterm" >&2
  exit 2
fi

# Artifacts are evidence, never a scratch area to erase. Canonicalize before
# creation so ../ and a symlinked parent cannot escape the dedicated harness
# root, then reject reuse rather than recursively deleting prior evidence.
OUT=$(realpath -m -- "$OUT") || { echo "could not canonicalize OUT: $OUT" >&2; exit 2; }
case "$OUT" in
  /tmp/cos-repro/*) ;;
  *) echo "refusing OUT outside /tmp/cos-repro/: $OUT" >&2; exit 2 ;;
esac
if [ -e "$OUT" ]; then
  echo "refusing existing OUT path: $OUT" >&2
  exit 2
fi

SIDECAR_DIR="$OUT/sidecar"
SERVER_LOG="$OUT/server.log"
PIDFILE="$STATE/muxterm.pid"

# Playwright resolves its browsers under XDG_CACHE_HOME, which is redirected
# below. Pin the real location FIRST, or drive.mjs dies with "Executable doesn't
# exist at .../ms-playwright/chromium_headless_shell-*/chrome-linux".
export PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}
export XDG_DATA_HOME="$STATE/data" XDG_RUNTIME_DIR="$STATE/run"
export XDG_CONFIG_HOME="$STATE/config" XDG_CACHE_HOME="$STATE/cache"
mkdir -p "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

say() { printf '\n>>> %s\n' "$*"; }

stop_server() {
  if [ -f "$PIDFILE" ]; then
    old=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; then
      kill "$old" 2>/dev/null || true
      for _ in $(seq 1 40); do kill -0 "$old" 2>/dev/null || break; sleep 0.25; done
      kill -9 "$old" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # Belt and braces, scoped to THIS harness's command line only.
  pkill -f "serve --addr 127.0.0.1:$PORT" 2>/dev/null || true
  pkill -f "repro-sidecar.py" 2>/dev/null || true
}
stop_server
# The fixture transcript and once-only injection markers must survive a
# supervised sidecar replacement. OUT was required to be new above, so these
# begin empty without destroying artifacts from a previous harness invocation.
mkdir -p "$OUT" "$SIDECAR_DIR" "$STATE"

BIN=${BIN:-/tmp/bin-muxterm-$(basename "$REPO")}
# web/dist is //go:embed-ed by web/embed.go, so the frontend must exist BEFORE
# the go build or the binary serves a stale (or empty) UI.
if [ "${BUILD:-0}" = "1" ] || [ ! -f "$REPO/web/dist/index.html" ]; then
  say "building web/dist"
  ( cd "$REPO/web" && npm run build ) || { echo "web build FAILED" >&2; exit 1; }
fi
if [ "${BUILD:-0}" = "1" ] || [ ! -x "$BIN" ]; then
  say "building $BIN"
  ( cd "$REPO" && go build -o "$BIN" ./cmd/muxterm ) || { echo "go build FAILED" >&2; exit 1; }
fi
echo "    tree: $REPO"
echo "    bin:  $BIN  ($(sha256sum "$BIN" | cut -c1-16))"

export MUXTERM_COS_SIDECAR="$HARNESS/repro-sidecar.py"
export MUXTERM_COS_PYTHON=${MUXTERM_COS_PYTHON:-python3}
export MUXTERM_REPRO_DIR="$SIDECAR_DIR"
# Fault injection is opt-in and scoped to the exact integration mode. Clear
# inherited values so an ordinary run can never accidentally inherit a race.
unset MUXTERM_REPRO_EXIT_ON_HISTORY_ONCE MUXTERM_REPRO_DELAY_HISTORY_ONCE_MS
unset MUXTERM_REPRO_DELAY_FIRST_CLEAR_HISTORY_MS MUXTERM_REPRO_OVERLAP_CLEAR_HISTORY
unset MUXTERM_REPRO_HISTORY_METADATA
unset MUXTERM_REPRO_SEED_HISTORY MUXTERM_REPRO_SEED_PROMPT MUXTERM_REPRO_SEED_ANSWER
case "$MODE" in
  restart)
    export MUXTERM_REPRO_EXIT_ON_HISTORY_ONCE=1
    ;;
  clear-race)
    export MUXTERM_REPRO_DELAY_HISTORY_ONCE_MS=3000
    ;;
  overlap-clear)
    # Two harmless fixture-owned turns, one old enough for the seven-day
    # prune and one recent. The first post-prune history reply is delayed so
    # a second all-clear can expose an out-of-order server broadcast.
    export MUXTERM_REPRO_OVERLAP_CLEAR_HISTORY=1
    export MUXTERM_REPRO_DELAY_FIRST_CLEAR_HISTORY_MS=3000
    "$MUXTERM_COS_PYTHON" "$HARNESS/repro-sidecar.py" --seed-history-only >/dev/null
    ;;
  metadata-absent)
    export MUXTERM_REPRO_HISTORY_METADATA=absent
    ;;
  metadata-unknown)
    export MUXTERM_REPRO_HISTORY_METADATA=unknown
    ;;
  replay-order)
    # Fixture-owned durable history only. These never name or access a native
    # SessionStore; repro-sidecar.py writes the one safe seed under
    # $MUXTERM_REPRO_DIR before the server and browser open.
    export MUXTERM_REPRO_SEED_HISTORY=1
    export MUXTERM_REPRO_SEED_PROMPT='fixture durable seed prompt'
    export MUXTERM_REPRO_SEED_ANSWER='fixture durable seed answer'
    "$MUXTERM_COS_PYTHON" "$HARNESS/repro-sidecar.py" --seed-history-only >/dev/null
    ;;
esac

say "starting muxterm serve on 127.0.0.1:$PORT"
echo "    artifacts: $OUT"
nohup "$BIN" serve --addr "127.0.0.1:$PORT" --no-auth > "$SERVER_LOG" 2>&1 &
SRV=$!
echo "$SRV" > "$PIDFILE"
trap 'stop_server' EXIT

up=0
for _ in $(seq 1 80); do
  if curl -sS -o /dev/null -m 2 "http://127.0.0.1:$PORT/" 2>/dev/null; then up=1; break; fi
  kill -0 "$SRV" 2>/dev/null || break
  sleep 0.25
done
if [ "$up" != "1" ]; then
  echo "server never answered on 127.0.0.1:$PORT" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi

say "driving scenario: $SCENARIO   (mode: $MODE)"
node "$HARNESS/drive.mjs" "$SCENARIO" \
  --mode "$MODE" --label "$SLUG" --out "$OUT" \
  --url "http://127.0.0.1:$PORT/" \
  --timeout "${TIMEOUT_MS:-60000}" --settle "${SETTLE_MS:-20000}"
RC=$?

say "artifacts in $OUT"
[ -f "$SIDECAR_DIR/turns.jsonl" ] && sed 's/^/    sidecar: /' "$SIDECAR_DIR/turns.jsonl"
# The two server lines that say the reply was LOST rather than slow, counted
# rather than left for a human to spot in a wall of log.
echo "    cos: events dropped (sum): $(grep -o 'subscriber dropped [0-9]*' "$SERVER_LOG" 2>/dev/null | awk '{s+=$3} END {print s+0}')"
echo "    cos: subscriber write failed lines: $(grep -c 'subscriber write failed' "$SERVER_LOG" 2>/dev/null || true)"
exit $RC
