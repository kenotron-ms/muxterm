# sessiond Core (Phase 1) Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Build the standalone `sessiond` daemon package — a Unix-socket server that owns PTYs, keeps per-pane scrollback, manages workspaces, and broadcasts composition/lifecycle events over the **frozen v1 wire contract** — fully testable in isolation (no web, no tmux, no subcommand wiring).

**Architecture:** A single Go package `internal/sessiond/`. A `Server` listens on a Unix socket and speaks the framed protocol **defined and owned by Phase 0** (`protocol.go`). A `Registry` is the single source of truth holding `Workspace`s, each owning `Pane`s. A `Pane` wraps one `creack/pty` PTY, feeds a `PaneBuffer` (the v1 `RawBuffer`), and broadcasts output. Each connected client is a `subscriber`: a **bounded queue drained by a dedicated writer goroutine**, so a slow client can never block the PTY drain or other clients. A connection is bound to exactly one workspace via `attach`; `create-pane`/`resize`/keyboard-`input` are connection-scoped.

**Tech Stack:** Go 1.24, module `github.com/user/muxterm`. External dep: `github.com/creack/pty` (already in `go.mod`; this phase makes it a direct dependency). Tests: stdlib `testing` only (NO testify). NO `charmbracelet` dependency in Phase 1.

---

## ⚠️ Depends on Phase 0 (read first)

**Phase 0 (`docs/plans/2026-06-02-session-persistence-phase0-wire-contract-implementation.md`) MUST be implemented before this phase.** Phase 0 produces and **owns** the wire contract in `internal/sessiond/protocol.go` + `internal/sessiond/protocol_test.go`. **Phase 1 does NOT create, edit, or duplicate those files** — it imports the symbols they define.

The frozen symbols Phase 1 consumes (do **not** redefine any of them):

- **Frame kinds:** `FrameControl` (`0x01`), `FramePaneData` (`0x02`)
- **Framing helpers:**
  - `WriteControl(w io.Writer, msg *Message) error`
  - `WritePaneData(w io.Writer, paneID uint32, data []byte) error`
  - `ReadFrame(r io.Reader) (kind byte, payload []byte, err error)`  ← **3 return values**
  - `DecodePaneData(payload []byte) (paneID uint32, data []byte)`
  - **There is NO `DecodeControl` helper.** To decode a control payload, call `json.Unmarshal(payload, &msg)` directly.
- **Structs:** `Message` (envelope), `WorkspaceInfo`, `PaneInfo`. Note the field is `WorkspaceInfo.WorkspaceID` (NOT `ID`), and `Message.CID uint64`, `Message.Code` / `Message.Error` for the error envelope.
- **Type constants:** `TypeCreateWorkspace`, `TypeListWorkspaces`, `TypeRenameWorkspace`, `TypeCloseWorkspace`, `TypeAttach`, `TypeCreatePane`, `TypeResize`, `TypeWorkspaceCreated`, `TypeWorkspaceList`, `TypeComposition`, `TypePaneCreated`, `TypeOK`, `TypePaneAdded`, `TypePaneClosed`, `TypeWorkspaceClosed`, `TypeWorkspaceRenamed`, `TypeError`.
- **Error codes:** `CodeUnknownWorkspace`, `CodePaneSpawnFailed`.

