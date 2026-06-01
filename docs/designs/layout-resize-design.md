# Layout & Resize Design

## Reference: How iTerm2 Does It

Studied from iTerm2 source (`sources/tmux/TmuxController.m`, `TmuxGateway.m`, `TmuxLayoutParser.m`).

### The Two Resize Paths

iTerm2 has exactly two ways to tell tmux about sizing:

**Path A — pane divider drag** (`windowPane:resizedBy:horizontally:`)
Sends a relative resize using direction flags:
```
resize-pane -R -t "%3" 5   // drag right by 5 cells
resize-pane -L -t "%3" 3   // drag left by 3 cells
resize-pane -D -t "%3" 2   // drag down by 2 cells
resize-pane -U -t "%3" 1   // drag up by 1 cell
```
This only adjusts the relationship between adjacent panes. The total session size does not change.

**Path B — client/window viewport resize** (`setClientSize:` / `commandListToSetWindowSizes:`)
Sends the full viewport dimensions to tmux:
```
refresh-client -C @1:220x50    // tmux >= 3.4, per-window
refresh-client -C 220x50       // legacy, all windows
resize-window -x 220 -y 50 -t @1  // fallback
```
This is what sets the total session size. Called when the iTerm2 window resizes (ResizeObserver on the tab body).

**These two paths are completely separate and never mixed.**

### The Round-Trip Loop for Pane Drag

```
User drags divider N cells
  ↓
iTerm2: ++numOutstandingWindowResizes_
iTerm2: send [resize-pane -<dir> -t "%<paneId>" <N>, list-windows]  ← atomic pair
  ↓
tmux processes resize-pane
tmux broadcasts: %layout-change @<win> <layout> <visibleLayout> <flags>  ← async
tmux sends: list-windows response                                          ← sequential
  ↓
iTerm2 receives %layout-change (arrives first):
  → TmuxGateway.parseLayoutChangeCommand: extracts window-id + layout string
  → delegate: tmuxUpdateLayoutForWindow:only:YES
  → TmuxController → TmuxWindowOpener → TmuxLayoutParser
  → UI rebuilt from new layout tree (dividers repositioned)

iTerm2 receives list-windows response:
  → parseListWindowsResponseAndUpdateLayouts:
  → tmuxUpdateLayoutForWindow:only:NO (bulk reconcile)
  → adjustWindowSizeIfNeededForTabs:
      → checks numOutstandingWindowResizes_ > 0 → SKIP fitLayoutToWindows
      → --numOutstandingWindowResizes_
```

The `numOutstandingWindowResizes_` counter is the feedback loop guard. Without it:
`layout-change` → `fitLayoutToWindows` → `resize-pane` → `layout-change` → oscillates.

### The Layout String Format

tmux sends the layout in `%layout-change` and `list-windows` responses:

```
Grammar:
  layout    := WxH,X,Y,<checksum>   (leaf pane)
             | WxH,X,Y{L,L,...}     (horizontal split — side by side, curly braces)
             | WxH,X,Y[L,L,...]     (vertical split   — stacked,       square brackets)

Example (2 panes, horizontal split):
  bc62,220x50,0,0{110x50,0,0,%1,109x50,111,0,%2}
        │          │               │
        checksum   left pane       right pane
                   110 cols wide   109 cols wide (1 col goes to the divider)

Example (3 panes — left + right split top/bottom):
  bc62,220x50,0,0{110x50,0,0,%1,109x50,111,0[109x25,111,0,%2,109x24,111,26,%3]}
```

Each pane entry: `WxH,X,Y,%pane_id`
- W, H = width and height in cells
- X, Y = top-left offset from session origin (not from parent)
- %pane_id = tmux pane id (integer with % prefix in the string, bare integer in practice)

The checksum at the start is a tmux-internal 4-hex-char hash of the layout. Clients can ignore it.

### Splitting a Pane

The split command (`split-window`) cannot return the new pane ID directly in control mode.
iTerm2 works around this with a bracket pattern:

```
list-panes -t %<wp> -F '#{pane_id}'   ← record before
split-window [flags]
list-panes -t %<wp> -F '#{pane_id}'   ← record after — diff gives new pane id
```

The visual update comes from the `%layout-change` broadcast, not from the split response.
Comment in source: "No need for a callback. We should get a layout-changed message and act on it."

---

## How Muxterm Should Work

### The Core Principle

**Never send pane dimensions to `refresh-client -C`.** That command sets the entire session size.
Only the full-viewport dimensions should go to `refresh-client -C`.

### Path A — Pane Divider Drag (relative resize)

On drag-end, send the delta in cells, not absolute sizes:

