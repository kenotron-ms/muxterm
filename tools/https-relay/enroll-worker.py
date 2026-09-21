#!/usr/bin/env python3
"""Exchange owner authorization for a single-use, worker-only config.

The client config stays with the owner. Transfer ONLY the output to the worker.
The output expires after 120 seconds until consumed; an exchange is not retried.
"""
import argparse
import json
import os
from pathlib import Path
import stat
import urllib.request
from urllib.parse import urlsplit


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("broker redirects forbidden")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-config", required=True)
    parser.add_argument("--output", required=True, help="new private worker config file")
    args = parser.parse_args()
    path = Path(args.client_config)
    with path.open() as f:
        mode = os.fstat(f.fileno()).st_mode
        if not stat.S_ISREG(mode) or mode & 0o077:
            raise ValueError("client config must be a private regular file")
        cfg = json.load(f)
    url = urlsplit(cfg["url"])
    if (url.scheme != "https" or not url.hostname or url.username or
            url.password or url.path not in ("", "/") or url.query or url.fragment):
        raise ValueError("broker requires an HTTPS origin")
    request = urllib.request.Request(
        cfg["url"].rstrip("/") + "/enroll", data=b"{}",
        headers={"Authorization": "Bearer " + cfg["token"],
                 "Content-Type": "application/json"},
    )
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(request, timeout=20) as response:
        enrolled = json.loads(response.read(8192))
    if enrolled["host"] != cfg["host"]:
        raise ValueError("broker enrollment binding mismatch")
    # Exclusive creation prevents replacing another runtime's config or a symlink.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"url": cfg["url"], "host": cfg["host"],
                   "enrollmentToken": enrolled["enrollmentToken"]}, f)
    print("Worker enrollment written privately; transfer and start within 120 seconds.")


if __name__ == "__main__":
    main()
