# E2E — Dock Mount of 2 Surfaces (Content + Layout Fidelity)

First re-parenting test. Mount a second region and assert BOTH surfaces show
correct content (CONTENT fidelity vs `tmux capture-pane`) and correct geometry
(LAYOUT fidelity vs `playwright-cli`). Uses Phase-2 harness; no OCR.

---

## Prerequisites

1. **Dev server running** — `make dev` must be up on `http://localhost:8080`.
2. **tmux session attached in the browser** — at least two live panes available
   so pane `%1` and `%2` have actual content.
3. **playwright-cli available** — `npm install -g playwright-cli` or project
   dev-dependency. Verify with `playwright-cli --version`.

---

## Step 1 — Verify dev server

```bash
curl -sSf http://localhost:8080/ >/dev/null && echo "dev up"
```

Expected: `dev up`

---

## Step 2 — Open browser

```bash
playwright-cli open --browser=chromium http://localhost:8080
```

---

## Step 3 — Failing assertion (before dock)

Assert only one region is rendered before triggering the dock:

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length"
```

Expected: `1`

---

## Step 4 — Trigger dock

Mount a second region and assert the workspace now has two:

```bash
playwright-cli --raw eval "(() => { const app = document.querySelector('mux-app'); app.openRegionForTest('work', 2); return app.shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region').length; })()"
```

Expected: `2`

---

## Step 5 — Confirm divider

```bash
playwright-cli --raw eval "document.querySelector('mux-app').shadowRoot.querySelector('mux-workspace').shadowRoot.querySelectorAll('mux-region-divider').length"
```

Expected: `1`

---

## Step 6 — CONTENT Fidelity

### Shell helper function

```bash
assert_content () {  # $1 = pane %N
  pane="$1"
  tmux capture-pane -p -t "%$pane" | sed 's/[[:space:]]*$//' > /tmp/tmux_$pane.txt
  playwright-cli --raw eval "JSON.stringify(window.__muxterm.snapshot($pane).rows.map(r => r.replace(/\\s+$/,'')))" \
    | jq -r '.[]' > /tmp/xterm_$pane.txt
  diff /tmp/tmux_$pane.txt /tmp/xterm_$pane.txt && echo "CONTENT OK pane $pane" || { echo "CONTENT MISMATCH pane $pane"; exit 1; }
}
```

### Run fidelity assertions

```bash
source web/e2e/dock-mount.e2e.md  # loads assert_content
tmux list-panes -a -F '#{pane_id} #{window_id}'  # discover real %N values
assert_content 1   # editor window's pane
assert_content 2   # logs window's pane
```

Expected output:
```
CONTENT OK pane 1
CONTENT OK pane 2
```

---

## Step 7 — LAYOUT Fidelity

Capture xterm snapshot dims for pane 2, compare against rendered body geometry.

### Fetch snapshot dimensions for pane 2

```bash
playwright-cli --raw eval "JSON.stringify((function(){ const s = window.__muxterm.snapshot(2); return { cols: s.cols, rows: s.rows }; })())"
```

### Measure rendered body geometry

```bash
playwright-cli --raw eval "JSON.stringify((function(){ const r = document.body.getBoundingClientRect(); const el = document.querySelector('.xterm-viewport'); const rowEl = document.querySelector('.xterm-rows > div'); const cellEl = rowEl && rowEl.querySelector('span'); const cellWidth = cellEl ? cellEl.getBoundingClientRect().width : 0; const rowHeight = rowEl ? rowEl.getBoundingClientRect().height : 0; return { bodyWidth: r.width, bodyHeight: r.height, cellWidth: cellWidth, rowHeight: rowHeight, expectedCols: cellWidth > 0 ? Math.floor(r.width / cellWidth) : 0, expectedRows: rowHeight > 0 ? Math.floor(r.height / rowHeight) : 0 }; })())"
```

### Assertions

- `cols` from snapshot ≈ `floor(bodyWidth / cellWidth)` (±1 cell tolerance)
- `rows` from snapshot ≈ `floor(bodyHeight / cellHeight)` (±1 cell tolerance)

Record the observed `cols` and `rows` numbers as baseline values for
regression testing.

---

## Acceptance Criteria

| Check | Assertion |
|-------|-----------|
| Content fidelity pane 1 | `CONTENT OK pane 1` from diff assertion |
| Content fidelity pane 2 | `CONTENT OK pane 2` from diff assertion |
| Layout fidelity cols    | snapshot.cols ≈ floor(bodyWidth / cellWidth) |
| Layout fidelity rows    | snapshot.rows ≈ floor(bodyHeight / cellHeight) |
| DOM structure — regions | 2 `mux-region` elements in workspace shadowRoot |
| DOM structure — divider | 1 `mux-region-divider` element in workspace shadowRoot |

---

## Commit

```bash
git add web/e2e/dock-mount.e2e.md && git commit -m "test(phase3): e2e dock mount of 2 surfaces — content + layout fidelity (no OCR)"
```
