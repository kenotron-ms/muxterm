#!/usr/bin/env bash
# Verify Operator lifecycle markers against a REAL, isolated sessiond.
#
# This is not a unit test and there is no assertion library: it starts the
# actual daemon, creates an actual pane, runs the actual reference producer
# (`muxterm session report`) inside it, and reads the durable marker file the
# daemon wrote. The thing under test -- edge detection across whole-state
# declarations -- has no meaning outside a running daemon with a real pane, so
# there is nothing smaller worth checking.
#
# ISOLATION. Every path is redirected by the caller (`make verify-lifecycle`),
# which expands the Makefile's DEV_ISOLATE macro exactly as every other dev
# target does. This script uses dev port 8399 for migration checks and kills only
# explicit PIDs it started itself -- never a pattern, never a service.
#
# WHAT IT PROVES
#   1. an autonomous lane going working -> done while its pane is still alive
#      produces a `finished` marker  (the /goal resume-handoff case that a
#      pane-exit record can never catch)
#   2. working -> blocked produces a `blocked` marker carrying waitingFor
#   3. blocked -> working RESOLVES that marker instead of leaving a stale
#      "needs you"
#   4. an INTERACTIVE lane doing the same things produces nothing at all
#   5. all of the above happen with NO session-state subscriber attached --
#      i.e. with no browser open, which is the whole point of a durable notice
#   6. the first observation of a session is a baseline and never an event, so
#      a daemon restart cannot retro-announce a lane that was already finished

set -uo pipefail

BIN="${MUXTERM_BIN:?set MUXTERM_BIN to the built muxterm binary}"
STATE_DIR="${XDG_RUNTIME_DIR:?}/muxterm/session-state"
MARKERS="${XDG_DATA_HOME:?}/muxterm/attention.json"
LOG="${XDG_RUNTIME_DIR}/verify-sessiond.log"

fail=0
note() { printf '  %s\n' "$*"; }
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf 'PASS  %s\n' "$1"
  else
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$2" "$3"
    fail=1
  fi
}

markers() { # markers <jq-filter>
  # An absent file is an EMPTY store, not an error: before the first marker is
  # written there is legitimately nothing on disk, and that is the state check 1
  # asserts.
  if [ ! -f "$MARKERS" ]; then echo '{"v":1,"records":[]}' | jq -c "$1"; return; fi
  jq -c "$1" <"$MARKERS" 2>/dev/null || echo "jq-error"
}

cleanup() {
  if [ -n "${SERVE_PID:-}" ]; then kill "$SERVE_PID" 2>/dev/null; fi
  if [ -n "${PANE_SHELL_PID:-}" ]; then kill "$PANE_SHELL_PID" 2>/dev/null; fi
  if [ -n "${DAEMON_PID:-}" ]; then
    kill "$DAEMON_PID" 2>/dev/null
    wait "$DAEMON_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

echo "=== isolated environment ==="
note "XDG_RUNTIME_DIR = $XDG_RUNTIME_DIR"
note "XDG_DATA_HOME   = $XDG_DATA_HOME"
note "markers file    = $MARKERS"
rm -f "$MARKERS"

echo
echo "=== starting sessiond (lifecycle notices ON) ==="
env -u MUXTERM_OPERATOR_LIFECYCLE_NOTICES "$BIN" sessiond >"$LOG" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 40); do
  [ -S "$XDG_RUNTIME_DIR/muxterm/sessiond.sock" ] && break
  sleep 0.25
done
[ -S "$XDG_RUNTIME_DIR/muxterm/sessiond.sock" ] || { echo "FAIL  sessiond did not start; see $LOG"; exit 1; }
note "sessiond pid $DAEMON_PID"

# The Claude adapter's default is visible in the daemon's own startup log.
sleep 0.5
if grep -q "claude adapter enabled (default on" "$LOG"; then
  echo "PASS  claude fleet adapter is ON by default (no env var set)"
else
  echo "FAIL  claude fleet adapter did not report itself enabled by default"
  fail=1
fi

