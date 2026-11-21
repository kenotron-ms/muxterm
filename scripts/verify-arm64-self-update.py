#!/usr/bin/env python3
"""Exercise a Linux ARM64 muxterm binary against a published release in a container."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ASSET = "muxterm_linux_arm64.tar.gz"
SOURCE_VERSION = os.environ.get("MUXTERM_SOURCE_VERSION", "0.52.149")
TARGET_VERSION = os.environ.get("MUXTERM_TARGET_VERSION", "0.52.150")
TAG = "v" + TARGET_VERSION
FIXTURE = Path("/fixture")
HOST = "http://127.0.0.1:8765"
APP = "http://127.0.0.1:8766"
mode = "missing"
mode_lock = threading.Lock()


def set_mode(value):
    global mode
    with mode_lock:
        mode = value


class ReleaseHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        with mode_lock:
            current_mode = mode
        if self.path == "/release.json":
            assets = [{"name": "checksums.txt", "browser_download_url": HOST + "/checksums.txt"}]
            if current_mode != "missing":
                assets.append({"name": ASSET, "browser_download_url": HOST + "/" + ASSET})
            self.reply(json.dumps({"tag_name": TAG, "assets": assets}).encode(), "application/json")
        elif self.path == "/checksums.txt":
            data = ("0" * 64 + "  " + ASSET + "\n").encode() if current_mode == "bad" else (FIXTURE / "checksums.txt").read_bytes()
            self.reply(data, "text/plain")
        elif self.path == "/" + ASSET:
            data = b"corrupt archive" if current_mode == "bad" else (FIXTURE / ASSET).read_bytes()
            self.reply(data, "application/gzip")
        else:
            self.send_error(404)

    def reply(self, data, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


def request(path, method="GET"):
    with urlopen(Request(APP + path, method=method), timeout=30) as response:
        return response.status, json.load(response)


def expect_apply_failure(fragment, before):
    try:
        request("/api/update/apply", "POST")
        raise AssertionError("update unexpectedly succeeded")
    except HTTPError as exc:
        assert exc.code == 500, exc.code
        message = json.load(exc)["error"]
        assert fragment in message, message
        assert hashlib.sha256(binary.read_bytes()).hexdigest() == before, "binary changed on failure"
        print("rejected:", message, flush=True)


assert os.uname().machine == "aarch64", os.uname().machine
with tempfile.TemporaryDirectory(prefix="muxterm-arm64-update-") as root:
    root = Path(root)
    binary = root / "muxterm"
    shutil.copy2(FIXTURE / "older-muxterm", binary)
    binary.chmod(0o755)
    original_hash = hashlib.sha256(binary.read_bytes()).hexdigest()
    config = root / "config" / "muxterm"
    config.mkdir(parents=True)
    (config / "config.toml").write_text('[server]\naddr = "127.0.0.1:8766"\n')
    runtime = root / "run"
    runtime.mkdir(mode=0o700)
    env = os.environ.copy()
    env.pop("CI", None)
    env.pop("INVOCATION_ID", None)
    env.update({
        "HOME": str(root),
        "XDG_CONFIG_HOME": str(root / "config"),
        "XDG_RUNTIME_DIR": str(runtime),
        "XDG_DATA_HOME": str(root / "data"),
        "XDG_CACHE_HOME": str(root / "cache"),
        "MUXTERM_UPDATE_API_URL": HOST + "/release.json",
    })
    release_server = ThreadingHTTPServer(("127.0.0.1", 8765), ReleaseHandler)
    threading.Thread(target=release_server.serve_forever, daemon=True).start()
    process = subprocess.Popen([str(binary), "serve"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError("muxterm exited: " + process.stderr.read().decode())
            try:
                _, status = request("/api/update/status")
                break
            except URLError:
                time.sleep(0.5)
        else:
            raise RuntimeError("muxterm did not start")
        assert status["method"] == "binary", status
        assert status["updateAvailable"] and status["canUpdate"], status
        assert status["currentVersion"] == SOURCE_VERSION, status
        assert status["latestVersion"] == TARGET_VERSION, status
        print("actionable status:", json.dumps(status, sort_keys=True), flush=True)

        expect_apply_failure('has no asset "' + ASSET + '"', original_hash)
        set_mode("bad")
        request("/api/update/check", "POST")
        expect_apply_failure("checksum mismatch", original_hash)
        set_mode("good")
        request("/api/update/check", "POST")
        code, applied = request("/api/update/apply", "POST")
        assert code == 200 and applied["version"] == TARGET_VERSION, applied
        assert hashlib.sha256(binary.read_bytes()).hexdigest() != original_hash
        assert subprocess.check_output([str(binary), "version"], text=True).startswith("muxterm " + TARGET_VERSION + " ")
        print("published archive installed:", subprocess.check_output([str(binary), "version"], text=True).strip(), flush=True)
        for _ in range(60):
            try:
                _, status = request("/api/update/status")
                if status["currentVersion"] == TARGET_VERSION:
                    break
            except URLError:
                pass
            time.sleep(0.5)
        else:
            raise RuntimeError("updated server did not return")
        assert not status["updateAvailable"] and not status["canUpdate"], status
        print("updated server status:", json.dumps(status, sort_keys=True), flush=True)
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        release_server.shutdown()