The `Message` envelope (frozen — for reference only, defined in Phase 0's `protocol.go`):

```go
type Message struct {
	Type        string          `json:"type"`
	CID         uint64          `json:"cid,omitempty"`        // request/reply correlation; 0 = unsolicited event
	WorkspaceID string          `json:"workspaceId,omitempty"`
	Name        string          `json:"name,omitempty"`
	PaneID      int             `json:"paneId,omitempty"`     // workspace-local
	Cols        int             `json:"cols,omitempty"`
	Rows        int             `json:"rows,omitempty"`
	Cmd         []string        `json:"cmd,omitempty"`        // argv; empty => default $SHELL
	Title       string          `json:"title,omitempty"`
	Workspaces  []WorkspaceInfo `json:"workspaces,omitempty"`
	Panes       []PaneInfo      `json:"panes,omitempty"`
	Code        string          `json:"code,omitempty"`       // error code
	Error       string          `json:"error,omitempty"`      // human-readable error text
}
```

> **omitempty caveat (matters for tests):** an empty `Panes` slice marshals as an **absent** `panes` field and decodes back to `nil`. The `composition` reply is still sent (never silence) — its absence-of-panes simply means "no panes". Tests assert `len(panes) == 0`, **not** non-nil.

---

## Scope & Boundaries

**This is Phase 1 of 5.** Stay strictly inside it.

**IN scope (this plan):** the `internal/sessiond/` package — `buffer.go`, `pane.go`, `registry.go`, `workspace.go`, `subscriber.go`, `server.go`, `peercred_linux.go`, `peercred_other.go`, a `_test.go` per file, and one integration test. **All wire I/O uses the frozen Phase 0 `Message`/types/helpers.**

**OUT of scope (later phases — do NOT touch):**
- `protocol.go` / `protocol_test.go` → **owned by Phase 0**. Import, never edit.
- Subcommand wiring / auto-spawn / `SocketPath()` / `DefaultLogPath()` / `EnsureDaemon()` / systemd → **Phase 2**. (Phase 1 implements only `NewServer` + `ListenAndServe`.)
- Web `serve` integration & tmux `-CC` removal → **Phase 3**.
- Browser multiplexer → **Phase 4**.
- `TrackedBuffer` / `VTBuffer` and real OSC-title parsing → **Phase 5**. Phase 1 uses `RawBuffer` and a plain, settable `Title string` field that nothing populates yet.

**Design source of truth:** `docs/plans/2026-06-01-session-persistence-design.md` → section **"## Wire Protocol (frozen v1 contract)"**. It is authoritative for the protocol, the connection/delivery model (backpressure + replay-before-live), server lifecycle signatures, and pane/socket security. This plan conforms to it exactly.

---

## Conventions (apply to every task)

**Run a single test:**
```
go test ./internal/sessiond/ -run TestName -v
```
**Run all package tests (with the race detector):**
```
go test ./internal/sessiond/ -race -v
```
**Expected FAIL before an implementation file exists** looks like:
```
# github.com/user/muxterm/internal/sessiond [build failed]
./somefile_test.go:NN:MM: undefined: SomeSymbol
FAIL    github.com/user/muxterm/internal/sessiond [build failed]
```

**Commit message convention:** Conventional Commits. End **every** commit body with exactly:
```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```
Use `git add <paths> && git commit -m "<subject>" -m "<body>"`. **Never** run `git push`, merge, or open a PR.

**Task order (each a strict TDD micro-cycle):** verify Phase 0 → buffer → pane → registry → workspace → subscriber → server → integration test.

---

## Task 0: Confirm Phase 0 is present

This phase builds on Phase 0's `protocol.go`. Verify it exists and the package compiles before adding anything.

**Step 1: Confirm the protocol file and key symbols exist**
Run:
```
ls internal/sessiond/protocol.go && go doc ./internal/sessiond/ ReadFrame
```
Expected: the file lists, and `go doc` prints the signature `func ReadFrame(r io.Reader) (kind byte, payload []byte, err error)`. If either fails, **stop** — Phase 0 must be implemented first.

**Step 2: Confirm the existing protocol tests are green**
Run:
```
go test ./internal/sessiond/ -run 'TestMessage|TestWriteControl|TestReadFrame|TestWritePaneData|TestDecodePaneData|TestTypeConstants' -v
```
Expected: all Phase 0 protocol tests `PASS`, ending in `ok  github.com/user/muxterm/internal/sessiond`.

No commit (no changes). Proceed to Task 1.

---

## Task 1: Buffer — `PaneBuffer` interface + `RawBuffer`

**Files:**
- Create: `internal/sessiond/buffer.go`
- Test: `internal/sessiond/buffer_test.go`

**Step 1: Write the failing test**

Create `internal/sessiond/buffer_test.go`:
```go
package sessiond

import (
	"bytes"
	"testing"
)

func TestRawBufferReplayRoundTrip(t *testing.T) {
	b := NewRawBuffer(1024)
	if _, err := b.Write([]byte("hello ")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := b.Write([]byte("world\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got := string(b.Replay()); got != "hello world\n" {
		t.Errorf("Replay = %q, want %q", got, "hello world\n")
	}
}

func TestRawBufferTrimsAtNewlineBoundary(t *testing.T) {
	// budget 8; write 11 bytes so a trim is forced.
	b := NewRawBuffer(8)
	if _, err := b.Write([]byte("123\n456\n789")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got := b.Replay()
	// cut point = len(11) - budget(8) = 3; first newline at/after index 3 is the
	// '\n' at index 3, so bytes are dropped through it, leaving "456\n789".
	if string(got) != "456\n789" {
		t.Errorf("Replay = %q, want %q", got, "456\n789")
	}
	if len(got) > 8 {
		t.Errorf("retained %d bytes, want <= budget 8", len(got))
	}
	if bytes.HasPrefix(got, []byte("\n")) {
		t.Errorf("retained data starts with a newline: %q", got)
	}
}

func TestRawBufferReplayReturnsCopy(t *testing.T) {
	b := NewRawBuffer(1024)
	b.Write([]byte("abc"))
	r := b.Replay()
	r[0] = 'X' // mutate the returned slice
	if string(b.Replay()) != "abc" {
		t.Errorf("Replay returned an aliased slice; internal state was mutated")
	}
}

func TestRawBufferImplementsPaneBuffer(t *testing.T) {
	var _ PaneBuffer = NewRawBuffer(0) // compile-time interface assertion
}
```

**Step 2: Run the test to verify it fails**
Run:
```
go test ./internal/sessiond/ -run TestRawBuffer -v
```
Expected: FAIL — `undefined: NewRawBuffer`, `undefined: PaneBuffer`.

**Step 3: Write the implementation**

Create `internal/sessiond/buffer.go`:
```go
package sessiond

import (
	"bytes"
	"sync"
)

// defaultBufferBudget is the RawBuffer byte budget when an explicit budget of
// <= 0 is requested. ~1 MiB is roughly 10k lines of typical terminal output.
const defaultBufferBudget = 1 << 20

// PaneBuffer is the per-pane scrollback seam. v1 ships RawBuffer; the richer
// TrackedBuffer (x/ansi) and VTBuffer (x/vt) are deferred to Phase 5 and slot
// in behind this interface without touching the daemon or protocol.
type PaneBuffer interface {
	// Write appends raw PTY output to the buffer.
	Write(p []byte) (int, error)
	// Replay returns a copy of the retained bytes to send to a fresh client.
	Replay() []byte
}

// RawBuffer is the v1 default: a budgeted byte ring with newline-boundary
// trimming and raw replay. Zero external dependencies. Replay is byte-identical
// because xterm.js (the client) is itself the VT emulator.
type RawBuffer struct {
	mu     sync.Mutex
	buf    []byte
	budget int
}

// NewRawBuffer returns a RawBuffer with the given byte budget. A budget <= 0
// uses defaultBufferBudget.
func NewRawBuffer(budget int) *RawBuffer {
	if budget <= 0 {
		budget = defaultBufferBudget
	}
	return &RawBuffer{budget: budget}
}

func (b *RawBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	b.trimLocked()
	return len(p), nil
}

// trimLocked drops the oldest bytes when over budget, cutting at the nearest
// newline at or after the minimum cut point so lines (and, in the common case,
// escape sequences) are never severed. Caller must hold b.mu.
func (b *RawBuffer) trimLocked() {
	if len(b.buf) <= b.budget {
		return
	}
	cut := len(b.buf) - b.budget
	if idx := bytes.IndexByte(b.buf[cut:], '\n'); idx >= 0 {
		cut = cut + idx + 1 // drop through the newline
	}
	retained := make([]byte, len(b.buf)-cut)
	copy(retained, b.buf[cut:])
	b.buf = retained
}

func (b *RawBuffer) Replay() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]byte, len(b.buf))
	copy(out, b.buf)
	return out
}
```

**Step 4: Run the test to verify it passes**
Run:
```
go test ./internal/sessiond/ -run TestRawBuffer -v
```
Expected: `--- PASS` for all four, then `ok`.

**Step 5: Quality check**
Run:
```
go vet ./internal/sessiond/ && gofmt -l internal/sessiond/
```
Expected: no output.

**Step 6: Commit**
```
git add internal/sessiond/buffer.go internal/sessiond/buffer_test.go
git commit -m "feat(sessiond): add PaneBuffer interface and RawBuffer v1 default" -m "$(printf 'RawBuffer is a budgeted byte ring with newline-boundary trimming and\nbyte-identical raw replay; zero external deps. TrackedBuffer/VTBuffer are\ndeferred (Phase 5) behind the same interface.\n\n🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

## Task 2: Pane — PTY wrapper on `creack/pty` (env + cwd + size)

**Files:**
- Create: `internal/sessiond/pane.go`
- Test: `internal/sessiond/pane_test.go`
- Modify: `go.mod` / `go.sum` (promote `creack/pty` to a direct dependency via `go mod tidy`)

**Step 1: Write the failing test**

Create `internal/sessiond/pane_test.go`:
```go
package sessiond

import (
	"bytes"
	"os"
	"testing"
	"time"
)

// waitExit waits up to d for the pane to signal exit, returning the reported localID.
func waitExit(t *testing.T, ch <-chan int, d time.Duration) int {
	t.Helper()
	select {
	case id := <-ch:
		return id
	case <-time.After(d):
		t.Fatalf("timed out waiting for pane exit")
		return 0
	}
}

func TestPaneEchoThenExit(t *testing.T) {
	exitCh := make(chan int, 1)
	p, err := NewPane(1, []string{"echo", "hello-pane"}, 80, 24,
		NewRawBuffer(0),
		nil, // onData not needed; we assert via Replay after exit
		func(id int) { exitCh <- id },
	)
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()

	if id := waitExit(t, exitCh, 3*time.Second); id != 1 {
		t.Fatalf("exit localID = %d, want 1", id)
	}
	if !bytes.Contains(p.Replay(), []byte("hello-pane")) {
		t.Fatalf("Replay = %q, missing %q", p.Replay(), "hello-pane")
	}
}

func TestPaneInputIsEchoed(t *testing.T) {
	dataCh := make(chan []byte, 64)
	p, err := NewPane(2, []string{"cat"}, 80, 24,
		NewRawBuffer(0),
		func(id int, d []byte) {
			cp := make([]byte, len(d))
			copy(cp, d)
			dataCh <- cp
		},
		nil,
	)
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()

	if err := p.Write([]byte("ping\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	var acc []byte
	deadline := time.After(3 * time.Second)
	for {
		select {
		case d := <-dataCh:
			acc = append(acc, d...)
			if bytes.Contains(acc, []byte("ping")) {
				return // success
			}
		case <-deadline:
			t.Fatalf("did not see echoed input; got %q", acc)
		}
	}
}

func TestPaneResizeUpdatesInfo(t *testing.T) {
	p, err := NewPane(3, []string{"cat"}, 80, 24, NewRawBuffer(0), nil, nil)
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()

	if err := p.Resize(100, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	info := p.Info()
	if info.PaneID != 3 || info.Cols != 100 || info.Rows != 30 {
		t.Errorf("Info after resize = %+v, want {PaneID:3 Cols:100 Rows:30}", info)
	}
}

func TestPaneDefaultArgvUsesShell(t *testing.T) {
	// Empty argv must fall back to a shell rather than erroring.
	p, err := NewPane(5, nil, 80, 24, NewRawBuffer(0), nil, nil)
	if err != nil {
		t.Fatalf("NewPane with empty argv: %v", err)
	}
	defer p.Close()
}

func TestPaneEnvAndCwd(t *testing.T) {
	home := os.Getenv("HOME")
	if home == "" {
		t.Skip("HOME not set in test environment")
	}
	p, err := NewPane(6, []string{"sh", "-c", "printf 'TERM=%s\\nPWD=%s\\n' \"$TERM\" \"$PWD\""},
		80, 24, NewRawBuffer(0), nil, nil)
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()

	deadline := time.After(3 * time.Second)
	for {
		out := p.Replay()
		if bytes.Contains(out, []byte("TERM=xterm-256color")) &&
			bytes.Contains(out, []byte("PWD="+home)) {
			return // success
		}
		select {
		case <-deadline:
			t.Fatalf("env/cwd not reflected; got %q (want TERM=xterm-256color, PWD=%s)", out, home)
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestPaneTitleFieldIsSettable(t *testing.T) {
	// Phase 1: Title is a plain settable field; OSC-title capture is Phase 5.
	p, err := NewPane(4, []string{"cat"}, 80, 24, NewRawBuffer(0), nil, nil)
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()
	p.Title = "vim main.go"
	if p.Info().Title != "vim main.go" {
		t.Errorf("Info().Title = %q, want %q", p.Info().Title, "vim main.go")
	}
}
```

**Step 2: Run the test to verify it fails**
Run:
```
go test ./internal/sessiond/ -run TestPane -v
```
Expected: FAIL — `undefined: NewPane`.

**Step 3: Write the implementation**

Create `internal/sessiond/pane.go`:
```go
package sessiond

import (
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// Pane owns exactly one PTY + child process and a PaneBuffer of its output.
// It streams output to a PaneBuffer and an onData callback, and signals process
// exit via an onExit callback. There is no split/layout logic here.
type Pane struct {
	LocalID int

	// Title is the pane's display title. In Phase 1 it is a plain settable
	// field that nothing populates; OSC 0/2 title capture arrives in Phase 5.
	Title string

	mu   sync.Mutex // guards cols/rows
	cols int
	rows int

	cmd  *exec.Cmd
	ptmx *os.File
	buf  PaneBuffer

	onData func(localID int, data []byte)
	onExit func(localID int)

	closeOnce sync.Once
}

// resolveArgv returns a runnable argv. An empty argv falls back to $SHELL
// (or /bin/sh).
func resolveArgv(argv []string) []string {
	if len(argv) == 0 {
		sh := os.Getenv("SHELL")
		if sh == "" {
			sh = "/bin/sh"
		}
		return []string{sh}
	}
	return argv
}

// NewPane forks a PTY running argv at the given size, wires its output to buf
// and onData, and invokes onExit exactly once when the process exits. onData and
// onExit may be nil. Forked panes inherit the daemon's environment plus
// TERM=xterm-256color, with a default working directory of $HOME.
func NewPane(
	localID int,
	argv []string,
	cols, rows int,
	buf PaneBuffer,
	onData func(localID int, data []byte),
	onExit func(localID int),
) (*Pane, error) {
	if buf == nil {
		buf = NewRawBuffer(0)
	}
	argv = resolveArgv(argv)
	c := exec.Command(argv[0], argv[1:]...)
	c.Env = append(os.Environ(), "TERM=xterm-256color")
	if home := os.Getenv("HOME"); home != "" {
		c.Dir = home
	}
	ws := &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
	ptmx, err := pty.StartWithSize(c, ws)
	if err != nil {
		return nil, fmt.Errorf("sessiond: start pane pty: %w", err)
	}
	p := &Pane{
		LocalID: localID,
		cols:    cols,
		rows:    rows,
		cmd:     c,
		ptmx:    ptmx,
		buf:     buf,
		onData:  onData,
		onExit:  onExit,
	}
	go p.readLoop()
	return p, nil
}

func (p *Pane) readLoop() {
	chunk := make([]byte, 32*1024)
	for {
		n, err := p.ptmx.Read(chunk)
		if n > 0 {
			data := chunk[:n]
			_, _ = p.buf.Write(data)
			if p.onData != nil {
				cp := make([]byte, n)
				copy(cp, data)
				p.onData(p.LocalID, cp)
			}
		}
		if err != nil {
			break
		}
	}
	_ = p.cmd.Wait()
	if p.onExit != nil {
		p.onExit(p.LocalID)
	}
}

// Write sends input bytes to the PTY (the child's stdin).
func (p *Pane) Write(input []byte) error {
	_, err := p.ptmx.Write(input)
	return err
}

// Resize sets the PTY window size; the child program reflows.
func (p *Pane) Resize(cols, rows int) error {
	p.mu.Lock()
	p.cols, p.rows = cols, rows
	p.mu.Unlock()
	return pty.Setsize(p.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

// Replay returns the pane's retained scrollback.
func (p *Pane) Replay() []byte { return p.buf.Replay() }

// Info returns the pane's current PaneInfo (frozen wire struct).
func (p *Pane) Info() PaneInfo {
	p.mu.Lock()
	cols, rows := p.cols, p.rows
	p.mu.Unlock()
	return PaneInfo{PaneID: p.LocalID, Cols: cols, Rows: rows, Title: p.Title}
}

// Close kills the child process and closes the PTY. Closing the PTY ends the
// read loop, which then drives the onExit callback. Safe to call repeatedly.
func (p *Pane) Close() {
	p.closeOnce.Do(func() {
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		_ = p.ptmx.Close()
	})
}
```

**Step 4: Promote `creack/pty` to a direct dependency**
Run:
```
go mod tidy
```
Then verify:
```
grep creack go.mod
```
Expected: a line like `github.com/creack/pty v1.1.24` **without** `// indirect`.

**Step 5: Run the test to verify it passes**
Run:
```
go test ./internal/sessiond/ -run TestPane -v
```
Expected: `--- PASS` for all pane tests, then `ok`.

**Step 6: Quality check**
Run:
```
go vet ./internal/sessiond/ && gofmt -l internal/sessiond/
```
Expected: no output.

**Step 7: Commit**
```
git add internal/sessiond/pane.go internal/sessiond/pane_test.go go.mod go.sum
git commit -m "feat(sessiond): add Pane wrapping creack/pty with env, cwd, and exit signal" -m "$(printf 'Pane forks a PTY (argv with $SHELL fallback), inherits the daemon env plus\nTERM=xterm-256color and cwd $HOME, streams output to a PaneBuffer + onData,\nwrites input, resizes via pty.Setsize, and fires onExit once on exit. Info()\nreports the frozen PaneInfo. Promotes creack/pty to a direct dependency.\n\n🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

## Task 3: Registry — workspaces + panes data structure

**Files:**
- Create: `internal/sessiond/registry.go`
- Test: `internal/sessiond/registry_test.go`

**Step 1: Write the failing test**

Create `internal/sessiond/registry_test.go`:
```go
package sessiond

import "testing"

func TestRegistryAddAndGetWorkspace(t *testing.T) {
	r := NewRegistry()
	w1 := r.AddWorkspace("")    // unnamed
	w2 := r.AddWorkspace("dev") // named

	if w1.ID == w2.ID {
		t.Fatalf("workspace ids collide: %q", w1.ID)
	}
	if w1.Name != "" {
		t.Errorf("w1.Name = %q, want empty", w1.Name)
	}
	if w2.Name != "dev" {
		t.Errorf("w2.Name = %q, want %q", w2.Name, "dev")
	}
	if !r.Has(w1.ID) {
		t.Errorf("Has(%q) = false, want true", w1.ID)
	}
	if r.Has("nope") {
		t.Errorf("Has(nope) = true, want false")
	}
	got, ok := r.Get(w2.ID)
	if !ok || got.ID != w2.ID {
		t.Errorf("Get(%q) = %v,%v", w2.ID, got, ok)
	}
}

func TestRegistryPaneIDsAreWorkspaceLocal(t *testing.T) {
	r := NewRegistry()
	a := r.AddWorkspace("")
	b := r.AddWorkspace("")

	id1, ok := r.AllocPaneID(a.ID)
	if !ok || id1 != 1 {
		t.Fatalf("AllocPaneID(a) = %d,%v, want 1,true", id1, ok)
	}
	id2, _ := r.AllocPaneID(a.ID)
	if id2 != 2 {
		t.Fatalf("second AllocPaneID(a) = %d, want 2", id2)
	}
	idB, _ := r.AllocPaneID(b.ID)
	if idB != 1 {
		t.Fatalf("AllocPaneID(b) = %d, want 1 (workspace-local)", idB)
	}
	if _, ok := r.AllocPaneID("unknown"); ok {
		t.Errorf("AllocPaneID(unknown) ok = true, want false")
	}
}

func TestRegistryPutGetRemovePane(t *testing.T) {
	r := NewRegistry()
	w := r.AddWorkspace("")
	// A zero-value Pane carries no PTY, which is fine: the Registry only stores
	// and indexes the pointer by LocalID.
	p1 := &Pane{LocalID: 1}
	p2 := &Pane{LocalID: 2}
	if !r.PutPane(w.ID, p1) || !r.PutPane(w.ID, p2) {
		t.Fatal("PutPane returned false")
	}

	ids := r.PaneIDs(w.ID)
	if len(ids) != 2 {
		t.Fatalf("PaneIDs len = %d, want 2", len(ids))
	}

	got, ok := r.Pane(w.ID, 2)
	if !ok || got != p2 {
		t.Errorf("Pane(2) = %v,%v", got, ok)
	}

	removed, remaining, ok := r.RemovePane(w.ID, 1)
	if !ok || removed != p1 || remaining != 1 {
		t.Errorf("RemovePane(1) = %v,%d,%v; want p1,1,true", removed, remaining, ok)
	}
	if _, _, ok := r.RemovePane(w.ID, 1); ok {
		t.Errorf("RemovePane(1) twice ok = true, want false")
	}
}

func TestRegistryListReportsWorkspaceInfo(t *testing.T) {
	r := NewRegistry()
	w := r.AddWorkspace("ops")
	r.PutPane(w.ID, &Pane{LocalID: 1})

	list := r.List()
	if len(list) != 1 {
		t.Fatalf("List len = %d, want 1", len(list))
	}
	// WorkspaceInfo uses the frozen field name WorkspaceID (NOT ID).
	if list[0].WorkspaceID != w.ID || list[0].Name != "ops" || list[0].PaneCount != 1 {
		t.Errorf("List[0] = %+v, want {WorkspaceID:%s Name:ops PaneCount:1}", list[0], w.ID)
	}
}

func TestRegistryPaneInfosReportsFrozenPaneInfo(t *testing.T) {
	r := NewRegistry()
	w := r.AddWorkspace("")
	p := &Pane{LocalID: 1, Title: "shell"}
	p.cols, p.rows = 80, 24
	r.PutPane(w.ID, p)

	infos := r.PaneInfos(w.ID)
	if len(infos) != 1 {
		t.Fatalf("PaneInfos len = %d, want 1", len(infos))
	}
	if infos[0] != (PaneInfo{PaneID: 1, Cols: 80, Rows: 24, Title: "shell"}) {
		t.Errorf("PaneInfos[0] = %+v, want {1 80 24 shell}", infos[0])
	}
	if r.PaneInfos("unknown") != nil {
		t.Errorf("PaneInfos(unknown) = non-nil, want nil")
	}
}
```

**Step 2: Run the test to verify it fails**
Run:
```
go test ./internal/sessiond/ -run TestRegistry -v
```
Expected: FAIL — `undefined: NewRegistry`.

**Step 3: Write the implementation**

Create `internal/sessiond/registry.go`:
```go
package sessiond

import (
	"fmt"
	"sort"
	"sync"
)

// Workspace is the persistence unit: a set of live panes plus an optional
// display name. Its panes map is keyed by workspace-local pane id. All access
// is serialized through the owning Registry's mutex.
type Workspace struct {
	ID         string
	Name       string // optional display label; "" == unnamed
	Panes      map[int]*Pane
	nextPaneID int
}

// Registry is the single source of truth: workspaces keyed by id. There is no
// global pane map; panes live inside their workspace.
type Registry struct {
	mu         sync.Mutex
	workspaces map[string]*Workspace
	nextWSID   int
}

// NewRegistry returns an empty Registry.
func NewRegistry() *Registry {
	return &Registry{workspaces: make(map[string]*Workspace)}
}

// addWorkspaceLocked allocates an id and inserts a new workspace. Caller must
// hold r.mu. Shared by AddWorkspace and the lifecycle helpers in workspace.go.
func (r *Registry) addWorkspaceLocked(name string) *Workspace {
	r.nextWSID++
	id := fmt.Sprintf("w%d", r.nextWSID)
	ws := &Workspace{ID: id, Name: name, Panes: make(map[int]*Pane)}
	r.workspaces[id] = ws
	return ws
}

// AddWorkspace creates a workspace with the given (optional) name.
func (r *Registry) AddWorkspace(name string) *Workspace {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.addWorkspaceLocked(name)
}

// Get returns the workspace for id.
func (r *Registry) Get(id string) (*Workspace, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[id]
	return ws, ok
}

// Has reports whether a workspace id exists.
func (r *Registry) Has(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.workspaces[id]
	return ok
}

// List returns a deterministic snapshot of workspace info (frozen WorkspaceInfo).
func (r *Registry) List() []WorkspaceInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]WorkspaceInfo, 0, len(r.workspaces))
	for _, ws := range r.workspaces {
		out = append(out, WorkspaceInfo{WorkspaceID: ws.ID, Name: ws.Name, PaneCount: len(ws.Panes)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WorkspaceID < out[j].WorkspaceID })
	return out
}

// AllocPaneID reserves the next workspace-local pane id (starting at 1).
func (r *Registry) AllocPaneID(wsID string) (int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return 0, false
	}
	ws.nextPaneID++
	return ws.nextPaneID, true
}

// PutPane inserts a pane (keyed by p.LocalID) into a workspace.
func (r *Registry) PutPane(wsID string, p *Pane) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return false
	}
	ws.Panes[p.LocalID] = p
	return true
}

// Pane returns a pane pointer by (workspaceId, localPaneId).
func (r *Registry) Pane(wsID string, paneID int) (*Pane, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil, false
	}
	p, ok := ws.Panes[paneID]
	return p, ok
}

// PaneIDs returns a deterministic snapshot of a workspace's pane ids.
func (r *Registry) PaneIDs(wsID string) []int {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil
	}
	ids := make([]int, 0, len(ws.Panes))
	for id := range ws.Panes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	return ids
}

// PaneInfos returns a deterministic snapshot of a workspace's panes as frozen
// PaneInfo values (used to build the composition reply). Returns nil for an
// unknown workspace.
func (r *Registry) PaneInfos(wsID string) []PaneInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil
	}
	ids := make([]int, 0, len(ws.Panes))
	for id := range ws.Panes {
		ids = append(ids, id)
	}
	sort.Ints(ids)
	out := make([]PaneInfo, 0, len(ids))
	for _, id := range ids {
		out = append(out, ws.Panes[id].Info())
	}
	return out
}

// RemovePane deletes a pane and returns it plus the number of panes remaining
// in the workspace.
func (r *Registry) RemovePane(wsID string, paneID int) (*Pane, int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok {
		return nil, 0, false
	}
	p, ok := ws.Panes[paneID]
	if !ok {
		return nil, len(ws.Panes), false
	}
	delete(ws.Panes, paneID)
	return p, len(ws.Panes), true
}
```

> Note: `PaneInfos` calls `Pane.Info()`, which takes the pane's own `mu`. Calling it while holding `r.mu` is safe — `Pane.Info()` never calls back into the Registry, so there is no lock cycle.

**Step 4: Run the test to verify it passes**
Run:
```
go test ./internal/sessiond/ -run TestRegistry -v
```
Expected: `--- PASS` for all five, then `ok`.

**Step 5: Quality check**
Run:
```
go vet ./internal/sessiond/ && gofmt -l internal/sessiond/
```
Expected: no output.

**Step 6: Commit**
```
git add internal/sessiond/registry.go internal/sessiond/registry_test.go
git commit -m "feat(sessiond): add Registry as the single source of truth for workspaces" -m "$(printf 'Registry holds workspaces keyed by daemon-allocated id; panes live inside\ntheir workspace with workspace-local ids. Locked CRUD plus List()/PaneInfos()\nthat emit the frozen WorkspaceInfo/PaneInfo wire structs for list + composition.\n\n🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

## Task 4: Workspace lifecycle — cold-start, rename, reap, close

**Files:**
- Create: `internal/sessiond/workspace.go`
- Test: `internal/sessiond/workspace_test.go`

**Step 1: Write the failing test**

Create `internal/sessiond/workspace_test.go`:
```go
package sessiond

import "testing"

func TestEnsureDefaultColdStartCreatesUnnamed(t *testing.T) {
	r := NewRegistry()
	ws := r.EnsureDefault()
	if ws == nil {
		t.Fatal("EnsureDefault returned nil on empty registry")
	}
	if ws.Name != "" {
		t.Errorf("default workspace Name = %q, want empty (unnamed)", ws.Name)
	}
	if len(r.List()) != 1 {
		t.Fatalf("workspace count = %d, want 1", len(r.List()))
	}
}

func TestEnsureDefaultNoOpWhenNonEmpty(t *testing.T) {
	r := NewRegistry()
	existing := r.AddWorkspace("dev")
	ws := r.EnsureDefault()
	if ws.ID != existing.ID {
		t.Errorf("EnsureDefault returned %q, want existing %q", ws.ID, existing.ID)
	}
	if len(r.List()) != 1 {
		t.Errorf("workspace count = %d, want 1 (no new default)", len(r.List()))
	}
}

func TestRenameWorkspace(t *testing.T) {
	r := NewRegistry()
	w := r.AddWorkspace("")
	if !r.RenameWorkspace(w.ID, "prod") {
		t.Fatal("RenameWorkspace returned false for known id")
	}
	got, _ := r.Get(w.ID)
	if got.Name != "prod" {
		t.Errorf("Name = %q, want %q", got.Name, "prod")
	}
	if !r.RenameWorkspace(w.ID, "") {
		t.Fatal("RenameWorkspace to empty returned false")
	}
	got, _ = r.Get(w.ID)
	if got.Name != "" {
		t.Errorf("Name = %q, want empty after clear", got.Name)
	}
	if r.RenameWorkspace("unknown", "x") {
		t.Error("RenameWorkspace(unknown) = true, want false")
	}
}

func TestReapIfEmpty(t *testing.T) {
	r := NewRegistry()
	a := r.AddWorkspace("")
	b := r.AddWorkspace("")
	r.PutPane(b.ID, &Pane{LocalID: 1})

	if removed, def := r.ReapIfEmpty(b.ID); removed || def != nil {
		t.Errorf("ReapIfEmpty(b non-empty) = %v,%v; want false,nil", removed, def)
	}
	removed, def := r.ReapIfEmpty(a.ID)
	if !removed || def != nil {
		t.Errorf("ReapIfEmpty(a) = %v,%v; want true,nil", removed, def)
	}
	if r.Has(a.ID) {
		t.Error("workspace a still present after reap")
	}
}

func TestReapLastWorkspaceRecreatesDefault(t *testing.T) {
	r := NewRegistry()
	a := r.AddWorkspace("only")
	removed, def := r.ReapIfEmpty(a.ID)
	if !removed {
		t.Fatal("ReapIfEmpty(only) removed = false, want true")
	}
	if def == nil {
		t.Fatal("expected a fresh default to be recreated when registry empties")
	}
	if def.Name != "" {
		t.Errorf("recreated default Name = %q, want empty", def.Name)
	}
	if len(r.List()) != 1 {
		t.Errorf("workspace count = %d, want 1 (the recreated default)", len(r.List()))
	}
}

func TestCloseWorkspaceReturnsPanes(t *testing.T) {
	r := NewRegistry()
	_ = r.AddWorkspace("keep")
	w := r.AddWorkspace("")
	p := &Pane{LocalID: 1}
	r.PutPane(w.ID, p)

	panes, def, ok := r.CloseWorkspace(w.ID)
	if !ok {
		t.Fatal("CloseWorkspace ok = false, want true")
	}
	if len(panes) != 1 || panes[0] != p {
		t.Errorf("returned panes = %v, want [p]", panes)
	}
	if def != nil {
		t.Errorf("def = %v, want nil (another workspace survives)", def)
	}
	if r.Has(w.ID) {
		t.Error("workspace still present after CloseWorkspace")
	}
	if _, _, ok := r.CloseWorkspace("unknown"); ok {
		t.Error("CloseWorkspace(unknown) ok = true, want false")
	}
}
```

**Step 2: Run the test to verify it fails**
Run:
```
go test ./internal/sessiond/ -run 'TestEnsureDefault|TestRename|TestReap|TestCloseWorkspace' -v
```
Expected: FAIL — `undefined: (*Registry).EnsureDefault`, etc.

**Step 3: Write the implementation**

Create `internal/sessiond/workspace.go`:
```go
package sessiond

import "sort"

// EnsureDefault guarantees at least one workspace exists (the cold-start rule).
// On an empty registry it creates a single unnamed default and returns it.
// Otherwise it returns the lowest-id existing workspace and creates nothing.
func (r *Registry) EnsureDefault() *Workspace {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.workspaces) == 0 {
		return r.addWorkspaceLocked("")
	}
	ids := make([]string, 0, len(r.workspaces))
	for id := range r.workspaces {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return r.workspaces[ids[0]]
}

// RenameWorkspace sets (or clears, when name == "") a workspace's display
// label. No uniqueness check: ids are the key. Returns false for unknown ids.
func (r *Registry) RenameWorkspace(id, name string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[id]
	if !ok {
		return false
	}
	ws.Name = name
	return true
}

// ReapIfEmpty removes a workspace iff it has no panes (tmux-parity auto-reap).
// If that removal leaves the registry empty, a fresh unnamed default is created
// and returned so the next attach always lands somewhere. Returns
// (removed, recreatedDefault). recreatedDefault is nil unless a default was made.
func (r *Registry) ReapIfEmpty(wsID string) (bool, *Workspace) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, ok := r.workspaces[wsID]
	if !ok || len(ws.Panes) > 0 {
		return false, nil
	}
	delete(r.workspaces, wsID)
	if len(r.workspaces) == 0 {
		return true, r.addWorkspaceLocked("")
	}
	return true, nil
}

// CloseWorkspace removes a workspace and returns its panes so the caller can
// kill them (the Registry never touches PTYs). If removal empties the registry,
// a fresh unnamed default is created and returned as recreatedDefault.
func (r *Registry) CloseWorkspace(id string) (panes []*Pane, recreatedDefault *Workspace, ok bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ws, exists := r.workspaces[id]
	if !exists {
		return nil, nil, false
	}
	for _, p := range ws.Panes {
		panes = append(panes, p)
	}
	delete(r.workspaces, id)
	if len(r.workspaces) == 0 {
		recreatedDefault = r.addWorkspaceLocked("")
	}
	return panes, recreatedDefault, true
}
```

**Step 4: Run the test to verify it passes**
Run:
```
go test ./internal/sessiond/ -run 'TestEnsureDefault|TestRename|TestReap|TestCloseWorkspace' -v
```
Expected: `--- PASS` for all six, then `ok`.

**Step 5: Quality check**
Run:
```
go vet ./internal/sessiond/ && gofmt -l internal/sessiond/
```
Expected: no output.

**Step 6: Commit**
```
git add internal/sessiond/workspace.go internal/sessiond/workspace_test.go
git commit -m "feat(sessiond): add workspace lifecycle (cold-start, rename, reap, close)" -m "$(printf 'EnsureDefault enforces the cold-start rule; ReapIfEmpty auto-reaps a\nworkspace when its last pane exits and recreates a fresh default if the daemon\nempties; CloseWorkspace returns panes for the caller to kill. RenameWorkspace\nsets/clears the optional label with no uniqueness rule.\n\n🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

## Task 5: Subscriber — bounded queue + dedicated writer goroutine (backpressure)

This is the review blocker. **Every write to a client goes through a bounded queue drained by a dedicated goroutine.** Producers (the PTY read goroutine and request handlers) only ever **enqueue** — they never block on a slow socket. If a client's queue overflows, that ONE subscriber is disconnected; the PTY drain and all other clients are untouched.

**Files:**
- Create: `internal/sessiond/subscriber.go`
- Test: `internal/sessiond/subscriber_test.go`

**Step 1: Write the failing test**

Create `internal/sessiond/subscriber_test.go`:
```go
package sessiond

import (
	"bytes"
	"io"
	"sync"
	"testing"
	"time"
)

// blockingWriter blocks every Write until Close is called, simulating a client
// whose socket never drains.
type blockingWriter struct {
	release chan struct{}
	once    sync.Once
}

func newBlockingWriter() *blockingWriter { return &blockingWriter{release: make(chan struct{})} }

func (b *blockingWriter) Write(p []byte) (int, error) {
	<-b.release
	return len(p), nil
}
func (b *blockingWriter) Close() error {
	b.once.Do(func() { close(b.release) })
	return nil
}

// safeBuffer is a thread-safe io.WriteCloser collecting all bytes written.
type safeBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *safeBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}
func (s *safeBuffer) Close() error { return nil }
func (s *safeBuffer) snapshot() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]byte, s.buf.Len())
	copy(out, s.buf.Bytes())
	return out
}

