#!/usr/bin/env python3
"""A stand-in provider API.

The claim under test belongs to muxterm, not to a vendor: does the credential
muxterm stored reach the process muxterm starts, and does it never come back
out of any muxterm surface? Both are answerable against an endpoint that
accepts a FABRICATED key, so no real credential is needed anywhere.

It records every x-api-key it is handed, so the evidence can assert that what
arrived is exactly what was stored.
"""
import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SEEN = []
LOCK = threading.Lock()

class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _key(self):
        return (self.headers.get("x-api-key")
                or (self.headers.get("authorization") or "").removeprefix("Bearer ").strip())

    def _record(self, path):
        with LOCK:
            SEEN.append({"path": path, "key": self._key()})

    def _send(self, code, body, ctype="application/json"):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        self._record(self.path)
        if self.path.startswith("/v1/models"):
            self._send(200, json.dumps({"data": [
                {"id": "claude-sonnet-5", "type": "model"},
                {"id": "claude-opus-5", "type": "model"}]}))
        elif self.path == "/__seen__":
            with LOCK:
                self._send(200, json.dumps(SEEN))
        else:
            self._send(404, '{"error":"no"}')

    def do_POST(self):
        self._record(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        stream = b'"stream":true' in raw.replace(b" ", b"")
        if not self.path.startswith("/v1/messages"):
            return self._send(404, '{"error":"no"}')
        if not stream:
            return self._send(200, json.dumps({
                "id": "msg_stub", "type": "message", "role": "assistant",
                "model": "claude-sonnet-5",
                "content": [{"type": "text", "text": "READY"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 5, "output_tokens": 1}}))
        ev = [
            ("message_start", {"type":"message_start","message":{"id":"msg_stub","type":"message","role":"assistant","model":"claude-sonnet-5","content":[],"stop_reason":None,"usage":{"input_tokens":5,"output_tokens":0}}}),
            ("content_block_start", {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            ("content_block_delta", {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"READY"}}),
            ("content_block_stop", {"type":"content_block_stop","index":0}),
            ("message_delta", {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}),
            ("message_stop", {"type":"message_stop"}),
        ]
        body = "".join(f"event: {n}\ndata: {json.dumps(d)}\n\n" for n, d in ev).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass

if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
