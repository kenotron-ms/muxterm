#!/usr/bin/env bash
# Verify that an SDK-backed session's output is WATCHABLE in a real browser.
#
# Run it through `make verify-sdk-stream`, never directly: the Makefile target
# expands DEV_ISOLATE, the ONE mechanism separating a dev instance from
# production. This script re-asserts that isolation rather than assuming it,
# and refuses the reserved ports outright.
#
# WHAT IT PROVES, AND WHY A BROWSER IS REQUIRED. #220 recorded that
# `item/agentMessage/delta` already arrives from the harness and is rendered
# nowhere. An SDK-backed session has NO PANE -- that is the whole point of it --
# so "watchable" cannot be demonstrated by reading a terminal, a log file or a
# JSON record. It can only be demonstrated by a human-visible surface showing
# text WHILE the model is still producing it. So this drives the actual UI:
#
#   1. An isolated sessiond and an isolated `muxterm serve` on a non-production
#      port, both started here and both torn down here, by exact PID.
#   2. A real browser (playwright-cli) on that port.
#   3. An SDK session created through the daemon, with no pane and no terminal.
#   4. A turn whose answer is long enough to still be arriving when looked at.
#   5. The session's card CLICKED -- the same gesture a human makes -- to open
#      the detail panel, and the live text read back OUT OF THE RENDERED DOM
#      while the record still says `working`.
#   6. A PNG screenshot, which is the artifact a reader can check.
#
# Reading the text out of the rendered DOM matters: a buffer in a component's
# memory is not a thing anybody can see. The assertion is against the <pre> the
# browser is painting.
set -uo pipefail

BIN="${MUXTERM_BIN:?MUXTERM_BIN must point at the build under test}"
ADDR="${MUXTERM_STREAM_ADDR:-127.0.0.1:8319}"
OUT="${MUXTERM_VERIFY_OUT:-/home/ken/artifacts/sdk-stream-verify}"
PW="${PLAYWRIGHT_CLI:-playwright-cli}"
SESSION_NAME="sdkstream"
# The fleet label for this run's session. Unique enough to target by, because
# the fleet legitimately holds other rows.
SESSION_LABEL="watchable stream proof"

