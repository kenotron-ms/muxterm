# MCP Agent Workbench — Phase 2: Server & Client Foundations Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add the Go (sessiond) and TypeScript (browser client) protocol foundations the Phase 4 MCP server will build on — additive message types, OSC 133 command-done detection, on-demand VT screen snapshots, an ASCII layout generator, and the daemon-side relay plumbing for `browser-action` and `layout-command` events.

**Architecture:** Phase 1 (the SW bridge POC) is complete and validated. Phase 2 does NOT touch the MCP server itself (that is Phase 4). It only widens the existing frozen WS protocol — additively — and wires the daemon-broadcast and browser-client routing halves so later phases have working plumbing to call into. Each new message type follows the existing pattern in `internal/sessiond/protocol.go`; each new daemon handler follows the existing `conn.handle()` switch; each TypeScript handler follows the existing `onSessiondMessage` dispatch.

**Tech Stack:** Go 1.22+ (sessiond daemon, `charmbracelet/x/vt` cell-grid emulator), TypeScript + Lit 3 + dockview (browser client). Build gates: `go build ./... && go test ./internal/sessiond/...` and `cd web && npm run check:fast`.

---

## READ THIS FIRST — Orientation for the implementer

You know nothing about this codebase. That is fine. Here is everything you need.

### What Phase 2 is (and is NOT)

Phase 2 is **foundation plumbing**. It adds new wire message types and the handlers that move them around, but it does **not** build the MCP server, the Playwright-shaped browser tools, or the real dockview layout mutations. Those are Phase 3/4. Several tasks here deliberately implement only "half" of a flow (the daemon broadcast, or a TypeScript stub that logs and emits an event) — that is intentional and called out per task. Do not try to build more than the task says; you will collide with later phases.

### The protocol is FROZEN — additive only

`internal/sessiond/protocol.go` defines every wire message type as a Go string constant, grouped into **Requests**, **Replies**, and **Events**, and a single `Message` struct carrying every field. The header comments say these values are FROZEN per the v1 wire contract. "Frozen" means: **never change or remove an existing constant, JSON tag, or field**. You may only **add** new constants (in the correct group) and new `omitempty` fields. Every task in this plan is additive. If you ever feel the urge to edit an existing constant or retag an existing field, stop — you are doing it wrong.

### The five files you will touch on the Go side

