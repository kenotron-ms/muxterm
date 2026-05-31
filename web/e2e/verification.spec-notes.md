# 3-Source Harness Verification Notes

How to self-verify every pane re-parent against `make dev` using the
three-source harness introduced in Phase 3.

---

## Prerequisites

1. **Server running** — `make dev` must be up on `http://localhost:8080`
   (the default `Addr` in `cmd/muxterm/cli.go`).
2. **tmux session attached in the browser** — open `http://localhost:8080`,
   create at least one live pane so tmux pane `%1` (or whichever you target)
   has actual content.
3. **playwright-cli available** — install via `npm install -g playwright-cli`
   or the project dev-dependency. Verify with `playwright-cli --version`.

---

## Three Sources

The harness triangulates terminal state from three independent perspectives:

### Source 1 — tmux `capture-pane` (oracle)

Ground truth. tmux knows exactly what bytes were written to the pty.

```bash
tmux capture-pane -p -t %1
```

Captures the visible contents of pane `%1` as plain text (one row per line,
right-trimmed by tmux).

### Source 2 — xterm.js `StructuredSnapshot` (logical render)

Reads the xterm internal buffer via the `window.__muxterm.snapshot(paneId)` API
exposed by the frontend. Returns a `StructuredSnapshot` containing:

- `rowText: string[]` — one entry per visible row (exact characters, right-padded
  to `cols` with spaces).
- `rows`, `cols` — viewport dimensions in cells.
- `cursor`, `viewportY`, `baseY` — scroll and cursor position.

This replaces OCR (see [Why No OCR](#why-no-ocr) below). It gives exact
characters **and** styles to-the-blank with zero image processing.

```bash
playwright-cli open http://localhost:8080
playwright-cli eval "JSON.stringify(window.__muxterm.snapshot(1))"
```

The `eval` result is a JSON-serialised `StructuredSnapshot` for pane id `1`.

### Source 3 — playwright-cli physical render (DOM geometry)

Measures real DOM layout via playwright-cli `eval` against the terminal
viewport element. Captures:

- `scrollTop` — `element.scrollTop` (CSS px).
- `rowHeight` — height of one row in pixels.
- `clientWidth` — `element.clientWidth` (CSS px).
- `cellWidth` — width of one cell in pixels.
- `rows` — expected visible row count.

Example snippet:

```bash
playwright-cli eval "
  const el = document.querySelector('.xterm-viewport');
  const rowEl = document.querySelector('.xterm-rows > div');
  const cellEl = rowEl && rowEl.querySelector('span');
  JSON.stringify({
    scrollTop:   el.scrollTop,
    rowHeight:   rowEl ? rowEl.getBoundingClientRect().height : 0,
    clientWidth: el.clientWidth,
    cellWidth:   cellEl ? cellEl.getBoundingClientRect().width : 0,
    rows:        Math.round(el.clientHeight / (rowEl ? rowEl.getBoundingClientRect().height : 1))
  })
"
```

Build a `MeasuredLayout` object from this JSON and pass it to `compareLayout`.

---

## Two Invariants (encoded in `web/e2e/helpers/fidelity.ts`)

### CONTENT fidelity — `compareContent(capturePaneText, snapshot)`

```ts
import { compareContent } from './helpers/fidelity.js';
const result = compareContent(capturePaneText, snapshot);
// result.ok === true  →  no blank-tab / duplicated-content / lost-window bugs
```

- Compares the tmux oracle rows against `snapshot.rowText` row-by-row.
- Right-trims both sides before comparison (tolerates the known tmux vs xterm
  trailing-space difference).
- Returns `{ ok: boolean, diffs: ContentDiff[] }`.
- **Kills**: blank-tab bugs, duplicated-content bugs, lost-window bugs.

### LAYOUT fidelity — `compareLayout(snapshot, measured)`

```ts
import { compareLayout } from './helpers/fidelity.js';
const result = compareLayout(snapshot, measured);
// result.ok === true  →  no fit miscalcs, scroll drift, or responsive bugs
```

- Converts the playwright-cli pixel measurements to cell units and compares
  against `snapshot.rows`, `snapshot.cols`, and `snapshot.viewportY`.
- Tolerates ±1 cell sub-pixel rounding via `near()`.
- Returns `{ ok: boolean, diffs: LayoutDiff[] }`.
- **Catches**: `fit()` miscalculations, scroll drift, responsive layout bugs.

---

## CONTENT Fidelity — Runnable Proof

The full runnable proof lives in `web/e2e/content-fidelity.mjs` (Task 7).

```bash
node web/e2e/content-fidelity.mjs --pane 1
```

This script:
1. Runs `tmux capture-pane -p -t %1` to fetch the oracle.
2. Calls `playwright-cli eval "JSON.stringify(window.__muxterm.snapshot(1))"` to
   fetch the snapshot.
3. Calls `compareContent(oracle, snapshot)` from `helpers/fidelity.ts`.
4. Prints `CONTENT OK` on success or a unified diff of any mismatched rows on
   failure.

---

## LAYOUT Fidelity — Step-by-Step

1. Gather physical facts from the DOM:

   ```bash
   playwright-cli eval "<snippet from Source 3 above>"
   ```

2. Parse the JSON into a `MeasuredLayout` object.

3. Fetch the snapshot:

   ```bash
   playwright-cli eval "JSON.stringify(window.__muxterm.snapshot(1))"
   ```

4. Call `compareLayout(snapshot, measured)` from `web/e2e/helpers/fidelity.ts`.

5. Assert `result.ok === true`.

---

## Why No OCR

`tools/ocr` was deleted in Phase 2 (commit `7d028e4`).

OCR was:
- **Lossy** — sub-pixel anti-aliasing caused character misreads on non-ASCII and
  monospace glyphs.
- **Slow** — required a full screenshot render pipeline before any comparison.
- **Flaky** — font rendering differed across OS/GPU combinations, causing
  spurious CI failures.

`window.__muxterm.snapshot(paneId)` reads the **xterm.js internal buffer**
directly. It returns exact characters and styles to-the-blank with zero image
processing — making it strictly superior for content verification.

---

## Quick Verification

```bash
test -f web/e2e/verification.spec-notes.md && echo 'notes present'
```

Expected output: `notes present`
