#!/usr/bin/env bash
# Verify that an SDK-backed session can be CONTINUED after a daemon restart.
#
# Run it through `make verify-sdk-resume`, never directly: the Makefile target
# expands DEV_ISOLATE, which is the ONE mechanism that separates a dev instance
# from production (XDG_RUNTIME_DIR, XDG_DATA_HOME and MUXTERM_COS_SESSION_ID set
# together, plus the guard that refuses a runtime dir resolving to production
# state). This script asserts that isolation held rather than assuming it.
#
# WHAT IT PROVES, AND WHY THE SHAPE MATTERS. PR #220 demonstrated that a durable
# record survives a daemon restart carrying its harness-native thread id. What
# it could not do was USE that id: every turn against a surviving record was
# refused. So the thing to prove here is not "the daemon returned 200 after a
# restart" -- it is that the CONVERSATION survived.
#
# The design is therefore a memory test the harness cannot pass by accident:
#
#   1. A PASSPHRASE IS MINTED HERE, AT RANDOM, AT RUN TIME. It is in no
#      training set, no prompt template and no file the model can read: a
#      read-only sandbox rooted at an empty temp directory holds nothing but
#      what this script put there.
#   2. Turn one tells the session the passphrase. Nothing else.
#   3. THE DAEMON IS KILLED BY EXACT PID AND RESTARTED. Its app-server child
#      dies with it; the live JSON-RPC connection is gone.
#   4. Turn two asks for the passphrase back and nothing else.
#
# A harness that merely started a NEW thread in the same directory would answer
# turn two with an apology. Only a thread that still holds turn one can say the
# word. That answer, quoted verbatim, is the evidence -- not the HTTP status of
# the send, and not the presence of the record in a list.
#
# It starts a daemon, so it tears it down on the way out.
set -uo pipefail

BIN="${MUXTERM_BIN:?MUXTERM_BIN must point at the build under test}"
OUT="${MUXTERM_VERIFY_OUT:-/home/ken/artifacts/sdk-resume-verify}"