- `internal/sessiond/protocol.go` — the frozen constants block (line ~23) and the `Message` struct (line ~132). Task 1 adds to both.
- `internal/sessiond/pane.go` — wraps one PTY-backed process. The `Pane` struct (line ~15) has `onData`/`onExit` callbacks; `readLoop()` (line ~121) pumps PTY bytes into the buffer. Task 2 adds OSC 133 detection here.
- `internal/sessiond/vt.go` — `VTBuffer` wraps a `charmbracelet/x/vt` `SafeEmulator` cell grid. Task 3 adds plain-text screen extraction here.
- `internal/sessiond/server.go` — the daemon. `conn.handle()` (line ~279) is the request dispatch switch; `broadcast()`/`broadcastAll()` (line ~181) fan out events; `createPane()` (line ~349) wires pane callbacks. Tasks 2–6 add cases and wiring here.
- `internal/sessiond/client.go` — the **serve-side** client (the muxterm HTTP server's handle to sessiond). The `Handlers` struct (line ~43) holds event callbacks; `dispatchEvent()` (line ~352) routes daemon events to them. Tasks 4–5 extend both.
- `internal/sessiond/layout.go` — **new file** created in Task 6.

### The three files you will touch on the TypeScript side

- `web/src/ws.ts` — the `MuxSocket` WebSocket wrapper. Incoming text frames with a top-level `type` go to `onSessiondMessage` (line ~196–217). Tasks 7–8 dispatch new `window` CustomEvents here.
- `web/src/app.ts` — the top-level `<mux-app>` Lit element (shadow root). It owns the socket (`this._socket`), has a `private get _dock()` getter (line ~741) returning the `<mux-dock>` element, and registers event listeners in `connectedCallback` (~line 306). Tasks 7–8 add listeners here.
- `web/src/components/mux-dock.ts` — the `<mux-dock>` Lit element wrapping dockview. `BrowserRenderer` (line ~106) bridges a dockview panel to a `<mux-browser-surface>` element holding the iframe. Tasks 7–8 add relay methods here.

### How the daemon flows fit together (the mental model)

```
                       (Phase 4 MCP server, NOT built here)
                                    │  browser-action / layout-command request
                                    ▼
   serve client (client.go) ──► sessiond conn.handle() (server.go)
                                    │  broadcast to ALL workspace subscribers
                                    ▼
   every attached subscriber's subscriber queue (includes browser WS clients)
                                    │  daemon event (cid=0)
                                    ▼
   serve client.go dispatchEvent() ──► Handlers.OnBrowserAction / OnLayoutCommand
                                    │  (Phase 4 forwards to the browser WS)
                                    ▼
   browser ws.ts onSessiondMessage ──► window CustomEvent ──► app.ts ──► mux-dock.ts
                                    │  postMessage to iframe shim (Task 7)
                                    ▼
                            SW bridge (Phase 1 POC)
```

Phase 2 builds: the daemon `case` that broadcasts (Tasks 4–5), the `Handlers` fields + `dispatchEvent` cases (Tasks 4–5), and the browser-side `ws.ts → app.ts → mux-dock.ts` routing (Tasks 7–8). It does **not** build the Phase 4 MCP server that originates or consumes these.

### TDD discipline

- **Go tasks (1–6):** write the failing test first, run it red, implement, run it green, commit. Pure functions (`scanOSC133`, `ScreenText`, `ASCIILayout`) are unit-tested directly. Handler broadcast behavior is tested via the existing daemon test patterns.
- **TypeScript tasks (7–8):** `cd web && npm run check:fast` (oxlint + tsgo) is the gate. These tasks are routing/plumbing only; there is no runtime E2E in Phase 2. Write the code, make `check:fast` pass, commit.

### Commands you will run (memorize these)

- Go build + test gate: `go build ./... && go test ./internal/sessiond/...`
- Run a single Go test: `go test ./internal/sessiond/ -run TestScanOSC133 -v`
- TypeScript gate: `cd web && npm run check:fast`

### Commit style

Conventional commits: `feat:`, `test:`, `fix:`, `chore:`. **One commit per task** (test + implementation together is fine for the Go tasks, or commit the test separately if you prefer — but each task ends with exactly one logical commit of working, green code).

---

## Task 1: Add the frozen protocol constants, Message fields, and CursorPos struct

**Files:**
- Modify: `internal/sessiond/protocol.go` (constants block line ~23–53; `Message` struct line ~132–155)

This task is pure declaration — no behavior, so no test of its own. Its correctness is proven by `go build ./...` and by every later task that uses these symbols. Add the constants in the **correct group** (requests, events, replies) to honor the frozen-protocol grouping convention.

**Step 1: Add the new type constants.**

In `internal/sessiond/protocol.go`, the `const (...)` block at line ~23 already has three labeled groups. Add the new constants to the matching group. Find the `// Requests (client -> daemon).` group (ends at the `TypePaneUpdate` line ~35) and add, just after `TypePaneUpdate`:

```go
	TypeScreenSnapshot = "screen-snapshot" // request: MCP → daemon, VT grid for a pane
	TypeGetLayout      = "get-layout"       // request: MCP → daemon, ASCII layout diagram
```

Find the `// Replies (daemon -> client, echo request cid).` group (ends at `TypeOK` line ~42) and add, just after `TypeOK`:

```go
	TypeScreenSnapshotResult = "screen-snapshot-result"
	TypeLayoutResult         = "layout-result"
```

Find the `// Events (daemon -> all subscribers, cid=0).` group (ends at `TypePaneRenamed` line ~49) and add, just after `TypePaneRenamed`:

```go
	TypeBrowserAction = "browser-action" // event: relay browser DOM command to/from SW bridge
	TypeLayoutCommand = "layout-command" // event: relay layout mutation to browser clients
	TypeShellPrompt   = "shell-prompt"   // event: OSC 133 prompt/command lifecycle
```

**Step 2: Add the new fields to the `Message` struct.**

The `Message` struct is at line ~132. Find the closing of its browser-pane field block (the `ProxyHeaders map[string]string` line ~154, just before the struct's closing `}`). Add these fields immediately after `ProxyHeaders`:

```go

	// MCP relay fields (Phase 2+). All additive and omitempty; absent on every
	// existing message type, so the frozen wire format is unchanged.
	Action     string     `json:"action,omitempty"`   // browser-action command verb (click/fill/...)
	Ref        string     `json:"ref,omitempty"`       // element ref (e1, e2...) from a snapshot
	Selector   string     `json:"selector,omitempty"`  // CSS selector
	Value      string     `json:"value,omitempty"`     // input value for fill/type
	Key        string     `json:"key,omitempty"`       // keyboard key for press
	Expression string     `json:"expr,omitempty"`      // JS expression for eval
	Text       string     `json:"text,omitempty"`      // plain-text result (screen snapshot, eval)
	ExitCode   int        `json:"exitCode,omitempty"`  // OSC 133 command exit code
	Cursor     *CursorPos `json:"cursor,omitempty"`    // cursor {row, col} for screen snapshot
	ASCII      string     `json:"ascii,omitempty"`     // ASCII layout diagram (get-layout result)
```

**Step 3: Add the `CursorPos` struct.**

Add this struct directly after the `Message` struct's closing `}` (before the `WorkspaceInfo` struct at line ~157):

```go

// CursorPos is a 0-indexed terminal cursor position, carried by a
// screen-snapshot-result so an agent knows where the cursor sits in the grid.
type CursorPos struct {
	Row int `json:"row"`
	Col int `json:"col"`
}
```

**Step 4: Verify the build.**

Run: `go build ./...`
Expected: builds with no errors. (No tests yet — these are pure declarations.)

**Step 5: Commit.**
```
git add internal/sessiond/protocol.go && git commit -m "feat: add MCP relay protocol constants and Message fields"
```

---

## Task 2: OSC 133 command-done detection in the pane read loop

**Files:**
- Create test: `internal/sessiond/pane_osc133_test.go`
- Modify: `internal/sessiond/pane.go` (`Pane` struct line ~15; `readLoop()` line ~121)
- Modify: `internal/sessiond/server.go` (`createPane()` line ~381)

**Background you need:** OSC 133 is the shell-integration escape sequence standard used by VS Code, iTerm2, and Warp. The sequence is `\x1b]133;{letter}[;{data}]{terminator}` where the terminator is either BEL (`\x07`) or ST (`\x1b\\`). The marker we care about is **`D`** ("command done"), optionally carrying `;{exitcode}`. When we see it, the command the user ran has finished; the MCP `run_command` tool (Phase 4) waits on the resulting `shell-prompt` event.

**Step 1: Write the failing test for `scanOSC133`.**

Create `internal/sessiond/pane_osc133_test.go`:

```go
package sessiond

import "testing"

func TestScanOSC133(t *testing.T) {
	const esc = "\x1b"
	const bel = "\x07"
	const st = "\x1b\\"

	tests := []struct {
		name      string
		data      string
		wantCode  int
		wantFound bool
	}{
		{"bel terminator no code", esc + "]133;D" + bel, 0, true},
		{"st terminator no code", esc + "]133;D" + st, 0, true},
		{"bel exit code 0", esc + "]133;D;0" + bel, 0, true},
		{"bel exit code 1", esc + "]133;D;1" + bel, 1, true},
		{"bel exit code 127", esc + "]133;D;127" + bel, 127, true},
		{"st exit code 2", esc + "]133;D;2" + st, 2, true},
		{"mid-buffer sequence", "output\r\n" + esc + "]133;D;1" + bel + "next", 1, true},
		{"no osc 133 at all", "just regular terminal output\r\n", 0, false},
		{"other osc 133 marker (A)", esc + "]133;A" + bel, 0, false},
		{"partial sequence at end (no terminator)", "data" + esc + "]133;D;1", 0, false},
		{"empty", "", 0, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			code, found := scanOSC133([]byte(tt.data))
			if found != tt.wantFound {
				t.Fatalf("found = %v, want %v", found, tt.wantFound)
			}
			if found && code != tt.wantCode {
				t.Errorf("code = %d, want %d", code, tt.wantCode)
			}
		})
	}
}
```

**Step 2: Run the test to confirm it fails (RED).**

Run: `go test ./internal/sessiond/ -run TestScanOSC133 -v`
Expected: compile failure — `undefined: scanOSC133`. That is the correct RED state.

**Step 3: Implement `scanOSC133`.**

Add this function to `internal/sessiond/pane.go` (place it just above `readLoop`, around line 119). Add `"bytes"` and `"strconv"` to the file's `import` block:

```go
// scanOSC133 scans data for an OSC 133 "command done" sequence,
// \x1b]133;D[;{exitcode}]{BEL|ST}, and returns the exit code (0 when no
// ;{code} suffix is present) and whether such a complete sequence was found.
// A partial sequence with no terminator in this buffer is NOT a match (the
// terminator may arrive in a later read; we do not buffer across reads — a
// missed split sequence simply yields no event, which is acceptable for the
// run_command completion signal that also has a timeout fallback).
func scanOSC133(data []byte) (exitCode int, found bool) {
	const prefix = "\x1b]133;D"
	idx := bytes.Index(data, []byte(prefix))
	if idx < 0 {
		return 0, false
	}
	rest := data[idx+len(prefix):]

	// Locate the terminator: BEL (\x07) or ST (\x1b\\).
	belAt := bytes.IndexByte(rest, '\x07')
	stAt := bytes.Index(rest, []byte("\x1b\\"))
	end := -1
	switch {
	case belAt >= 0 && (stAt < 0 || belAt < stAt):
		end = belAt
	case stAt >= 0:
		end = stAt
	default:
		return 0, false // no terminator in this buffer: not a complete sequence
	}

	// params is everything between the prefix and the terminator. With no exit
	// code it is empty; with one it is ";{code}".
	params := rest[:end]
	if len(params) == 0 {
		return 0, true
	}
	if params[0] != ';' {
		// e.g. "Done" — a marker that merely starts with D is not our sequence.
		return 0, false
	}
	code, err := strconv.Atoi(string(params[1:]))
	if err != nil {
		return 0, true // malformed code: treat as done with code 0
	}
	return code, true
}
```

> Note the `"other osc 133 marker (A)"` test case passes because `\x1b]133;A` does not contain the literal `\x1b]133;D` prefix, so `bytes.Index` returns -1.

**Step 4: Run the test to confirm it passes (GREEN).**

Run: `go test ./internal/sessiond/ -run TestScanOSC133 -v`
Expected: PASS (all sub-tests).

**Step 5: Add the `onPrompt` callback field to the `Pane` struct.**

In `internal/sessiond/pane.go`, find the callback fields in the `Pane` struct (line ~36–37):

```go
	onData func(localID int, data []byte)
	onExit func(localID int)
```

Add a third callback directly after `onExit`:

```go
	onData   func(localID int, data []byte)
	onExit   func(localID int)
	onPrompt func(localID int, msg *Message)
```

**Step 6: Hook OSC 133 detection into `readLoop`.**

In `readLoop()` (line ~121), find the block that writes to the buffer:

```go
			data := chunk[:n]
			_, _ = p.buf.Write(data)
```

Insert the OSC 133 scan **between** those two lines, so it runs before the buffer write:

```go
			data := chunk[:n]
			if code, prompted := scanOSC133(data); prompted && p.onPrompt != nil {
				p.onPrompt(p.LocalID, &Message{Type: TypeShellPrompt, ExitCode: code})
			}
			_, _ = p.buf.Write(data)
```

**Step 7: Wire the callback in `server.go createPane()`.**

In `internal/sessiond/server.go`, find `createPane()` where the terminal pane is constructed via `NewPane(...)` (line ~381–388). The pane `p` is assigned at line ~381 and inserted via `c.srv.reg.PutPane(wsID, p)` at line ~393. Insert the `onPrompt` wiring **after** `PutPane` succeeds and before the `c.reply(...)` at line ~394:

```go
	c.srv.reg.PutPane(wsID, p)
	p.onPrompt = func(id int, msg *Message) {
		msg.WorkspaceID = wsID
		msg.PaneID = id
		c.srv.broadcast(wsID, msg)
	}
	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
```

> `onPrompt` is set after construction (not passed to `NewPane`) so the existing frozen `NewPane` signature is unchanged. There is a tiny window between `go p.readLoop()` starting inside `NewPane` and this assignment; that is harmless because `readLoop` guards with `p.onPrompt != nil`, and no OSC 133 sequence can arrive before the shell has even drawn its first prompt.

**Step 8: Run the full Go gate.**

Run: `go build ./... && go test ./internal/sessiond/...`
Expected: builds clean; all tests (including `TestScanOSC133`) pass.

**Step 9: Commit.**
```
git add internal/sessiond/pane.go internal/sessiond/pane_osc133_test.go internal/sessiond/server.go && git commit -m "feat: detect OSC 133 command-done and emit shell-prompt event"
```

---

## Task 3: screen-snapshot handler + VTBuffer text extraction

**Files:**
- Create test: `internal/sessiond/vt_screen_test.go`
- Modify: `internal/sessiond/vt.go` (add `ScreenText` and `CursorPos` methods)
- Modify: `internal/sessiond/server.go` (`conn.handle()` switch line ~279)

**Background you need:** `VTBuffer` (in `vt.go`) wraps a `charmbracelet/x/vt` `SafeEmulator`. The existing `serializeGrid` function (line ~113) shows the available API: `emu.Render()` returns the styled screen with rows separated by `\n`, `emu.CursorPosition()` returns a `uv.Position` (an `image.Point` with 0-based `X`/`Y`). The buffer's own `b.mu` RWMutex must guard multi-step reads. `VTBuffer.emu` is a `*vt.SafeEmulator`; `b.emu.Emulator` is the raw `*vt.Emulator` used while holding `b.mu`.

**Note on the buffer type:** terminal panes are currently created with `NewRawBuffer(0)` (server.go line ~385), NOT `NewVTBuffer`. `RawBuffer` does not have a cell grid. The `PaneBuffer` interface therefore needs the new methods too, OR `screen-snapshot` must type-assert for a `*VTBuffer`. **Use the type-assert approach** — it keeps the change minimal and additive, and Phase 4 can switch terminal panes to `NewVTBuffer` when `get_screen` becomes a real tool. Confirm the buffer interface and `RawBuffer` by reading `internal/sessiond/buffer.go` (or whichever file defines `PaneBuffer` and `NewRawBuffer`) before writing the handler.

**Step 1: Confirm the `vt` API and buffer types.**

Run:
```
go doc github.com/charmbracelet/x/vt.Emulator | grep -iE "Render|CursorPosition|Width|Height" 
grep -rn "func NewRawBuffer\|type PaneBuffer\|func (b \*VTBuffer)" internal/sessiond/
```
Read whatever defines `PaneBuffer` to see if it is an interface (it is — `Pane.buf` is typed `PaneBuffer`). This confirms the type-assert plan for the handler.

**Step 2: Write the failing test for `ScreenText` and `CursorPos`.**

Create `internal/sessiond/vt_screen_test.go`:

```go
package sessiond

import (
	"strings"
	"testing"
)

func TestVTBufferScreenText(t *testing.T) {
	b := NewVTBuffer(20, 5)
	// Write two visible lines of plain text. \r\n positions the cursor at the
	// start of the next row each time.
	if _, err := b.Write([]byte("hello\r\nworld\r\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	text := b.ScreenText()
	lines := strings.Split(text, "\n")
	if len(lines) < 2 {
		t.Fatalf("expected at least 2 lines, got %d: %q", len(lines), text)
	}
	if strings.TrimRight(lines[0], " ") != "hello" {
		t.Errorf("line 0 = %q, want %q", lines[0], "hello")
	}
	if strings.TrimRight(lines[1], " ") != "world" {
		t.Errorf("line 1 = %q, want %q", lines[1], "world")
	}
	// Trailing blank rows must be trimmed: a 5-row grid with 2 used rows must
	// not return 5 lines.
	if strings.HasSuffix(text, "\n\n") {
		t.Errorf("trailing blank lines were not trimmed: %q", text)
	}
	// ScreenText must be ANSI-stripped: no ESC bytes.
	if strings.ContainsRune(text, '\x1b') {
		t.Errorf("ScreenText contains raw ANSI escapes: %q", text)
	}
}

func TestVTBufferCursorPos(t *testing.T) {
	b := NewVTBuffer(20, 5)
	// "abc" leaves the cursor on row 0 at column 3.
	if _, err := b.Write([]byte("abc")); err != nil {
		t.Fatalf("write: %v", err)
	}
	row, col := b.CursorPos()
	if row != 0 || col != 3 {
		t.Errorf("cursor = (%d,%d), want (0,3)", row, col)
	}
}
```

**Step 3: Run the test to confirm it fails (RED).**

Run: `go test ./internal/sessiond/ -run TestVTBuffer -v`
Expected: compile failure — `b.ScreenText undefined` / `b.CursorPos undefined`. Correct RED.

**Step 4: Implement `ScreenText` and `CursorPos` in `vt.go`.**

Add these methods to `internal/sessiond/vt.go` (place them after `Replay`, around line 84). They mirror the locking discipline of the existing read methods:

```go
// ScreenText returns the current visible VT grid as ANSI-stripped plain text.
// Rows are joined with "\n" and trailing blank rows are trimmed. It is the
// plain-text counterpart to Replay (which emits styled bytes for re-feeding a
// terminal); ScreenText is for agents that want to read the screen as text.
func (b *VTBuffer) ScreenText() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	// Render() emits the styled screen; stripANSI removes SGR/control sequences
	// leaving plain glyphs. Rows are separated by "\n".
	plain := stripANSI(b.emu.Emulator.Render())
	lines := strings.Split(plain, "\n")
	// Trim trailing blank (whitespace-only) lines.
	end := len(lines)
	for end > 0 && strings.TrimRight(lines[end-1], " \t") == "" {
		end--
	}
	return strings.Join(lines[:end], "\n")
}

// CursorPos returns the live cursor row and column, 0-indexed.
func (b *VTBuffer) CursorPos() (row, col int) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	pos := b.emu.Emulator.CursorPosition()
	return pos.Y, pos.X
}

// stripANSI removes ANSI escape sequences (CSI ... and OSC ... terminated by
// BEL or ST) from s, leaving plain text. It is intentionally small: it handles
// the SGR/CSI and OSC forms emitted by the emulator's Render output.
func stripANSI(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); {
		if s[i] == '\x1b' && i+1 < len(s) {
			switch s[i+1] {
			case '[': // CSI: ESC [ ... final-byte in 0x40-0x7E
				j := i + 2
				for j < len(s) && (s[j] < 0x40 || s[j] > 0x7E) {
					j++
				}
				i = j + 1
				continue
			case ']': // OSC: ESC ] ... (BEL | ST)
				j := i + 2
				for j < len(s) && s[j] != '\x07' && !(s[j] == '\x1b' && j+1 < len(s) && s[j+1] == '\\') {
					j++
				}
				if j < len(s) && s[j] == '\x1b' {
					j++ // consume the backslash of ST
				}
				i = j + 1
				continue
			default:
				i += 2 // ESC + one byte (e.g. ESC ( charset selectors)
				continue
			}
		}
		out.WriteByte(s[i])
		i++
	}
	return out.String()
}
```

> If `go doc` in Step 1 revealed a ready-made plain-text method on the emulator (e.g. a `String()` that is already ANSI-free), prefer it over `stripANSI(Render())` and delete `stripANSI`. The existing `serializeGrid` comment notes `String()` is plain text while `Render()` is styled — if `b.emu.Emulator.String()` exists and returns the visible grid as plain text, use `stripANSI` is unnecessary: `plain := b.emu.Emulator.String()`. Pick whichever the actual API offers; the test in Step 2 is the contract.

**Step 5: Run the test to confirm it passes (GREEN).**

Run: `go test ./internal/sessiond/ -run TestVTBuffer -v`
Expected: PASS.

**Step 6: Add the `TypeScreenSnapshot` case to `conn.handle()`.**

In `internal/sessiond/server.go`, add a new case to the `conn.handle()` switch (line ~279). Place it after the `TypePaneUpdate` case (ends line ~330), before the switch's closing `}`:

```go
	case TypeScreenSnapshot:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		p, ok := c.srv.reg.Pane(c.attached, msg.PaneID)
		if !ok {
			c.replyError(msg.CID, CodeUnknownWorkspace, "pane not found")
			return
		}
		// Only VTBuffer-backed terminal panes can produce a grid snapshot.
		// Browser panes (no buffer) and raw-buffer panes return empty text.
		vb, ok := p.buf.(*VTBuffer)
		if !ok {
			c.reply(&Message{Type: TypeScreenSnapshotResult, CID: msg.CID, PaneID: msg.PaneID, Text: ""})
			return
		}
		row, col := vb.CursorPos()
		c.reply(&Message{
			Type:   TypeScreenSnapshotResult,
			CID:    msg.CID,
			PaneID: msg.PaneID,
			Text:   vb.ScreenText(),
			Cursor: &CursorPos{Row: row, Col: col},
		})
```

> `p.buf` is the unexported `PaneBuffer` field on `Pane`. Because `conn.handle` lives in the same `sessiond` package, the type assertion `p.buf.(*VTBuffer)` is legal. Browser panes have `buf == nil`; the `nil.(*VTBuffer)` assertion fails cleanly with `ok == false`, so the empty-text branch covers them.

**Step 7: Run the full Go gate.**

Run: `go build ./... && go test ./internal/sessiond/...`
Expected: clean build, all tests pass.

**Step 8: Commit.**
```
git add internal/sessiond/vt.go internal/sessiond/vt_screen_test.go internal/sessiond/server.go && git commit -m "feat: add screen-snapshot handler and VTBuffer text extraction"
```

---

## Task 4: browser-action relay — daemon broadcast half

**Files:**
- Create test: `internal/sessiond/server_relay_test.go`
- Modify: `internal/sessiond/server.go` (`conn.handle()` switch)
- Modify: `internal/sessiond/client.go` (`Handlers` struct line ~43; `dispatchEvent()` line ~352)

**Background you need:** A `browser-action` message has two lives on the wire. As a **request** (MCP → daemon) it carries a `CID` and asks the daemon to relay a DOM command. The daemon's job in Phase 2 is only to **broadcast it as an event** (cid cleared) to every workspace subscriber — the browser WS clients among them will (in Phase 7+) forward it to the iframe shim. The result returns as a separate `browser-action-result` message handled later. Phase 2 implements only the daemon broadcast (the receive-and-fan-out) and the serve-side `Handlers.OnBrowserAction` dispatch so Phase 4 has a hook.

**Step 1: Write the failing test for the daemon broadcast.**

First, read an existing daemon test to copy the harness (how a test spins up a `Server`, connects a `conn`, attaches, and inspects broadcasts). Run:
```
grep -rln "func Test" internal/sessiond/ | head
grep -rn "attachConn\|broadcast\|newConn\|subscriber" internal/sessiond/server_test.go 2>/dev/null | head
```
Read the file that already tests `conn.handle`/broadcast (likely `server_test.go`) to learn the exact in-package helpers for building a `conn` and draining its `subscriber` queue. Mirror that style.

Create `internal/sessiond/server_relay_test.go` using the harness pattern you just read. The test must prove: when a `browser-action` request is handled on an attached conn, every subscriber to that workspace receives a `TypeBrowserAction` event with `CID == 0` and the action fields preserved. Sketch (adapt field names to the real harness helpers):

```go
package sessiond

import "testing"

func TestBrowserActionBroadcast(t *testing.T) {
	srv, _ := NewServer(t.TempDir() + "/sock")
	wsID := srv.reg.AddWorkspace("test", "")

	// Two conns attached to the same workspace: the actor and an observer.
	actor := newTestConn(t, srv)   // helper from existing server_test.go
	observer := newTestConn(t, srv)
	srv.attachConn(actor, wsID, 1, "wide")
	srv.attachConn(observer, wsID, 2, "wide")
	drain(actor)    // discard composition + replay frames (helper)
	drain(observer)

	actor.handle(Message{
		Type:        TypeBrowserAction,
		CID:         99,
		WorkspaceID: wsID,
		PaneID:      3,
		Action:      "click",
		Ref:         "e5",
	})

	msg := nextControl(t, observer) // helper: pops the next control Message
	if msg.Type != TypeBrowserAction {
		t.Fatalf("type = %q, want browser-action", msg.Type)
	}
	if msg.CID != 0 {
		t.Errorf("CID = %d, want 0 (event, not unicast reply)", msg.CID)
	}
	if msg.Action != "click" || msg.Ref != "e5" || msg.PaneID != 3 {
		t.Errorf("relayed fields lost: %+v", msg)
	}
}
```

> If the existing test file has no `newTestConn`/`drain`/`nextControl` helpers, write minimal local equivalents in this test file using whatever the real `subscriber`/`conn` surface exposes (read `subscriber` in `server.go`/its file to see how to construct one with an in-memory `net.Conn`, e.g. `net.Pipe()`). The exact harness is whatever the existing daemon tests already use — match it; do not invent a parallel style.

**Step 2: Run the test to confirm it fails (RED).**

Run: `go test ./internal/sessiond/ -run TestBrowserActionBroadcast -v`
Expected: fails — no `TypeBrowserAction` case yet, so the observer receives nothing (or the test does not compile if you referenced a not-yet-existing handler path). Correct RED.

**Step 3: Add the `TypeBrowserAction` case to `conn.handle()`.**

In `internal/sessiond/server.go`, add to the `conn.handle()` switch, after the `TypeScreenSnapshot` case from Task 3:

```go
	case TypeBrowserAction:
		// Relay a browser DOM command to all subscribers (including browser WS
		// clients), which forward it to the SW bridge. This is an event, not a
		// unicast reply, so clear the request CID before broadcasting.
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		msg.CID = 0
		c.srv.broadcast(c.attached, &msg)
```

> `msg` is the `Message` value parameter of `handle`; `&msg` takes the address of the local copy, which is safe to broadcast because `broadcast` enqueues (marshals) it. Other cases in this switch already take `msg` by value, so this matches the existing pattern.

**Step 4: Run the test to confirm it passes (GREEN).**

Run: `go test ./internal/sessiond/ -run TestBrowserActionBroadcast -v`
Expected: PASS.

**Step 5: Add `OnBrowserAction` to the serve-side `Handlers` struct.**

In `internal/sessiond/client.go`, add to the `Handlers` struct (line ~43–66), after the `OnPaneRenamed` field:

```go
	// OnBrowserAction fires when the daemon relays a browser-action event to
	// this subscriber. The serve layer (Phase 4) forwards it to the browser WS
	// client, which postMessages it to the iframe SW bridge.
	OnBrowserAction func(paneID int, action, ref, value, key, expr string)
```

**Step 6: Add the `TypeBrowserAction` dispatch case.**

In `client.go dispatchEvent()` (line ~352), add a case after `TypePaneRenamed` (line ~386–389):

```go
	case TypeBrowserAction:
		if h.OnBrowserAction != nil {
			h.OnBrowserAction(msg.PaneID, msg.Action, msg.Ref, msg.Value, msg.Key, msg.Expression)
		}
```

**Step 7: Run the full Go gate.**

Run: `go build ./... && go test ./internal/sessiond/...`
Expected: clean build, all tests pass.

**Step 8: Commit.**
```
git add internal/sessiond/server.go internal/sessiond/client.go internal/sessiond/server_relay_test.go && git commit -m "feat: relay browser-action events through daemon broadcast"
```

---

## Task 5: layout-command push — daemon broadcast half

**Files:**
- Modify: `internal/sessiond/server.go` (`conn.handle()` switch)
- Modify: `internal/sessiond/client.go` (`Handlers` struct; `dispatchEvent()`)
- Extend test: `internal/sessiond/server_relay_test.go`

**Background you need:** `layout-command` is simpler than `browser-action`: the MCP client (Phase 4) sends it, and the daemon broadcasts it to all subscribers so browser clients can manipulate dockview. It carries an `Action` (verb like `create-pane`/`rename-pane`/`close-pane`/`switch-workspace`), a `PaneID`, and reuses other fields. We model the placement/reference using existing fields where possible — Phase 2 only moves the message; Phase 3/4 interpret it.

**Step 1: Extend the relay test (RED).**

Add a second test to `internal/sessiond/server_relay_test.go`, mirroring Task 4's harness:

```go
func TestLayoutCommandBroadcast(t *testing.T) {
	srv, _ := NewServer(t.TempDir() + "/sock")
	wsID := srv.reg.AddWorkspace("test", "")

	actor := newTestConn(t, srv)
	observer := newTestConn(t, srv)
	srv.attachConn(actor, wsID, 1, "wide")
	srv.attachConn(observer, wsID, 2, "wide")
	drain(actor)
	drain(observer)

	actor.handle(Message{
		Type:        TypeLayoutCommand,
		CID:         42,
		WorkspaceID: wsID,
		Action:      "create-pane",
		PaneID:      0,
	})

	msg := nextControl(t, observer)
	if msg.Type != TypeLayoutCommand {
		t.Fatalf("type = %q, want layout-command", msg.Type)
	}
	if msg.CID != 0 {
		t.Errorf("CID = %d, want 0", msg.CID)
	}
	if msg.Action != "create-pane" {
		t.Errorf("action lost: %+v", msg)
	}
}
```

Run: `go test ./internal/sessiond/ -run TestLayoutCommandBroadcast -v`
Expected: fails (no `TypeLayoutCommand` case yet). Correct RED.

**Step 2: Add the `TypeLayoutCommand` case to `conn.handle()`.**

In `internal/sessiond/server.go`, add after the `TypeBrowserAction` case from Task 4:

```go
	case TypeLayoutCommand:
		// Relay a layout mutation to all subscribers (browser clients apply it
		// to dockview). Event, not unicast reply: clear the CID before fan-out.
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		msg.CID = 0
		c.srv.broadcast(c.attached, &msg)
```

**Step 3: Add `OnLayoutCommand` to `Handlers`.**

In `client.go`, add to the `Handlers` struct after `OnBrowserAction`:

```go
	// OnLayoutCommand fires when the daemon relays a layout-command event to
	// this subscriber. The serve layer forwards it to browser clients, which
	// perform the dockview operation. placement and referencePane carry the
	// split intent (Phase 3/4 interpret them).
	OnLayoutCommand func(command string, paneID int, placement string, referencePane int)
```

**Step 4: Add the `TypeLayoutCommand` dispatch case.**

In `client.go dispatchEvent()`, add after the `TypeBrowserAction` case:

```go
	case TypeLayoutCommand:
		if h.OnLayoutCommand != nil {
			// Placement/referencePane reuse existing Message fields; Selector is
			// the placement token and Cols is the reference pane id when set by
			// the originator. Phase 4 finalizes the field mapping; Phase 2 just
			// surfaces the verb and pane id.
			h.OnLayoutCommand(msg.Action, msg.PaneID, msg.Selector, msg.Cols)
		}
```

> The placement/reference field mapping is provisional here — the daemon broadcast preserves the whole `Message`, so no information is lost on the wire regardless of how the serve handler reads it. Phase 4 will lock the exact field names when it builds the `create_pane` tool. This is acceptable because Phase 2's contract is "the message round-trips"; the test asserts the verb survives.

**Step 5: Run the full Go gate.**

Run: `go build ./... && go test ./internal/sessiond/...`
Expected: clean build, both relay tests pass.

**Step 6: Commit.**
```
git add internal/sessiond/server.go internal/sessiond/client.go internal/sessiond/server_relay_test.go && git commit -m "feat: relay layout-command events through daemon broadcast"
```

---

## Task 6: get_layout ASCII diagram generator

**Files:**
- Create: `internal/sessiond/layout.go`
- Create test: `internal/sessiond/layout_test.go`
- Modify: `internal/sessiond/server.go` (`conn.handle()` switch)

**Background you need:** The dockview layout is stored per workspace per breakpoint as opaque JSON (`reg.Layout(wsID, "wide")` — `"wide"` is the desktop breakpoint). We must parse that JSON and render an ASCII box diagram so an agent can "see" the layout without a browser round-trip. The dockview grid JSON has this shape (confirm against `web/src/components/mux-dock.ts` serialization if anything is unclear):

```json
{
  "grid": {
    "root": {
      "type": "branch",
      "data": [ <child>, <child> ],
      "size": 100
    },
    "orientation": "HORIZONTAL"
  },
  "panels": {
    "3": { "id": "3", "title": "terminal", "contentComponent": "terminal" }
  },
  "activeGroup": "group-id"
}
```

- A **leaf** node: `{"type":"leaf","data":{"id":"group-id","views":["1","2"],"activeView":"1"},"size":N}`. `views` are panel ids (stringified pane ids); `activeView` is the visible tab.
- A **branch** node: `{"type":"branch","data":[child,child],"size":N}`. `orientation` (on the parent grid, or implied) determines whether children stack horizontally or vertically.

For Phase 2 the renderer must be **correct and total** (never panic, always return a string), but it does not need pixel-perfect box drawing. Match the design's target output for the simple cases the tests cover; degrade gracefully (return `""`) on empty or malformed input.

**Step 1: Read the dockview serialization to confirm the JSON shape.**

Run:
```
grep -n "toJSON\|fromJSON\|orientation\|activeView\|views\|branch\|leaf\|grid" web/src/components/mux-dock.ts | head -40
```
Confirm the keys (`grid.root.type`, `data`, `views`, `activeView`, `panels`, `activeGroup`). Adjust the struct tags in Step 3 to match exactly what dockview emits.

**Step 2: Write the failing table-driven test.**

Create `internal/sessiond/layout_test.go`:

```go
package sessiond

import (
	"strings"
	"testing"
)

func TestASCIILayout(t *testing.T) {
	panes := []PaneInfo{
		{PaneID: 1, SurfaceKind: "terminal", Title: "terminal"},
		{PaneID: 2, SurfaceKind: "terminal", Title: "terminal"},
		{PaneID: 3, SurfaceKind: "browser", Title: "browser", BrowserPath: "/"},
	}

	tests := []struct {
		name     string
		layout   string
		panes    []PaneInfo
		active   int
		wantSub  []string // substrings that must appear
		wantTrim bool     // when true, expect "" (empty)
	}{
		{
			name:     "empty layout json",
			layout:   "",
			panes:    panes,
			active:   -1,
			wantTrim: true,
		},
		{
			name:     "malformed json falls back to empty",
			layout:   "{not valid json",
			panes:    panes,
			active:   -1,
			wantTrim: true,
		},
		{
			name:    "single leaf one pane",
			layout:  `{"grid":{"root":{"type":"leaf","data":{"id":"g1","views":["1"],"activeView":"1"},"size":100},"orientation":"HORIZONTAL"},"panels":{"1":{"id":"1","title":"terminal"}},"activeGroup":"g1"}`,
			panes:   panes,
			active:  1,
			wantSub: []string{"[1]", "terminal"},
		},
		{
			name:    "two-pane horizontal split",
			layout:  `{"grid":{"root":{"type":"branch","data":[{"type":"leaf","data":{"id":"g1","views":["1"],"activeView":"1"},"size":50},{"type":"leaf","data":{"id":"g2","views":["3"],"activeView":"3"},"size":50}],"size":100},"orientation":"HORIZONTAL"},"panels":{"1":{"id":"1","title":"terminal"},"3":{"id":"3","title":"browser"}},"activeGroup":"g1"}`,
			panes:   panes,
			active:  1,
			wantSub: []string{"[1]", "[3]", "terminal", "browser"},
		},
		{
			name:    "multi-tab group",
			layout:  `{"grid":{"root":{"type":"leaf","data":{"id":"g1","views":["1","2"],"activeView":"1"},"size":100},"orientation":"HORIZONTAL"},"panels":{"1":{"id":"1","title":"terminal"},"2":{"id":"2","title":"terminal"}},"activeGroup":"g1"}`,
			panes:   panes,
			active:  1,
			wantSub: []string{"[1]", "[2]"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ASCIILayout(tt.layout, tt.panes, tt.active)
			if tt.wantTrim {
				if strings.TrimSpace(got) != "" {
					t.Errorf("want empty, got %q", got)
				}
				return
			}
			for _, sub := range tt.wantSub {
				if !strings.Contains(got, sub) {
					t.Errorf("output missing %q:\n%s", sub, got)
				}
			}
		})
	}
}
```

**Step 3: Run the test to confirm it fails (RED).**

Run: `go test ./internal/sessiond/ -run TestASCIILayout -v`
Expected: compile failure — `undefined: ASCIILayout`. Correct RED.

**Step 4: Implement `layout.go`.**

Create `internal/sessiond/layout.go`. This parses the dockview JSON into a tree and renders it. Keep it total (no panics) and degrade to `""` on empty/malformed input:

```go
package sessiond

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// dockNode is one node of the dockview grid tree. A leaf carries a group (Data
// decoded as dockLeaf); a branch carries child nodes (Data decoded as a JSON
// array). We decode Data lazily based on Type to handle the polymorphism.
type dockNode struct {
	Type string          `json:"type"` // "branch" | "leaf"
	Data json.RawMessage `json:"data"`
	Size float64         `json:"size"`
}

type dockLeaf struct {
	ID         string   `json:"id"`
	Views      []string `json:"views"`
	ActiveView string   `json:"activeView"`
}

type dockGrid struct {
	Grid struct {
		Root        dockNode `json:"root"`
		Orientation string   `json:"orientation"`
	} `json:"grid"`
	Panels      map[string]dockPanel `json:"panels"`
	ActiveGroup string               `json:"activeGroup"`
}

type dockPanel struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// ASCIILayout renders an ASCII box diagram of the workspace layout from the
// stored dockview layout JSON, the workspace's panes, and the active pane id
// (-1 when unknown). Returns "" when there is no layout or the JSON cannot be
// parsed — callers treat "" as "no layout available".
func ASCIILayout(layoutJSON string, panes []PaneInfo, activePaneID int) string {
	if strings.TrimSpace(layoutJSON) == "" {
		return ""
	}
	var g dockGrid
	if err := json.Unmarshal([]byte(layoutJSON), &g); err != nil {
		return ""
	}

	// Index panes by id for title/hint lookup.
	byID := make(map[int]PaneInfo, len(panes))
	for _, p := range panes {
		byID[p.PaneID] = p
	}

	// Collect leaves in visual order via a depth-first walk.
	leaves := collectLeaves(&g.Grid.Root)
	if len(leaves) == 0 {
		return ""
	}

	var b strings.Builder
	for _, leaf := range leaves {
		b.WriteString(renderGroup(leaf, byID, activePaneID))
		b.WriteString("\n")
	}
	if activePaneID >= 0 {
		fmt.Fprintf(&b, "active: %d\n", activePaneID)
	}
	return b.String()
}

// collectLeaves walks the dock tree depth-first and returns leaf groups in
// order. Branch children are decoded from Data as an array of dockNode.
func collectLeaves(n *dockNode) []dockLeaf {
	switch n.Type {
	case "leaf":
		var l dockLeaf
		if err := json.Unmarshal(n.Data, &l); err != nil {
			return nil
		}
		return []dockLeaf{l}
	case "branch":
		var children []dockNode
		if err := json.Unmarshal(n.Data, &children); err != nil {
			return nil
		}
		var out []dockLeaf
		for i := range children {
			out = append(out, collectLeaves(&children[i])...)
		}
		return out
	default:
		return nil
	}
}

// renderGroup renders one group (a leaf) as a boxed cell. The active view's
// content line is shown; other tabs in the group are listed in the tab bar.
func renderGroup(leaf dockLeaf, byID map[int]PaneInfo, activePaneID int) string {
	// Build the tab bar: "[1]* terminal  [2] terminal".
	var tabs []string
	for _, v := range leaf.Views {
		id, err := strconv.Atoi(v)
		if err != nil {
			continue
		}
		info := byID[id]
		marker := ""
		if id == activePaneID {
			marker = "*"
		}
		kind := info.Title
		if kind == "" {
			kind = info.SurfaceKind
		}
		tabs = append(tabs, fmt.Sprintf("[%d]%s %s", id, marker, kind))
	}
	bar := strings.Join(tabs, "  ")

	// Content hint for the active view: browser path or a placeholder.
	hint := ""
	if av, err := strconv.Atoi(leaf.ActiveView); err == nil {
		if info, ok := byID[av]; ok && info.SurfaceKind == "browser" {
			hint = info.BrowserPath
		}
	}

	width := len(bar)
	if len(hint) > width {
		width = len(hint)
	}
	if width < 4 {
		width = 4
	}
	top := "┌" + strings.Repeat("─", width+2) + "┐"
	mid := "├" + strings.Repeat("─", width+2) + "┤"
	bot := "└" + strings.Repeat("─", width+2) + "┘"

	var b strings.Builder
	b.WriteString(top + "\n")
	fmt.Fprintf(&b, "│ %-*s │\n", width, bar)
	b.WriteString(mid + "\n")
	fmt.Fprintf(&b, "│ %-*s │\n", width, hint)
	b.WriteString(bot)
	return b.String()
}
```

> This renderer draws each group as a stacked box rather than reproducing the exact side-by-side art in the design doc. That is a deliberate Phase 2 simplification: the tests assert that the right pane ids, titles, active marker, and structure appear — not exact glyph positions. Phase 4 can refine the box-joining art when `get_layout` becomes a user-facing tool. Keep it total and test-driven.

**Step 5: Run the test to confirm it passes (GREEN).**

Run: `go test ./internal/sessiond/ -run TestASCIILayout -v`
Expected: PASS (all sub-tests).

**Step 6: Add the `TypeGetLayout` handler.**

In `internal/sessiond/server.go`, add to the `conn.handle()` switch after the `TypeLayoutCommand` case from Task 5:

```go
	case TypeGetLayout:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		layout := c.srv.reg.Layout(c.attached, "wide")
		panes := c.srv.reg.PaneInfos(c.attached)
		ascii := ASCIILayout(layout, panes, -1)
		c.reply(&Message{Type: TypeLayoutResult, CID: msg.CID, ASCII: ascii})
```

> Use `reg.PaneInfos` (registry.go line ~156), which returns `[]PaneInfo` — the design instruction's `PanesInfo` name does not exist; the real accessor is `PaneInfos`. Active pane is `-1` for now; Phase 4 wires real active-pane tracking.

**Step 7: Run the full Go gate.**

Run: `go build ./... && go test ./internal/sessiond/...`
Expected: clean build, all tests pass.

**Step 8: Commit.**
```
git add internal/sessiond/layout.go internal/sessiond/layout_test.go internal/sessiond/server.go && git commit -m "feat: add get-layout ASCII diagram generator and handler"
```

---

## Task 7: browser-action relay — browser client half (TypeScript)

**Files:**
- Modify: `web/src/ws.ts` (incoming-message handling)
- Modify: `web/src/app.ts` (event listener)
- Modify: `web/src/components/mux-dock.ts` (`sendBrowserAction` method)
- Modify: `web/src/components/browser-surface.ts` (`receiveBrowserAction` method)

**Background you need:** The browser receives a `browser-action` event from the server, must postMessage the command to the correct iframe (the `<mux-browser-surface>` for that pane), wait for the shim's response, and send the result back over the WebSocket. `BrowserRenderer` (mux-dock.ts line ~106) holds a `MuxBrowserSurface` per browser pane. Read `browser-surface.ts` first to learn how it exposes its iframe (look for the `<iframe>` and `contentWindow` usage near line ~110).

There is **no runtime E2E in Phase 2**. The gate is `cd web && npm run check:fast` (oxlint + tsgo). Write correct, type-checking code that wires the path end to end; Phase 7 validates it live.

**Step 1: Read `browser-surface.ts` to find the iframe accessor.**

Run:
```
sed -n '1,135p' web/src/components/browser-surface.ts
```
Note how the element holds its `<iframe>` (a `@query` or a property) and its `paneId`. You will add a `receiveBrowserAction` method that posts to `iframe.contentWindow` and resolves on the matching response.

**Step 2: Dispatch a `browser-action` window event in `ws.ts`.**

In `web/src/ws.ts`, the `onSessiondMessage` hook already routes flat typed messages (line ~214–216). The cleanest additive hook is in the ` onmessage` text branch: after `this.onSessiondMessage?.(...)`, dispatch a window CustomEvent for the relay-only types so the app layer can listen without coupling to the socket. Add, immediately after the `this.onSessiondMessage?.(raw as unknown as SessiondMessage);` line (line ~215):

```ts
          // MCP relay events: surface as window CustomEvents so the dock layer
          // can handle them without the socket knowing about dockview/iframes.
          if (raw.type === 'browser-action') {
            window.dispatchEvent(new CustomEvent('browser-action', { detail: raw }));
          } else if (raw.type === 'layout-command') {
            window.dispatchEvent(new CustomEvent('layout-command', { detail: raw }));
          }
```

> We compare against the string literals `'browser-action'`/`'layout-command'` here because `ws.ts` works with the raw envelope. If `web/src/types.ts` exports a `SessiondType` enum, prefer adding `BrowserAction = 'browser-action'` and `LayoutCommand = 'layout-command'` members there and referencing them — check `types.ts` and match the existing convention (the file already centralizes the vocabulary). Do whichever keeps `check:fast` clean and matches the codebase style.

**Step 3: Add the `SessiondType` enum members (if the enum exists).**

Run: `grep -n "enum SessiondType\|Attach =\|ClosePane =" web/src/types.ts`
If `SessiondType` is a string enum, add these members alongside the others:

```ts
  BrowserAction = 'browser-action',
  BrowserActionResult = 'browser-action-result',
  LayoutCommand = 'layout-command',
  ScreenSnapshot = 'screen-snapshot',
  GetLayout = 'get-layout',
```

Then use `SessiondType.BrowserAction` etc. in Step 2 instead of raw strings. If there is no such enum, skip this step and keep the literals.

**Step 4: Add the `browser-action` listener in `app.ts`.**

In `web/src/app.ts connectedCallback()` (the listener-registration block around line ~306–309, near `this.addEventListener('pane-navigate', ...)`), register a window listener. Because the event is dispatched on `window` (Step 2), add it to `window`, and remove it in `disconnectedCallback`. Add in `connectedCallback`:

```ts
    window.addEventListener('browser-action', this._onBrowserAction);
```

Add the handler method to the `MuxApp` class (place it near `_onPaneNavigate`):

```ts
  /** Relay a browser-action event from the server to the target pane's iframe
   *  shim, then send the shim's result back over the socket. The dock owns the
   *  iframe; we delegate to it. */
  private _onBrowserAction = (e: Event): void => {
    const msg = (e as CustomEvent).detail as Record<string, unknown>;
    void this._dock?.sendBrowserAction(msg);
  };
```

And in `disconnectedCallback` (find the matching `removeEventListener` block) add:

```ts
    window.removeEventListener('browser-action', this._onBrowserAction);
```

**Step 5: Add `sendBrowserAction` to `mux-dock.ts`.**

In `web/src/components/mux-dock.ts`, add a public method to the `MuxDock` class. It finds the `BrowserRenderer`/`MuxBrowserSurface` for the pane and delegates. You need a way to look up the surface by pane id — read how `BrowserRenderer` instances are tracked (the renderer is created in the `createComponent` factory at line ~784; check whether there is a map of pane id → renderer; if not, store one). Add a private map field near the other private fields (line ~263) if none exists:

```ts
  /** Browser-surface renderers keyed by pane id, for MCP browser-action relay. */
  private _browserRenderers = new Map<number, BrowserRenderer>();
```

In the `BrowserRenderer` constructor (or where it is created, line ~784/~127), register and unregister it. The simplest: when `BrowserRenderer` is constructed in the factory, do `this._browserRenderers.set(pane.paneId, renderer)`. Then add the method:

```ts
  /**
   * Relay an MCP browser-action to the target pane's iframe shim and forward
   * the shim's response back to the server over the WebSocket. Resolves when
   * the round-trip completes (or rejects/empties on timeout inside the surface).
   */
  async sendBrowserAction(msg: Record<string, unknown>): Promise<void> {
    const paneId = typeof msg.paneId === 'number' ? msg.paneId : -1;
    const renderer = this._browserRenderers.get(paneId);
    if (!renderer) {
      this._emitBrowserActionResult({ ...msg, error: 'pane-not-found' });
      return;
    }
    try {
      const result = await renderer.surface.receiveBrowserAction(paneId, msg);
      this._emitBrowserActionResult({ ...result, paneId });
    } catch (err) {
      this._emitBrowserActionResult({ paneId, error: String(err) });
    }
  }

  /** Dispatch the browser-action result up to mux-app, which sends it over the
   *  socket. Decoupled via event so the dock holds no socket reference. */
  private _emitBrowserActionResult(result: Record<string, unknown>): void {
    this.dispatchEvent(
      new CustomEvent('browser-action-result', {
        detail: result,
        bubbles: true,
        composed: true,
      }),
    );
  }
```

> `renderer.surface` assumes `BrowserRenderer` exposes its `MuxBrowserSurface`. If the field is private/named differently, expose a getter or use the actual field name you saw in Step 1's read of `BrowserRenderer` (line ~106–130). The exact accessor is whatever the class already has — match it.

**Step 6: Send the result over the socket in `app.ts`.**

Add a listener for `browser-action-result` (dispatched by the dock, bubbles through the shadow DOM). In `connectedCallback`, near the other `this.addEventListener(...)` calls:

```ts
    this.addEventListener('browser-action-result', this._onBrowserActionResult);
```

Add the handler:

```ts
  private _onBrowserActionResult = (e: Event): void => {
    const detail = (e as CustomEvent).detail as Record<string, unknown>;
    this._socket?.sendBrowserActionResult(detail);
  };
```

And add the sender to `MuxSocket` in `web/src/ws.ts`, alongside the other `sendSessiond`-based senders:

```ts
  /** Send a browser-action result back to the server (MCP relay return path). */
  sendBrowserActionResult(detail: Record<string, unknown>): void {
    this.sendSessiond({ type: 'browser-action-result', ...detail } as unknown as SessiondMessage);
  }
```

> If you added `SessiondType.BrowserActionResult` in Step 3, use it instead of the string literal.

**Step 7: Add `receiveBrowserAction` to `browser-surface.ts`.**

In `web/src/components/browser-surface.ts`, add a method that posts the command to the iframe with a generated correlation id and resolves on the matching `message` reply, rejecting after 10s. Use the actual iframe accessor you found in Step 1:

```ts
  /**
   * Post an MCP browser-action command to this surface's iframe shim and
   * resolve with the shim's response. A generated correlation id (cid) is added
   * so concurrent commands don't cross. Rejects after a 10s timeout.
   */
  receiveBrowserAction(paneId: number, msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const iframe = this._iframe; // use the real field name from this class
    const win = iframe?.contentWindow;
    if (!win) return Promise.reject(new Error('bridge-not-ready'));

    const cid = `ba-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMessage);
        reject(new Error('browser-action-timeout'));
      }, 10_000);

      const onMessage = (ev: MessageEvent): void => {
        const data = ev.data as Record<string, unknown> | null;
        if (!data || data.cid !== cid) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        resolve(data);
      };

      window.addEventListener('message', onMessage);
      win.postMessage({ ...msg, cid, paneId }, '*');
    });
  }
