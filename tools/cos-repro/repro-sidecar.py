#!/usr/bin/env python3
"""VERIFICATION HARNESS - a scripted chief-of-staff sidecar. See README.md.

NOT the real sidecar (internal/cos/sidecar/main.py) and not the dev fixture next
to it (internal/cos/sidecar/stub-sidecar.py). This one emits a LARGE, EXACTLY
VERIFIABLE reply so something downstream can prove every byte reached the
browser. Wire it in with the same two env vars the fixture uses:

    MUXTERM_COS_SIDECAR=tools/cos-repro/repro-sidecar.py \\
    MUXTERM_COS_PYTHON=python3 muxterm serve --addr 127.0.0.1:9390 --no-auth

IT IMPLEMENTS THE `history` OP, WHICH stub-sidecar.py DOES NOT. That is why this
file exists: without it a browser that reloads or re-subscribes gets an empty
replay, so every replay bug is invisible.

Behaviour is steered by KEYWORDS IN THE PROMPT:

    s6-stream    2 thinking events, the payload as ~200 char `delta` events
                 ~5ms apart, then turn_end.response = the WHOLE payload.
    s6-nostream  2 thinking events, ZERO deltas, then the whole payload in
                 turn_end. Models a non-streaming provider.
    s6-empty     thinking, a real tool pair, then turn_end with an EMPTY
                 response: a legitimate, complete, answerless turn.
    s6-histcap   MANY (thinking, tool) pairs then a short answer, whose replay
                 blocks are built by the PRODUCT's own _summarize_turn, imported
                 from the tree this file lives in. That puts the block cap under
                 test rather than imitating it.
    size:<N>     payload bytes (default 40000; the fixed header is a ~1KB floor)
    delta:<N>    bytes per delta (default 200)
    gap:<ms>     gap between deltas (default 5)
    tools:<N>    (thinking, tool) pairs for s6-histcap. Default 22 = 44 replay
                 blocks against a 40-block cap.
    slow         stretch the turn over ~8s, so an away action has time to land
    tool         one tool_start/tool_end pair mid-stream

Every turn writes what it actually sent to $MUXTERM_REPRO_DIR (default
/tmp/cos-repro): payload-<turn_id>.txt byte for byte, and one record per turn in
turns.jsonl. The driver reads those rather than re-deriving them, so a
harness/product disagreement is visible rather than assumed.

STDOUT DISCIPLINE (spec 2.1): protocol lines go to the REAL stdout, claimed by
an fd dup before anything else can print to it; everything else goes to stderr.
"""

import hashlib
import importlib.util
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone

_real = os.dup(1)
os.dup2(2, 1)
PROTO = os.fdopen(_real, "w", buffering=1)
_write_lock = threading.Lock()

ARTIFACT_DIR = os.environ.get("MUXTERM_REPRO_DIR", "/tmp/cos-repro")
DEFAULT_SIZE = 40000
# The payload is ASCII, so characters and bytes are the same thing here - which
# is what lets the driver compare a DOM string length against a byte count.
DELTA_CHARS = 200
DELTA_SLEEP = 0.005
# A megabyte-scale payload at 5ms/delta would outlive any sane driver timeout,
# so past this many deltas the gap is scaled down, and the scaling is RECORDED.
MAX_DELTAS_AT_FULL_SLEEP = 6000
STREAM_BUDGET_S = float(os.environ.get("MUXTERM_REPRO_STREAM_BUDGET_S", "25"))
SLOW_SECONDS = 8.0
# Two replay blocks per pair against the product's 40-block cap, so 22 pairs is
# 44 blocks and the answer is the 45th. The answer stays under the product's own
# text limit, so the replay is compared against the whole thing and never
# against a legitimately trimmed tail.
HISTCAP_TOOLS = 22
HISTCAP_SIZE = 3000


def emit(**event):
    with _write_lock:
        PROTO.write(json.dumps(event) + "\n")
        PROTO.flush()