```typescript
// drag-end: compute delta from drag snapshot
const deltaCols = newLeftCols - snapshot.leftCols;  // positive = dragged right
const deltaRows = newTopRows - snapshot.topRows;     // positive = dragged down

// pick direction
const dir = isHorizontal
  ? (deltaCols > 0 ? 'R' : 'L')
  : (deltaRows > 0 ? 'D' : 'U');
const amount = Math.abs(isHorizontal ? deltaCols : deltaRows);

ws.send({ type: 'resize-pane', paneId, dir, amount });
// server: `resize-pane -<dir> -t "%<paneId>" <amount>`
```

The server sends this command verbatim to tmux. No `RefreshClientSize` call.

Paired with a `list-windows` (or rely solely on `%layout-change`) to confirm the new layout.

### Path B — Viewport Resize (full client size)

`CellBudgetManager` already observes `region.bodyElement` and computes full-viewport
cols/rows. This is correct. What is broken is the delivery path:

```typescript
// workspace.ts emits:
ws.send({ type: 'resize-surface', surfaceId, cols, rows });
// server: `refresh-client -C <cols>x<rows>`
```

The server needs to call `refresh-client -C <cols>x<rows>` (full viewport).
This is the ONLY place `RefreshClientSize` should be called.

### The Feedback Loop Guard

After any pane drag:
1. Increment an outstanding-resize counter
2. While counter > 0, ignore `%layout-change`-triggered fitToViewport calls
3. Decrement counter when the `list-windows` round-trip completes (or `%layout-change` arrives)

Without this: drag → layout-change → fitToViewport → resize-pane → layout-change → loop.

### Layout String to CSS

The tmux layout string maps to CSS flex:

```
{L, R}  →  flex-direction: row   (horizontal split)
[T, B]  →  flex-direction: column  (vertical split)
leaf    →  flex: <paneSize>/<parentSize>
```

For a layout `220x50,0,0{110x50,0,0,%1,109x50,111,0,%2}`:
- Container: `flex-direction: row`
- Left child:  `flex: 110 / 219`  (110 of 219 total pane-allocated cols)
- Right child: `flex: 109 / 219`

The divider consumes 1 column — so parent width (220) - number-of-dividers (1) = 219 usable.

---

## Current Bugs

### Bug 1: `resize-surface` path is dead — `SurfaceRouter.Mount()` never called

`SurfaceRouter.Resize()` in `surface.go` looks up a registered client by `surfaceId`.
`SurfaceRouter.Mount()` registers that client. `Mount()` is **never called in `main.go`**.

Every `resize-surface` message from the browser returns:
```
"SurfaceRouter.Resize: no client for surface \"surf-1\""
```
The browser's `normalizeMessage` returns `null` and drops it silently.
tmux never receives `refresh-client -C`. The session never fits the viewport.

**Fix**: Wire `SurfaceRouter.Mount(surfaceId, windowId, controlClient)` in `main.go`
when each tmux session is started. Or simpler: route `resize-surface` directly to
`controlClient.RefreshClientSize(cols, rows)` without the SurfaceRouter indirection.

### Bug 2: Drag-end sends pane dimensions to `RefreshClientSize`

`app.ts._onPaneResizeRequest` sends `leftPaneId, leftWidth, leftHeight` to the server.
`main.go controllerAdapter.ResizePane` ignores `paneId` and calls:
```go
c.Commands().RefreshClientSize(cols, rows)  // cols = left pane width only!
```

For a 220-col window split 110/109:
1. Drag fires → `RefreshClientSize(110, 50)` → session shrinks to 110 cols
2. `%layout-change` arrives → each pane now ~54 cols
3. xterm.js FitAddon fires → `resize-pane(54, 50)` → `RefreshClientSize(54, 50)`
4. Session shrinks to 54 cols → oscillates toward minimum

**Fix**: The drag path should send a relative `resize-pane -<dir> -t "%id" <amount>` command,
not a `RefreshClientSize`. `ResizePane` on the server should call
`c.Commands().ResizePane(paneId, dir, amount)` (relative), never `RefreshClientSize`.

### Bug 3: Cell metrics are hardcoded

`workspace.ts._cellMetricsFor()` returns `{ cellWidth: 8, cellHeight: 16 }` regardless
of the actual terminal font. On Retina displays or with non-default fonts this gives wrong
col/row counts, so even a working `refresh-client -C` would send incorrect dimensions.

**Fix**: Read cell dimensions from the attached xterm.js instance via `terminalRegistry`.
xterm.js exposes `terminal.charMeasure` or can be measured via the DOM after attach.
