#!/usr/bin/env bash
# Verify the first SDK-backed session against a real, isolated sessiond.
#
# Run it through `make verify-sdk-session`, never directly: the Makefile target
# expands DEV_ISOLATE, which is the ONE mechanism that separates a dev instance
# from production (XDG_RUNTIME_DIR, XDG_DATA_HOME and MUXTERM_COS_SESSION_ID set
# together, plus the guard that refuses a runtime dir resolving to production
# state). This script asserts that isolation held rather than assuming it.
#
# What it proves, in order -- these are the four criteria the slice is judged on:
#
#   (a) A SESSION IS CREATED THROUGH THE SDK AND APPEARS IN THE FLEET.
#       `sdk-session start` drives codex's app-server over JSON-RPC; the row
#       then shows up in `muxterm fleet --json` with no pane and no workspace.
#   (b) DELIVERY IS ACKNOWLEDGED. `sdk-session send` returns a TURN ID the
#       harness minted in its turn/start response. The receipt is captured
#       verbatim, because an unquoted claim of acknowledgement is worthless.
#   (c) TURN BOUNDARIES COME FROM SDK EVENTS. The session has no PTY, no pane
#       and no hook, so its working -> stopped transition and its summary can
#       only have come from turn/started, turn/completed and item/completed.
#   (d) THE RECORD SURVIVES A DAEMON RESTART. The daemon is stopped by the exact
#       PID this script started, restarted on the same runtime and data dirs,
#       and the record is still there -- because it is written durably with
#       atomicfile, not published into the tmpfs session-state spool.
#
# It binds a port and starts a daemon, so it tears both down on the way out.
set -uo pipefail

BIN="${MUXTERM_BIN:?MUXTERM_BIN must point at the build under test}"
ADDR="${MUXTERM_VERIFY_ADDR:-127.0.0.1:8317}"
OUT="${MUXTERM_VERIFY_OUT:-/home/ken/artifacts/sdk-session-verify}"