```

> Replace `this._iframe` with the surface's real iframe field (from Step 1). If the class has no direct iframe reference, add a `@query('iframe')` accessor. Keep all additions type-clean for tsgo.

**Step 8: Run the TypeScript gate.**

Run: `cd web && npm run check:fast`
Expected: PASS (oxlint + tsgo, no errors). Fix any type errors by matching the real field/accessor names — do not loosen types with broad `any` casts beyond the `Record<string, unknown>` envelopes already used.

**Step 9: Commit.**
```
git add web/src/ws.ts web/src/app.ts web/src/components/mux-dock.ts web/src/components/browser-surface.ts web/src/types.ts && git commit -m "feat: relay browser-action between server and iframe shim (client half)"
```

---

## Task 8: layout-command routing — browser client half (TypeScript, plumbing only)

**Files:**
- Modify: `web/src/app.ts` (event listener)
- Modify: `web/src/components/mux-dock.ts` (`handleLayoutCommand` method)

**Background you need:** Phase 2 wires only the **routing** for `layout-command`: the server event reaches `mux-dock`, which logs it and emits a `layout-command-received` event proving the plumbing works. The actual dockview operations (create/rename/close/switch) are Phase 3/4. The `layout-command` window CustomEvent was already dispatched in Task 7, Step 2 (`ws.ts`), so this task only adds the app listener and the dock stub.

**Step 1: Define a `LayoutCommand` type and add the listener in `app.ts`.**

In `web/src/app.ts`, register a window listener in `connectedCallback` (near the Task 7 `browser-action` listener):

```ts
    window.addEventListener('layout-command', this._onLayoutCommand);
