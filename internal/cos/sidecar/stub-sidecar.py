#!/usr/bin/env python3
"""DEV FIXTURE - NOT THE REAL SIDECAR.

This is a canned-response stand-in for internal/cos/sidecar/main.py, used to exercise
internal/cos (spawn, supervise, queue, fan-out, approvals, crash recovery)
without booting a real amplifier session. It speaks the wire protocol in
docs/designs/2026-09-06-cos-sidecar-spec.md section 2 and nothing else: no
amplifier, no model, no tools, no session store.

The real sidecar is internal/cos/sidecar/main.py. Point the supervisor at this one
explicitly:

    MUXTERM_COS_SIDECAR=internal/cos/sidecar/stub-sidecar.py muxterm cos "hi"

Prompt keywords steer the canned behaviour, so one fixture covers every path
the Go side has to survive:

    slow      - stretch the turn out over ~6s (mid-turn kill, cancel, queueing)
    tool      - emit a tool_start/tool_end pair
    approval  - emit an approval_request and block until it is answered
    crash     - die mid-turn with os._exit, producing no terminal event
    big       - emit a reply larger than one pipe buffer
    markdown  - reply with every construct <mux-cos> renders as formatting,
                streamed in several deltas so the check also covers a reply
                that is re-parsed while it is still half-written

It also ENFORCES section 2.4 law 1 from the sidecar side: a turn arriving while
another is active is refused with {"ev":"error","code":"busy"} and logs loudly.
If the Go queue is doing its job, that refusal is unreachable.
"""

import json
import os
import sys
import threading
import time

# 2.1 stdout discipline: claim the real stdout before anything else can print
# to it, and send every other write to stderr.
_real = os.dup(1)
os.dup2(2, 1)
PROTO = os.fdopen(_real, "w", buffering=1)

_write_lock = threading.Lock()

# The `markdown` fixture reply: one chunk per construct <mux-cos> promises to
# render as formatting. Split across deltas ON PURPOSE -- the renderer re-parses
# the whole accumulated string on every delta, so a reply that arrives in pieces
# is the case where a naive parser flickers (a half-typed fence briefly looking
# like a stray ``` , a lone ** looking like literal asterisks). Splitting mid-fence
# keeps that path covered by anything that drives this fixture.
MARKDOWN_CHUNKS = [
    "Here is **bold text** and *italic text* and `inline_code()` in a sentence.\n\n",
    "A fenced block:\n\n```sh\ngo build ./...\n",
    "go vet ./...\n```\n\n",
    "A link to [the muxterm repo](https://github.com/kenotron-ms/muxterm).\n\n",
    "Bullets:\n\n- first bullet\n- second bullet with `code`\n- third bullet\n\n",
    "Numbered:\n\n1. step one\n2. step two\n3. step three\n",
]


def emit(**event):
    with _write_lock:
        PROTO.write(json.dumps(event) + "\n")
        PROTO.flush()


def log(msg):
    print(f"[stub] {msg}", file=sys.stderr, flush=True)


