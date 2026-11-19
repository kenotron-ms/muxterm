#!/usr/bin/env python3
"""Exercise the signed Mac app's native browser on a disposable CI runner."""

import base64
import http.client
import http.server
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time


if os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("This check runs only on a disposable GitHub Actions Mac runner")


class Fixture(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        page = b'''<!doctype html><title>Native browser check</title>
<label for="name">Name</label><input id="name">
<button id="show" onclick="document.getElementById('status').textContent = document.getElementById('name').value">Show name</button>
<p id="status">Waiting</p>'''
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def log_message(self, *_args):
        pass


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=20)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(20)
        self.sock.connect(self.path)


def action(path, command, expected=200):
    conn = UnixConnection(path)
    try:
        conn.request("POST", "/action", json.dumps(command), {"Content-Type": "application/json"})
        response = conn.getresponse()
        body = response.read()
        if response.status != expected:
            raise AssertionError(f"{command['action']} returned HTTP {response.status}: {body[:300]!r}")
        return json.loads(body) if expected == 200 else body.decode()
    finally:
        conn.close()


def wait_for(description, check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.2)
    raise AssertionError(f"Timed out waiting for {description}")


bundle = Path.cwd() / "desktop/bin/Muxterm.app"
if not bundle.is_dir():
    raise SystemExit("Build the Mac app before running native browser verification")

fixture = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
threading.Thread(target=fixture.serve_forever, daemon=True).start()
# Darwin Unix socket paths are short (sun_path is 104 bytes). Keep the
# isolated HOME short enough for both the local server and control sockets.
home = Path(tempfile.mkdtemp(prefix="mb-", dir="/tmp"))
socket_path = home / "Library/Application Support/muxterm-desktop/browser-control.sock"
server_url = home / "Library/Application Support/muxterm-desktop/local/runtime/muxterm/server.url"
settings = home / "Library/Application Support/muxterm-desktop/settings.json"
settings.parent.mkdir(parents=True)
settings.write_text('{"keepSessionsOnQuit":false}\n')
log = Path(os.environ["RUNNER_TEMP"]) / "muxterm-browser-control.log"

try:
    subprocess.run(
        ["open", "-n", "--env", f"HOME={home}", "--stdout", str(log), "--stderr", str(log), "-a", str(bundle)],
        check=True,
    )
    wait_for("local Muxterm server", server_url.exists)
    wait_for("native browser control socket", socket_path.exists)
    if socket_path.stat().st_mode & 0o777 != 0o600:
        raise AssertionError("Native browser control socket is not mode 0600")

    url = f"http://127.0.0.1:{fixture.server_port}/"
    tab_id = action(str(socket_path), {"action": "new_tab", "url": url})["id"]

    def inspected():
        try:
            page = action(str(socket_path), {"action": "inspect", "id": tab_id})
        except (AssertionError, OSError):
            return None
        return page if page.get("title") == "Native browser check" else None

    page = wait_for("fixture page in WKWebView", inspected)
    input_ref = next(line.split()[0] for line in page["elements"] if '"Name"' in line)
    button_ref = next(line.split()[0] for line in page["elements"] if '"Show name"' in line)
    action(str(socket_path), {"action": "type", "id": tab_id, "ref": input_ref, "text": "native-ok"})
    invalid = action(str(socket_path), {"action": "navigate", "id": tab_id, "url": "ftp://invalid.example"}, expected=400)
    if "full http" not in invalid:
        raise AssertionError("Invalid URL was not rejected")
    action(str(socket_path), {"action": "click", "id": tab_id, "ref": button_ref})
    if "native-ok" not in action(str(socket_path), {"action": "inspect", "id": tab_id})["text"]:
        raise AssertionError("Native type and click did not update the page")

    def screenshot_ready():
        try:
            return action(str(socket_path), {"action": "screenshot", "id": tab_id})
        except (AssertionError, OSError):
            return None

    screenshot = wait_for("native screenshot", screenshot_ready)
    if screenshot["mimeType"] != "image/jpeg" or not base64.b64decode(screenshot["data"]).startswith(b"\xff\xd8"):
        raise AssertionError("Native screenshot is not JPEG")
    action(str(socket_path), {"action": "navigate", "id": tab_id, "url": url + "?next=1"})
    def navigated():
        try:
            return action(str(socket_path), {"action": "inspect", "id": tab_id}).get("url", "").endswith("?next=1")
        except (AssertionError, OSError):
            return False

    wait_for("native navigation", navigated)
    print("Native WKWebView control passed: open, inspect, type, invalid navigate, click, screenshot, navigate")
except Exception:
    if log.exists():
        print("Isolated Mac app log (last 4000 characters):")
        print(log.read_text(errors="replace")[-4000:])
    raise
finally:
    subprocess.run(["osascript", "-e", 'tell application id "io.ampbox.muxterm.desktop" to quit'], check=False)
    fixture.shutdown()