def log(msg):
    print(f"[repro-sidecar] {msg}", file=sys.stderr, flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# --- the payload -----------------------------------------------------------

_TABLE = """\
| lane | workspace | state | note |
| :--- | :-------- | ----: | :--: |
| lane-01 | cos-repro | 1 | pipe \\| inside a cell |
| lane-02 | away-scenarios | 22 | `code`, **bold**, <b>html</b> |
"""

# Hostile to anything that reformats, sanitises or re-encodes the reply on its
# way to the DOM: a literal </script>, literal quotes and backslashes, backticks
# next to fence markers, ampersands and entity-lookalikes.
_CODE = """\
```go
const (
\tScriptClose = "</script>"
\tQuote       = "\\""
\tBackslashes = "\\\\ \\\\\\\\ \\\\\\\\\\\\"
\tBacktickish = "adjacent to ``` fence markers"
\tAmpersand   = "a & b < c > d"
\tEntityish   = "&lt;not an entity&gt; &amp;amp;"
\tBraces      = "{ nested { braces { three deep } } }"
)
```
"""

_PARA = (
    "This is filler whose only purpose is to occupy bytes so that partial loss "
    "is measurable rather than a matter of opinion. Every 1000-byte block of "
    "filler opens with a countable token, so counting the tokens that survived "
    "gives the fraction of the payload that survived. "
)


def build_payload(turn_id: str, size: int) -> str:
    """MARKER-START, a markdown table, a fenced go block, filler padded so the
    whole thing is EXACTLY `size` bytes with a [[chunk-NNNN]] token opening
    every 1000 bytes of it, then MARKER-END. ASCII only, so a DOM textContent
    length can be compared against a byte count honestly."""
    head = f"MARKER-START-{turn_id}\n\n{_TABLE}\n{_CODE}\n"
    tail = f"\nMARKER-END-{turn_id}\n"
    target = max(0, size - len(head) - len(tail))
    out, written, idx = [], 0, 0
    while written < target:
        idx += 1
        want = min(1000, target - written)
        token = f"[[chunk-{idx:04d}]] "
        if want <= len(token):
            out.append("." * want)          # no room for a whole token; pad so
            written += want                 # the byte count still lands exactly
            break
        body = want - len(token)
        out.append(token + (_PARA * (body // len(_PARA) + 1))[:body])
        written += want
    payload = head + "".join(out) + tail
    assert payload.isascii(), "payload must be ASCII so bytes == characters"
    return payload


def parse_prompt(prompt: str) -> dict:
    low = prompt.lower()
    mode = next((m for m in ("s6-empty", "s6-histcap", "s6-nostream") if m in low), "s6-stream")
    size = re.search(r"size:(\d+)", low)
    delta = re.search(r"delta:(\d+)", low)
    gap = re.search(r"gap:(\d+)", low)
    tools = re.search(r"tools:(\d+)", low)
    return {
        "mode": mode,
        "size": int(size.group(1)) if size
                else (HISTCAP_SIZE if mode == "s6-histcap" else DEFAULT_SIZE),
        "delta_chars": max(1, int(delta.group(1))) if delta else DELTA_CHARS,
        "gap_s": max(0.0, int(gap.group(1)) / 1000.0) if gap else DELTA_SLEEP,
        "slow": re.search(r"\bslow\b", low) is not None,
        # \b so `tools:22` does not silently switch the one-tool keyword on.
        "tool": re.search(r"\btool\b", low) is not None,
        "tool_pairs": max(1, int(tools.group(1))) if tools else HISTCAP_TOOLS,
    }


# --- the PRODUCT's own history summariser ----------------------------------
#
# s6-histcap must run the tree's own code, not a copy of it, so the module is
# loaded from <repo>/tools/cos-repro/ -> <repo>. That is what makes "same
# harness, two trees" differ for the right reason.
#
# Importing it is safe despite its stdout discipline: main.py dups whatever is
# on fd 1 AT IMPORT TIME, and fd 1 already points at stderr here, so its dup
# cannot reach the protocol stream. Its amplifier imports are function-local and
# its entry point is behind __name__ == "__main__".

_product = None
_product_err = ""
_product_path = ""
_product_lock = threading.Lock()


def product_sidecar():
    """The product sidecar module, or None with the reason recorded."""
    global _product, _product_err, _product_path
    with _product_lock:
        if _product is not None or _product_err:
            return _product
        repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        _product_path = os.path.join(repo, "internal", "cos", "sidecar", "main.py")
        try:
            spec = importlib.util.spec_from_file_location("cos_product_sidecar", _product_path)
            mod = importlib.util.module_from_spec(spec)
            # Registered BEFORE exec: main.py uses @dataclass, and dataclasses
            # resolves a field's type through sys.modules[cls.__module__].
            sys.modules["cos_product_sidecar"] = mod
            spec.loader.exec_module(mod)
            if not hasattr(mod, "_summarize_turn"):
                raise AttributeError("no _summarize_turn")
            _product = mod
            log(f"product sidecar loaded from {_product_path} "
                f"(HISTORY_MAX_BLOCKS={getattr(mod, 'HISTORY_MAX_BLOCKS', '?')})")
        except Exception as exc:  # noqa: BLE001
            _product_err = f"{type(exc).__name__}: {exc}"
            log(f"product sidecar NOT loaded from {_product_path}: {_product_err}")
        return _product


def histcap_members(prompt: str, payload: str, pairs: int) -> list:
    """An amplifier-shaped transcript: N (thinking, tool_use, tool) triples then
    the final text answer, shaped as _group_turns/_summarize_turn expect one
    turn to look. Each pair costs TWO replay blocks, because add_text only
    merges a block with a tail of the SAME kind."""
    t0 = time.time()
    step = [0]

    def meta():
        step[0] += 1
        return {"timestamp": datetime.fromtimestamp(t0 + step[0] * 0.25, timezone.utc).isoformat()}

    msgs = [{"role": "user", "content": prompt, "metadata": meta()}]
    for i in range(pairs):
        call_id = f"call-{i:03d}"
        msgs.append({"role": "assistant", "metadata": meta(), "content": [
            {"type": "thinking", "thinking": f"step {i + 1}: which lane next"}]})
        msgs.append({"role": "assistant", "metadata": meta(), "content": [
            {"type": "tool_use", "id": call_id,
             "name": "mcp_muxterm_list_workspaces", "input": {"probe": i}}]})
        msgs.append({"role": "tool", "metadata": meta(), "tool_call_id": call_id,
                     "name": "mcp_muxterm_list_workspaces",
                     "content": json.dumps({"output": f"3 workspaces (probe {i})"})})
    msgs.append({"role": "assistant", "metadata": meta(),
                 "content": [{"type": "text", "text": payload}]})
    return msgs


def write_artifacts(turn_id: str, payload: str, record: dict) -> None:
    try:
        os.makedirs(ARTIFACT_DIR, exist_ok=True)
        with open(os.path.join(ARTIFACT_DIR, f"payload-{turn_id}.txt"), "w") as f:
            f.write(payload)
        with open(os.path.join(ARTIFACT_DIR, "turns.jsonl"), "a") as f:
            f.write(json.dumps(record) + "\n")
    except OSError as exc:
        log(f"could not write artifacts to {ARTIFACT_DIR}: {exc}")


def _kinds(blocks) -> dict:
    out = {}
    for b in blocks:
        k = str(b.get("kind") or "?")
        out[k] = out.get(k, 0) + 1
    return out


# --- the sidecar -----------------------------------------------------------


class Repro:
    def __init__(self, session_id):
        self.session_id = session_id
        self.active = None
        self.lock = threading.Lock()
        # The in-memory transcript. THIS is what the history op replays, and
        # what makes an away/reload scenario testable at all.
        self.transcript = []

    def on_turn(self, turn_id, prompt):
        with self.lock:
            if self.active is not None:
                log(f"BUSY: refused {turn_id} while {self.active} is active")
                emit(ev="error", turn_id=turn_id, code="busy",
                     message=f"turn {self.active} is already running", fatal=False)
                return
            self.active = turn_id
        threading.Thread(target=self._run_turn, args=(turn_id, prompt), daemon=True).start()

    # Nothing in this harness sends a cancel, but a human driving the surface by
    # hand can press stop. Answering it keeps the Go queue from waiting for a
    # terminal event that would never come.
    def on_cancel(self, turn_id):
        with self.lock:
            if self.active != turn_id:
                return
            self.active = None
        log(f"cancelled {turn_id}")
        emit(ev="cancelled", turn_id=turn_id)

    def on_history(self, limit, req_id):
        with self.lock:
            turns = list(self.transcript)
        if limit and limit > 0:
            turns = turns[-limit:]
        log(f"history req={req_id} limit={limit} -> {len(turns)} turn(s)")
        emit(ev="history", req_id=req_id, session_id=self.session_id, turns=turns)

    def _cancelled(self, turn_id) -> bool:
        with self.lock:
            return self.active != turn_id

    def _tool(self, turn_id, call_id="c1", summary="3 workspaces", pause=0.05):
        emit(ev="tool_start", turn_id=turn_id, call_id=call_id,
             name="mcp_muxterm_list_workspaces", args={})
        time.sleep(pause)
        emit(ev="tool_end", turn_id=turn_id, call_id=call_id, ok=True, summary=summary, ms=3)

    def _run_turn(self, turn_id, prompt):
        started = time.time()
        opts = parse_prompt(prompt)
        mode = opts["mode"]
        payload = "" if mode == "s6-empty" else build_payload(turn_id, opts["size"])
        log(f"turn {turn_id} start mode={mode} requested={opts['size']} "
            f"actual={len(payload)} slow={opts['slow']} tool={opts['tool']}")
        emit(ev="turn_start", turn_id=turn_id)

        thinking = [f"planning a {mode} reply of {len(payload)} bytes for {turn_id}",
                    "second thinking block, so the DOM has two p.thought nodes to find"]
        for t in thinking:
            emit(ev="thinking", turn_id=turn_id, text=t)

        # s6-histcap: the tool calls happen BEFORE the answer, which is the order
        # that makes the history cap bite - the block budget is spent on
        # breadcrumbs and the answer arrives to a full list.
        pairs = 0
        if mode == "s6-histcap":
            pairs = opts["tool_pairs"]
            for i in range(pairs):
                if self._cancelled(turn_id):
                    return log(f"turn {turn_id} abandoned during tool pair {i}")
                emit(ev="thinking", turn_id=turn_id, text=f"step {i + 1}: which lane next")
                self._tool(turn_id, call_id=f"call-{i:03d}",
                           summary=f"3 workspaces (probe {i})", pause=0.01)
        elif mode == "s6-empty":
            pairs = 1
            self._tool(turn_id)

        deltas, gap = [], 0.0
        if mode in ("s6-stream", "s6-histcap"):
            n = opts["delta_chars"]
            deltas = [payload[i:i + n] for i in range(0, len(payload), n)]
            gap = opts["gap_s"]
            if opts["slow"]:
                gap = SLOW_SECONDS / max(1, len(deltas))
            elif len(deltas) > MAX_DELTAS_AT_FULL_SLEEP:
                gap = STREAM_BUDGET_S / len(deltas)
                log(f"{len(deltas)} deltas would take {len(deltas) * opts['gap_s']:.1f}s; "
                    f"scaling the gap to {gap * 1000:.3f}ms for the {STREAM_BUDGET_S}s budget")

        tool_at = len(deltas) // 2
        streamed = 0
        for i, chunk in enumerate(deltas):
            if opts["tool"] and i == tool_at:
                self._tool(turn_id)
            if self._cancelled(turn_id):
                return log(f"turn {turn_id} abandoned after {streamed} bytes")
            emit(ev="delta", turn_id=turn_id, text=chunk)
            streamed += len(chunk)
            if gap > 0:
                time.sleep(gap)

        if not deltas:
            if opts["tool"]:
                self._tool(turn_id)
            if opts["slow"]:
                time.sleep(SLOW_SECONDS)
        if self._cancelled(turn_id):
            return log(f"turn {turn_id} abandoned before turn_end")

        elapsed_ms = int((time.time() - started) * 1000)
        emit(ev="turn_end", turn_id=turn_id, response=payload, cost_usd="0.0100", ms=elapsed_ms)

        history = self._history_blocks(opts, prompt, payload, thinking, pairs)
        record = {
            "turn_id": turn_id, "prompt": prompt, "mode": mode, "slow": opts["slow"],
            "tool": opts["tool"], "requested_bytes": opts["size"] if payload else 0,
            "actual_bytes": len(payload), "sha256": hashlib.sha256(payload.encode()).hexdigest(),
            "chunk_tokens": len(re.findall(r"\[\[chunk-\d{4}\]\]", payload)),
            "delta_count": len(deltas), "delta_bytes": streamed, "delta_sleep_s": gap,
            "tool_pairs": pairs, "ms": elapsed_ms, "ts": now_iso(),
        }
        record.update(history["record"])
        # Written even when EMPTY: the driver reads it to learn that 0 bytes is
        # the correct expectation, which is not the same as not knowing.
        write_artifacts(turn_id, payload, record)

        with self.lock:
            self.transcript.append({"id": f"h-{len(self.transcript)}", "prompt": prompt,
                                    "ts": now_iso(), "ms": elapsed_ms,
                                    "blocks": history["blocks"]})
            if self.active == turn_id:
                self.active = None
        log(f"turn {turn_id} done in {elapsed_ms}ms ({len(deltas)} deltas, {streamed} streamed, "
            f"{len(payload)} response bytes, {len(history['blocks'])} replay blocks via "
            f"{history['record']['history_source']})")

    def _history_blocks(self, opts, prompt, payload, thinking, pairs) -> dict:
        """The blocks a later `history` op will replay. Two sources, and which
        one was used is RECORDED rather than implied:

          product  s6-histcap only: whatever the tree's own _summarize_turn
                   makes of an amplifier-shaped transcript. That is the block
                   cap under test, not an imitation of it.
          raw      everything else: untrimmed harness blocks, so an away
                   scenario measures the transport and the render rather than
                   the product's replay budget.
        """
        fallback = ""
        if opts["mode"] == "s6-histcap":
            mod = product_sidecar()
            if mod is not None:
                members = histcap_members(prompt, payload, pairs)
                turn = mod._summarize_turn(0, members)
                blocks = list(turn.get("blocks") or []) if turn else []
                texts = [b for b in blocks if b.get("kind") == "text"]
                return {"blocks": blocks, "record": {
                    "history_source": f"product:{_product_path}",
                    "history_max_blocks": getattr(mod, "HISTORY_MAX_BLOCKS", None),
                    "history_input_messages": len(members),
                    "history_block_count": len(blocks), "history_block_kinds": _kinds(blocks),
                    "history_has_text_block": bool(texts),
                    "history_text_bytes": sum(len(b.get("text") or "") for b in texts)}}
            # Reported, never silent: a histcap result built from harness blocks
            # would prove nothing about the product.
            fallback = _product_err or "unknown"

        blocks = [{"kind": "thinking", "text": thinking[0]}]
        if opts["tool"] or opts["mode"] == "s6-empty":
            blocks.append({"kind": "tool", "call_id": "c1", "args": "", "ok": True,
                           "name": "mcp_muxterm_list_workspaces", "summary": "3 workspaces",
                           "ms": 3})
        blocks.append({"kind": "thinking", "text": thinking[1]})
        if payload:
            blocks.append({"kind": "text", "text": payload})
        rec = {"history_source": "raw-FALLBACK" if fallback else "raw",
               "history_block_count": len(blocks), "history_block_kinds": _kinds(blocks),
               "history_has_text_block": bool(payload), "history_text_bytes": len(payload)}
        if fallback:
            rec["history_fallback_reason"] = fallback
        return {"blocks": blocks, "record": rec}


def main():
    args = sys.argv[1:]
    session_id = "muxterm-cos-repro"
    for i, a in enumerate(args):
        if a == "--session-id" and i + 1 < len(args):
            session_id = args[i + 1]
    log(f"argv: {args}; artifact dir: {ARTIFACT_DIR}")

    repro = Repro(session_id)
    emit(ev="ready", session_id=session_id, bundle="stub", tools=0, boot_ms=0, resumed=False)

    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            op = json.loads(line)
        except json.JSONDecodeError as exc:
            log(f"ignoring unparseable op ({exc}): {line[:200]}")
            continue
        name = op.get("op")
        if name == "turn":
            repro.on_turn(op.get("turn_id", ""), op.get("prompt", ""))
        elif name == "cancel":
            repro.on_cancel(op.get("turn_id", ""))
        elif name == "history":
            repro.on_history(int(op.get("limit", 50) or 50), op.get("req_id", ""))
        elif name == "ping":
            emit(ev="pong")
        elif name == "shutdown":
            break
        else:
            log(f"ignoring unknown op {name!r}")
    log("exiting")


if __name__ == "__main__":
    main()