// countFrames decodes as many whole frames as are present in b.
func countFrames(b []byte) int {
	r := bytes.NewReader(b)
	n := 0
	for {
		if _, _, err := ReadFrame(r); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return n
			}
			return n
		}
		n++
	}
}

func TestSubscriberStalledClientDoesNotBlockEnqueue(t *testing.T) {
	bw := newBlockingWriter()
	s := newSubscriber(bw, 4)
	defer s.Close()

	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			s.enqueuePaneData(1, []byte("x"))
		}
		close(done)
	}()

	select {
	case <-done:
		// enqueue returned without blocking even though the client is stalled.
	case <-time.After(2 * time.Second):
		t.Fatal("enqueue blocked on a stalled client")
	}

	// The stalled subscriber must have been disconnected on overflow.
	select {
	case <-s.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("stalled subscriber was not disconnected on overflow")
	}
}

func TestSubscriberStalledDoesNotStarveFastClient(t *testing.T) {
	// A stalled subscriber and a fast subscriber both receive the same fan-out.
	stalled := newSubscriber(newBlockingWriter(), 4)
	defer stalled.Close()
	fastBuf := &safeBuffer{}
	fast := newSubscriber(fastBuf, 256)
	defer fast.Close()

	const n = 50
	for i := 0; i < n; i++ {
		data := []byte("frame")
		stalled.enqueuePaneData(uint32(i), data) // never blocks
		fast.enqueuePaneData(uint32(i), data)
	}

	deadline := time.After(2 * time.Second)
	for {
		if countFrames(fastBuf.snapshot()) >= n {
			return // fast client received everything despite the stalled peer
		}
		select {
		case <-deadline:
			t.Fatalf("fast client got %d frames, want %d (stalled peer starved it)",
				countFrames(fastBuf.snapshot()), n)
		case <-time.After(10 * time.Millisecond):
		}
	}
}
```

**Step 2: Run the test to verify it fails**
Run:
```
go test ./internal/sessiond/ -run TestSubscriber -v
```
Expected: FAIL — `undefined: newSubscriber`.

**Step 3: Write the implementation**

Create `internal/sessiond/subscriber.go`:
```go
package sessiond

