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
of assistant `div.say.md` in `<mux-cos>`'s shadow root, per turn), and **the screen**
(geometry — is the end of the answer inside `.chatbody`'s visible box). The
user prompt is deliberately read separately from the preceding `p.say`.

The DOM assertion is semantic, not literal byte equality: Markdown deliberately
consumes table delimiters and markup before `textContent` is read. A complete
fixture payload therefore requires its explicit start/end markers in order, the
exact ordered sequence of durable `[[chunk-NNNN]]` tokens, exactly one rendered
submitted prompt, and no visible `working...` placeholder. The report records
whether the ordered token sequence matches and its first mismatch index. Wire and
DOM byte counts remain diagnostics only. The `working...` check detects the
component's visible stuck state; it intentionally does not infer liveness from
the absence of a footer, because a completed turn has no footer too.

## Running it

```bash
# one scenario against the tree you are standing in
bash tools/cos-repro/run.sh "s6-stream size:4194304"
MODE=s1 bash tools/cos-repro/run.sh "s6-histcap slow"

# targeted persistent-history and cross-tab cases
MODE=restart bash tools/cos-repro/run.sh "s6-stream"
MODE=clear-race bash tools/cos-repro/run.sh "s6-stream"
MODE=overlap-clear bash tools/cos-repro/run.sh "s6-stream"
MODE=peer bash tools/cos-repro/run.sh "s6-stream"
MODE=replay-order bash tools/cos-repro/run.sh "s6-stream slow"
MODE=identity-fence bash tools/cos-repro/run.sh "s6-stream"
MODE=metadata-absent bash tools/cos-repro/run.sh "s6-stream"
MODE=metadata-unknown bash tools/cos-repro/run.sh "s6-stream"

# baseline matrix against two trees, then compare
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
dismissed), `s4` (reload mid-stream), and `s5` (websocket killed mid-stream).

Additional opt-in history modes all submit one completed fixture turn first:

- `restart` persists the fixture's safe summarized transcript, then makes the
  first fresh-page history request exit the fixture once. The supervisor must
  replace it and the new page must eventually render the canonical history
  exactly once. This deliberately exposes a server missed-replay failure; it
  does not send a substitute snapshot.
- `clear-race` opens a second page whose pre-clear history response is captured
  and delayed, confirms **Clear all messages** through the first page's real UI,
  then requires the current delayed-snapshot page and the clearing page after a
  real browser reload to remain empty after the fixture emits the stale response.
  The fixture writes an emission artifact after that response is sent; a fixed
  server is expected to suppress it before it reaches the second browser page.
- `overlap-clear` seeds harmless old and recent fixture turns, performs a real
  **Clear messages older than 7 days** followed by a real **Clear all messages**
  from the other page, and delays the first post-prune history response. It
  requires both clear results and both snapshots to arrive in mutation order,
  the later all-clear to leave both pages empty, and a fresh browser reload to
  remain empty.
- `peer` opens and subscribes both pages before submission. Each must receive
  exactly one terminal event for the submitted turn, render it exactly once,
  and agree on the final canonical view.
- `replay-order` creates one known, harmless fixture-owned durable seed before
  muxterm starts or a browser opens, then uses the real `s5` WebSocket
  interruption while a second turn streams. It requires exactly the seed and
  submitted turns, each prompt once and in seed-before-submitted order, a
  complete submitted payload, and no visible `working...` placeholder. It also
  requires a real post-reconnect `cos-history` frame; it does not inject a
  browser frame.
- `identity-fence` first opens a fresh page and requires an OK subscription
  result with a structurally valid non-empty identity plus a semantically
  complete, identity-bearing canonical history replay. It then dispatches a
  harmless foreign `cos-history` `MessageEvent` through that page's app socket
  and requires the foreign content to be ignored while the real history remains.
  No production debug hook is used.
- `metadata-absent` and `metadata-unknown` respectively replay a history item
  with no metadata and one with only harmless unknown/provenance-like metadata.
  Both must render the ordinary prompt/reply exactly once, while the unknown
  metadata must not render.

`run.sh` alone enables the narrowly scoped fixture environment flags for
`restart`, `clear-race`, `overlap-clear`, `replay-order`, and the metadata modes. The sidecar
persists only its safe summarized fixture transcript in the already-isolated
`$MUXTERM_REPRO_DIR/transcript.json`; it never reads a real SessionStore.

`OUT` is an evidence directory, not a cleanup target. `run.sh` canonicalizes it,
requires it to be a new path strictly below `/tmp/cos-repro/`, and rejects an
existing path rather than deleting it. The default already satisfies this.

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
