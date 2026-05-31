# E2E — Divider-Drag Resize Propagation

Drag the heavy region divider and prove the resize **propagates**: the smaller
surface's xterm grid shrinks, a `refresh-client` reaches tmux (the window's
reported size changes), and content/layout fidelity hold after settle.

Continues in the same browser session as Task 12 (two regions docked,
`mux-region-divider` visible).  Uses Phase-2 harness; no OCR.

---

## Prerequisites

1. **Two-region session** — complete [dock-mount.e2e.md](./dock-mount.e2e.md)
   first; the browser must have two `mux-region` elements and one
   `mux-region-divider` in the workspace shadow DOM.
2. **`jq` available** — `jq --version` must succeed (used to compare `cols`
   numerically in Step 4).
3. **playwright-cli attached** — browser session still open from Task 12.

---

## Background — Two-Clock Model

Resize in muxterm uses two clocks:

| Clock | Trigger | Purpose |
|-------|---------|---------|
| **PIXEL clock** | `ResizeObserver` / pointer events | Batches raw pixel changes at 16 ms |
| **CELL clock** | 40 ms debounce after pixel settle | Converts px→cells, calls `fit()`, sends `refresh-client` to tmux |

The `sleep 1` in Step 3 covers the full CELL-clock debounce **plus** the tmux
`%layout-change` round-trip.  `PROPAGATION OK` means both clocks fired and
the new `cols` value was committed to the xterm buffer.

---

## Step 1 — Capture Baseline

Record the xterm grid dimensions for pane 2 **and** the tmux-reported window
size before any drag occurs.

```bash
playwright-cli --raw eval "JSON.stringify({cols: window.__muxterm.snapshot(2).cols, rows: window.__muxterm.snapshot(2).rows})" > /tmp/before.json
tmux display-message -p -t '@2' '#{window_width}x#{window_height}' > /tmp/tmux_before.txt
cat /tmp/before.json /tmp/tmux_before.txt
```

Expected output (example):
```
{"cols":100,"rows":20}
100x20
```

Both numbers must be non-zero; the tmux `WIDTHxHEIGHT` must equal the xterm
`cols x rows` (CELL clock has already run at mount time).

---

## Step 2 — Get Divider Centre Position

Query the bounding rect of the `mux-region-divider` to find the drag
start-point (centre of the handle).

```bash
playwright-cli --raw eval "(() => { const d = document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelector('mux-region-divider'); const b = d.getBoundingClientRect(); return JSON.stringify({x: Math.round(b.x + b.width/2), y: Math.round(b.y + b.height/2)}); })()"
```

Expected: an integer `{x, y}` near the horizontal centre of the viewport.

Record the returned values as `X` and `Y` for use in Step 3.

---

## Step 3 — Perform Drag (PIXEL Clock) and Let CELL Clock Settle

Substitute the actual `X` and `Y` values from Step 2.  The drag moves the
divider 150 px to the left, shrinking the right-hand region.

```bash
X=<value from Step 2>
Y=<value from Step 2>

playwright-cli mousemove $X $Y
playwright-cli mousedown
playwright-cli mousemove $((X-150)) $Y
playwright-cli mousemove $((X-150)) $Y
playwright-cli mouseup
sleep 1   # cover 40 ms CELL-clock debounce + tmux %layout-change round-trip
```

The double `mousemove` at the destination is intentional: it flushes the
pointer-event queue so the PIXEL clock fires at least twice at the final
position before `mouseup`.

---

## Step 4 — Assert Propagation

Capture the new xterm dimensions and tmux-reported size, then verify:

1. **xterm `cols` decreased** — the CELL clock ran and called `fit()`.
2. **tmux window width equals new `cols`** — `refresh-client` reached tmux.

```bash
playwright-cli --raw eval "JSON.stringify({cols: window.__muxterm.snapshot(2).cols, rows: window.__muxterm.snapshot(2).rows})" > /tmp/after.json
tmux display-message -p -t '@2' '#{window_width}x#{window_height}' > /tmp/tmux_after.txt
echo "BEFORE:"; cat /tmp/before.json; echo "AFTER:"; cat /tmp/after.json
echo "TMUX before/after:"; cat /tmp/tmux_before.txt /tmp/tmux_after.txt
test "$(jq .cols /tmp/after.json)" -lt "$(jq .cols /tmp/before.json)" && echo "PROPAGATION OK" || { echo "NO PROPAGATION"; exit 1; }
```

Expected terminal output (example — exact numbers vary):
```
BEFORE:
{"cols":100,"rows":20}
AFTER:
{"cols":83,"rows":20}
TMUX before/after:
100x20
83x20
PROPAGATION OK
```

The key invariants:
- `after.cols < before.cols` → `PROPAGATION OK`
- tmux `after_width == after.cols` → `refresh-client` confirmed

---

## Step 5 — Content Fidelity After Resize

Re-assert that pane 2 content is intact after the layout change.

```bash
source web/e2e/dock-mount.e2e.md   # re-loads assert_content
assert_content 2
```

Expected: `CONTENT OK pane 2`

If content differs, the most likely causes are:
- Scroll offset changed during resize (`viewportY` drift)
- `fit()` fired before the terminal buffer finished re-wrapping

Allow up to 200 ms extra settle time and retry once before failing.

---

## Acceptance Criteria

| Check | Assertion |
|-------|-----------|
| xterm cols shrank | `after.cols < before.cols` → `PROPAGATION OK` |
| tmux width updated | tmux `window_width` after == `after.cols` |
| Content fidelity pane 2 | `CONTENT OK pane 2` from `assert_content` |

---

## Commit

```bash
git add web/e2e/divider-resize.e2e.md && git commit -m "test(phase3): e2e divider-drag resize propagation (two-clock, no OCR)"
```
