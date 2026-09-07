#!/usr/bin/env python3
"""Development driver for the CoS sidecar.

Stands in for internal/cos until the Go side exists: spawns the sidecar,
speaks the NDJSON protocol, prints the event stream, and asserts the
behaviours the spec's laws promise.

    ~/.local/share/uv/tools/amplifier/bin/python3 internal/cos/sidecar/dev-driver.py

Read-only by design: the only muxterm MCP tool it ever asks for is
list_workspaces.  It never creates or closes a pane or workspace -- the
production sessiond on this machine is live (AGENTS.md).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAIN = HERE / "main.py"

CODEWORD = "PLATYPUS-7731"


def now() -> str:
    return time.strftime("%H:%M:%S")


class Sidecar:
    """One sidecar process plus the plumbing to talk to it."""

    def __init__(self, args: argparse.Namespace, label: str,
                 extra_env: dict | None = None, extra_args: list | None = None) -> None:
        self.args = args
        self.label = label
        self.extra_env = extra_env or {}
        self.extra_args = extra_args or []
        self.proc: asyncio.subprocess.Process | None = None
        self.events: asyncio.Queue = asyncio.Queue()
        self.log: list[dict] = []
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> float:
        env = dict(os.environ)
        # Keep the muxterm session-state spool out of production's home view.
        env.setdefault("MUXTERM_SESSION_STATE_DIR", tempfile.mkdtemp(prefix="cos-dev-state-"))
        env.update(self.extra_env)
        cmd = [
            self.args.python, str(MAIN),
            "--session-id", self.args.session_id,
            "--bundle", self.args.bundle,
            "--cwd", self.args.cwd,
            "--log-level", self.args.log_level,
        ] + self.extra_args
        print(f"[{now()}] spawn {self.label}: {' '.join(cmd)}", file=sys.stderr)
        t0 = time.monotonic()
        self.proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        self._tasks.append(asyncio.create_task(self._read_stdout()))
        self._tasks.append(asyncio.create_task(self._read_stderr()))
        return t0

    async def _read_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        while True:
            raw = await self.proc.stdout.readline()
            if not raw:
                await self.events.put(None)
                return
            line = raw.decode("utf-8", "replace").rstrip("\n")
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                print(f"[{now()}] !! NON-JSON ON STDOUT: {line[:400]!r}", file=sys.stderr)
                await self.events.put({"ev": "__protocol_violation__", "raw": line})
                continue
            self.log.append(ev)
            self._render(ev)
            await self.events.put(ev)

    async def _read_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        while True:
            raw = await self.proc.stderr.readline()
            if not raw:
                return
            if self.args.stderr:
                sys.stderr.write(f"    [{self.label} stderr] " + raw.decode("utf-8", "replace"))
            else:
                text = raw.decode("utf-8", "replace")
                if "tools mounted" in text or "restored" in text or "ERROR" in text:
                    sys.stderr.write(f"    [{self.label} stderr] " + text)

    @staticmethod
    def _render(ev: dict) -> None:
        kind = ev.get("ev")
        if kind in ("delta", "thinking"):
            text = (ev.get("text") or "").replace("\n", "\\n")
            print(f"[{now()}] {kind:<16} {ev.get('turn_id')} {text!r}")
        elif kind == "tool_start":
            print(f"[{now()}] {kind:<16} {ev.get('turn_id')} {ev.get('name')} args={ev.get('args')}")
        elif kind == "tool_end":
            print(f"[{now()}] {kind:<16} {ev.get('turn_id')} ok={ev.get('ok')} "
                  f"ms={ev.get('ms')} summary={(ev.get('summary') or '')[:90]!r}")
        elif kind in ("turn_end", "cancelled"):
            resp = (ev.get("response") or "").replace("\n", " ")
            print(f"[{now()}] {kind:<16} {ev.get('turn_id')} ms={ev.get('ms')} "
                  f"cost={ev.get('cost_usd')} response={resp[:160]!r}")
        else:
            print(f"[{now()}] {kind:<16} {json.dumps({k: v for k, v in ev.items() if k != 'ev'})[:300]}")

    def send(self, **op) -> None:
        assert self.proc and self.proc.stdin
        line = json.dumps(op)
        print(f"[{now()}] --> {line}")
        self.proc.stdin.write((line + "\n").encode())

    async def wait_for(self, pred, timeout: float = 180.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timed out waiting for event")
            ev = await asyncio.wait_for(self.events.get(), timeout=remaining)
            if ev is None:
                raise RuntimeError("sidecar stdout closed while waiting")
            if pred(ev):
                return ev

    async def terminal(self, turn_id: str, timeout: float = 300.0) -> dict:
        return await self.wait_for(
            lambda e: e.get("turn_id") == turn_id
            and (e.get("ev") in ("turn_end", "cancelled")
                 or (e.get("ev") == "error" and e.get("fatal"))),
            timeout,
        )

    def stream_text(self, turn_id: str, kind: str = "delta") -> str:
        return "".join(e.get("text") or "" for e in self.log
                       if e.get("ev") == kind and e.get("turn_id") == turn_id)

    def count(self, kind: str, turn_id: str | None = None) -> int:
        return len([e for e in self.log
                    if e.get("ev") == kind and (turn_id is None or e.get("turn_id") == turn_id)])

    async def stop(self) -> None:
        if self.proc is None:
            return
        try:
            self.send(op="shutdown")
            if self.proc.stdin:
                await self.proc.stdin.drain()
                self.proc.stdin.close()
        except (BrokenPipeError, ConnectionResetError):
            pass
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=30)
        except (asyncio.TimeoutError, TimeoutError):
            self.proc.kill()
            await self.proc.wait()
        for t in self._tasks:
            t.cancel()
        print(f"[{now()}] {self.label} exited rc={self.proc.returncode}")


RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"\n{'PASS' if ok else 'FAIL'}  {name}" + (f"  --  {detail}" if detail else "") + "\n")


async def scenario(args: argparse.Namespace) -> int:
    timings: dict[str, int] = {}

    sc = Sidecar(args, "phase1")
    t0 = await sc.start()
    ready = await sc.wait_for(lambda e: e.get("ev") == "ready", timeout=240)
    timings["boot_ms(reported)"] = ready.get("boot_ms", -1)
    timings["boot_ms(wall)"] = int((time.monotonic() - t0) * 1000)

    # (a) ready with tools > 0 including mcp_muxterm_*
    check("(a) ready reports tools > 0 including mcp_muxterm_*",
          ready.get("tools", 0) > 0 and ready.get("muxterm_tools", 0) > 0,
          f"tools={ready.get('tools')} muxterm_tools={ready.get('muxterm_tools')} "
          f"resumed={ready.get('resumed')} boot_ms={ready.get('boot_ms')}")

    sc.send(op="ping")
    pong = await sc.wait_for(lambda e: e.get("ev") == "pong", timeout=30)
    check("ping/pong", pong.get("ev") == "pong")

    # (e) two turn ops back to back -> the second is refused with busy
    sc.send(op="turn", turn_id="t-1",
            prompt=f"Remember this codeword exactly: {CODEWORD}. Reply with only the word: ok")
    sc.send(op="turn", turn_id="t-2", prompt="This one must be refused as busy.")
    busy = await sc.wait_for(
        lambda e: e.get("ev") == "error" and e.get("code") == "busy", timeout=120)
    check("(e) second back-to-back turn is refused with busy",
          busy.get("turn_id") == "t-2" and busy.get("fatal") is False,
          json.dumps(busy))

    end1 = await sc.terminal("t-1")
    timings["turn t-1 ms"] = end1.get("ms", -1)

    # (c) deltas actually streamed during the turn
    n_delta = sc.count("delta", "t-1")
    check("(c) delta events stream during a turn", n_delta > 0,
          f"{n_delta} delta events on t-1 "
          f"(+{sc.count('thinking', 't-1')} thinking)")
    stream1 = sc.stream_text("t-1")
    check("(c+) delta stream reconstructs the reply, no background-call leakage",
          (end1.get("response") or "") in stream1 and '"label"' not in stream1,
          f"concatenated deltas={stream1!r} vs response={end1.get('response')!r}")

    check("law 2: exactly one terminal event for t-1",
          len([e for e in sc.log if e.get("turn_id") == "t-1"
               and e.get("ev") in ("turn_end", "cancelled")]) == 1,
          f"terminal={end1.get('ev')}")

    # (b) second turn remembers the first
    sc.send(op="turn", turn_id="t-3",
            prompt="What codeword did I ask you to remember? Reply with only that codeword.")
    end3 = await sc.terminal("t-3")
    timings["turn t-3 ms"] = end3.get("ms", -1)
    check("(b) second sequential turn remembers the first",
          CODEWORD in (end3.get("response") or ""),
          f"response={end3.get('response')!r}")

    # (d) a turn that calls a READ-ONLY muxterm MCP tool
    sc.send(op="turn", turn_id="t-4",
            prompt="Call the mcp_muxterm_list_workspaces tool now (it is read-only) and "
                   "tell me how many workspaces exist. Do not create, rename or close "
                   "anything.")
    end4 = await sc.terminal("t-4")
    timings["turn t-4 ms (with MCP tool call)"] = end4.get("ms", -1)
    starts = [e for e in sc.log if e.get("ev") == "tool_start" and e.get("turn_id") == "t-4"]
    ends = [e for e in sc.log if e.get("ev") == "tool_end" and e.get("turn_id") == "t-4"]
    mux = [e for e in starts if str(e.get("name", "")).startswith("mcp_muxterm_")]
    check("(d) muxterm MCP tool call emits tool_start / tool_end",
          bool(mux) and len(ends) >= len(mux),
          f"tool_start={[e.get('name') for e in starts]} tool_end={len(ends)} "
          f"ok={[e.get('ok') for e in ends]}")

    stream4 = sc.stream_text("t-4")
    check("(c+) delta stream clean on a tool-calling turn",
          (end4.get("response") or "") in stream4 and '"label"' not in stream4,
          f"concatenated deltas len={len(stream4)} response len={len(end4.get('response') or '')}")

    # protocol hygiene
    check("stdout carried protocol only (no non-JSON lines)",
          sc.count("__protocol_violation__") == 0)

    await sc.stop()

    # session resume across a sidecar restart (spec 3.1)
    sc2 = Sidecar(args, "phase2")
    t0b = await sc2.start()
    ready2 = await sc2.wait_for(lambda e: e.get("ev") == "ready", timeout=240)
    timings["boot_ms phase2 (resume, reported)"] = ready2.get("boot_ms", -1)
    timings["boot_ms phase2 (wall)"] = int((time.monotonic() - t0b) * 1000)
    sc2.send(op="turn", turn_id="r-1",
             prompt="What codeword did I ask you to remember earlier? Reply with only that codeword.")
    endr = await sc2.terminal("r-1")
    timings["turn r-1 ms (after resume)"] = endr.get("ms", -1)
    check("session resumes across a sidecar restart",
          ready2.get("resumed") is True and CODEWORD in (endr.get("response") or ""),
          f"resumed={ready2.get('resumed')} response={endr.get('response')!r}")
    await sc2.stop()

    print("\n" + "=" * 72)
    print("MEASURED TIMINGS")
    for k, v in timings.items():
        print(f"  {k:<42} {v} ms")
    print("=" * 72)
    print("RESULTS")
    failed = 0
    for name, ok, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if detail:
            print(f"        {detail}")
        failed += 0 if ok else 1
    print(f"\n  session id: {args.session_id}")
    print(f"  resume in a terminal with:  amplifier resume {args.session_id}")
    print("=" * 72)
    return 1 if failed else 0


async def scenario_approval(args: argparse.Namespace) -> int:
    """Critical point 4: the approval round trip, including timeout -> DENIED.

    The anchors bundle runs hooks-approval in policy_driven_only mode, so
    nothing triggers an approval on its own.  MUXTERM_COS_REQUIRE_APPROVAL is
    the seam that puts a (read-only) tool behind the host gate.
    """
    tool = "mcp_muxterm_list_workspaces"
    sc = Sidecar(args, "approval",
                 extra_env={"MUXTERM_COS_REQUIRE_APPROVAL": tool},
                 extra_args=["--approval-timeout", "5"])
    await sc.start()
    await sc.wait_for(lambda e: e.get("ev") == "ready", timeout=240)

    prompt = (f"Call the {tool} tool now (it is read-only) and say how many "
              "workspaces exist. Do not create, rename or close anything.")

    def ran(turn_id: str) -> list:
        # hooks-approval denies at tool:pre, so a denied call produces NO
        # tool_end at all -- its absence is the evidence.
        return [e for e in sc.log if e.get("ev") == "tool_end"
                and e.get("turn_id") == turn_id and e.get("ok")]

    # 1. approve
    sc.send(op="turn", turn_id="ap-1", prompt=prompt)
    req = await sc.wait_for(lambda e: e.get("ev") == "approval_request", timeout=180)
    check("approval_request is emitted and blocks the turn",
          req.get("tool") == tool and bool(req.get("request_id")), json.dumps(req))
    sc.send(op="approval", request_id=req["request_id"], approved=True, reason="driver approves")
    await sc.terminal("ap-1")
    check("approved tool actually runs", bool(ran("ap-1")),
          f"tool_end={[(e.get('ok'), (e.get('summary') or '')[:50]) for e in ran('ap-1')]}")

    # 2. deny
    sc.send(op="turn", turn_id="ap-2", prompt=prompt)
    req2 = await sc.wait_for(lambda e: e.get("ev") == "approval_request", timeout=180)
    sc.send(op="approval", request_id=req2["request_id"], approved=False, reason="driver denies")
    end2 = await sc.terminal("ap-2")
    check("denied tool never executes", not ran("ap-2"),
          f"successful tool_end count={len(ran('ap-2'))} "
          f"response={(end2.get('response') or '')[:140]!r}")

    # 3. no answer at all -> timeout must resolve to DENIED, never approved
    sc.send(op="turn", turn_id="ap-3", prompt=prompt)
    req3 = await sc.wait_for(lambda e: e.get("ev") == "approval_request", timeout=180)
    t0 = time.monotonic()
    end3 = await sc.terminal("ap-3", timeout=180)
    elapsed = time.monotonic() - t0
    timeout_s = float(req3.get("timeout") or 0)
    check("unanswered approval times out as DENIED, never approved",
          not ran("ap-3") and elapsed >= timeout_s,
          f"no answer sent; waited {elapsed:.1f}s (approval timeout {timeout_s}s), "
          f"successful tool_end count={len(ran('ap-3'))}, "
          f"response={(end3.get('response') or '')[:160]!r}")
    await sc.stop()
    return 0


async def scenario_cancel(args: argparse.Namespace) -> int:
    """Critical point 5: a cancelled turn still gets exactly one terminal event."""
    sc = Sidecar(args, "cancel")
    await sc.start()
    await sc.wait_for(lambda e: e.get("ev") == "ready", timeout=240)
    sc.send(op="turn", turn_id="c-1",
            prompt="Count from 1 to 400, one number per line, with a short comment on "
                   "each. Do not stop early and do not summarise.")
    await sc.wait_for(lambda e: e.get("ev") in ("delta", "thinking")
                      and e.get("turn_id") == "c-1", timeout=180)
    sc.send(op="cancel", turn_id="c-1")
    term = await sc.terminal("c-1", timeout=180)
    terminals = [e for e in sc.log if e.get("turn_id") == "c-1"
                 and e.get("ev") in ("turn_end", "cancelled")]
    check("cancel produces exactly one terminal event",
          len(terminals) == 1, f"terminal={term.get('ev')} ms={term.get('ms')}")

    # the sidecar must still be usable afterwards
    sc.send(op="turn", turn_id="c-2", prompt="Reply with only the word: alive")
    end2 = await sc.terminal("c-2")
    check("sidecar survives a cancel and accepts the next turn",
          "alive" in (end2.get("response") or "").lower(),
          f"response={end2.get('response')!r}")

    # protocol robustness
    sc.send(op="nonsense-op")
    bad = await sc.wait_for(lambda e: e.get("ev") == "error" and e.get("code") == "unknown_op",
                            timeout=30)
    check("unknown op is reported, never fatal", bad.get("fatal") is False, json.dumps(bad))
    assert sc.proc and sc.proc.stdin
    sc.proc.stdin.write(b"{not json at all\n")
    bad2 = await sc.wait_for(lambda e: e.get("ev") == "error" and e.get("code") == "bad_json",
                             timeout=30)
    check("malformed line is reported, never fatal", bad2.get("fatal") is False, json.dumps(bad2))
    sc.send(op="ping")
    await sc.wait_for(lambda e: e.get("ev") == "pong", timeout=30)
    await sc.stop()
    return 0


def summarise() -> int:
    print("\n" + "=" * 72)
    print("RESULTS")
    failed = 0
    for name, ok, detail in RESULTS:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
        if detail:
            print(f"        {detail}")
        failed += 0 if ok else 1
    print("=" * 72)
    return 1 if failed else 0


def main() -> int:
    default_python = sys.executable
    p = argparse.ArgumentParser(description="drive the CoS sidecar")
    p.add_argument("--python", default=default_python, help="amplifier venv interpreter")
    p.add_argument("--session-id", default=f"cos-dev-{int(time.time())}")
    p.add_argument("--bundle", default="anchors")
    p.add_argument("--cwd", default=str(HERE.parent.parent))
    p.add_argument("--log-level", default="info")
    p.add_argument("--stderr", action="store_true", help="mirror all sidecar stderr")
    p.add_argument("--scenario", default="smoke", choices=["smoke", "approval", "cancel"])
    args = p.parse_args()
    runner = {"smoke": scenario, "approval": scenario_approval, "cancel": scenario_cancel}
    try:
        if args.scenario == "smoke":
            return asyncio.run(scenario(args))
        asyncio.run(runner[args.scenario](args))
        return summarise()
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