# --- isolation assertions ----------------------------------------------------
case "${XDG_RUNTIME_DIR:-}" in
  ""|/run/user/*) echo "refusing: XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-<unset>} is production state"; exit 1;;
esac
case "${XDG_DATA_HOME:-}" in
  ""|"$HOME"/.local/share*) echo "refusing: XDG_DATA_HOME=${XDG_DATA_HOME:-<unset>} is production state"; exit 1;;
esac
case "$ADDR" in
  *:9090|*:8311|*:8440|*:8441|*:8442) echo "refusing: $ADDR is a reserved port"; exit 1;;
esac
command -v "$PW" >/dev/null || { echo "refusing: $PW not found; a browser is not optional for this check"; exit 1; }

# Stale artifacts from a previous run are worse than none: a screenshot left
# behind by an earlier pass would be read as this pass's evidence.
rm -rf "$OUT"
mkdir -p "$OUT"
SOCK="$XDG_RUNTIME_DIR/muxterm/sessiond.sock"
WORKDIR="$XDG_RUNTIME_DIR/sdk-work"
mkdir -p "$WORKDIR"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
note() { printf '\n=== %s ===\n' "$*"; }

DAEMON_PID=""; SERVE_PID=""
kill_pid() { # $1 = pid. By EXACT pid, never pkill: that matches production too.
  [ -n "${1:-}" ] || return 0
  kill -TERM "$1" 2>/dev/null
  for _ in $(seq 1 50); do kill -0 "$1" 2>/dev/null || break; sleep 0.1; done
  kill -0 "$1" 2>/dev/null && kill -KILL "$1" 2>/dev/null
  return 0
}
teardown() {
  "$PW" -s="$SESSION_NAME" close >/dev/null 2>&1
  kill_pid "$SERVE_PID"
  kill_pid "$DAEMON_PID"
  # `serve` starts its own sessiond if one is not already up; that child is in
  # THIS isolated runtime dir, so it is ours to reap and nobody else's.
  for p in $(pgrep -f "^$BIN sessiond$" 2>/dev/null); do kill_pid "$p"; done
  for p in $(pgrep -f "^$BIN serve --addr $ADDR" 2>/dev/null); do kill_pid "$p"; done
}
trap 'teardown' EXIT INT TERM

# eval_page <js-file> -- run a page expression and print only its result line.
eval_page() { "$PW" -s="$SESSION_NAME" eval "$(cat "$1")" 2>&1 | sed -n '2p'; }

# =============================================================================
note "0. an isolated daemon and an isolated server, on a non-production port"
# FRESH FIXTURES, EVERY RUN (AGENTS.md). The durable SDK-session store lives
# under $XDG_DATA_HOME and is the whole point of the feature -- it SURVIVES,
# which means a previous run's sessions are still in the fleet on the next
# one. Two runs in, the browser is looking at a pile of detached records and
# "the first card" is somebody else's. Both paths were asserted above to be
# isolated dev state, never production.
rm -rf "${XDG_DATA_HOME:?}/muxterm" "${XDG_RUNTIME_DIR:?}/muxterm"
mkdir -p "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR"
setsid nohup "$BIN" sessiond > "$OUT/sessiond.log" 2>&1 < /dev/null &
DAEMON_PID=$!
for _ in $(seq 1 60); do [ -S "$SOCK" ] && break; sleep 0.1; done
[ -S "$SOCK" ] || { echo "daemon did not bind $SOCK"; cat "$OUT/sessiond.log"; exit 1; }
ok "sessiond pid $DAEMON_PID on $SOCK (runtime dir $XDG_RUNTIME_DIR)"

setsid nohup "$BIN" serve --addr "$ADDR" --no-auth > "$OUT/serve.log" 2>&1 < /dev/null &
SERVE_PID=$!
for _ in $(seq 1 60); do
  curl -sS -o /dev/null --max-time 2 "http://$ADDR/" && break
  sleep 0.25
done
CODE="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://$ADDR/")"
[ "$CODE" = "200" ] && ok "muxterm serve pid $SERVE_PID answering HTTP $CODE on $ADDR" \
                    || { bad "server did not answer on $ADDR (got $CODE)"; cat "$OUT/serve.log"; exit 1; }

# =============================================================================
note "1. an SDK session with no pane and no terminal"
START_JSON="$("$BIN" sdk-session start --harness codex --cwd "$WORKDIR" --name "$SESSION_LABEL" --json 2>"$OUT/start.err")"
[ -n "$START_JSON" ] || { bad "sdk-session start produced no output"; cat "$OUT/start.err"; exit 1; }
printf '%s\n' "$START_JSON" > "$OUT/start.json"
SID="$(printf '%s' "$START_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')"
ok "session $SID created"
# JSON-quoted, by a JSON encoder, so these go into the page expressions as
# literals rather than as string concatenation waiting for a quote character.
SESSION_ID_JSON="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$SID")"
SESSION_LABEL_JSON="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$SESSION_LABEL")"

# =============================================================================
note "2. a real browser on that port"
"$PW" -s="$SESSION_NAME" open "http://$ADDR/" > "$OUT/browser-open.txt" 2>&1
"$PW" -s="$SESSION_NAME" resize 1600 1000 > /dev/null 2>&1
grep -q "Page URL" "$OUT/browser-open.txt" && ok "browser open on http://$ADDR/" || bad "browser did not open"

# Clicks the card for THIS session by name, not "the first card on screen".
# The name is unique to this run; the fleet may hold other rows and the wrong
# one opening looks exactly like the feature not working.
cat > "$OUT/click-card.js" <<JS
() => {
  const want = ${SESSION_LABEL_JSON};
  const found = [];
  const walk = (n) => {
    if (!n) return;
    if (n.tagName === 'APPLET-DASHBOARD') found.push(n);
    if (n.shadowRoot) for (const c of n.shadowRoot.children || []) walk(c);
    for (const c of n.children || []) walk(c);
  };
  walk(document.body);
  if (!found.length) return 'NO_DASHBOARD';
  const el = found[0];
  if (el._detailSessionId === ${SESSION_ID_JSON}) return 'ALREADY_OPEN';
  const buttons = [...el.shadowRoot.querySelectorAll('article.card button.card-open')];
  const btn = buttons.find((b) => (b.querySelector('.n') || {}).textContent === want);
  if (!btn) return 'NO_CARD(' + buttons.length + ' others)';
  btn.click();
  return 'CLICKED';
}
JS

# Reads the text the browser is PAINTING, out of the .live <pre> in the
# detail panel -- not a component field, not a websocket frame.
#
# It reports the surrounding facts (is the panel open, did any frame reach this
# browser at all) alongside the character count, so a run that sees nothing
# says WHY rather than just "nothing".
cat > "$OUT/read-live.js" <<JS
() => {
  const found = [];
  const walk = (n) => {
    if (!n) return;
    if (n.tagName === 'APPLET-DASHBOARD') found.push(n);
    if (n.shadowRoot) for (const c of n.shadowRoot.children || []) walk(c);
    for (const c of n.children || []) walk(c);
  };
  walk(document.body);
  if (!found.length) return 'NO_DASHBOARD';
  const el = found[0];
  const buffered = el._sdkOutput ? el._sdkOutput.size : -1;
  const ctx = ' detail=' + el._detailSessionId + ' buffered=' + buffered +
              ' cards=' + el.shadowRoot.querySelectorAll('article.card button.card-open').length;
  if (el._detailSessionId !== ${SESSION_ID_JSON}) return 'LIVE_CHARS=0 WRONG_PANEL' + ctx;
  const pre = el.shadowRoot.querySelector('pre.live');
  if (!pre) return 'LIVE_CHARS=0 NO_LIVE_PRE' + ctx;
  const t = pre.textContent || '';
  return 'LIVE_CHARS=' + t.length + ' HEAD=' + JSON.stringify(t.slice(0, 90)) + ctx;
}
JS

session_state() {
  "$BIN" sdk-session list --json 2>/dev/null | python3 -c '
import json,sys
for r in json.load(sys.stdin) or []:
    if r["sessionId"]==sys.argv[1]: print(r["state"]); break
' "$SID"
}

# =============================================================================
note "3. send a turn, open its card, and watch the answer arrive"
#
# ONE ATTEMPT MAY LOSE THE RACE, AND THAT IS NOT A FAILURE OF THE FEATURE. A
# resting session has no card: the fleet files a `stopped` interactive session
# under Completed, which is collapsed, and that is the existing product
# grouping this check does not get to change. A card appears when the session
# is `working`, so the window for the first click is the turn itself -- and a
# model that answers unusually fast can close it before a browser round trip
# lands. The retry is therefore against the RACE, not against the result:
# every attempt after the first starts with the detail panel already open, so
# it goes straight to reading. An attempt that produces no mid-stream frame is
# reported, never hidden.
PROMPT='Write a thorough 1500-word essay on why a terminal multiplexer benefits from streaming an agent reply token by token instead of only showing the finished message. Plain prose, no headings, no lists, no code.'
BEST=0; LIVE=""; SHOT=""; STATE_AT_SHOT=""; ACCEPTED=0
for attempt in 1 2 3; do
  echo "   -- attempt $attempt --"
  SEND="$("$BIN" sdk-session send "$SID" --json --prompt "$PROMPT" 2>&1)"
  printf '%s\n' "$SEND" > "$OUT/send-$attempt.json"
  echo "   RECEIPT: $(printf '%s' "$SEND" | tr -d '\n')"
  if printf '%s' "$SEND" | grep -q '"turnId"'; then ACCEPTED=1; else
    echo "   harness did not accept the turn"; continue
  fi

  # Open the card, unless a previous attempt already did.
  CLICKED=""
  for _ in $(seq 1 25); do
    CLICKED="$(eval_page "$OUT/click-card.js")"
    case "$CLICKED" in *CLICKED*|*ALREADY_OPEN*) break;; esac
    [ "$(session_state)" = "working" ] || break
    sleep 0.2
  done
  echo "   card: $CLICKED"

  # Read what the browser is PAINTING, and photograph it at the moment the
  # text is on screen and the harness is still producing.
  for _ in $(seq 1 60); do
    STATE="$(session_state)"
    LIVE="$(eval_page "$OUT/read-live.js")"
    N="$(printf '%s' "$LIVE" | grep -oE 'LIVE_CHARS=[0-9]+' | cut -d= -f2)"
    [ -n "$N" ] && [ "$N" -gt "$BEST" ] && BEST="$N"
    if [ "${N:-0}" -gt 400 ] && [ "$STATE" = "working" ]; then
      "$PW" -s="$SESSION_NAME" screenshot > "$OUT/screenshot.txt" 2>&1
      SHOT="$(grep -oE '[^ ()]+\.(png|jpeg|jpg)' "$OUT/screenshot.txt" | head -1)"
      STATE_AT_SHOT="$(session_state)"
      break
    fi
    [ "$STATE" != "working" ] && break
    sleep 0.4
  done
  echo "   ON SCREEN (verbatim from the rendered DOM): $LIVE"
  [ -n "$SHOT" ] && break
  # Let the turn finish before trying again, so two turns never overlap.
  for _ in $(seq 1 120); do [ "$(session_state)" = "working" ] || break; sleep 0.5; done
done

[ "$ACCEPTED" = "1" ] && ok "turn accepted by the harness" || bad "no turn was accepted"
printf '%s\n' "$LIVE" > "$OUT/live-dom-read.txt"
[ "$BEST" -gt 100 ] && ok "assistant text was RENDERED in the browser ($BEST chars in pre.live)" \
                    || bad "no assistant text rendered in the browser"
[ "$STATE_AT_SHOT" = "working" ] && ok "observed WHILE the harness was still producing (state=working)" \
                                 || bad "no mid-stream observation (state at capture=${STATE_AT_SHOT:-none})"

# =============================================================================
note "4. the screenshot"
# playwright-cli reports the path relative to ITS cwd.
if [ -n "$SHOT" ] && [ ! -f "$SHOT" ] && [ -f "$PWD/$SHOT" ]; then SHOT="$PWD/$SHOT"; fi
if [ -n "$SHOT" ] && [ -f "$SHOT" ]; then
  cp -f "$SHOT" "$OUT/sdk-stream-live.png"
  ok "screenshot captured mid-stream: $OUT/sdk-stream-live.png ($(stat -c%s "$OUT/sdk-stream-live.png") bytes)"
else
  bad "no screenshot produced"
  cat "$OUT/screenshot.txt" 2>/dev/null | sed 's/^/   /'
fi

# =============================================================================
note "RESULT"
printf 'pass=%d fail=%d\n' "$PASS" "$FAIL"
printf 'artifacts in %s\n' "$OUT"
[ "$FAIL" -eq 0 ]