import (
	"io"
	"sync"
)

// defaultSubscriberDepth bounds how many frames may queue for one slow client
// before it is disconnected. Large enough to absorb a normal burst, small
// enough that a stalled client cannot consume unbounded memory.
const defaultSubscriberDepth = 256

// outFrame is one queued write: either a control message or a pane-data frame.
type outFrame struct {
	isData bool
	msg    *Message
	paneID uint32
	data   []byte
}

// subscriber serializes all writes to one client through a bounded queue drained
// by a dedicated goroutine. Producers (the PTY read goroutine and request
// handlers) only ENQUEUE; they never block on the socket. If the queue overflows
// because the client is too slow, that one subscriber is disconnected and never
// affects any other client or the PTY drain.
type subscriber struct {
	w     io.WriteCloser
	queue chan outFrame
	done  chan struct{}
	once  sync.Once
}

// newSubscriber starts the writer goroutine for w. depth <= 0 uses the default.
func newSubscriber(w io.WriteCloser, depth int) *subscriber {
	if depth <= 0 {
		depth = defaultSubscriberDepth
	}
	s := &subscriber{
		w:     w,
		queue: make(chan outFrame, depth),
		done:  make(chan struct{}),
	}
	go s.writeLoop()
	return s
}

func (s *subscriber) writeLoop() {
	for {
		select {
		case f := <-s.queue:
			var err error
			if f.isData {
				err = WritePaneData(s.w, f.paneID, f.data)
			} else {
				err = WriteControl(s.w, f.msg)
			}
			if err != nil {
				s.Close()
				return
			}
		case <-s.done:
			return
		}
	}
}

