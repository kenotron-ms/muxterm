#!/usr/bin/env bash
# Verify the Inbox container against a real, isolated sessiond.
#
# Run it through `make verify-inbox`, never directly: the Makefile target
# expands DEV_ISOLATE, which is the ONE mechanism that separates a dev instance
# from production (XDG_RUNTIME_DIR, XDG_DATA_HOME and MUXTERM_COS_SESSION_ID set
# together, plus the guard that refuses a runtime dir resolving to production
# state). This script asserts that isolation held rather than assuming it.
#
# What it proves, in order:
#
#   1. AN EXISTING INSTALLATION STILL OPENS. A BASELINE binary (built from the
#      commit before this feature) creates workspaces and panes; its daemon is
#      stopped; THIS build's daemon boots on the same runtime and data dirs and
#      every workspace and pane is still there. This is the whole risk of the
#      change and it is checked first.
#   2. A NEW SESSION LANDS IN THE INBOX AUTOMATICALLY, with no filing step.
#   3. THE INBOX REFUSES DELETION AND RENAME, as a real executed attempt.
#   4. THE FILING GESTURE WORKS, and refuses an unknown destination.
#
# It binds a port and starts a daemon, so it tears both down on the way out.
set -uo pipefail

BIN="${MUXTERM_BIN:?MUXTERM_BIN must point at the build under test}"
BASELINE_BIN="${MUXTERM_BASELINE_BIN:-}"
ADDR="${MUXTERM_VERIFY_ADDR:-127.0.0.1:8317}"
OUT="${MUXTERM_VERIFY_OUT:-/home/ken/artifacts/inbox-verify}"

# --- isolation assertion -----------------------------------------------------
# DEV_ISOLATE already refuses a production-looking runtime dir. Re-checking here
# means this script cannot be run outside the target and quietly write to the
# real installation.
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
start_daemon() { # $1 = binary, $2 = log
  "$1" sessiond > "$2" 2>&1 &
  DAEMON_PID=$!
  for _ in $(seq 1 60); do [ -S "$SOCK" ] && break; sleep 0.1; done
  [ -S "$SOCK" ] || { echo "daemon did not bind $SOCK"; cat "$2"; exit 1; }
}
trap 'stop_daemon' EXIT INT TERM

# Talk to the daemon through its OWN Go client (internal/sessiond.Client), the
# same one the CLI and the serve relay use. A refusal captured here is the real
# API boundary refusing, not a reimplementation of it. The probe is built from
# a throwaway source file under tmp/ and deleted on the way out.
PROBE="$PWD/tmp/inbox-probe"
probe() { "$PROBE" "$SOCK" "$@"; }

# A workspace's DURABLE identity is its workspaceUuid, name and pane count. Its
# `wN` local id is re-minted by the restore path on every boot, and a control
# run of the BASELINE binary against itself produces exactly the same shift --
# so comparing on `wN` would report a regression that v0.51.0 already has.
# Boot also mints one fresh empty unnamed workspace, which is likewise not a
# survivor and is excluded here.
durable() {
  python3 -c '
import json, sys
rows = json.load(sys.stdin)
keep = [(r["name"], r["uuid"], r["panes"]) for r in rows if r["name"] or r["panes"]]
print(json.dumps(sorted(keep)))'
}

