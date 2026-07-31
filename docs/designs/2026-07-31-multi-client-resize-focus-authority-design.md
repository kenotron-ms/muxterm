# Multi-Client Resize / Focus-Authority Design

## Goal

Fix garbled terminal restore on reconnect (wrong cursor position, apparent wrong-terminal content) by giving each pane's PTY a single, well-defined authoritative client for sizing purposes, and by re-establishing the client-side saved-cursor register on reconnect.

## Background

Reported symptom: reopening/reconnecting to muxterm often shows a garbled restore — cursor mid-screen, sometimes what looks like the wrong terminal's content.

Two human theories were investigated independently. Both were confirmed to have a real basis in the code, but only one is the primary driver of the reported symptom; the other is a real, narrower gap worth fixing opportunistically.

## Root Cause

**Primary cause — no PTY resize authority.** Each pane has exactly one shared PTY and one shared server-side VT grid emulator (`VTBuffer` wrapping `charmbracelet/x/vt`, in `internal/sessiond/vt.go`). Every attached browser client independently measures its own container and unconditionally pushes `resize(cols, rows)` to the server whenever its local `ResizeObserver` fires (`web/src/lib/terminal-registry.ts`, `web/src/lib/workspace-controller.ts`, `web/src/ws.ts`). The server (`internal/sessiond/server.go`, `TypeResize` case in `conn.handle`) applies whichever resize arrives last — there is no client identity, no priority, no "authoritative client" concept, and no broadcast to inform other clients that the size changed.

A design intent for this was documented but never built: `docs/plans/2026-06-01-session-persistence-design.md` (lines ~287-291) describes "most-recently-active view drives PTY size" — zero code exists for it today.

There is also no reconnect-time resize re-assertion. Reopening a client rides on incidental `ResizeObserver` timing rather than explicitly re-establishing the correct size, so replay is built for whatever size the PTY was left at by a *previous* client, not the reconnecting one.

**Secondary, narrower cause — saved-cursor register not restored on reconnect.** `charmbracelet/x/vt`'s saved-cursor register (DECSC/DECRC) is internal/private — confirmed: `saveCursor`/`restoreCursor` in the vendored library's `csi_mode.go` have no public accessor. This register persists correctly across reconnects on the server side, since the emulator object (one per `Pane`) is never recreated on reconnect, only rebuilt if the pane itself is destroyed. But muxterm's own reconnect replay preamble (`serializeGrid()` in `internal/sessiond/vt.go`) never re-establishes that saved-cursor register on the client's *fresh* xterm.js emulator. If an app issues DECRC after reconnect, the client-side emulator restores to whatever is in its own unset/default saved-cursor slot rather than the value the app expects.

**Ruled out:** No cross-pane ID mixup exists. Pane/workspace keying (`(workspaceID, paneID)`) is consistent end-to-end through the registry and attach path.

## Chosen Approach

Reflow to the focused client's PTY size; non-focused clients letterbox/scroll to fit. This is explicitly **not** a scaled/zoomed rendering approach — it matches the already-documented "active-view-wins" intent and how tmux/screen behave for real terminal programs that need genuine COLS×LINES, not a visually resized viewport.

The focus-authority signal is a **combined model**: both (a) visibility+OS-focus — a pane becoming the visible tab in a client's dockview *and* that browser tab/window having OS focus — and (b) keystroke/input from that client update a per-`(pane, client)` "last active" timestamp. Whichever event happened most recently determines the authoritative client for that pane. This handles both tab-switching within one window and the multi-monitor case (two windows visible simultaneously, only one being typed into).

Reconnect/reopen automatically sends the visibility+focus signal and becomes authoritative with no separate opt-in step — this is what directly fixes the reported bug: reopening immediately resizes to fit the current window and reflows correctly.

**Programmatic/MCP-agent input is explicitly excluded** from the focus-authority signal — only real interactive human browser sessions can claim authority via keystroke or visibility+focus. This prevents an automated agent typing into a background pane from silently stealing PTY-size authority from whatever human client is actually viewing that pane — a real regression path identified during design, given the existing MCP agent-workbench feature (`docs/designs/2026-06-11-muxterm-mcp-agent-workbench-design.md`).

