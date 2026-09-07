#!/usr/bin/env bash
# down.sh -- stop and remove everything up.sh started, and prove it.
#
# Kills by RECORDED PID and by process group only. No pattern-matching pkill:
# AGENTS.md's warning that a pkill aimed at "just my scratch process" matches
# production too applies just as much to a teardown script as to a debugging
# reflex.
#
# Ends by printing what is still listening, because a teardown you have not
# looked at is not a teardown.
set -uo pipefail

RUN="${TMPDIR:-/tmp}/muxterm-mdstream"

kill_tree() {
  local pid="$1"
  [ -z "$pid" ] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill -TERM "$pid" 2>/dev/null
}

for name in chrome vite; do
  f="$RUN/$name.pid"
  if [ -f "$f" ]; then
    pid="$(cat "$f")"
    echo "stopping $name (pid $pid)"
    kill_tree "$pid"
    rm -f "$f"
  fi
done

sleep 2
for name in chrome vite; do
  f="$RUN/$name.pid"
  [ -f "$f" ] || continue
  pid="$(cat "$f")"
  kill -KILL "$pid" 2>/dev/null
  rm -f "$f"
done

rm -rf "$RUN"

echo
echo "=== ports this work used (must be empty) ==="
ss -ltn 2>/dev/null | grep -E ":5199|:9333|:8399" || echo "  none -- 5199, 9333, 8399 are free"
echo
echo "=== production (must be present and unchanged) ==="
ss -ltnp 2>/dev/null | grep -E ":9090|:8311" || echo "  WARNING: production listeners not found"
echo
echo "=== throwaway dir (must be gone) ==="
if [ -d "$RUN" ]; then echo "  WARNING: $RUN still present"; else echo "  $RUN removed"; fi