```

Add the handler method:

```ts
  /** Route a layout-command event from the server to the dock. Phase 2 wires
   *  the plumbing only; the dock logs it and emits a receipt event. The actual
   *  dockview mutations are Phase 3/4. */
  private _onLayoutCommand = (e: Event): void => {
    const msg = (e as CustomEvent).detail as Record<string, unknown>;
    this._dock?.handleLayoutCommand(msg);
  };
```

And remove it in `disconnectedCallback`:

```ts
    window.removeEventListener('layout-command', this._onLayoutCommand);
```

**Step 2: Add `handleLayoutCommand` to `mux-dock.ts`.**

In `web/src/components/mux-dock.ts`, add a public method and a small type to the `MuxDock` class:

```ts
  /**
   * Handle a layout-command relayed from the server. PHASE 2: routing/plumbing
   * only — log the command and emit a `layout-command-received` event so tests
   * and later phases can confirm the path works. The real dockview operations
   * (create-pane, rename-pane, close-pane, switch-workspace) land in Phase 3/4.
   */
  handleLayoutCommand(msg: Record<string, unknown>): void {
    // eslint-disable-next-line no-console -- intentional Phase 2 plumbing trace
    console.debug('[mux-dock] layout-command received (Phase 2 stub):', msg);
    this.dispatchEvent(
      new CustomEvent('layout-command-received', {
        detail: msg,
        bubbles: true,
        composed: true,
      }),
    );
  }