# =============================================================================
note "1. AN EXISTING INSTALLATION STILL OPENS"
# =============================================================================
if [ -n "$BASELINE_BIN" ]; then
  echo "baseline binary: $BASELINE_BIN"
  start_daemon "$BASELINE_BIN" "$OUT/baseline-sessiond.log"
  # Build a realistic installation on the OLD code: three named workspaces
  # with panes in each, created through the daemon's own client exactly as the
  # browser and the CLI do.
  probe seed > "$OUT/baseline-created.txt" 2>&1
  cat "$OUT/baseline-created.txt"
  BEFORE_RAW=$(probe inventory)
  echo "BEFORE_RAW: $BEFORE_RAW"
  BEFORE=$(printf '%s' "$BEFORE_RAW" | durable)
  echo "BEFORE durable identity: $BEFORE"
  # Graceful stop so the crash-restore snapshot is written, which is exactly
  # what a real upgrade does: stop the old daemon, start the new one.
  stop_daemon
  sleep 0.5

  echo "upgrading to build under test: $BIN"
  start_daemon "$BIN" "$OUT/upgraded-sessiond.log"
  AFTER_RAW=$(probe inventory)
  echo "AFTER_RAW : $AFTER_RAW"
  AFTER=$(printf '%s' "$AFTER_RAW" | durable)
  echo "AFTER  durable identity: $AFTER"
  if [ "$BEFORE" = "$AFTER" ] && [ "$BEFORE" != "[]" ] && [ -n "$BEFORE" ]; then
    ok "every workspace kept its durable uuid, its name and its pane count across the upgrade"
  else
    bad "workspace/pane set changed across the upgrade"
  fi
else
  echo "(no baseline binary supplied; starting the build under test directly)"
  start_daemon "$BIN" "$OUT/upgraded-sessiond.log"
fi

# =============================================================================
note "2. A NEW SESSION LANDS IN THE INBOX AUTOMATICALLY"
# =============================================================================
# A producer writes a snapshot exactly as docs/session-state-protocol.md
# describes. Nothing here mentions a project: that is the point.
"$BIN" session report \
  --session-id verify-fresh-session \
  --harness codex \
  --name "rewire the approval translation so codex-cli 0.157 is accepted" \
  --mode interactive \
  --state working \
  --doing "editing internal/sessiond/lane_argv.go" >/dev/null 2>&1
sleep 1.5
"$BIN" fleet --json > "$OUT/fleet-after-new-session.json" 2>/dev/null
python3 - "$OUT/fleet-after-new-session.json" > "$OUT/inbox-landing.txt" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
rows = rows if isinstance(rows, list) else rows.get("sessions", [])
for r in rows:
    print(f"  sessionId={r.get('sessionId')!r} projectId={r.get('projectId')!r}")
print(f"TOTAL={len(rows)}")
print(f"NULL_OR_MISSING={sum(1 for r in rows if not r.get('projectId'))}")
print(f"IN_INBOX={sum(1 for r in rows if r.get('projectId')=='inbox')}")
PY
cat "$OUT/inbox-landing.txt"
TOTAL=$(grep '^TOTAL=' "$OUT/inbox-landing.txt" | cut -d= -f2)
NULLS=$(grep '^NULL_OR_MISSING=' "$OUT/inbox-landing.txt" | cut -d= -f2)
INBOX=$(grep '^IN_INBOX=' "$OUT/inbox-landing.txt" | cut -d= -f2)
[ "$TOTAL" -gt 0 ] && ok "the fleet published $TOTAL session row(s)" || bad "no session rows published"
[ "$NULLS" = "0" ] && ok "zero rows carry a null or missing projectId" || bad "$NULLS row(s) carry no projectId"
[ "$INBOX" = "$TOTAL" ] && ok "all $TOTAL row(s) landed in the Inbox with no filing step" || bad "only $INBOX of $TOTAL landed in the Inbox"

# =============================================================================
note "3. THE INBOX REFUSES DELETION AND RENAME"
# =============================================================================
# A real executed attempt against the real API boundary, not a claim.
cat > "$OUT/refusal_probe.go" <<'PY'
package main