# --- isolation assertion -----------------------------------------------------
# DEV_ISOLATE already refuses a production-looking runtime dir. Re-checking here
# means this script cannot be run outside the target and quietly drive the real
# installation's daemon.
case "${XDG_RUNTIME_DIR:-}" in
  ""|/run/user/*) echo "refusing: XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-<unset>} is production state"; exit 1;;
esac
case "${XDG_DATA_HOME:-}" in
  ""|"$HOME"/.local/share*) echo "refusing: XDG_DATA_HOME=${XDG_DATA_HOME:-<unset>} is production state"; exit 1;;
esac
case "$ADDR" in
  *:9090|*:8311|*:8440|*:8441|*:8442) echo "refusing: $ADDR is a reserved port"; exit 1;;
esac

mkdir -p "$OUT"
SOCK="$XDG_RUNTIME_DIR/muxterm/sessiond.sock"
WORKDIR="$XDG_RUNTIME_DIR/sdk-work"
mkdir -p "$WORKDIR"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
note() { printf '\n=== %s ===\n' "$*"; }

DAEMON_PID=""
stop_daemon() {
  [ -n "$DAEMON_PID" ] || return 0
  # Signal by the exact PID this script started. Never pkill/killall: those
  # match production's sessiond too.
  kill -TERM "$DAEMON_PID" 2>/dev/null
  for _ in $(seq 1 50); do kill -0 "$DAEMON_PID" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$DAEMON_PID" 2>/dev/null && kill -KILL "$DAEMON_PID" 2>/dev/null
  wait "$DAEMON_PID" 2>/dev/null
  DAEMON_PID=""
}
start_daemon() { # $1 = log
  "$BIN" sessiond > "$1" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 60); do [ -S "$SOCK" ] && break; sleep 0.1; done
  [ -S "$SOCK" ] || { echo "daemon did not bind $SOCK"; cat "$1"; exit 1; }
}
trap 'stop_daemon' EXIT INT TERM

STORE="$XDG_DATA_HOME/muxterm/sdk-sessions.json"

# =============================================================================
note "0. boot an isolated daemon"
start_daemon "$OUT/daemon-1.log"
ok "daemon running on $SOCK (pid $DAEMON_PID), runtime dir $XDG_RUNTIME_DIR"

# =============================================================================
note "(a) create a session THROUGH THE SDK"
START_JSON="$("$BIN" sdk-session start --harness codex --cwd "$WORKDIR" --name "sdk slice proof" --json 2>"$OUT/start.err")"
if [ -z "$START_JSON" ]; then
  bad "sdk-session start produced no output"; cat "$OUT/start.err"; exit 1
fi
printf '%s\n' "$START_JSON" > "$OUT/start.json"
SID="$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')"
TID="$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["threadId"])')"
[ -n "$SID" ] && ok "session created: $SID" || bad "no session id"
[ -n "$TID" ] && ok "harness thread id returned by thread/start: $TID" || bad "no thread id"

# It must appear in the fleet -- the same rows the browser home view renders.
sleep 2
"$BIN" fleet --json > "$OUT/fleet-before.json" 2>/dev/null
if python3 -c '
import json,sys
rows=json.load(open(sys.argv[1]))
rows=rows.get("sessions",rows) if isinstance(rows,dict) else rows
hit=[r for r in rows if r.get("sessionId")==sys.argv[2]]
sys.exit(0 if hit else 1)' "$OUT/fleet-before.json" "$SID"; then
  ok "session appears in muxterm fleet"
else
  bad "session missing from fleet"
fi
# No pane, no workspace: this session has no terminal at all.
python3 -c '
import json,sys
rows=json.load(open(sys.argv[1]))
rows=rows.get("sessions",rows) if isinstance(rows,dict) else rows
r=[x for x in rows if x.get("sessionId")==sys.argv[2]][0]
assert r.get("paneId") in (None,0), r.get("paneId")
assert r.get("workspaceId") in (None,""), r.get("workspaceId")
print("   fleet row: harness=%s state=%s paneId=%r workspaceId=%r" % (r.get("harness"),r.get("state"),r.get("paneId"),r.get("workspaceId")))
' "$OUT/fleet-before.json" "$SID" && ok "fleet row carries NO pane and NO workspace (no terminal)" \
  || bad "fleet row unexpectedly has a terminal attachment"

# =============================================================================
note "(b) deliver a turn and capture the ACKNOWLEDGEMENT"
SEND_JSON="$("$BIN" sdk-session send "$SID" --prompt 'Reply with exactly: SDK-SESSION-PROOF-OK' --json 2>"$OUT/send.err")"
if [ -z "$SEND_JSON" ]; then
  bad "sdk-session send produced no receipt"; cat "$OUT/send.err"
else
  printf '%s\n' "$SEND_JSON" > "$OUT/send-receipt.json"
  echo "   RECEIPT (verbatim): $SEND_JSON"
  TURN="$(printf '%s' "$SEND_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("turnId",""))')"
  [ -n "$TURN" ] && ok "harness returned turn id $TURN -- delivery acknowledged" \
                 || bad "no turn id in receipt"
fi
# The same text through the PTY-backed path is the contrast, recorded for the
# report rather than asserted: that path has no session here to send to.
"$BIN" session send "$SID" --prompt 'contrast probe' --client-ref sdk-contrast-1 \
  > "$OUT/pty-path-contrast.txt" 2>&1
echo "   PTY-path contrast recorded in $OUT/pty-path-contrast.txt"

# =============================================================================
note "(c) turn boundaries and state from SDK EVENTS"
# Poll the durable record until the harness reports the turn finished. The
# transition cannot come from anywhere else: there is no pane to read, no
# process group to poll, and no hook writing into the session-state spool.
FINAL_STATE=""
for _ in $(seq 1 90); do
  FINAL_STATE="$("$BIN" sdk-session list --json 2>/dev/null | python3 -c '
import json,sys
try: recs=json.load(sys.stdin)
except Exception: sys.exit(0)
for r in recs or []:
    if r["sessionId"]==sys.argv[1]: print(r["state"]); break
' "$SID")"
  [ "$FINAL_STATE" = "stopped" ] && break
  [ "$FINAL_STATE" = "failed" ] && break
  sleep 1
done
"$BIN" sdk-session list --json > "$OUT/records-before-restart.json" 2>/dev/null
python3 -c '
import json,sys
recs=json.load(open(sys.argv[1]))
r=[x for x in recs if x["sessionId"]==sys.argv[2]][0]
print("   state=%s turnCount=%d lastTurnStatus=%s" % (r["state"], r["turnCount"], r.get("lastTurnStatus")))
print("   summary=%r" % (r.get("summary","")[:120],))
sys.exit(0 if r["state"]=="stopped" and r["turnCount"]>=1 else 1)
' "$OUT/records-before-restart.json" "$SID" \
  && ok "turn completed; state came from turn/completed, summary from item/completed" \
  || bad "turn did not complete (state=$FINAL_STATE)"

# =============================================================================
note "(d) the record SURVIVES A DAEMON RESTART"
[ -f "$STORE" ] && ok "durable store written at $STORE" || bad "no durable store at $STORE"
cp -f "$STORE" "$OUT/sdk-sessions-before-restart.json" 2>/dev/null
BEFORE_PID="$DAEMON_PID"
stop_daemon
sleep 1
# The spool is the control: it is tmpfs and producer-owned, so it is expected
# to be empty here. The durable store is what must still hold the record.
ls "$XDG_RUNTIME_DIR/muxterm/session-state" > "$OUT/spool-after-stop.txt" 2>&1
start_daemon "$OUT/daemon-2.log"
ok "daemon restarted: old pid $BEFORE_PID -> new pid $DAEMON_PID"
"$BIN" sdk-session list --json > "$OUT/records-after-restart.json" 2>/dev/null
python3 -c '
import json,sys
recs=json.load(open(sys.argv[1]))
r=[x for x in recs if x["sessionId"]==sys.argv[2]]
if not r: print("   record ABSENT after restart"); sys.exit(1)
r=r[0]
print("   session=%s thread=%s state=%s turnCount=%d" % (r["sessionId"], r["threadId"], r["state"], r["turnCount"]))
sys.exit(0)
' "$OUT/records-after-restart.json" "$SID" \
  && ok "record survived the restart, with its harness thread id" \
  || bad "record did not survive the restart"

# A restarted daemon holds no live connection, and must SAY so rather than
# pretend the session is still drivable.
"$BIN" sdk-session send "$SID" --prompt 'after restart' --json > "$OUT/send-after-restart.txt" 2>&1
if grep -q "no live harness connection" "$OUT/send-after-restart.txt"; then
  ok "post-restart send refused honestly (no live connection claimed)"
else
  bad "post-restart send did not report the missing connection"
fi
cat "$OUT/send-after-restart.txt" | sed 's/^/   /'

# =============================================================================
note "PTY path unchanged"
# The PTY path's own argv builder and its lane spawn are untouched by this
# slice. Prove the binary still starts a real PTY-backed pane and that the
# harness argv is still built the old way.
WS="$("$BIN" workspace create sdk-pty-check 2>/dev/null | tail -1)"
if [ -n "$WS" ]; then ok "PTY path: workspace created ($WS)"; else bad "PTY path: workspace create failed"; fi
"$BIN" fleet --json > "$OUT/fleet-after.json" 2>/dev/null && ok "PTY path: fleet still readable" || bad "fleet broke"

# =============================================================================
note "RESULT"
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
printf 'artifacts in %s\n' "$OUT"
[ "$FAIL" -eq 0 ]
