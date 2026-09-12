#!/usr/bin/env python3
"""Launch/observe a real Amplifier root; never manufacture a fleet declaration.

Uses supported `amplifier run --bundle ... [--resume ...] --mode chat` and the
existing read-only `muxterm fleet --json` collector subscription. No model call
is needed when prompt is omitted. stdout/stdin remain the agent's; bounded
code-only commissioning results go to stderr. A failed check never kills it.
Launch is intentional CLI execution, not a side-effect-free inspection: normal
CLI first-run setup/update behavior still applies. Use --observe-pid for reads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time

PUBLISHER = "hooks-muxterm-session/0.7.0"
SAFE_ID = re.compile(r"[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}")
REJECTION_CODES = {
    "accepted", "incompatible_schema", "incompatible_publisher",
    "identity_mismatch", "identity_unavailable", "invalid_snapshot",
    "unplaceable", "superseded",
}


def process_start(pid: int) -> int:
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
        return int(text[text.rindex(")") + 1:].split()[19])
    except (OSError, ValueError, IndexError):
        return 0


def private_directory(path: Path) -> bool:
    try:
        info = path.lstat()
        return (stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
                and info.st_mode & 0o077 == 0)
    except OSError:
        return False


def read_document(path: Path) -> tuple[dict, bytes]:
    """Bounded, same-user, no symlink/FIFO reads; no file contents are logged."""
    if not private_directory(path.parent):
        return {}, b""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                    or info.st_mode & 0o077 or info.st_size >= 65536):
                return {}, b""
            body = stream.read(65536)
        value = json.loads(body)
        return (value, body) if isinstance(value, dict) else ({}, b"")
    except (OSError, ValueError):
        return {}, b""


def result(stage: str, status: str, code: str, pid: int, **fields: object) -> dict:
    payload = {"v": 1, "component": "muxterm-amplifier-commission",
               "stage": stage, "status": status, "code": code, "pid": pid, **fields}
    print(json.dumps(payload, separators=(",", ":")), file=sys.stderr, flush=True)
    return payload


def find_publisher(spool: Path, pid: int, start: int) -> tuple[str, dict, bytes, dict]:
    # Publisher diagnostics include explicit opt-out even when no snapshot exists.
    # Directory iteration is capped, not a broad history or transcript search.
    for directory in (spool / ".reporting", spool):
        if not private_directory(directory):
            continue
        try:
            with os.scandir(directory) as entries:
                for index, entry in enumerate(entries):
                    if index >= 256:
                        break
                    if not entry.name.endswith(".json"):
                        continue
                    sid = entry.name[:-5]
                    if not SAFE_ID.fullmatch(sid):
                        continue
                    doc, _ = read_document(Path(entry.path))
                    if (doc.get("pid") != pid or doc.get("pidStart") != start
                            or doc.get("sessionId") != sid):
                        continue
                    snapshot, raw = read_document(spool / f"{sid}.json")
                    diagnostic, _ = read_document(spool / ".reporting" / f"{sid}.json")
                    return sid, snapshot, raw, diagnostic
        except OSError:
            continue
    return "", {}, b"", {}


def commission(pid: int, timeout: float, muxterm: str) -> dict:
    start = process_start(pid)
    if not start:
        return result("reporting", "blocked", "process_identity_unavailable", pid)
    spool = Path(os.environ.get("MUXTERM_SESSION_STATE_DIR") or (
        str(Path(os.environ["XDG_RUNTIME_DIR"]) / "muxterm" / "session-state")
        if os.environ.get("XDG_RUNTIME_DIR") else
        str(Path(tempfile.gettempdir()) / f"muxterm-{os.getuid()}" / "session-state")
    ))
    deadline = time.monotonic() + timeout
    initialized = False
    last_code = "publisher_missing_or_uninitialized"
    while time.monotonic() < deadline:
        if process_start(pid) != start:
            return result("reporting", "blocked", "process_ended_or_replaced", pid)
        sid, snapshot, raw, diagnostic = find_publisher(spool, pid, start)
        if sid:
            if diagnostic.get("pid") == pid and diagnostic.get("pidStart") == start:
                if diagnostic.get("status") in {"disabled", "failed"}:
                    return result("publisher", diagnostic["status"],
                                  "publisher_disabled" if diagnostic["status"] == "disabled"
                                  else "publisher_reporting_failed", pid, sessionId=sid)
            if snapshot.get("publisher") != PUBLISHER:
                last_code = "publisher_missing_or_incompatible"
            elif (snapshot.get("v") != 1 or snapshot.get("pid") != pid
                  or snapshot.get("pidStart") != start):
                last_code = "snapshot_identity_or_version_mismatch"
            else:
                if not initialized:
                    result("publisher", "initialized", "snapshot_written", pid,
                           sessionId=sid, publisher=PUBLISHER)
                    initialized = True
                # Ordinary collector subscription. Output may contain other lanes'
                # display fields: discard it, never echo or save it in diagnostics.
                try:
                    subprocess.run([muxterm, "fleet", "--json"],
                                   stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, timeout=min(
                                       2.0, max(0.05, deadline - time.monotonic())),
                                   check=True)
                    last_code = "collector_unobserved"
                except (OSError, subprocess.SubprocessError):
                    last_code = "collector_unavailable"
                receipt, _ = read_document(spool / ".receipts" / f"{sid}.json")
                collector_pid = receipt.get("collectorPid")
                collector_start = receipt.get("collectorStart")
                if (receipt.get("v") == 1 and receipt.get("sessionId") == sid
                        and receipt.get("pid") == pid and receipt.get("pidStart") == start
                        and receipt.get("publisher") == PUBLISHER
                        and receipt.get("snapshotSha256") == hashlib.sha256(raw).hexdigest()
                        and type(collector_pid) is int and collector_pid > 0
                        and type(collector_start) is int and collector_start > 0
                        and process_start(collector_pid) == collector_start):
                    code = receipt.get("code")
                    code = code if code in REJECTION_CODES else "collector_rejected"
                    if receipt.get("status") == "rejected":
                        return result("collector", "rejected", code, pid, sessionId=sid)
                    if (receipt.get("status") == "observed" and code == "accepted"
                            and isinstance(receipt.get("workspaceId"), str)
                            and receipt["workspaceId"]
                            and type(receipt.get("paneId")) is int and receipt["paneId"] > 0):
                        # Recheck bytes and process generation so concurrent resume/
                        # progress cannot acknowledge yesterday's snapshot.
                        _, current_raw = read_document(spool / f"{sid}.json")
                        if current_raw == raw and process_start(pid) == start:
                            return result("collector", "observed", "accepted", pid,
                                          sessionId=sid, workspaceId=receipt["workspaceId"],
                                          paneId=receipt["paneId"])
        elif spool.exists() and (
            not private_directory(spool) or not os.access(spool, os.W_OK | os.X_OK)
        ):
            last_code = "spool_unsafe_or_unwritable"
        time.sleep(min(0.25, max(0, deadline - time.monotonic())))
    return result("reporting", "blocked", last_code, pid)


def safe_commission(pid: int, timeout: float, muxterm: str) -> dict:
    try:
        return commission(pid, timeout, muxterm)
    except Exception:
        # No exception string: paths and environment are not diagnostic content.
        return result("reporting", "failed", "commissioning_check_failed", pid)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observe-pid", type=int, help="Check a newly started root without sending input")
    parser.add_argument("--bundle", help="Explicit supported Amplifier bundle; existing opt-outs are preserved")
    parser.add_argument("--resume", help="Saved root session ID, passed to amplifier run --resume")
    parser.add_argument("--timeout", type=float, default=15, help="Readiness budget, 1-60 seconds")
    parser.add_argument("--amplifier", default="amplifier")
    parser.add_argument("--muxterm", default="muxterm")
    parser.add_argument("prompt", nargs="?", help="Omit to initialize without a model turn")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 60:
        parser.error("--timeout must be 1-60 seconds")
    if args.observe_pid is not None:
        if args.observe_pid <= 0 or args.bundle or args.resume or args.prompt:
            parser.error("--observe-pid requires a positive PID and no launch arguments")
        outcome = safe_commission(args.observe_pid, args.timeout, args.muxterm)
        return 0 if outcome["status"] == "observed" else 2
    if not args.bundle:
        parser.error("launch requires --bundle; no personal bundle is modified or implicitly replaced")
    if args.resume and not SAFE_ID.fullmatch(args.resume):
        parser.error("invalid resume session ID")
    if args.prompt and args.prompt.lstrip().startswith("/"):
        parser.error("use the existing muxterm goal launcher for /goal, then --observe-pid")
    argv = [args.amplifier, "run", "--bundle", args.bundle, "--mode", "chat"]
    if args.resume:
        argv += ["--resume", args.resume]
    if args.prompt:
        argv += ["--", args.prompt]
    try:
        child = subprocess.Popen(argv)  # inherited PTY, stdin, auth and environment
    except OSError:
        result("process", "failed", "launch_failed", 0)
        return 1
    result("process", "started", "launch_started", child.pid)
    watcher = threading.Thread(target=safe_commission,
                               args=(child.pid, args.timeout, args.muxterm), daemon=True)
    watcher.start()
    while True:
        try:
            return child.wait()
        except KeyboardInterrupt:
            # The PTY already delivered SIGINT to Amplifier. Never turn a
            # telemetry failure or a user's cancellation into a process kill.
            continue


if __name__ == "__main__":
    raise SystemExit(main())