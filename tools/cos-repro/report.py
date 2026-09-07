"""VERIFICATION HARNESS - the matrix as one table.

    python3 tools/cos-repro/report.py /tmp/cos-repro/base /tmp/cos-repro/fixed

One row per run per tree. A FORMATTER: nothing is computed that the run did not
measure, except the percentage (domB / expB), so a surprising row can be chased
straight into its report-*.json.

    domB   reply bytes rendered as p.say for THIS turn
    end?   is MARKER-END - the last line of the answer - in the DOM at all
    vis?   is that same marker inside the visible box of .chatbody
    te?    did turn_end reach the browser
    histB  bytes of answer text the server's history replay carried
    live   turns still rendered as streaming after the turn ended
    drop   events the server dropped into this connection's queue
"""

import json
import os
import re
import sys

ORDER = ["stream", "nostream", "big", "empty", "histcap", "s1", "s3", "s4", "s5"]


def dropped(rundir):
    """Events the server logged as dropped, and write failures, for this run."""
    n = fails = 0
    try:
        with open(os.path.join(rundir, "server.log"), errors="replace") as f:
            for line in f:
                m = re.search(r"subscriber dropped (\d+)", line)
                if m:
                    n += int(m.group(1))
                if "subscriber write failed" in line:
                    fails += 1
    except OSError:
        pass
    return n, fails


def load(root):
    """{case id: report dict} for every run under `root`."""
    out = {}
    for name in sorted(os.listdir(root)):
        rundir = os.path.join(root, name)
        if not os.path.isdir(rundir):
            continue
        for f in sorted(os.listdir(rundir)):
            if f.startswith("report-") and f.endswith(".json"):
                with open(os.path.join(rundir, f)) as fh:
                    rep = json.load(fh)
                rep["_dropped"], rep["_writefail"] = dropped(rundir)
                out[name] = rep
                break
    return out


def row(tag, case, r):
    exp = (r.get("expected") or {}).get("bytes")
    dom = r.get("dom") or {}
    wire = r.get("wire") or {}
    scr = r.get("screen") or {}
    domb = dom.get("sayBytes")
    pct = "n/a" if not exp else f"{domb / exp * 100:.1f}%"
    return (f"{case:9s} {tag:6s} {str(exp):>8s} {str(domb):>8s} {pct:>7s} "
            f"{str(dom.get('hasMarkerEnd'))[:5]:>5s} {str(scr.get('markerEndVisible'))[:5]:>5s} "
            f"{str(wire.get('turnEndReachedBrowser'))[:5]:>5s} "
            f"{str(wire.get('deltaBytes')):>9s} {str(wire.get('historyTextBytes')):>7s} "
            f"{str(dom.get('liveTurnsStillRendered')):>4s} {str(r['_dropped']):>6s} "
            f"{str(r.get('settled'))[:5]:>5s}")


def main():
    roots = sys.argv[1:]
    if not roots:
        print(__doc__)
        return 2
    tables = {os.path.basename(r.rstrip("/")): load(r) for r in roots}
    ids = [i for i in ORDER if any(i in t for t in tables.values())]
    ids += sorted({k for t in tables.values() for k in t} - set(ids))

    hdr = (f"{'case':9s} {'tree':6s} {'expB':>8s} {'domB':>8s} {'%':>7s} {'end?':>5s} "
           f"{'vis?':>5s} {'te?':>5s} {'wireDlt':>9s} {'histB':>7s} {'live':>4s} "
           f"{'drop':>6s} {'setl':>5s}")
    print(hdr)
    print("-" * len(hdr))
    for i in ids:
        for tag, t in tables.items():
            r = t.get(i)
            print(row(tag, i, r) if r else f"{i:9s} {tag:6s} (not run)")
        print()

    for tag, t in tables.items():
        for i, r in sorted(t.items()):
            if r.get("harnessError"):
                print(f"!! {tag}/{i} HARNESS ERROR: {r['harnessError'].splitlines()[0]}")
            if r["_writefail"]:
                print(f"!! {tag}/{i} server logged {r['_writefail']} subscriber write failure(s)")
            if r.get("sidecarMissingReason"):
                print(f"!! {tag}/{i} {r['sidecarMissingReason']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
