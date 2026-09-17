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

Every completed turn writes what it actually sent to $MUXTERM_REPRO_DIR (default
/tmp/cos-repro): payload-<turn_id>.txt byte for byte, one record per turn in
turns.jsonl, and a safe summarized transcript. The transcript is committed
before turn_end and reloaded by a supervised replacement fixture process; it
never opens an Amplifier SessionStore. A delayed fixture history response also
writes delayed-history-emitted.json after it is emitted; this proves the stale
input existed without requiring a correctly fenced server to deliver it.

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
from datetime import datetime, timedelta, timezone

_real = os.dup(1)
os.dup2(2, 1)
PROTO = os.fdopen(_real, "w", buffering=1)
_write_lock = threading.Lock()

ARTIFACT_DIR = os.environ.get("MUXTERM_REPRO_DIR", "/tmp/cos-repro")
TRANSCRIPT_PATH = os.path.join(ARTIFACT_DIR, "transcript.json")
RESTART_ON_HISTORY_ONCE = os.environ.get("MUXTERM_REPRO_EXIT_ON_HISTORY_ONCE") == "1"
DELAY_HISTORY_ONCE_MS = max(0, int(os.environ.get("MUXTERM_REPRO_DELAY_HISTORY_ONCE_MS", "0")))
DELAY_FIRST_CLEAR_HISTORY_MS = max(
    0, int(os.environ.get("MUXTERM_REPRO_DELAY_FIRST_CLEAR_HISTORY_MS", "0")),
)
HISTORY_METADATA_MODE = os.environ.get("MUXTERM_REPRO_HISTORY_METADATA", "")
SEED_HISTORY = os.environ.get("MUXTERM_REPRO_SEED_HISTORY") == "1"
SEED_PROMPT = os.environ.get("MUXTERM_REPRO_SEED_PROMPT", "")
SEED_ANSWER = os.environ.get("MUXTERM_REPRO_SEED_ANSWER", "")
OVERLAP_CLEAR_HISTORY = os.environ.get("MUXTERM_REPRO_OVERLAP_CLEAR_HISTORY") == "1"
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