// enqueueControl queues a control message. Never blocks; overflow disconnects
// this subscriber only.
func (s *subscriber) enqueueControl(msg *Message) { s.enqueue(outFrame{msg: msg}) }

// enqueuePaneData queues a pane-data frame (the data is copied). Never blocks.
func (s *subscriber) enqueuePaneData(paneID uint32, data []byte) {
	cp := make([]byte, len(data))
	copy(cp, data)
	s.enqueue(outFrame{isData: true, paneID: paneID, data: cp})
}

func (s *subscriber) enqueue(f outFrame) {
	select {
	case <-s.done:
		return // already disconnected
	default:
	}
	select {
	case s.queue <- f:
	case <-s.done:
	default:
		// Queue full: the client is too slow. Disconnect it only.
		s.Close()
	}
}

// Close disconnects the subscriber and closes the underlying writer. Idempotent.
func (s *subscriber) Close() {
	s.once.Do(func() {
		close(s.done)
		_ = s.w.Close()
	})
}

// Done is closed when the subscriber is disconnected.
func (s *subscriber) Done() <-chan struct{} { return s.done }
```

**Step 4: Run the test to verify it passes (with the race detector)**
Run:
```
go test ./internal/sessiond/ -run TestSubscriber -race -v
```
Expected: `--- PASS` for both, no `DATA RACE`, then `ok`.

**Step 5: Quality check**
Run:
```
go vet ./internal/sessiond/ && gofmt -l internal/sessiond/
```
Expected: no output.

**Step 6: Commit**
```
git add internal/sessiond/subscriber.go internal/sessiond/subscriber_test.go
git commit -m "feat(sessiond): add per-subscriber bounded queue with writer goroutine" -m "$(printf 'Each client is a subscriber: a bounded queue drained by a dedicated writer\ngoroutine. Producers only enqueue and never block on a slow socket; on queue\noverflow that one subscriber is disconnected, never stalling the PTY drain or\nother clients. Closes the review backpressure blocker.\n\n🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

## Task 6: Server — socket lifecycle, dispatch, attach/composition, security

This wires everything to the frozen contract: `NewServer`/`ListenAndServe(ctx)` lifecycle (graceful nil-on-cancel), `cid` echo on every reply, the `composition` attach reply (replay-before-live), connection-scoped `create-pane`/`resize`/binary-`input`, socket perms `0600`/`0700`, and an `SO_PEERCRED` uid check.