echo
echo "=== creating a real pane ==="
WS=$("$BIN" workspace create lifecycle-verify --json 2>&1 | jq -r '.workspaceId // .workspace_id // empty' 2>/dev/null)
[ -n "$WS" ] || { echo "FAIL  could not create workspace"; "$BIN" workspace create lifecycle-verify --json; exit 1; }
PANE=$("$BIN" pane create --workspace "$WS" --json 2>&1 | jq -r '.paneId // .pane_id // empty' 2>/dev/null)
[ -n "$PANE" ] || { echo "FAIL  could not create pane"; "$BIN" pane create --workspace "$WS" --json; exit 1; }
note "workspace $WS pane $PANE"
sleep 1

# report <session-id> <mode> <state> [extra flags...]
#
# Run INSIDE the pane so the producer's own process session is the pane's, which
# is exactly how the shipped hook attributes itself. A report typed from this
# script's shell would be unplaceable and correctly ignored.
report() {
  local sid="$1" mode="$2" state="$3"; shift 3
  # Every extra argument is shell-quoted before it is typed into the PTY. It is
  # a real terminal: an unquoted "permission prompt" arrives as two arguments
  # and the report silently reports something else.
  local extra=""
  local a
  for a in "$@"; do extra="$extra $(printf '%q' "$a")"; done
  "$BIN" pane send "$PANE" \
    --text "$BIN session report --session-id $sid --mode $mode --state $state --name $sid$extra ; clear" >/dev/null 2>&1
  "$BIN" pane send "$PANE" --keys Enter >/dev/null 2>&1
  sleep 2.5
}

AUTO=verify-auto
INTER=verify-interactive

echo
echo "=== 1. baseline observation must not announce anything ==="
report "$AUTO" autonomous working -doing "starting"
check "first sighting of a working lane writes no marker" "0" "$(markers '[.records[]]|length')"