def write_json_atomic(path: str, value: object) -> None:
    """Write a fixture-owned JSON value without ever exposing a half transcript."""
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    tmp = f"{path}.tmp-{os.getpid()}-{threading.get_ident()}"
    try:
        with open(tmp, "w") as f:
            json.dump(value, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def claim_once(name: str, payload: dict) -> bool:
    """Atomically claim one fixture-only fault injection across replacements."""
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    path = os.path.join(ARTIFACT_DIR, name)
    try:
        with open(path, "x") as f:
            json.dump(payload, f)
        return True
    except FileExistsError:
        return False


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
        # The fixture's safe, summarized transcript. It deliberately models
        # durability without touching a real SessionStore or its credentials.
        self.transcript = self._load_transcript()
        self.clear_count = 0
        self._seed_history_if_requested()

    def _load_transcript(self):
        try:
            with open(TRANSCRIPT_PATH) as f:
                loaded = json.load(f)
            if not isinstance(loaded, list) or not all(isinstance(turn, dict) for turn in loaded):
                raise ValueError("expected a JSON array of summarized turns")
            log(f"reloaded {len(loaded)} durable summarized turn(s)")
            return loaded
        except FileNotFoundError:
            return []
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            log(f"ignoring unusable fixture transcript {TRANSCRIPT_PATH}: {exc}")
            return []

    def _persist_transcript_locked(self):
        # Call while self.lock is held so an overlapping history/clear sees
        # either the old committed snapshot or this complete replacement.
        write_json_atomic(TRANSCRIPT_PATH, self.transcript)

    def _seed_history_if_requested(self):
        """Create one safe fixture-owned history shape before ready/history."""
        if self.transcript:
            return
        if OVERLAP_CLEAR_HISTORY:
            now = datetime.now(timezone.utc)
            self.transcript = [
                {
                    "id": "fixture-old-clear-seed",
                    "prompt": "fixture old clear seed prompt",
                    "ts": (now - timedelta(days=8)).isoformat(),
                    "blocks": [{"kind": "text", "text": "fixture old clear seed answer"}],
                },
                {
                    "id": "fixture-recent-clear-seed",
                    "prompt": "fixture recent clear seed prompt",
                    "ts": now.isoformat(),
                    "blocks": [{"kind": "text", "text": "fixture recent clear seed answer"}],
                },
            ]
            self._persist_transcript_locked()
            write_json_atomic(
                os.path.join(ARTIFACT_DIR, "overlap-clear-seed.json"),
                {"old_prompt": self.transcript[0]["prompt"], "recent_prompt": self.transcript[1]["prompt"]},
            )
            log("created old and recent fixture history for overlapping clears")
            return
        if not SEED_HISTORY:
            return
        if not SEED_PROMPT or not SEED_ANSWER:
            raise ValueError("seed history requires both prompt and answer")
        self.transcript = [{
            "id": "fixture-durable-seed",
            "prompt": SEED_PROMPT,
            # This fixed old timestamp makes the intended chronological order
            # explicit without borrowing any real transcript metadata.
            "ts": "2000-01-01T00:00:00+00:00",
            "blocks": [{"kind": "text", "text": SEED_ANSWER}],
        }]
        # This is fixture-only durability under MUXTERM_REPRO_DIR. Persist
        # before ready so the first browser subscription can only replay it.
        self._persist_transcript_locked()
        write_json_atomic(
            os.path.join(ARTIFACT_DIR, "seed-history.json"),
            {"prompt": SEED_PROMPT, "answer": SEED_ANSWER},
        )
        log("created one durable fixture seed history turn")

    def _history_metadata(self):
        if HISTORY_METADATA_MODE == "absent":
            return None
        if HISTORY_METADATA_MODE == "unknown":
            # This is intentionally not interpreted or rendered. It exercises
            # history consumers that receive a harmless future provenance field.
            return {"provenance": "fixture-provenance", "fixture_unknown": "fixture-unknown-value"}
        return {"timestamp": now_iso()}

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
            # JSON round-trip freezes the captured pre-clear value. A delayed
            # reply must not accidentally read the post-clear list by reference.
            turns = json.loads(json.dumps(self.transcript))
        if limit and limit > 0:
            turns = turns[-limit:]
        log(f"history req={req_id} limit={limit} -> {len(turns)} turn(s)")
        if RESTART_ON_HISTORY_ONCE and turns and claim_once(
            "restart-on-history.json", {"req_id": req_id, "turns": len(turns), "ts": now_iso()},
        ):
            # Deliberately fail THIS history request after a durable transcript
            # exists. The real supervisor must restart us and arrange a replay;
            # emitting a stale snapshot here would hide the product failure.
            log("exiting once on a persisted history request (controlled restart)")
            os._exit(0)
        if DELAY_HISTORY_ONCE_MS and turns and claim_once(
            "delayed-history.json",
            {"req_id": req_id, "turns": len(turns), "delay_ms": DELAY_HISTORY_ONCE_MS, "ts": now_iso()},
        ):
            # The server can process Clear while this old snapshot is delayed.
            # Its late arrival is the precise reconciliation race under test.
            def delayed_reply():
                time.sleep(DELAY_HISTORY_ONCE_MS / 1000.0)
                emit(ev="history", req_id=req_id, session_id=self.session_id, turns=turns)
                write_json_atomic(
                    os.path.join(ARTIFACT_DIR, "delayed-history-emitted.json"),
                    {"req_id": req_id, "turns": len(turns), "delay_ms": DELAY_HISTORY_ONCE_MS,
                     "emitted_at": now_iso()},
                )
            threading.Thread(target=delayed_reply, daemon=True).start()
            return
        if DELAY_FIRST_CLEAR_HISTORY_MS and self.clear_count == 1 and turns and claim_once(
            "overlap-first-clear-history.json",
            {"req_id": req_id, "turns": len(turns), "delay_ms": DELAY_FIRST_CLEAR_HISTORY_MS, "ts": now_iso()},
        ):
            # The first seven-day prune has retained current turns. Hold this
            # captured read-back reply until an all-clear can arrive behind it:
            # an unfenced server broadcasts this stale retained snapshot last.
            def delayed_first_clear_reply():
                time.sleep(DELAY_FIRST_CLEAR_HISTORY_MS / 1000.0)
                emit(ev="history", req_id=req_id, session_id=self.session_id, turns=turns)
                write_json_atomic(
                    os.path.join(ARTIFACT_DIR, "overlap-first-clear-history-emitted.json"),
                    {"req_id": req_id, "turns": len(turns),
                     "delay_ms": DELAY_FIRST_CLEAR_HISTORY_MS, "emitted_at": now_iso()},
                )
            threading.Thread(target=delayed_first_clear_reply, daemon=True).start()
            return
        emit(ev="history", req_id=req_id, session_id=self.session_id, turns=turns)

    def on_clear(self, older_than_days, req_id):
        # The browser harness drives both scoped and all-history clear through
        # the real UI. Keep all resulting mutation inside the fixture transcript.
        with self.lock:
            if self.active is not None:
                emit(ev="error", req_id=req_id, code="clear_failed",
                     message="fixture refuses clear during an active turn", fatal=False)
                return
            if older_than_days == 0:
                removed = len(self.transcript)
                self.transcript = []
            else:
                cutoff = datetime.now(timezone.utc) - timedelta(days=older_than_days)
                kept_turns = []
                removed = 0
                for turn in self.transcript:
                    try:
                        timestamp = datetime.fromisoformat(str(turn.get("ts", "")).replace("Z", "+00:00"))
                        if timestamp.tzinfo is None:
                            timestamp = timestamp.replace(tzinfo=timezone.utc)
                    except (TypeError, ValueError):
                        # A malformed fixture timestamp is retained: a scoped
                        # destructive operation must not guess that it is old.
                        kept_turns.append(turn)
                        continue
                    if timestamp < cutoff:
                        removed += 1
                    else:
                        kept_turns.append(turn)
                self.transcript = kept_turns
            self.clear_count += 1
            self._persist_transcript_locked()
            kept = len(self.transcript)
        log(f"cleared {removed} durable fixture turn(s), kept={kept}, older_than_days={older_than_days}")
        emit(ev="cleared", req_id=req_id, removed=removed, kept=kept,
             removed_turns=removed, kept_turns=kept, protected=[], reloaded=True)

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
        history = self._history_blocks(opts, prompt, payload, thinking, pairs)
        item = {"id": f"h-{int(time.time() * 1000)}-{turn_id}", "prompt": prompt,
                "ts": now_iso(), "ms": elapsed_ms, "blocks": history["blocks"]}
        metadata = self._history_metadata()
        if metadata is not None:
            item["metadata"] = metadata
        with self.lock:
            self.transcript.append(item)
            # Durability is deliberately BEFORE turn_end: a process replacement
            # after the terminal event must replay exactly this safe summary.
            self._persist_transcript_locked()
            if self.active == turn_id:
                self.active = None
        emit(ev="turn_end", turn_id=turn_id, response=payload, cost_usd="0.0100", ms=elapsed_ms)

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
    # run.sh invokes this fixture-only setup mode before it starts muxterm, so
    # replay-order's durable seed exists before any browser can subscribe.
    if "--seed-history-only" in args:
        return
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
        elif name == "clear":
            repro.on_clear(op.get("older_than_days", 0), op.get("req_id", ""))
        elif name == "ping":
            emit(ev="pong")
        elif name == "shutdown":
            break
        else:
            log(f"ignoring unknown op {name!r}")
    log("exiting")


if __name__ == "__main__":
    main()