# --- isolation assertion -----------------------------------------------------
case "${XDG_RUNTIME_DIR:-}" in
  ""|/run/user/*) echo "refusing: XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-<unset>} is production state"; exit 1;;
esac
case "${XDG_DATA_HOME:-}" in
  ""|"$HOME"/.local/share*) echo "refusing: XDG_DATA_HOME=${XDG_DATA_HOME:-<unset>} is production state"; exit 1;;
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

# wait_turn <session-id> -- block until the harness reports the turn finished.
wait_turn() {
  local st=""
  for _ in $(seq 1 120); do
    st="$("$BIN" sdk-session list --json 2>/dev/null | python3 -c '
import json,sys
try: recs=json.load(sys.stdin)
except Exception: sys.exit(0)
for r in recs or []:
    if r["sessionId"]==sys.argv[1]: print(r["state"]); break
' "$1")"
    [ "$st" = "stopped" ] && break
    [ "$st" = "failed" ] && break
    sleep 1
  done
  printf '%s' "$st"
}
summary_of() {
  "$BIN" sdk-session list --json 2>/dev/null | python3 -c '
import json,sys
for r in json.load(sys.stdin) or []:
    if r["sessionId"]==sys.argv[1]: print(r.get("summary","")); break
' "$1"
}

# The secret. Minted here, never written into the session cwd, so the only
# place it can survive between turn one and turn two is the harness thread.
SECRET="MUXTERM-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | tr 'a-f' 'A-F')"

# =============================================================================
note "0. boot an isolated daemon"
start_daemon "$OUT/daemon-1.log"
ok "daemon running on $SOCK (pid $DAEMON_PID), runtime dir $XDG_RUNTIME_DIR"
echo "   passphrase minted for this run: $SECRET"

# =============================================================================
note "1. start an SDK session and TELL IT the passphrase"
START_JSON="$("$BIN" sdk-session start --harness codex --cwd "$WORKDIR" --name "sdk resume proof" --json 2>"$OUT/start.err")"
[ -n "$START_JSON" ] || { bad "sdk-session start produced no output"; cat "$OUT/start.err"; exit 1; }
printf '%s\n' "$START_JSON" > "$OUT/start.json"
SID="$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')"
TID="$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["threadId"])')"
ok "session $SID on harness thread $TID"

SEND1="$("$BIN" sdk-session send "$SID" --json \
  --prompt "Remember this passphrase for later in our conversation: $SECRET . Reply with exactly the word NOTED and nothing else." 2>&1)"
printf '%s\n' "$SEND1" > "$OUT/send-1.json"
echo "   TURN 1 RECEIPT: $SEND1"
printf '%s' "$SEND1" | grep -q '"turnId"' && ok "turn 1 accepted by the harness" || bad "turn 1 was not accepted"
ST1="$(wait_turn "$SID")"
[ "$ST1" = "stopped" ] && ok "turn 1 completed (state=$ST1)" || bad "turn 1 did not complete (state=$ST1)"
summary_of "$SID" > "$OUT/answer-1.txt"
echo "   TURN 1 ANSWER: $(cat "$OUT/answer-1.txt")"

# =============================================================================
note "2. RESTART THE DAEMON BY EXACT PID"
BEFORE_PID="$DAEMON_PID"
# Record the app-server children of THIS daemon before the kill, so the report
# can show they went with it rather than asserting it.
pgrep -P "$BEFORE_PID" -a > "$OUT/children-before-restart.txt" 2>&1
stop_daemon
sleep 1
start_daemon "$OUT/daemon-2.log"
ok "daemon restarted: old pid $BEFORE_PID -> new pid $DAEMON_PID"
"$BIN" sdk-session list --json > "$OUT/records-after-restart.json" 2>/dev/null
python3 -c '
import json,sys
recs=json.load(open(sys.argv[1]))
r=[x for x in recs if x["sessionId"]==sys.argv[2]]
if not r: print("   record ABSENT after restart"); sys.exit(1)
r=r[0]
print("   session=%s thread=%s state=%s turnCount=%d resumeCount=%d"
      % (r["sessionId"], r["threadId"], r["state"], r["turnCount"], r.get("resumeCount",0)))
sys.exit(0 if r.get("resumeCount",0)==0 else 1)
' "$OUT/records-after-restart.json" "$SID" \
  && ok "record survived with its thread id, NOT yet resumed (resumeCount=0)" \
  || bad "record missing or already resumed after restart"

# =============================================================================
note "3. send a SECOND turn and ask for the passphrase back"
SEND2="$("$BIN" sdk-session send "$SID" --json \
  --prompt "What passphrase did I ask you to remember earlier in this conversation? Reply with exactly that passphrase and nothing else." 2>&1)"
printf '%s\n' "$SEND2" > "$OUT/send-2.json"
echo "   TURN 2 RECEIPT: $SEND2"
printf '%s' "$SEND2" | grep -q '"resumed": true' && ok "the send RESUMED the harness thread (resumed=true on the receipt)" \
  || bad "receipt did not report a resumption"
ST2="$(wait_turn "$SID")"
[ "$ST2" = "stopped" ] && ok "turn 2 completed (state=$ST2)" || bad "turn 2 did not complete (state=$ST2)"
summary_of "$SID" > "$OUT/answer-2.txt"
ANSWER2="$(cat "$OUT/answer-2.txt")"

# =============================================================================
note "4. THE EVIDENCE: did the context survive?"
echo "   PASSPHRASE GIVEN BEFORE THE RESTART : $SECRET"
echo "   ANSWER AFTER THE RESTART            : $ANSWER2"
if printf '%s' "$ANSWER2" | grep -qF "$SECRET"; then
  ok "the resumed thread ANSWERED FROM THE PRE-RESTART TURN -- context survived"
else
  bad "the answer does not contain the passphrase; context did NOT survive"
fi
"$BIN" sdk-session list --json > "$OUT/records-final.json" 2>/dev/null
python3 -c '
import json,sys
r=[x for x in json.load(open(sys.argv[1])) if x["sessionId"]==sys.argv[2]][0]
print("   final record: turnCount=%d resumeCount=%d state=%s" % (r["turnCount"], r.get("resumeCount",0), r["state"]))
sys.exit(0 if r["turnCount"]>=2 and r.get("resumeCount",0)>=1 else 1)
' "$OUT/records-final.json" "$SID" \
  && ok "one record, two turns, one resumption -- a single continued conversation" \
  || bad "record does not show two turns across one resumption"

# =============================================================================
note "5. the PTY path, actually driven"
# Not "it compiles". A real workspace, a real pane, a real shell, input written
# into the PTY and the result read back off the screen.
WS="$("$BIN" workspace create sdk-resume-pty-check 2>/dev/null | grep -oE '\bw[0-9]+\b' | head -1)"
[ -n "$WS" ] && ok "PTY path: workspace created ($WS)" || bad "PTY path: workspace create failed"
PANE="$("$BIN" pane create --workspace "$WS" 2>"$OUT/pty-pane-create.err" | grep -oE '[0-9]+' | head -1)"
if [ -n "$PANE" ]; then
  ok "PTY path: pane $PANE created"
  sleep 2
  "$BIN" pane send "$PANE" --text 'echo PTY_ROUNDTRIP_OK' --keys Enter > "$OUT/pty-send.txt" 2>&1
  cat "$OUT/pty-send.txt" | sed 's/^/   /'
  sleep 2
  "$BIN" read-screen "$PANE" > "$OUT/pty-screen.txt" 2>&1
  grep -q 'PTY_ROUNDTRIP_OK' "$OUT/pty-screen.txt" \
    && ok "PTY path: round trip observed on the screen" \
    || bad "PTY path: round trip not observed"
  grep -n 'PTY_ROUNDTRIP_OK' "$OUT/pty-screen.txt" | head -3 | sed 's/^/   /'
else
  bad "PTY path: pane create failed"
fi

# =============================================================================
note "RESULT"
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
printf 'artifacts in %s\n' "$OUT"
[ "$FAIL" -eq 0 ]