**Files:**
- Create: `internal/sessiond/server.go`
- Create: `internal/sessiond/peercred_linux.go`
- Create: `internal/sessiond/peercred_other.go`
- Test: `internal/sessiond/server_test.go`

**Step 1: Write the failing test**

Create `internal/sessiond/server_test.go`:
```go
package sessiond

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// startTestServer starts a Server on a temp Unix socket under a cancellable ctx
// and returns the socket path and the server.
func startTestServer(t *testing.T) (string, *Server) {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "sessiond.sock")
	srv, err := NewServer(sock)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe(ctx) }()
	waitForSocket(t, sock)
	t.Cleanup(func() {
		cancel()
		select {
		case <-errCh:
		case <-time.After(2 * time.Second):
		}
	})
	return sock, srv
}

func waitForSocket(t *testing.T, sock string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if nc, err := net.Dial("unix", sock); err == nil {
			nc.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("socket %s did not become available", sock)
}

func dialMust(t *testing.T, sock string) net.Conn {
	t.Helper()
	nc, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { nc.Close() })
	return nc
}

// readControlUntil reads frames until a control Message of the given type
// arrives or the deadline passes.
func readControlUntil(t *testing.T, nc net.Conn, typ string) Message {
	t.Helper()
	nc.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		kind, payload, err := ReadFrame(nc)
		if err != nil {
			t.Fatalf("waiting for %q: %v", typ, err)
		}
		if kind != FrameControl {
			continue
		}
		var m Message
		if err := json.Unmarshal(payload, &m); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if m.Type == typ {
			return m
		}
	}
}

func TestServerGracefulShutdownReturnsNil(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "s.sock")
	srv, err := NewServer(sock)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- srv.ListenAndServe(ctx) }()
	waitForSocket(t, sock)

	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("ListenAndServe returned %v on ctx cancel, want nil (graceful)", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ListenAndServe did not return after ctx cancel")
	}
}

func TestServerSocketPermissions(t *testing.T) {
	sock, _ := startTestServer(t)
	fi, err := os.Stat(sock)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("socket perms = %o, want 600", perm)
	}
	di, err := os.Stat(filepath.Dir(sock))
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Errorf("socket dir perms = %o, want 700", perm)
	}
}

func TestServerColdStartCreatesDefault(t *testing.T) {
	_, srv := startTestServer(t)
	if got := len(srv.Registry().List()); got != 1 {
		t.Fatalf("cold-start workspace count = %d, want 1", got)
	}
	if srv.Registry().List()[0].Name != "" {
		t.Errorf("cold-start default is named, want unnamed")
	}
}

func TestServerEchoesCID(t *testing.T) {
	sock, _ := startTestServer(t)
	nc := dialMust(t, sock)
	if err := WriteControl(nc, &Message{Type: TypeCreateWorkspace, CID: 99, Name: "dev"}); err != nil {
		t.Fatalf("write: %v", err)
	}
	reply := readControlUntil(t, nc, TypeWorkspaceCreated)
	if reply.CID != 99 {
		t.Errorf("reply.CID = %d, want 99 (echoed)", reply.CID)
	}
	if reply.WorkspaceID == "" {
		t.Error("workspace-created reply has empty id")
	}
	if reply.Name != "dev" {
		t.Errorf("reply.Name = %q, want %q", reply.Name, "dev")
	}
}

func TestServerAttachRepliesComposition(t *testing.T) {
	sock, _ := startTestServer(t)
	nc := dialMust(t, sock)

	WriteControl(nc, &Message{Type: TypeCreateWorkspace, CID: 1})
	created := readControlUntil(t, nc, TypeWorkspaceCreated)

	WriteControl(nc, &Message{Type: TypeAttach, CID: 2, WorkspaceID: created.WorkspaceID})
	comp := readControlUntil(t, nc, TypeComposition)
	if comp.CID != 2 {
		t.Errorf("composition.CID = %d, want 2 (echoed)", comp.CID)
	}
	if comp.WorkspaceID != created.WorkspaceID {
		t.Errorf("composition.WorkspaceID = %q, want %q", comp.WorkspaceID, created.WorkspaceID)
	}
	// Empty workspace: no panes. (omitempty makes the wire field absent => nil.)
	if len(comp.Panes) != 0 {
		t.Errorf("composition.Panes len = %d, want 0", len(comp.Panes))
	}
}

func TestServerAttachUnknownWorkspaceErrors(t *testing.T) {
	sock, _ := startTestServer(t)
	nc := dialMust(t, sock)

	WriteControl(nc, &Message{Type: TypeAttach, CID: 7, WorkspaceID: "does-not-exist"})
	e := readControlUntil(t, nc, TypeError)
	if e.Code != CodeUnknownWorkspace {
		t.Errorf("error code = %q, want %q", e.Code, CodeUnknownWorkspace)
	}
	if e.CID != 7 {
		t.Errorf("error CID = %d, want 7 (echoes failed request)", e.CID)
	}

	// Recovery: list-workspaces shows the cold-start default.
	WriteControl(nc, &Message{Type: TypeListWorkspaces, CID: 8})
	list := readControlUntil(t, nc, TypeWorkspaceList)
	if len(list.Workspaces) == 0 {
		t.Fatal("expected at least the cold-start default workspace")
	}
}
```

**Step 2: Run the test to verify it fails**
Run:
```
go test ./internal/sessiond/ -run TestServer -v
```
Expected: FAIL — `undefined: NewServer`.

**Step 3: Write the implementation**