## Architecture

### Focus-Authority State (Server-Side)

Each `Pane` (`internal/sessiond/pane.go`) gains a new small piece of state: an "authoritative viewer" record, `{connID, lastActiveAt}`. This lives on the `Pane` itself (guarded by the existing `p.mu`), not on `conn`, because authority is a per-pane concept — a client can be authoritative for pane A while a different client is authoritative for pane B (e.g. two panes tiled across two different windows).

**What updates it** — two distinct client→server signals bump `lastActiveAt` for `(pane, connID)`:

1. A new `pane-focus` message, sent when a pane becomes visible *and* the browser tab/window has OS focus (visibility API + `document.hasFocus()`), including on initial attach/reconnect.
2. Existing input (keystroke) messages — already flow through input handling into `Pane.Write`; interactive-session connections are flagged (see below) so their input traffic also bumps `lastActiveAt`.

**Excluding MCP/automation:** `conn` (`internal/sessiond/server.go`) gains a `kind` field — `"interactive"` vs `"agent"` — set once at attach time, based on which attach path was used. The MCP/agent attach path already exists as a separate code path (createPane/browser-action machinery) distinct from normal browser `TypeAttach`. Only `interactive` conns' input bumps authority; `agent` conns' input never does, regardless of recency.

**Resize gating:** `TypeResize` is only applied to the PTY (`Pane.Resize`) if the sending conn is the current authoritative conn for that pane (`connID == pane.authority.connID`). Non-authoritative resizes are recorded (for later comparison/logging) but never call `pty.Setsize`/`buf.Resize`.

**On authority change:** when `pane-focus` promotes a new conn to authoritative, the server immediately resizes the PTY+buffer to that conn's reported size, then broadcasts the new canonical size to all other attached conns via a new `TypePaneResized` message.

### Protocol Additions

Two new message types, plus one internal (non-wire) field addition:

1. **`pane-focus`** (client → server): `{ type: "pane-focus", paneId: <int>, cols: <int>, rows: <int> }`. Sent by an interactive client when a pane becomes the visible+OS-focused view. Carries the client's current measured size so the server can resize in the same round-trip rather than waiting for a separate resize message afterward — this is what makes reconnect immediately correct in one step instead of two.

2. **`pane-resized`** (server → client, broadcast): `{ type: "pane-resized", paneId: <int>, cols: <int>, rows: <int> }`. Sent to every attached conn *except* the one that just became authoritative, whenever the canonical PTY size changes. Non-authoritative clients use this to resize their local xterm.js instance to match — without triggering their own `ResizeObserver`-driven resize message back (reentrancy guard).

3. **`conn.kind`** (server-internal, not wire protocol): set once when a connection completes its attach handshake — `"interactive"` for normal browser `TypeAttach`, `"agent"` for the existing MCP/automation attach path. Derived from which attach RPC was used; no new wire field needed.

**Existing `resize` message:** wire format unchanged, but now gated server-side by authority rather than applied unconditionally.

**Existing input frames:** wire format unchanged, but the server checks `conn.kind == "interactive"` before treating input as an authority-bumping event. Byte delivery to the PTY is unaffected either way — agents can still type, they just don't get authority from it.

No changes to `TypeComposition`, `TypeAttach`, or the replay framing — reconnect still gets composition + replay exactly as today; this design only adds the focus-authority layer on top.

### Client-Side Changes

**Sending `pane-focus`:** a new coordinator (in `workspace-controller.ts` or a small sibling module) listens for:

- Dockview `onDidActivePanelChange` (pane becomes the visible tab within this client) — matches existing intra-client "active-view-wins" logic already in `terminal-registry.ts`.
- `visibilitychange` + `window.onfocus` (browser tab/window regains OS focus) — currently entirely absent from the codebase; this is new.
- On initial attach/reconnect, for every pane that is currently visible in this client's layout.

