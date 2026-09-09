#!/usr/bin/env python3
"""A throwaway muxterm session-state feed, so the car screen can be developed
without a muxterm server.

Speaks just enough of the protocol for FleetRepository to have something real to
render: accepts a WebSocket upgrade on any path, answers
`{"type":"session-state-subscribe"}` with an ok result, then pushes a
`{"type":"session-state","sessions":[...]}` snapshot and alternates between two
snapshots every 20s so `Screen.invalidate()` can be watched doing its job.

Stdlib only, deliberately: this has to run anywhere the Android toolchain runs,
and adding a websocket dependency to look at a list of five rows is not a trade
worth making.

    ./android/tools/fake-fleet-feed.py [PORT]        # default 8491

Then point the app at it. From an emulator, the host is 10.0.2.2:

    adb -s emulator-5558 shell am start \
        -n io.ampbox.muxterm/.MainActivity -e url http://10.0.2.2:8491

THIS IS A TEST FIXTURE. It is not muxterm, it never talks to muxterm, and the
rows below are invented.
"""
import base64
import hashlib
import json
import socket
import struct
import sys
import threading
import time

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8491
PUSH_EVERY_S = int(sys.argv[2]) if len(sys.argv) > 2 else 20

# Deliberately includes done/failed rows: the car screen must drop them, and a
# fixture that only carries rows the screen wants proves nothing about that.
SNAP_A = [
    {"sessionId": "s1", "workspaceId": "w1", "harness": "amplifier", "name": "icons",
     "label": "android-icons", "mode": "interactive", "state": "blocked",
     "waitingFor": "permission prompt", "doing": "force-push rewrites 4 commits"},
    {"sessionId": "s2", "workspaceId": "w1", "harness": "amplifier", "name": "car-ui",
     "label": "car-ui", "mode": "autonomous", "state": "blocked",
     "waitingFor": "input needed", "doing": "loop stopped, awaiting a decision"},
    {"sessionId": "s3", "workspaceId": "w2", "harness": "claude", "name": "sessiond",
     "label": "sessiond-cutover", "mode": "autonomous", "state": "working",
     "doing": "writing keys to bytes translation"},
    {"sessionId": "s4", "workspaceId": "w2", "harness": "amplifier", "name": "voice",
     "label": "voice-orb", "mode": "interactive", "state": "working",
     "doing": "checking the screen-off guard on a real handset"},
    {"sessionId": "s5", "workspaceId": "w3", "harness": "codex", "name": "done-one",
     "label": "already-landed", "mode": "interactive", "state": "done"},
    {"sessionId": "s6", "workspaceId": "w3", "harness": "amplifier", "name": "dead",
     "label": "broken-lane", "mode": "autonomous", "state": "failed"},
]

# One blocked lane frees itself, one new blocked lane appears.
SNAP_B = [
    dict(SNAP_A[0], state="working", doing="pushing the icon commit", waitingFor=None),
    SNAP_A[1], SNAP_A[2], SNAP_A[3],
    {"sessionId": "s7", "workspaceId": "w4", "harness": "amplifier", "name": "dhu",
     "label": "head-unit", "mode": "interactive", "state": "blocked",
     "waitingFor": "input needed", "doing": "needs the phone plugged in"},
]


def stamp(rows):
    now = int(time.time())
    return [{k: v for k, v in dict(r, updatedAt=now).items() if v is not None}
            for r in rows]


def frame(payload: bytes, opcode: int = 0x1) -> bytes:
    n = len(payload)
    b0 = 0x80 | opcode
    if n < 126:
        hdr = struct.pack("!BB", b0, n)
    elif n < (1 << 16):
        hdr = struct.pack("!BBH", b0, 126, n)
    else:
        hdr = struct.pack("!BBQ", b0, 127, n)
    return hdr + payload


def read_frame(sock):
    """Returns (opcode, payload), or None when the peer is done.

    Ping handling is not optional here, however throwaway this is: OkHttp is
    configured with a ping interval, and a server that never answers a ping is
    dropped mid-conversation. The first version of this fixture ignored ping
    frames and the client dutifully reconnected every 20 seconds, which looked
    exactly like an app bug and was not one.
    """
    b = sock.recv(2)
    if len(b) < 2:
        return None
    op, second = b[0] & 0x0F, b[1]
    masked, n = second & 0x80, second & 0x7F
    if n == 126:
        n = struct.unpack("!H", sock.recv(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", sock.recv(8))[0]
    mask = sock.recv(4) if masked else b"\0\0\0\0"
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            break
        data += chunk
    if masked:
        data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
    return None if op == 0x8 else (op, data)


def serve(conn, addr):
    stop = threading.Event()
    try:
        req = b""
        while b"\r\n\r\n" not in req:
            chunk = conn.recv(4096)
            if not chunk:
                return
            req += chunk
        key = ""
        for line in req.decode("latin1").split("\r\n"):
            if line.lower().startswith("sec-websocket-key:"):
                key = line.split(":", 1)[1].strip()
        if not key:
            conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        accept = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
        conn.sendall(("HTTP/1.1 101 Switching Protocols\r\n"
                      "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Accept: {accept}\r\n\r\n").encode())
        print(f"[fixture] {addr} upgraded", flush=True)

        def pusher():
            snaps, i = (SNAP_A, SNAP_B), 0
            while not stop.is_set():
                body = json.dumps({"type": "session-state",
                                   "sessions": stamp(snaps[i % 2])})
                try:
                    conn.sendall(frame(body.encode()))
                except OSError:
                    return
                print(f"[fixture] pushed snapshot {'AB'[i % 2]}", flush=True)
                i += 1
                stop.wait(PUSH_EVERY_S)

        pushing = None
        while True:
            got = read_frame(conn)
            if got is None:
                break
            op, data = got
            if op == 0x9:                      # ping -> pong, same payload
                conn.sendall(frame(data, 0xA))
                continue
            if op == 0xA:                      # pong, nothing to do
                continue
            try:
                msg = json.loads(data)
            except ValueError:
                continue
            print(f"[fixture] <- {msg.get('type')}", flush=True)
            if msg.get("type") == "session-state-subscribe":
                conn.sendall(frame(json.dumps(
                    {"type": "session-state-subscribe-result", "ok": True}).encode()))
                if pushing is None:
                    pushing = threading.Thread(target=pusher, daemon=True)
                    pushing.start()
    except Exception as e:  # noqa: BLE001 - it is a fixture; report and move on
        print(f"[fixture] {addr} error: {e}", flush=True)
    finally:
        stop.set()
        conn.close()
        print(f"[fixture] {addr} closed", flush=True)


def main():
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("0.0.0.0", PORT))
    s.listen(8)
    print(f"[fixture] listening on 0.0.0.0:{PORT}", flush=True)
    while True:
        conn, addr = s.accept()
        threading.Thread(target=serve, args=(conn, addr), daemon=True).start()


if __name__ == "__main__":
    main()