```

> If oxlint forbids `console.debug` even with the disable comment, drop the `console.debug` line entirely and keep only the event dispatch — the receipt event is the observable proof of plumbing; the log is a convenience. Match whatever `check:fast` accepts.

**Step 3: Run the TypeScript gate.**

Run: `cd web && npm run check:fast`
Expected: PASS (oxlint + tsgo, no errors).

**Step 4: Commit.**
```
git add web/src/app.ts web/src/components/mux-dock.ts && git commit -m "feat: route layout-command to mux-dock (Phase 2 plumbing stub)"
```

---

## Final verification

Run both gates from the repo root to confirm the whole phase is green:

```
go build ./... && go test ./internal/sessiond/...
cd web && npm run check:fast
```

Both must pass. Then confirm the commit log shows eight clean conventional commits (one per task):

```
git log --oneline -8
```

---

## Done criteria

- [ ] **Task 1:** New `Type*` constants added in the correct (request/reply/event) groups; new `Message` fields and `CursorPos` struct added; nothing frozen was changed; `go build ./...` passes.
- [ ] **Task 2:** `scanOSC133` passes its table-driven test (BEL/ST terminators, codes 0/1/127, mid-buffer, no-match, partial-no-terminator); `Pane.onPrompt` wired in `createPane`; `readLoop` emits `shell-prompt` on OSC 133;D.
- [ ] **Task 3:** `VTBuffer.ScreenText` (ANSI-stripped, trailing-blank-trimmed) and `CursorPos` pass unit tests; `screen-snapshot` handler returns `screen-snapshot-result` with text + cursor (empty for non-VT panes).
- [ ] **Task 4:** `browser-action` request broadcasts to all subscribers with CID cleared; `Handlers.OnBrowserAction` + `dispatchEvent` case added; broadcast test passes.
- [ ] **Task 5:** `layout-command` request broadcasts with CID cleared; `Handlers.OnLayoutCommand` + `dispatchEvent` case added; broadcast test passes.
- [ ] **Task 6:** `ASCIILayout` passes its table-driven test (empty, malformed, single leaf, two-pane split, multi-tab); `get-layout` handler returns `layout-result` with the ASCII diagram.
- [ ] **Task 7:** Server `browser-action` → `ws.ts` window event → `app.ts` → `mux-dock.sendBrowserAction` → `browser-surface.receiveBrowserAction` (postMessage + 10s timeout) → result back over the socket; `check:fast` passes.
- [ ] **Task 8:** Server `layout-command` → `ws.ts` window event → `app.ts` → `mux-dock.handleLayoutCommand` (logs + emits `layout-command-received`); `check:fast` passes.
- [ ] `go build ./... && go test ./internal/sessiond/...` is green.
- [ ] `cd web && npm run check:fast` is green.
- [ ] Eight conventional commits, one per task.