Create `internal/sessiond/server.go`:
```go
package sessiond

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
)

// Server serves the sessiond Unix socket: it accepts connections, decodes framed
// control messages, drives the Registry, and broadcasts events and pane output
// to the subscribers of each workspace. A connection is attached to at most one
// workspace at a time; create-pane/resize/input are connection-scoped.
type Server struct {
	reg    *Registry
	socket string

	mu   sync.Mutex
	subs map[string]map[*conn]bool // workspaceId -> set of attached connections
}

// NewServer returns a Server that will listen on socketPath.
func NewServer(socketPath string) (*Server, error) {
	if socketPath == "" {
		return nil, fmt.Errorf("sessiond: empty socket path")
	}
	return &Server{
		reg:    NewRegistry(),
		socket: socketPath,
		subs:   make(map[string]map[*conn]bool),
	}, nil
}

// Registry exposes the underlying registry (used by tests and later phases).
func (s *Server) Registry() *Registry { return s.reg }

// ListenAndServe binds the Unix socket (mode 0600 inside a 0700 dir), applies
// the cold-start default-workspace rule, and accepts connections until ctx is
// cancelled. On cancel it closes the listener and returns nil (graceful).
func (s *Server) ListenAndServe(ctx context.Context) error {
	if dir := filepath.Dir(s.socket); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("sessiond: mkdir %s: %w", dir, err)
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("sessiond: chmod dir %s: %w", dir, err)
		}
	}
	_ = os.Remove(s.socket)
	ln, err := net.Listen("unix", s.socket)
	if err != nil {
		return fmt.Errorf("sessiond: listen unix %s: %w", s.socket, err)
	}
	if err := os.Chmod(s.socket, 0o600); err != nil {
		_ = ln.Close()
		return fmt.Errorf("sessiond: chmod socket: %w", err)
	}
	s.reg.EnsureDefault()

	// Close the listener when ctx is cancelled to unblock Accept.
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		nc, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil // graceful shutdown
			default:
				return err
			}
		}
		if !s.peerAllowed(nc) {
			_ = nc.Close()
			continue
		}
		c := newConn(s, nc)
		go c.serve()
	}
}

// ---- subscriber bookkeeping ----

func (s *Server) unsubscribe(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for wsID, set := range s.subs {
		if set[c] {
			delete(set, c)
			if len(set) == 0 {
				delete(s.subs, wsID)
			}
		}
	}
	c.attached = ""
}

// attachConn enforces the frozen attach ordering under s.mu: composition reply
// first, THEN per-pane replay data frames (enqueued while NOT yet live), THEN
// mark live so subsequent broadcasts enqueue strictly after the replay frames.
func (s *Server) attachConn(c *conn, wsID string, cid uint64) {
	s.unsubscribe(c) // leave any previous workspace

	s.mu.Lock()
	defer s.mu.Unlock()

	// 1) composition reply FIRST. Empty (nil) panes if the workspace has none —
	// the message is always sent (never silence).
	panes := s.reg.PaneInfos(wsID)
	c.sub.enqueueControl(&Message{Type: TypeComposition, CID: cid, WorkspaceID: wsID, Panes: panes})

	// 2) per-pane replay data frames, enqueued BEFORE the conn is marked live.
	for _, pi := range panes {
		if p, ok := s.reg.Pane(wsID, pi.PaneID); ok {
			if data := p.Replay(); len(data) > 0 {
				c.sub.enqueuePaneData(uint32(pi.PaneID), data)
			}
		}
	}

	// 3) mark live: now broadcasts enqueue AFTER the replay frames.
	set := s.subs[wsID]
	if set == nil {
		set = make(map[*conn]bool)
		s.subs[wsID] = set
	}
	set[c] = true
	c.attached = wsID
}

// broadcast enqueues a control message to all subscribers of a workspace.
// enqueue never blocks, so holding s.mu here is safe.
func (s *Server) broadcast(wsID string, msg *Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.subs[wsID] {
		c.sub.enqueueControl(msg)
	}
}

// broadcastPaneData enqueues pane output to all subscribers of a workspace.
func (s *Server) broadcastPaneData(wsID string, paneID uint32, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.subs[wsID] {
		c.sub.enqueuePaneData(paneID, data)
	}
}

// handlePaneExit runs when a pane's process exits. It fires pane-closed, then
// (if that was the workspace's last pane) reaps the workspace and fires
// workspace-closed AFTER the final pane-closed (frozen ordering).
func (s *Server) handlePaneExit(wsID string, paneID int) {
	_, remaining, ok := s.reg.RemovePane(wsID, paneID)
	if !ok {
		return // already removed (e.g. via close-workspace)
	}
	s.broadcast(wsID, &Message{Type: TypePaneClosed, WorkspaceID: wsID, PaneID: paneID})
	if remaining == 0 {
		if removed, _ := s.reg.ReapIfEmpty(wsID); removed {
			s.broadcast(wsID, &Message{Type: TypeWorkspaceClosed, WorkspaceID: wsID})
		}
	}
}

// ---- per-connection handling ----

type conn struct {
	srv      *Server
	nc       net.Conn
	sub      *subscriber
	attached string // current workspace id; "" when not attached. Touched only
	// by this connection's own read goroutine, so it needs no lock.
}

func newConn(s *Server, nc net.Conn) *conn {
	return &conn{srv: s, nc: nc, sub: newSubscriber(nc, 0)}
}

func (c *conn) serve() {
	defer c.cleanup()
	for {
		kind, payload, err := ReadFrame(c.nc)
		if err != nil {
			return
		}
		switch kind {
		case FrameControl:
			var msg Message
			if err := json.Unmarshal(payload, &msg); err != nil {
				continue
			}
			c.handle(msg)
		case FramePaneData:
			// Keyboard input: a binary frame, connection-scoped to the attached
			// workspace. paneId is workspace-local.
			paneID, data := DecodePaneData(payload)
			if c.attached != "" {
				if p, ok := c.srv.reg.Pane(c.attached, int(paneID)); ok {
					_ = p.Write(data)
				}
			}
		}
	}
}

func (c *conn) cleanup() {
	c.srv.unsubscribe(c)
	c.sub.Close() // closes the underlying net.Conn
}

func (c *conn) handle(msg Message) {
	switch msg.Type {
	case TypeCreateWorkspace:
		ws := c.srv.reg.AddWorkspace(msg.Name)
		c.reply(&Message{Type: TypeWorkspaceCreated, CID: msg.CID, WorkspaceID: ws.ID, Name: ws.Name})
	case TypeListWorkspaces:
		c.reply(&Message{Type: TypeWorkspaceList, CID: msg.CID, Workspaces: c.srv.reg.List()})
	case TypeRenameWorkspace:
		if c.srv.reg.RenameWorkspace(msg.WorkspaceID, msg.Name) {
			c.reply(&Message{Type: TypeOK, CID: msg.CID, WorkspaceID: msg.WorkspaceID})
			c.srv.broadcast(msg.WorkspaceID, &Message{Type: TypeWorkspaceRenamed, WorkspaceID: msg.WorkspaceID, Name: msg.Name})
		} else {
			c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace "+msg.WorkspaceID)
		}
	case TypeCloseWorkspace:
		c.closeWorkspace(msg)
	case TypeAttach:
		c.attach(msg)
	case TypeCreatePane:
		c.createPane(msg)
	case TypeResize:
		// Connection-scoped: resolve paneId against the attached workspace.
		if c.attached != "" {
			if p, ok := c.srv.reg.Pane(c.attached, msg.PaneID); ok {
				_ = p.Resize(msg.Cols, msg.Rows)
			}
		}
	}
}

func (c *conn) attach(msg Message) {
	if !c.srv.reg.Has(msg.WorkspaceID) {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace "+msg.WorkspaceID)
		return
	}
	c.srv.attachConn(c, msg.WorkspaceID, msg.CID)
}

func (c *conn) createPane(msg Message) {
	// Connection-scoped: a pane is created only in the attached workspace.
	wsID := c.attached
	if wsID == "" || !c.srv.reg.Has(wsID) {
		c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
		return
	}
	localID, ok := c.srv.reg.AllocPaneID(wsID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace "+wsID)
		return
	}
	cols, rows := sizeOrDefault(msg.Cols, msg.Rows)
	srv := c.srv
	pane, err := NewPane(localID, msg.Cmd, cols, rows,
		NewRawBuffer(0),
		func(pid int, data []byte) { srv.broadcastPaneData(wsID, uint32(pid), data) },
		func(pid int) { srv.handlePaneExit(wsID, pid) },
	)
	if err != nil {
		c.replyError(msg.CID, CodePaneSpawnFailed, err.Error())
		return
	}
	srv.reg.PutPane(wsID, pane)
	// ACK to the actor with the assigned id (echoes cid)...
	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	// ...then broadcast pane-added (cid=0) to ALL subscribers. pane-added is only
	// for panes created AFTER attach; pre-existing panes are reported via
	// composition.panes. Clients dedup by paneId.
	srv.broadcast(wsID, &Message{Type: TypePaneAdded, WorkspaceID: wsID, PaneID: localID, Cols: cols, Rows: rows})
}

func (c *conn) closeWorkspace(msg Message) {
	wsID := msg.WorkspaceID
	panes, _, ok := c.srv.reg.CloseWorkspace(wsID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace "+wsID)
		return
	}
	c.reply(&Message{Type: TypeOK, CID: msg.CID, WorkspaceID: wsID})
	for _, p := range panes {
		p.Close() // pane exit handlers see the workspace already gone -> no dup events
	}
	c.srv.broadcast(wsID, &Message{Type: TypeWorkspaceClosed, WorkspaceID: wsID})
}

// ---- enqueued writes (never block; serialized by the subscriber goroutine) ----

func (c *conn) reply(msg *Message) { c.sub.enqueueControl(msg) }

func (c *conn) replyError(cid uint64, code, detail string) {
	c.sub.enqueueControl(&Message{Type: TypeError, CID: cid, Code: code, Error: detail})
}

// ---- helpers ----

// sizeOrDefault applies sane defaults for non-positive dimensions.
func sizeOrDefault(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return cols, rows
}
```

Create `internal/sessiond/peercred_linux.go`:
```go
//go:build linux

package sessiond

import (
	"net"
	"os"
	"syscall"
)

// peerAllowed performs an SO_PEERCRED uid check on the connecting peer and
// rejects any peer whose uid differs from the daemon's own uid. This uses
// stdlib syscall only (no golang.org/x/sys dependency).
func (s *Server) peerAllowed(nc net.Conn) bool {
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return false
	}
	var cred *syscall.Ucred
	var sockErr error
	ctrlErr := raw.Control(func(fd uintptr) {
		cred, sockErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if ctrlErr != nil || sockErr != nil || cred == nil {
		return false
	}
	return int(cred.Uid) == os.Getuid()
}
```

Create `internal/sessiond/peercred_other.go`:
```go
//go:build !linux

package sessiond

import "net"

// peerAllowed is a no-op on non-Linux platforms: SO_PEERCRED is Linux-specific.
// The socket's 0700 dir / 0600 file permissions remain the primary guard there.
func (s *Server) peerAllowed(nc net.Conn) bool { return true }
```

**Step 4: Run the test to verify it passes**
Run:
```
go test ./internal/sessiond/ -run TestServer -v
```
Expected: `--- PASS` for all server tests, then `ok`.

**Step 5: Quality check**
Run:
```
go vet ./internal/sessiond/ && gofmt -l internal/sessiond/
```
Expected: no output.

**Step 6: Commit**
```
git add internal/sessiond/server.go internal/sessiond/peercred_linux.go internal/sessiond/peercred_other.go internal/sessiond/server_test.go
git commit -m "feat(sessiond): add Server with ctx lifecycle, composition attach, and socket security" -m "$(printf 'Server binds a 0600 socket in a 0700 dir, performs an SO_PEERCRED uid check on\naccept, and serves the frozen contract: cid-echoing replies, attach->composition\n(empty panes if none) with replay-before-live ordering, connection-scoped\ncreate-pane/resize/binary-input, and pane/workspace lifecycle broadcasts.\nListenAndServe(ctx) returns nil on cancel (graceful shutdown).\n\n🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

## Task 7: End-to-end integration test (real PTYs over a real socket)

This task adds tests only — no new production code. It exercises the full daemon over a real Unix socket with real PTYs using the **frozen vocabulary** (attach→composition→pane-added→binary-input echo→resize→close, plus unknown-workspace recovery and scrollback replay).

**Files:**
- Create: `internal/sessiond/server_integration_test.go`

**Step 1: Write the test**

Create `internal/sessiond/server_integration_test.go`:
```go
package sessiond

import (
	"bytes"
	"encoding/json"
	"net"
	"testing"
	"time"
)

// tClient demuxes incoming frames into control and pane-data channels.
type tClient struct {
	conn net.Conn
	ctrl chan Message
	data chan tPaneData
}

type tPaneData struct {
	paneID uint32
	data   []byte
}

