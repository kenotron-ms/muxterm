# cos-repro — a verification harness for the chief-of-staff chat pipeline

`internal/cos` has no unit tests, and `AGENTS.md` bans them: the way this
codebase proves something works is by running muxterm and driving a real
browser. This is that, for the cos pipeline — sidecar → supervisor → broker →
websocket → `cos-store` → `<mux-cos>` — with numbers at each hop.

## Why it exists

The shipped dev fixture `internal/cos/sidecar/stub-sidecar.py` **does not
implement the `history` op**. A browser that reloads, reconnects, or subscribes
fresh therefore gets an empty replay from it, so every replay bug is invisible
to any test built on it. `repro-sidecar.py` implements `history` — and builds
its replay blocks with the *product's own* `_summarize_turn`, imported from the
tree under test, so the block cap is exercised rather than imitated.

It measures three layers, because "it didn't render" doesn't say where the bytes
went: **the wire** (every cos-\* frame the browser received), **the DOM** (text
of `p.say` in `<mux-cos>`'s shadow root, per turn), and **the screen**
(geometry — is the end of the answer inside `.chatbody`'s visible box). The
third exists because the first two kept saying 100% while a user saw nothing.

## Running it

```bash
# one scenario against the tree you are standing in
bash tools/cos-repro/run.sh "s6-stream size:4194304"
MODE=s1 bash tools/cos-repro/run.sh "s6-histcap slow"

# the whole matrix against two trees, then compare
REPO=/root/muxterm-base  TAG=base  bash tools/cos-repro/matrix.sh
REPO=/root/muxterm-fixed TAG=fixed bash tools/cos-repro/matrix.sh
python3 tools/cos-repro/report.py /tmp/cos-repro/base /tmp/cos-repro/fixed
```

Needs Go, Node, `npm` (the frontend is `//go:embed`-ed, so `web/dist` must be
built **before** `go build`), Python 3, and Playwright with Chromium.

Scenarios are prompt keywords, parsed by `repro-sidecar.py`: `s6-stream`,
`s6-nostream`, `s6-empty`, `s6-histcap`, plus `size:<N>`, `delta:<N>`,
`gap:<ms>`, `tools:<N>`, `slow`, `tool`. Away modes (`--mode` / `MODE=`) are
`plain`, `s1` (page closed mid-stream, fresh page after), `s3` (Dashboard
dismissed), `s4` (reload mid-stream), `s5` (websocket killed mid-stream).

## Isolation rules

**Run this in a DTU container.** It starts a muxterm server, and `AGENTS.md`
forbids hand-rolling a scratch instance on a host that has a real one: the live
`muxterm.service` (9090) and `muxterm-sessiond.service` own every running shell
on the machine. The env guards below are defence in depth *inside* the
container, not permission to skip it.

- **Ports 9090 and 8311 are production.** `run.sh` refuses both outright and
  defaults to 9390.
- **Nothing reaches `~/.local/share/muxterm/`.** `run.sh` points
  `XDG_DATA_HOME`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` at
  throwaway dirs under `$STATE` (default `/tmp/cos-repro-state`), so a run
  cannot read or write a real installation's state or its
  `restore-snapshot.json`.
- **It only kills what it started.** The server is stopped by the PID `run.sh`
  wrote; the fallback `pkill` is scoped to this harness's own command line, and
  the sessiond muxterm spawns is never reaped.
- One binary is built per tree (`/tmp/bin-muxterm-<tree>`) because `web/dist` is
  embedded — a shared binary path is how a baseline run ends up quietly served
  by the fixed build.

## Files

| file | what it is |
| --- | --- |
| `repro-sidecar.py` | scripted sidecar: exact payloads, `history` op, artifacts |
| `drive.mjs` | Playwright driver: submit, go away, measure wire/DOM/screen |
| `run.sh` | one scenario end to end: build, serve, drive, report |
| `matrix.sh` | every scenario against one tree |
| `report.py` | the matrix as one table |