echo
echo "=== 2. autonomous working -> done, pane still alive ==="
report "$AUTO" autonomous done -doing "all green"
check "one finished marker" "1" "$(markers "[.records[]|select(.kind==\"finished\")]|length")"
check "  attributed to the right session" "\"$AUTO\"" "$(markers "[.records[]|select(.kind==\"finished\")][0].sessionId")"
check "  records the transition it saw" "\"working\"" "$(markers "[.records[]|select(.kind==\"finished\")][0].fromState")"

for outcome in failed stopped; do
  report "verify-$outcome" autonomous working -doing "starting"
  report "verify-$outcome" autonomous "$outcome" -doing "$outcome distinctly"
  check "one $outcome marker" "1" "$(markers "[.records[]|select(.kind==\"$outcome\")]|length")"
done

echo
echo "=== 3. autonomous working -> blocked ==="
report "$AUTO" autonomous working -doing "second pass"
report "$AUTO" autonomous blocked -waiting-for "permission prompt"
check "one blocked marker" "1" "$(markers "[.records[]|select(.kind==\"blocked\")]|length")"
check "  carries the declared reason" "\"permission prompt\"" "$(markers "[.records[]|select(.kind==\"blocked\")][0].declaredWaitingFor")"
check "  is unresolved while it is blocked" "false" "$(markers "[.records[]|select(.kind==\"blocked\")][0].resolved // false")"

echo
echo "=== 4. blocked -> working resolves it rather than leaving a stale ask ==="
report "$AUTO" autonomous working -doing "unblocked"
check "blocked marker is now resolved" "true" "$(markers "[.records[]|select(.kind==\"blocked\")][0].resolved // false")"

echo
echo "=== 5. an INTERACTIVE lane is never an alarm ==="
report "$INTER" interactive working -doing "typing"
report "$INTER" interactive blocked -waiting-for "input needed"
report "$INTER" interactive stopped
report "$INTER" interactive done
check "interactive transitions produce no markers at all" "0" \
  "$(markers "[.records[]|select(.sessionId==\"$INTER\")]|length")"

echo
echo "=== 6. no session-state subscriber was ever attached ==="
if grep -qi "session-state-subscribe" "$LOG"; then
  echo "FAIL  something subscribed; this run does not prove the no-browser case"
  fail=1
else
  echo "PASS  every marker above was recorded with no browser attached"
fi

echo
echo "=== 7. delivery ledger: the one-time migration, and no backfill ==="
#
# The markers above are now PRE-EXISTING history from the notice pump's point of
# view -- exactly the state a machine is in the moment an operator first turns
# this feature on. The pump must record every one of them as already-announced
# and say nothing, because narrating days-old lanes into the conversation on
# first boot is the sharpest edge in this whole design.
LEDGER="${XDG_DATA_HOME}/muxterm/operator-notices.json"
SERVE_LOG="${XDG_RUNTIME_DIR}/verify-serve.log"
rm -f "$LEDGER"
env -u MUXTERM_OPERATOR_LIFECYCLE_NOTICES "$BIN" serve --addr 127.0.0.1:8399 >"$SERVE_LOG" 2>&1 &
SERVE_PID=$!
sleep 6
kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null

if [ -f "$LEDGER" ]; then
  echo "PASS  a delivery ledger was created"
else
  echo "FAIL  no delivery ledger was written to $LEDGER"; fail=1
fi
# Announceable means UNRESOLVED. A resolved marker is never announced at all --
# a lane that un-blocked itself needs nobody -- so it does not need a ledger
# entry either, and Resolved is a one-way flag that can never flip back.
ANNOUNCEABLE=$(markers '[.records[]|select((.resolved // false)==false)]|length')
RESOLVED=$(markers '[.records[]|select(.resolved==true)]|length')
SEEDED=$(jq -c '[.entries[]|select(.seeded==true)]|length' <"$LEDGER" 2>/dev/null || echo "jq-error")
check "every announceable pre-existing marker is recorded as already-announced" "$ANNOUNCEABLE" "$SEEDED"
check "a resolved marker is not announced, so it is not seeded either" "1" "$RESOLVED"
check "nothing was actually delivered" "0" \
  "$(jq -c '[.entries[]|select((.turnId // "") != "")]|length' <"$LEDGER" 2>/dev/null || echo jq-error)"
if grep -q "recorded as already-announced (no backfill)" "$SERVE_LOG"; then
  echo "PASS  the migration announced itself in the log"
else
  echo "FAIL  the one-time migration did not log"; fail=1
fi

LEDGER_BEFORE=$(cat "$LEDGER")
env -u MUXTERM_OPERATOR_LIFECYCLE_NOTICES "$BIN" serve --addr 127.0.0.1:8399 >>"$SERVE_LOG" 2>&1 &
SERVE_PID=$!
sleep 6
kill "$SERVE_PID" 2>/dev/null; wait "$SERVE_PID" 2>/dev/null
check "a restart re-seeds nothing and re-announces nothing" "$LEDGER_BEFORE" "$(cat "$LEDGER")"

echo
echo "=== 8. feature gate: with the switch OFF, nothing observes and nothing is written ==="
kill "$DAEMON_PID" 2>/dev/null; wait "$DAEMON_PID" 2>/dev/null
MARKERS_BEFORE=$(cat "$MARKERS" 2>/dev/null)
OFF_LOG="${XDG_RUNTIME_DIR}/verify-sessiond-off.log"
# Explicit opt-out disables notices; an unset switch now enables them.
MUXTERM_OPERATOR_LIFECYCLE_NOTICES=0 "$BIN" sessiond >"$OFF_LOG" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 40); do
  [ -S "$XDG_RUNTIME_DIR/muxterm/sessiond.sock" ] && break
  sleep 0.25
done
WS_OFF=$("$BIN" workspace create lifecycle-verify-off --json 2>&1 | jq -r '.workspaceId // empty' 2>/dev/null)
PANE=$("$BIN" pane create --workspace "$WS_OFF" --json 2>&1 | jq -r '.paneId // empty' 2>/dev/null)
sleep 1
report gated-lane autonomous working -doing "should be invisible"
report gated-lane autonomous done -doing "should be invisible"
check "no marker is written when the feature is off" "$MARKERS_BEFORE" "$(cat "$MARKERS" 2>/dev/null)"

echo
echo "=== delivery ledger ==="
[ -f "$LEDGER" ] && jq '.' <"$LEDGER"

echo
echo "=== markers written ==="
[ -f "$MARKERS" ] && jq '.' <"$MARKERS"

echo
if [ "$fail" = 0 ]; then echo "RESULT: all checks passed"; else echo "RESULT: FAILURES ABOVE"; fi
exit "$fail"