func newTClient(t *testing.T, sock string) *tClient {
	t.Helper()
	nc, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	tc := &tClient{
		conn: nc,
		ctrl: make(chan Message, 128),
		data: make(chan tPaneData, 128),
	}
	go func() {
		for {
			kind, payload, err := ReadFrame(nc)
			if err != nil {
				return
			}
			switch kind {
			case FrameControl:
				var m Message
				if err := json.Unmarshal(payload, &m); err == nil {
					tc.ctrl <- m
				}
			case FramePaneData:
				id, d := DecodePaneData(payload)
				cp := make([]byte, len(d))
				copy(cp, d)
				tc.data <- tPaneData{id, cp}
			}
		}
	}()
	t.Cleanup(func() { nc.Close() })
	return tc
}

func (tc *tClient) send(t *testing.T, m Message) {
	t.Helper()
	if err := WriteControl(tc.conn, &m); err != nil {
		t.Fatalf("send %s: %v", m.Type, err)
	}
}

// sendInput writes keyboard input as a BINARY pane-data frame (not a control
// message), connection-scoped to the attached workspace.
func (tc *tClient) sendInput(t *testing.T, paneID uint32, data []byte) {
	t.Helper()
	if err := WritePaneData(tc.conn, paneID, data); err != nil {
		t.Fatalf("sendInput: %v", err)
	}
}

func (tc *tClient) waitCtrl(t *testing.T, typ string) Message {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case m := <-tc.ctrl:
			if m.Type == typ {
				return m
			}
		case <-deadline:
			t.Fatalf("timeout waiting for control %q", typ)
		}
	}
}

func (tc *tClient) waitData(t *testing.T, substr string) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	var acc []byte
	for {
		select {
		case d := <-tc.data:
			acc = append(acc, d.data...)
			if bytes.Contains(acc, []byte(substr)) {
				return
			}
		case <-deadline:
			t.Fatalf("timeout waiting for pane data %q; got %q", substr, acc)
		}
	}
}

func TestIntegrationFullPaneLifecycle(t *testing.T) {
	sock, _ := startTestServer(t)
	cli := newTClient(t, sock)

	// Create an explicit workspace.
	cli.send(t, Message{Type: TypeCreateWorkspace, CID: 1})
	created := cli.waitCtrl(t, TypeWorkspaceCreated)
	wsID := created.WorkspaceID
	if wsID == "" {
		t.Fatal("empty workspace id")
	}

	// Attach -> exactly one composition reply (empty panes).
	cli.send(t, Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	comp := cli.waitCtrl(t, TypeComposition)
	if len(comp.Panes) != 0 {
		t.Fatalf("composition.Panes len = %d, want 0", len(comp.Panes))
	}

	// Create a pane running `cat` (connection-scoped: no workspaceId).
	cli.send(t, Message{Type: TypeCreatePane, CID: 3, Cols: 80, Rows: 24, Cmd: []string{"cat"}})
	ack := cli.waitCtrl(t, TypePaneCreated)
	paneID := ack.PaneID
	if paneID == 0 {
		t.Fatal("pane id 0; want a positive workspace-local id")
	}
	// The actor also receives the broadcast pane-added (cid=0).
	added := cli.waitCtrl(t, TypePaneAdded)
	if added.PaneID != paneID {
		t.Errorf("pane-added id = %d, want %d", added.PaneID, paneID)
	}

	// Keyboard input via a BINARY frame -> the PTY echoes it back as pane output.
	cli.sendInput(t, uint32(paneID), []byte("hello-integration\n"))
	cli.waitData(t, "hello-integration")

	// Resize is connection-scoped (no workspaceId) and must not disrupt the stream.
	cli.send(t, Message{Type: TypeResize, CID: 4, PaneID: paneID, Cols: 100, Rows: 30})

	// Close the workspace -> ok reply + workspace-closed broadcast.
	cli.send(t, Message{Type: TypeCloseWorkspace, CID: 5, WorkspaceID: wsID})
	cli.waitCtrl(t, TypeOK)
	closed := cli.waitCtrl(t, TypeWorkspaceClosed)
	if closed.WorkspaceID != wsID {
		t.Errorf("workspace-closed id = %q, want %q", closed.WorkspaceID, wsID)
	}
}

func TestIntegrationAttachUnknownThenRecover(t *testing.T) {
	sock, _ := startTestServer(t)
	cli := newTClient(t, sock)

	cli.send(t, Message{Type: TypeAttach, CID: 1, WorkspaceID: "stale-id"})
	e := cli.waitCtrl(t, TypeError)
	if e.Code != CodeUnknownWorkspace {
		t.Fatalf("error code = %q, want %q", e.Code, CodeUnknownWorkspace)
	}

	cli.send(t, Message{Type: TypeListWorkspaces, CID: 2})
	list := cli.waitCtrl(t, TypeWorkspaceList)
	if len(list.Workspaces) == 0 {
		t.Fatal("expected the cold-start default workspace to exist")
	}
	wsID := list.Workspaces[0].WorkspaceID
	cli.send(t, Message{Type: TypeAttach, CID: 3, WorkspaceID: wsID})
	cli.waitCtrl(t, TypeComposition)
	// Confirm liveness: create a pane in the recovered workspace.
	cli.send(t, Message{Type: TypeCreatePane, CID: 4, Cmd: []string{"echo", "recovered"}})
	cli.waitCtrl(t, TypePaneCreated)
	cli.waitData(t, "recovered")
}

func TestIntegrationReplayBeforeLiveOnAttach(t *testing.T) {
	sock, _ := startTestServer(t)

	// Client A creates a workspace + a LONG-LIVED pane (cat) and drives output
	// into it. cat stays alive so the workspace is not auto-reaped before B attaches.
	a := newTClient(t, sock)
	a.send(t, Message{Type: TypeCreateWorkspace, CID: 1})
	wsID := a.waitCtrl(t, TypeWorkspaceCreated).WorkspaceID
	a.send(t, Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	a.waitCtrl(t, TypeComposition)
	a.send(t, Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"cat"}})
	paneID := a.waitCtrl(t, TypePaneCreated).PaneID
	a.waitCtrl(t, TypePaneAdded)
	a.sendInput(t, uint32(paneID), []byte("scrollback-line\n"))
	a.waitData(t, "scrollback-line")

	// Let the pane flush its output into the buffer.
	time.Sleep(200 * time.Millisecond)

	// Client B attaches fresh: composition reports the pre-existing pane (NOT a
	// pane-added), then the replayed scrollback arrives BEFORE any live output.
	b := newTClient(t, sock)
	b.send(t, Message{Type: TypeAttach, CID: 9, WorkspaceID: wsID})
	comp := b.waitCtrl(t, TypeComposition)
	if len(comp.Panes) != 1 || comp.Panes[0].PaneID != paneID {
		t.Fatalf("composition.Panes = %+v, want one pane id %d", comp.Panes, paneID)
	}
	b.waitData(t, "scrollback-line")
}
```

**Step 2: Run the integration tests**
Run:
```
go test ./internal/sessiond/ -run TestIntegration -v
```
Expected: `--- PASS` for `TestIntegrationFullPaneLifecycle`, `TestIntegrationAttachUnknownThenRecover`, and `TestIntegrationReplayBeforeLiveOnAttach`, then `ok`.

> Note: this task is test-only. If any test fails, fix the production file it implicates (do not weaken the test) and re-run before committing.

**Step 3: Run the full package suite with the race detector**
Run:
```
go test ./internal/sessiond/ -race -v
```
Expected: every test PASS, no `DATA RACE` reports, ending in `ok  github.com/user/muxterm/internal/sessiond`.

**Step 4: Run the whole repo test suite to confirm nothing else broke**
Run:
```
make test
```
Expected: all packages report `ok` (or `no test files`); no failures.

**Step 5: Final quality check**
Run:
```
go vet ./internal/sessiond/ && gofmt -l internal/sessiond/
```
Expected: no output.

**Step 6: Commit**
```
git add internal/sessiond/server_integration_test.go
git commit -m "test(sessiond): add end-to-end integration tests over a real socket + PTYs" -m "$(printf 'Exercises the full daemon on the frozen contract: create-workspace, attach\n(composition), connection-scoped create-pane, binary keyboard input echo,\nresize, close-workspace, the unknown-workspace error + recovery path, and\nreplay-before-live to a second client on attach. Runs clean under -race.\n\n🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)\n\nCo-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>')"
```

---

## Phase 1 Done — Definition of Done

When all tasks are committed, the following must hold:

- `go test ./internal/sessiond/ -race -v` passes with no races (Phase 0 protocol tests included).
- `make test` is green across the repo.
- `go vet ./internal/sessiond/` and `gofmt -l internal/sessiond/` are clean.
- `github.com/creack/pty` is a **direct** dependency in `go.mod`; no `charmbracelet` dependency was added; no `golang.org/x/sys` was added (peercred uses stdlib `syscall`).
- Phase 1 **imported** the Phase 0 wire contract verbatim — it did not create or edit `protocol.go`/`protocol_test.go`.
- The `internal/sessiond` package stands alone on the frozen contract: a `Server` (`NewServer` + `ListenAndServe(ctx)`, graceful nil-on-cancel) on a `0600`/`0700` Unix socket with an `SO_PEERCRED` uid check creates workspaces + panes, streams live PTY output, replies to `attach` with a single `composition` (empty panes if none) followed by replay-before-live scrollback, handles connection-scoped `create-pane`/`resize`/binary-`input`, echoes `cid` on every reply, never lets a slow client block the PTY drain or peers, emits `pane-added`/`pane-closed`/`workspace-closed`/`workspace-renamed` (`pane-closed` before `workspace-closed`), and returns the `unknown-workspace` error with a working recovery path — all with no web, no tmux, and no subcommand wiring (Phases 2–4; richer buffers and OSC titles are Phase 5).
