#!/usr/bin/env python3
"""Plain static file server for the Android voice probe.

Two reasons this exists instead of `python3 -m http.server`:

1. Python's mimetypes module has no mapping for `.webmanifest`, so the stock
   server sends it as `application/octet-stream`. Chrome is lenient about the
   manifest content type today, but the probe's entire purpose is comparing an
   installed PWA against a tab -- betting that leniency on an install-critical
   file is a bad trade for four lines of code.

2. `Cache-Control: no-store` on everything. A probe that serves a stale copy of
   itself is an instrument that lies, and a service worker plus a phone's HTTP
   cache is two chances to do exactly that.

Usage:
    python3 serve.py [PORT] [--host HOST]

Defaults to 0.0.0.0:8478 so a phone on the same network can reach it.

NOTE ON SECURE CONTEXTS: getUserMedia, the Screen Wake Lock API, service
workers and AudioWorklet all require a secure context. A plain
`http://<lan-ip>:8478/` origin is NOT one, and the probe will refuse to run
there (it says so in a banner). Reach this server over https -- through a
muxterm tunnel or any other https front -- or the measurement cannot start.
"""

from __future__ import annotations

import argparse
import http.server
import mimetypes
import os
import socketserver
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))

mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        # The probe registers a service worker at the directory root. Serving
        # sw.js from that same directory already scopes it correctly, but being
        # explicit costs nothing and survives someone moving the file.
        if self.path.endswith("sw.js"):
            self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("port", nargs="?", type=int, default=8478)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()

    with Server((args.host, args.port), Handler) as httpd:
        sys.stderr.write(f"serving {ROOT} on http://{args.host}:{args.port}/\n")
        sys.stderr.write("reminder: getUserMedia needs a secure context -- reach this over https\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            sys.stderr.write("\nstopped\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