class Stub:
    def __init__(self, session_id):
        self.session_id = session_id
        self.active = None          # turn_id currently running
        self.lock = threading.Lock()
        self.approvals = {}         # request_id -> threading.Event
        self.decisions = {}         # request_id -> (approved, reason)
        self.turns_run = 0

    # --- ops ---------------------------------------------------------------

    def on_turn(self, turn_id, prompt):
        with self.lock:
            if self.active is not None:
                log(f"BUSY: refused {turn_id} while {self.active} is active "
                    f"(the Go queue should have made this impossible)")
                emit(ev="error", turn_id=turn_id, code="busy",
                     message=f"turn {self.active} is already running", fatal=False)
                return
            self.active = turn_id
        threading.Thread(target=self._run_turn, args=(turn_id, prompt), daemon=True).start()

    def on_approval(self, request_id, approved, reason):
        ev = self.approvals.get(request_id)
        if ev is None:
            log(f"approval for unknown request {request_id}")
            return
        self.decisions[request_id] = (approved, reason)
        ev.set()

    def on_cancel(self, turn_id):
        log(f"cancel requested for {turn_id}")
        with self.lock:
            if self.active != turn_id:
                return
            self.active = None
        emit(ev="cancelled", turn_id=turn_id)

    # --- turn body ---------------------------------------------------------

    def _run_turn(self, turn_id, prompt):
        started = time.time()
        log(f"turn {turn_id} start: {prompt!r}")
        emit(ev="turn_start", turn_id=turn_id)

        lowered = prompt.lower()
        slow = "slow" in lowered
        chunks = [f"you said: {prompt}", " -- ", "and this is a canned reply."]
        if "big" in lowered:
            chunks = [f"chunk-{i:04d} " * 8 for i in range(400)]
        if "markdown" in lowered:
            chunks = MARKDOWN_CHUNKS

        emit(ev="thinking", turn_id=turn_id, text="deciding what to say")

        if "approval" in lowered:
            request_id = f"a-{turn_id}"
            gate = threading.Event()
            self.approvals[request_id] = gate
            emit(ev="approval_request", turn_id=turn_id, request_id=request_id,
                 tool="bash", detail="rm -rf /tmp/definitely-not-real")
            log(f"blocking turn {turn_id} on approval {request_id}")
            if not gate.wait(timeout=120):
                emit(ev="error", turn_id=turn_id, code="approval_timeout",
                     message="no approval arrived within 120s", fatal=True)
                self._finish(turn_id)
                return
            approved, reason = self.decisions.get(request_id, (False, ""))
            chunks = [f"approval was {'granted' if approved else 'refused'} ({reason}). "]

        if "tool" in lowered:
            emit(ev="tool_start", turn_id=turn_id, call_id="c1",
                 name="mcp_muxterm_list_workspaces", args={})
            time.sleep(0.05)
            emit(ev="tool_end", turn_id=turn_id, call_id="c1", ok=True,
                 summary="3 workspaces", ms=3)

        response = ""
        for chunk in chunks:
            if "crash" in lowered and response:
                log(f"crashing mid-turn during {turn_id} (fixture behaviour)")
                PROTO.flush()
                os._exit(9)
            with self.lock:
                if self.active != turn_id:   # cancelled underneath us
                    log(f"turn {turn_id} abandoned")
                    return
            emit(ev="delta", turn_id=turn_id, text=chunk)
            response += chunk
            time.sleep(2.0 if slow else 0.01)

        elapsed_ms = int((time.time() - started) * 1000)
        emit(ev="turn_end", turn_id=turn_id, response=response,
             cost_usd="0.0000", ms=elapsed_ms)
        self._finish(turn_id)
        log(f"turn {turn_id} done in {elapsed_ms}ms")

    def _finish(self, turn_id):
        with self.lock:
            if self.active == turn_id:
                self.active = None
            self.turns_run += 1


def main():
    args = sys.argv[1:]
    session_id = "muxterm-cos"
    for i, a in enumerate(args):
        if a == "--session-id" and i + 1 < len(args):
            session_id = args[i + 1]
    log(f"argv: {args}")

    if os.environ.get("MUXTERM_COS_STUB_BOOT_FAIL"):
        emit(ev="error", code="boot_failed",
             message="MUXTERM_COS_STUB_BOOT_FAIL is set", fatal=True)
        sys.exit(3)

    boot_delay = float(os.environ.get("MUXTERM_COS_STUB_BOOT_MS", "0")) / 1000.0
    if boot_delay:
        time.sleep(boot_delay)

    stub = Stub(session_id)
    emit(ev="ready", session_id=session_id, bundle="stub", tools=0,
         boot_ms=int(boot_delay * 1000), resumed=False)
    # An unknown event, to prove the Go side ignores it instead of faulting
    # (2.4 law 5).
    emit(ev="stub_hello", unknown_field={"nested": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            op = json.loads(line)
        except json.JSONDecodeError as exc:
            log(f"ignoring unparseable op ({exc}): {line[:200]}")
            continue
        name = op.get("op")
        if name == "turn":
            stub.on_turn(op.get("turn_id", ""), op.get("prompt", ""))
        elif name == "approval":
            stub.on_approval(op.get("request_id", ""), bool(op.get("approved")), op.get("reason", ""))
        elif name == "cancel":
            stub.on_cancel(op.get("turn_id", ""))
        elif name == "ping":
            emit(ev="pong")
        elif name == "shutdown":
            log("shutdown received")
            break
        else:
            log(f"ignoring unknown op {name!r}")

    log("exiting")
    sys.exit(0)


if __name__ == "__main__":
    main()
