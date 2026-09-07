#!/usr/bin/env bash
# down.sh -- stop and remove everything up.sh started, and PROVE it was stopped.
#
# Kills by RECORDED PID and by process group only. No pattern-matching pkill:
# AGENTS.md's warning that a pkill aimed at "just my scratch process" matches
# production too applies just as much to a teardown script as to a debugging
# reflex.
#
# WHY THIS PRINTS SO MUCH. "No processes left" is not evidence of a teardown.
# vite and Chrome are daemons -- they do not exit when a test run finishes, so a
# clean `ps` afterwards is equally consistent with "stopped" and with "never
# checked". This script therefore records, for each process: whether it was
# ALIVE before the signal, that the signal was sent to that exact pid, and
# whether it is GONE after. Three facts, in order, are a teardown. One fact at
# the end is a hope.
set -uo pipefail

RUN="${TMPDIR:-/tmp}/muxterm-mdstream"
fail=0

alive() { kill -0 "$1" 2>/dev/null; }

kill_tree() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null
}

echo "=== stopping, by recorded pid ==="
declare -A WAS
for name in chrome vite; do
  f="$RUN/$name.pid"
  if [ ! -f "$f" ]; then
    echo "  $name: no pidfile at $f -- nothing recorded as started"
    continue
  fi
  pid="$(cat "$f")"
  WAS[$name]="$pid"
  if alive "$pid"; then
    kids=$(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ')
    echo "  $name pid $pid: ALIVE before -> SIGTERM to it and children [${kids:-none}]"
    kill_tree "$pid"
  else
    echo "  $name pid $pid: already gone before teardown (unexpected -- it should have been running)"
  fi
done

sleep 2

echo
echo "=== confirming, by the same pids ==="
for name in chrome vite; do
  pid="${WAS[$name]:-}"
  [ -z "$pid" ] && continue
  if alive "$pid"; then
    echo "  $name pid $pid: survived SIGTERM -> SIGKILL"
    kill -KILL "$pid" 2>/dev/null
    sleep 1
  fi
  if alive "$pid"; then
    echo "  $name pid $pid: STILL ALIVE -- teardown FAILED"
    fail=1
  else
    echo "  $name pid $pid: GONE"
  fi
  rm -f "$RUN/$name.pid"
done

rm -rf "$RUN"

echo
echo "=== ports this work used (must be empty) ==="
if ss -ltn 2>/dev/null | grep -E ":5199|:9333|:8399"; then fail=1; else
  echo "  none -- 5199, 9333, 8399 are free"; fi

echo
echo "=== production (must be present and unchanged) ==="
if ! ss -ltnp 2>/dev/null | grep -E ":9090|:8311"; then
  echo "  WARNING: production listeners not found"; fail=1; fi

echo
echo "=== throwaway dir (must be gone) ==="
if [ -d "$RUN" ]; then echo "  WARNING: $RUN still present"; fail=1; else echo "  $RUN removed"; fi

echo
if [ "$fail" = 0 ]; then echo "teardown: CLEAN"; else echo "teardown: INCOMPLETE -- see above"; fi
exit "$fail"