Whenever any of these fire, for each currently-visible pane the client measures its own current size and sends `pane-focus{paneId, cols, rows}`.

**Handling `pane-resized` (broadcast) as a non-authoritative client:** the client resizes its local xterm.js `Terminal` instance to the broadcast cols/rows via `term.resize()` — but must not let this trigger `fitAddon.fit()` or emit a resize message back. Reentrancy guard: an `applyingServerResize` flag suppresses the next `ResizeObserver`-driven fit cycle for that pane, mirroring the existing `lastCols`/`lastRows` idempotency check in `terminal-registry.ts`.

**Letterbox/scroll rendering:** the pane's host container gets `overflow: auto`, and the xterm.js viewport element keeps its natural pixel size for cols × rows at the container's font metrics. If the container is smaller than that natural size, native scrollbars let the user scroll/pan across the full grid; if larger, the grid sits anchored top-left with empty space around it. No scaling, no zoom.

**Keystroke-triggered authority reclaim:** normal terminal input already flows through the existing input path — no new client-side wiring needed beyond ensuring interactive (non-MCP) WebSocket connections are the ones whose input reaches the server's authority-bumping check.

### DECSC/DECRC Shadow Tracker (Opportunistic Fix)

Since `charmbracelet/x/vt`'s saved-cursor register is private, add a small shadow-tracker inside `VTBuffer` (`internal/sessiond/vt.go`), similar in spirit to `TrackedBuffer`'s existing `modeTracker` pattern (`internal/sessiond/tracked.go`) but much narrower in scope:

- `VTBuffer.Write()` additionally scans the incoming byte stream (using `charmbracelet/x/ansi`'s parser, already a dependency) for `ESC 7` (DECSC), `CSI s` (SCOSC), `ESC 8` (DECRC), and `CSI u` (SCORC).
- On a save sequence, record `savedCursor = (row, col)` and `savedCursorValid = true` at that moment, reading current position via the existing `CursorPos()`.
- On a restore sequence, no server-side action is needed — `x/vt` handles its own internal restore correctly for the live session. This tracking exists solely to inform replay.
- `serializeGrid()` gains one addition: if `savedCursorValid`, emit `ESC[<row>;<col>H` + `ESC 7` immediately after positioning to the live cursor (before the final absolute CUP restore). This re-establishes the client's fresh xterm.js saved-cursor register to match the server's, so a subsequent DECRC after reconnect restores to the correct place.

This is additive and low-risk: it doesn't touch resize-authority logic, and if tracking is ever wrong (e.g. an uncaught sequence variant), the failure mode is identical to today's gap — no regression, only improvement.

## Data Flow

### Reconnect Flow

Reconnect already works this way today: `Client.Attach()` → daemon `attachConn()` → composition + replay frames → conn goes live. This design adds one step immediately after a reconnecting client's UI has rendered its layout:

1. Client determines which panes are currently visible in its restored layout (from its own local layout state).
2. For each, it measures its actual current viewport size and sends `pane-focus{paneId, cols, rows}` — exactly the same message as a normal focus/visibility event; no special "reconnect" branch is needed client-side.
3. Server processes each `pane-focus` per the focus-authority architecture above: promotes this conn to authoritative for that pane, resizes PTY+buffer to the given size, and broadcasts `pane-resized` to any other attached conns.
4. Only after this resize does subsequent live PTY output (including the SIGWINCH-triggered prompt redraw from `Pane.Resize`) flow to the now-correctly-sized client normally.

**Known accepted trade-off:** the very first replay frame might briefly reflect the pre-resize size for a moment before the resize completes and the shell redraws — a small, acceptable flash rather than the current bug (a permanently wrong size/cursor). This is a real improvement, not full elimination of any transient.

**Alternative considered and rejected:** delaying the replay send until after `pane-focus` arrives, to avoid any flash. Rejected because it would require restructuring the frozen attach ordering (`attachConn`'s documented invariant: composition+replay always sent immediately on attach) for a cosmetic one-frame improvement — not worth the invariant-breaking risk for this bug.

### Normal Focus-Switch Flow

1. User switches tabs within a dockview, or moves OS focus to a different browser window showing a different pane.
2. Client's coordinator detects the change (`onDidActivePanelChange`, `visibilitychange`, or `window.onfocus`) and sends `pane-focus{paneId, cols, rows}` for the newly-focused pane(s).
3. Server bumps `lastActiveAt` for `(pane, connID)`, promotes this conn to authoritative if it wasn't already, resizes PTY+buffer if size changed, and broadcasts `pane-resized` to other conns.
4. Previously-authoritative client(s) receive `pane-resized` and letterbox/scroll their local xterm.js instance to the new canonical size without re-emitting a resize message.

### Keystroke Reclaim Flow

1. A non-authoritative interactive client's user types into a pane it can see (but that another client is currently authoritative for).
2. Input flows through the existing input path into `Pane.Write` as it does today.
3. Because `conn.kind == "interactive"`, this input also bumps `lastActiveAt` for `(pane, connID)`, making this conn authoritative if its timestamp is now the most recent.
4. Any subsequent resize from this conn is applied normally; other conns receive `pane-resized` if size changes.

## Error Handling

- **Solo client (no other viewers):** degenerate case — that client is trivially authoritative for every pane it's ever focused. No behavior change from today except reconnect now explicitly re-asserts size instead of relying on incidental timing.
- **Authoritative client disconnects:** `conn.cleanup()` (existing) already calls `unsubscribeLocked`. This design adds: clear `pane.authority` for any pane where this was the authoritative conn, so the next `pane-focus` or resize from any remaining client can claim it. No stale authority pointing at a dead conn should ever block a legitimate resize.
- **No `pane-focus` ever sent** (older/non-updated client, or a bug): falls back to today's behavior for that conn — its plain resize messages are simply ignored once another conn holds authority. Worst case is identical to today's bug for that one client, never worse.
- **Two interactive clients racing `pane-focus` near-simultaneously:** server-side `pane.mu` serializes processing; the last one processed under the lock wins, consistent with "most-recently-active."
- **Agent (`kind == "agent"`) conn is the only attached conn** (no human viewer): agent input never claims authority, but resize should still work somehow, since there is no human competing for it. Defensive fallback: allow an agent-attached pane with zero interactive conns to have its resize messages (if any) applied directly, since there is no authority to violate. This is a defensive fallback, not an active path today — MCP screen-snapshot flows don't currently resize panes.

## Verification Strategy

Per this project's testing policy (`AGENTS.md`), no unit tests. Verification is real execution only, using `make dev-local` (127.0.0.1:8313) and playwright-cli / simulated multiple clients. **Never touch port 8311** or its sessiond/socket/log files.

Required scenarios:

1. **Multiple terminal sizes** — at least 3 distinct simulated viewport sizes (e.g. 220x50, 90x30, 60x20) attached to the same pane at different times, confirming PTY/buffer reflows correctly for each as authority changes.
2. **Real multi-client, focus-switching** — 2+ simulated/real browser clients attached to the same pane simultaneously, at different sizes; switch focus (visibility+OS focus, then keystroke) between them and confirm: (a) PTY resizes to match whichever client is authoritative, (b) the non-authoritative client visibly letterboxes/scrolls rather than reflowing, (c) `pane-resized` broadcasts correctly update it.
3. **Reconnect correctness** — disconnect a client, resize the other, reconnect the first at a third size, confirm cursor position and buffer content are correct for the reconnecting client's actual viewport, not stale.
4. **DECSC/DECRC round-trip** — run a program that issues `ESC 7`, moves the cursor, disconnects/reconnects, then issues `ESC 8` — confirm the cursor lands at the originally-saved position, not a default/wrong one.
5. **MCP-agent exclusion** — with an agent connection actively sending input to a pane, confirm a human client's focus/resize is never overridden by the agent's activity.

Each scenario must be observed working via playwright-cli (or the muxterm-verify skill) in a real browser against a real sessiond process before this work is considered done — no scenario is satisfied by code inspection alone.

## Open Questions

None. This design has been fully validated and approved.