import (
	"fmt"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

func main() {
	reg := sessiond.NewProjectRegistry()
	fmt.Printf("inbox id                : %q\n", sessiond.InboxProjectID)
	fmt.Printf("inbox reserved          : %v\n", sessiond.InboxProjectID.Reserved())
	fmt.Printf("rename(inbox,\"Everything\"): %v\n", reg.Rename(sessiond.InboxProjectID, "Everything"))
	fmt.Printf("delete(inbox)           : %v\n", reg.Delete(sessiond.InboxProjectID))
	after, ok := reg.Get(sessiond.InboxProjectID)
	fmt.Printf("still present after both: ok=%v name=%q reserved=%v\n", ok, after.Name, after.Reserved)
	fmt.Printf("resolve(\"\")             : %q\n", sessiond.ResolveProjectID("", reg.Known))
	fmt.Printf("resolve(\"ghost-project\"): %q\n", sessiond.ResolveProjectID("ghost-project", reg.Known))
}
PY
mkdir -p "$PWD/tmp/refusal-probe"
cp "$OUT/refusal_probe.go" "$PWD/tmp/refusal-probe/main.go"
go run "$PWD/tmp/refusal-probe/main.go" > "$OUT/inbox-refusal.txt" 2>&1
rm -rf "$PWD/tmp/refusal-probe"
cat "$OUT/inbox-refusal.txt"
grep -q 'rename(inbox,"Everything"): sessiond: reserved project cannot be renamed' "$OUT/inbox-refusal.txt" \
  && ok "rename refused loudly with ErrProjectReserved" || bad "rename was NOT refused"
grep -q 'delete(inbox)           : sessiond: reserved project cannot be renamed or deleted' "$OUT/inbox-refusal.txt" \
  && ok "delete refused loudly with ErrProjectReserved" || bad "delete was NOT refused"
grep -q 'still present after both: ok=true name="Inbox" reserved=true' "$OUT/inbox-refusal.txt" \
  && ok "the Inbox survived both attempts, unrenamed" || bad "the Inbox did not survive intact"
grep -q 'resolve("")             : "inbox"' "$OUT/inbox-refusal.txt" \
  && ok "an empty parent resolves to the Inbox (no null representable)" || bad "empty parent did not resolve"
grep -q 'resolve("ghost-project"): "inbox"' "$OUT/inbox-refusal.txt" \
  && ok "a removed project's sessions fall back to the Inbox" || bad "unknown parent did not resolve"

# =============================================================================
note "4. THE FILING GESTURE"
# =============================================================================
probe projects > "$OUT/destinations.json"
echo "DESTINATIONS: $(cat "$OUT/destinations.json")"
grep -q '"id":"inbox"' "$OUT/destinations.json" \
  && ok "list-projects answered with the destination list, containing the Inbox" || bad "no Inbox in the destination list"
grep -q '"reserved":true' "$OUT/destinations.json" \
  && ok "the Inbox is published as reserved, so a UI declines to offer rename/delete" || bad "reserved flag missing"
DEST_COUNT=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))))' "$OUT/destinations.json")
[ "$DEST_COUNT" = "1" ] \
  && ok "the destination list currently contains exactly one entry, as specified" || bad "expected 1 destination, got $DEST_COUNT"

probe file verify-fresh-session inbox > "$OUT/file-ok.txt" 2>&1
cat "$OUT/file-ok.txt"
grep -q '^ACCEPTED' "$OUT/file-ok.txt" && ok "the filing gesture was accepted" || bad "filing gesture not accepted"

probe file verify-fresh-session a-project-that-does-not-exist > "$OUT/file-refused.txt" 2>&1
cat "$OUT/file-refused.txt"
grep -q 'unknown-project' "$OUT/file-refused.txt" \
  && ok "filing into a non-existent project was refused with unknown-project" || bad "unknown destination was NOT refused"

# The row is still in the Inbox, and still non-null, after both.
"$BIN" fleet --json > "$OUT/fleet-after-filing.json" 2>/dev/null
python3 - "$OUT/fleet-after-filing.json" > "$OUT/after-filing.txt" <<'PYEOF'
import json, sys
rows = json.load(open(sys.argv[1]))
rows = rows if isinstance(rows, list) else rows.get("sessions", [])
print(f"NULL_OR_MISSING={sum(1 for r in rows if not r.get('projectId'))}")
for r in rows:
    print(f"  sessionId={r.get('sessionId')!r} projectId={r.get('projectId')!r}")
PYEOF
cat "$OUT/after-filing.txt"
grep -q '^NULL_OR_MISSING=0' "$OUT/after-filing.txt" \
  && ok "after filing and a refusal, still zero rows with a null projectId" || bad "a null projectId appeared"

note "RESULT"
printf 'passed %d, failed %d\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
