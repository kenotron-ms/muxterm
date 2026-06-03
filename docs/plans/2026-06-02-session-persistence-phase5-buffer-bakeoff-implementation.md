# Phase 5 — Buffer Fidelity Bake-off Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add two richer `PaneBuffer` implementations — `TrackedBuffer` (on `charmbracelet/x/ansi`) and `VTBuffer` (on `charmbracelet/x/vt`) — behind the Phase-1 `PaneBuffer` interface, build a golden-test bake-off that measures fidelity vs weight against `RawBuffer`, choose a default empirically, and (if `TrackedBuffer` is chosen) graduate OSC-title capture from the Phase-1 placeholder.

**Architecture:** Both new buffers slot in behind the existing `PaneBuffer` seam that Phase 1 shipped in `internal/sessiond/buffer.go` (package `sessiond`). Nothing in the daemon, protocol, web relay, or client changes. A golden-test harness uses `charmbracelet/x/vt` as a *reference emulator oracle* (standing in for the browser's xterm.js): it renders the full live byte stream to a canonical screen, then renders each buffer's `Replay()` output to a screen, and asserts they match — including under aggressive trimming at every offset. The bake-off test scores all three buffers on fidelity and rough memory cost; the winner is wired into `pane.go`.

**Tech Stack:** Go 1.24, module `github.com/user/muxterm`, stdlib `testing` (table-driven golden tests, `t.Fatalf`/`t.Errorf`, **no testify**). New deps: `github.com/charmbracelet/x/ansi` and `github.com/charmbracelet/x/vt` (experimental `v0.0.0`, isolated behind `PaneBuffer`).

> **Dependency note:** Phase 5 depends ONLY on the Phase-1 `PaneBuffer` seam — the `Write(p []byte) (int, error)` / `Replay() []byte` interface and the exported `Pane.Title` string field. It has ZERO coupling to the wire protocol, the socket server, or the web/browser layers: no message types, frame formats, `cid` correlation, or events appear anywhere in this phase. The only cross-phase contracts it touches are the buffer interface signature and the `Pane.Title` field, both pinned below from the revised Phase 1.

---

## Context for the implementer (read this first)

You are a strong Go engineer but you have **zero prior context** on this codebase. Read these before starting:

1. **Design source of truth (authoritative — never contradict it):**
   `docs/plans/2026-06-01-session-persistence-design.md`, section **"The PaneBuffer interface (per-pane scrollback)"** (lines ~297–392). It describes the three buffer implementations, the "How we choose" empirical bake-off, and an **explicit anti-option**: *do NOT hand-port a VT grid emulator "by reference" from x/vt.* We either **depend on `x/vt`** or **stay byte-based** (Raw/Tracked). Never reimplement a grid emulator yourself.

2. **What Phase 1 already built (a prerequisite for this phase):**
   Phase 1 created `internal/sessiond/buffer.go` (package `sessiond`) containing the `PaneBuffer` interface and the `RawBuffer` implementation. This plan **adds** files alongside it. If Phase 1 is not yet merged, this plan cannot be executed — stop and report that Phase 1 is a blocking dependency.

3. **The `PaneBuffer` interface contract (frozen, from revised Phase 1).** It is exactly:
   ```go
   // PaneBuffer is the per-pane scrollback seam. v1 ships RawBuffer; Phase 5 adds
   // TrackedBuffer and VTBuffer behind this same interface — no daemon/protocol changes.
   type PaneBuffer interface {
       // Write appends raw PTY output to the buffer. The (int, error) shape makes
       // every implementation satisfy io.Writer (RawBuffer returns len(p), nil).
       Write(p []byte) (int, error)
       // Replay returns a COPY of the bytes that reconstruct the current screen
       // on a fresh emulator.
       Replay() []byte
   }
   ```
   This is the **real, frozen signature** Phase 1 ships in `internal/sessiond/buffer.go` — `Write` returns `(int, error)`, NOT a bare `Write([]byte)`. TrackedBuffer and VTBuffer in this plan implement it **verbatim** (their `Write` methods return `(int, error)`); the golden harness calls `buf.Write(...)` as a statement and discards the results. **VERIFY THIS FIRST:** open `internal/sessiond/buffer.go` and confirm the method set still matches before you write any code — the experimental charmbracelet APIs and the Phase-1 interface shape are the two places this plan could drift from reality. Do not guess; read the file.

### Package placement decision (do this, and know why)

The task brief listed candidate paths under `internal/sessiond/buffer/` (a subpackage). **We are deliberately NOT creating a subpackage.** Reason: Phase 1 placed `PaneBuffer` + `RawBuffer` in `internal/sessiond/buffer.go` in **package `sessiond`**, and `pane.go` (also package `sessiond`) references `PaneBuffer` directly. Moving the interface into a subpackage now would force a refactor of Phase-1 code and risk an import cycle, for no benefit — the charmbracelet dependency is *already* contained behind the interface regardless of file layout. So **all Phase 5 files live directly in `internal/sessiond/`, package `sessiond`**, matching Phase 1. (If the team later wants hard dependency isolation, extracting a `buffer` subpackage is a separate, self-contained refactor — out of scope here.)

Files this plan creates (all package `sessiond`):

| File | Purpose |
| --- | --- |
| `internal/sessiond/golden_test.go` | Reference-emulator oracle, fixtures, and the trim-resilience harness shared by all buffer tests |
| `internal/sessiond/tracked.go` / `tracked_test.go` | `TrackedBuffer` on `charmbracelet/x/ansi` |
| `internal/sessiond/vt.go` / `vt_test.go` | `VTBuffer` on `charmbracelet/x/vt` |
| `internal/sessiond/bakeoff_test.go` | The comparison test that scores Raw vs Tracked vs VT |
| `internal/sessiond/pane.go` (modify) | Wire the chosen default + OSC-title graduation |

### Scope boundaries (do NOT touch these — other phases own them)

- Protocol / socket server / registry / workspace logic → Phases 1, 3.
- Web relay (`internal/server/`) and the browser multiplexer (`web/`) → Phases 3, 4.
- Lifecycle / systemd / subcommands → Phase 2.
- **This phase is pure buffer work behind the Phase-1 `PaneBuffer` seam.**

### Verified API facts (so your code compiles)

These were confirmed against the real modules (`x/ansi@v0.11.7`, current `x/vt`). Use them; do not invent APIs.

- **`charmbracelet/x/ansi`** — a *standalone ANSI parser state machine*, NOT a grid emulator:
  - `p := ansi.NewParser()`
  - `p.SetHandler(ansi.Handler{ ... })` — `Handler` has func fields:
    `Print func(r rune)`, `Execute func(b byte)`, `HandleCsi func(cmd ansi.Cmd, params ansi.Params)`, `HandleEsc func(cmd ansi.Cmd)`, `HandleOsc func(cmd int, data []byte)`, plus `HandleDcs/HandlePm/HandleApc/HandleSos`.
  - `p.Parse(b []byte)` — feed bytes; handlers fire.
  - `ansi.Cmd` is an `int` with methods `Prefix() byte`, `Intermediate() byte`, `Final() byte`. For `CSI ? 1049 h` the handler gets `cmd.Prefix() == '?'`, `cmd.Final() == 'h'`, and `params.Param(0, 0) == (1049, false, true)`.
  - `ansi.Params` has `Param(i, def int) (val int, hasMore bool, ok bool)` and `ForEach(def int, f func(i, param int, hasMore bool))`.
- **`charmbracelet/x/vt`** — a *headless cell-grid emulator*:
  - `emu := vt.NewEmulator(width, height int) *vt.Emulator` (implements the `vt.Terminal` interface).
  - `emu.Write(p []byte) (int, error)` — feed PTY bytes.
  - `emu.Resize(w, h int)`, `emu.Width() int`, `emu.Height() int`.
  - `emu.CursorPosition() uv.Position`, `emu.IsAltScreen() bool`.
  - `emu.CellAt(x, y int) *uv.Cell` — read a rendered cell (`uv` = `github.com/charmbracelet/ultraviolet`).
  - `emu.String() string` — the visible screen as plain text (no styling). Useful as a cheap screen oracle.
  - `emu.Render() string` — screen rendered **with** ANSI styling. (Useful for `VTBuffer.Replay`; verify its exact escape output with a quick probe — see Task 10.)

---

## Task 1: Add the `charmbracelet/x/ansi` and `charmbracelet/x/vt` dependencies

**Files:**
- Modify: `go.mod`, `go.sum`
- Create: `internal/sessiond/deps_probe_test.go` (temporary smoke test, deleted in this same task)

**Step 1: Add the dependencies**

Run:
```
go get github.com/charmbracelet/x/ansi@latest github.com/charmbracelet/x/vt@latest
```
Expected: `go.mod` gains both `github.com/charmbracelet/x/ansi` and `github.com/charmbracelet/x/vt` (each pulls a small set of transitive deps such as `github.com/charmbracelet/ultraviolet`, `rivo/uniseg`).

**Step 2: Write a one-line compile smoke test**

Create `internal/sessiond/deps_probe_test.go`:
```go
package sessiond

import (
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

// TestDepsImport is a throwaway smoke test: it only proves the two new
// charmbracelet packages resolve and link. It is deleted at the end of Task 1.
func TestDepsImport(t *testing.T) {
	if ansi.NewParser() == nil {
		t.Fatal("ansi.NewParser returned nil")
	}
	if vt.NewEmulator(80, 24) == nil {
		t.Fatal("vt.NewEmulator returned nil")
	}
}
```

**Step 3: Tidy and verify the build/test**

Run:
```
go mod tidy && go test ./internal/sessiond/ -run TestDepsImport -v
```
Expected: `PASS` and `ok  github.com/user/muxterm/internal/sessiond`.

**Step 4: Delete the throwaway probe**

Run:
```
rm internal/sessiond/deps_probe_test.go && go build ./...
```
Expected: clean build, no output.

**Step 5: Commit**

```
git add go.mod go.sum && git commit -m "$(cat <<'EOF'
build(sessiond): add charmbracelet/x/ansi and x/vt deps for buffer bake-off

Experimental v0.0.0 packages, isolated behind the Phase-1 PaneBuffer
interface. No production code uses them yet; Phase 5 adds TrackedBuffer
and VTBuffer behind PaneBuffer.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 2: Golden oracle + fixtures + no-trim harness

This builds the shared test infrastructure every later task depends on. The oracle is a reference VT emulator (`x/vt`) standing in for the browser's xterm.js.

**Files:**
- Create: `internal/sessiond/golden_test.go`

**Step 1: Write the harness and fixtures, plus a no-trim test against `RawBuffer`**

Create `internal/sessiond/golden_test.go`:
```go
package sessiond

import (
	"fmt"
	"testing"

	"github.com/charmbracelet/x/vt"
)

// --- Reference emulator oracle ------------------------------------------------
//
// We use charmbracelet/x/vt as a *reference* terminal emulator that stands in
// for the browser's xterm.js. A buffer's Replay() is "correct" if rendering it
// on a fresh reference emulator reproduces the same visible screen as rendering
// the full original live byte stream.
//
// HONEST CAVEAT: this oracle cannot detect drift between x/vt and the REAL
// xterm.js (the design's "two-emulator drift" risk for VTBuffer). That class of
// bug needs manual/browser validation and is noted in the bake-off decision
// (Task 12). The oracle does reliably measure trim-resilience and sticky-state
// reconstruction, which is what the bake-off turns on.

const oracleCols, oracleRows = 80, 24

// renderScreen feeds bytes to a fresh reference emulator and returns the visible
// screen as a canonical string (plain text grid). Same input => same output.
func renderScreen(b []byte) string {
	emu := vt.NewEmulator(oracleCols, oracleRows)
	_, _ = emu.Write(b)
	return emu.String()
}

// --- Fixtures -----------------------------------------------------------------
//
// fixture is a named recorded byte stream. Keep fixtures small, deterministic,
// and reviewable: build them from explicit escape sequences rather than by
// shelling out to vim/htop (non-deterministic across environments).

type fixture struct {
	name  string
	bytes []byte
}

const esc = "\x1b"

// stickyFixtures exercise sticky state that survives trimming via a preamble:
// SGR pens, alt-screen enter/exit, DEC private modes, OSC title. TrackedBuffer
// and VTBuffer MUST reconstruct these even when early history is trimmed.
func stickyFixtures() []fixture {
	return []fixture{
		{
			name: "sgr_color_run",
			// Set bold + red, print text, more attrs, then plain text far later.
			bytes: []byte(
				esc + "[1m" + esc + "[31m" + "ERROR: boom\n" +
					esc + "[0m" + "back to normal\n" +
					esc + "[44m" + esc + "[37m" + "blue bg white fg line\n" +
					"trailing line A\ntrailing line B\n",
			),
		},
		{
			name: "altscreen_enter_exit",
			// Enter alt-screen, paint a full-screen-ish app, then exit back.
			bytes: []byte(
				"normal scrollback line 1\nnormal scrollback line 2\n" +
					esc + "[?1049h" + esc + "[2J" + esc + "[H" +
					"ALT SCREEN CONTENT\n" + esc + "[5;5H" + "cursor moved here" +
					esc + "[?1049l" +
					"back in normal screen\n",
			),
		},
		{
			name: "cursor_moves_and_color",
			bytes: []byte(
				esc + "[2J" + esc + "[H" +
					esc + "[3;10H" + esc + "[32m" + "green@3,10" +
					esc + "[6;1H" + esc + "[0m" + "row6\n" +
					"row7 normal\n",
			),
		},
		{
			name: "osc2_window_title",
			bytes: []byte(
				esc + "]2;vim main.go" + "\x07" + // OSC 2 ; <title> BEL
					"editing a file\n",
			),
		},
	}
}

// reflowFixtures are wrap-heavy / full-repaint streams where only a true grid
// emulator (VTBuffer) is expected to reconstruct perfectly after trimming.
// These are MEASURED in the bake-off, not asserted for Raw/Tracked.
func reflowFixtures() []fixture {
	// A long wrapping paragraph with no explicit newlines: cursor column after
	// trimming depends on wrap math that byte/Tracked buffers approximate.
	long := ""
	for i := 0; i < 200; i++ {
		long += fmt.Sprintf("word%03d ", i)
	}
	return []fixture{
		{name: "wrapping_paragraph", bytes: []byte(long + "\n")},
	}
}

// --- No-trim correctness harness ----------------------------------------------
//
// With no trimming, every buffer (even RawBuffer) must replay to the exact
// golden screen. This is the floor: a buffer that fails here is broken.

func runNoTrim(t *testing.T, newBuf func() PaneBuffer, fixtures []fixture) {
	t.Helper()
	for _, f := range fixtures {
		f := f
		t.Run(f.name, func(t *testing.T) {
			golden := renderScreen(f.bytes)
			buf := newBuf()
			buf.Write(f.bytes)
			got := renderScreen(buf.Replay())
			if got != golden {
				t.Errorf("replay screen mismatch for %q\n--- golden ---\n%s\n--- got ---\n%s",
					f.name, golden, got)
			}
		})
	}
}

func TestRawBufferNoTrim(t *testing.T) {
	runNoTrim(t, func() PaneBuffer { return NewRawBuffer(0) }, stickyFixtures())
}
```

> **VERIFY:** confirm the Phase-1 constructor. The revised Phase 1 ships a single
> `NewRawBuffer(budget int) *RawBuffer` where a budget `<= 0` uses the default
> (~1 MiB). This plan uses `NewRawBuffer(0)` for the default and `NewRawBuffer(budget)`
> for an explicit byte budget. If Phase 1 changed the signature, adjust the `newBuf`
> closures throughout the plan. Read `internal/sessiond/buffer.go`.

**Step 2: Run the no-trim harness**

Run:
```
go test ./internal/sessiond/ -run TestRawBufferNoTrim -v
```
Expected: `PASS` with subtests `sgr_color_run`, `altscreen_enter_exit`, `cursor_moves_and_color`, `osc2_window_title` all passing (RawBuffer with no trimming replays byte-identically, so the screens match).

**Step 3: Commit**

```
git add internal/sessiond/golden_test.go && git commit -m "$(cat <<'EOF'
test(sessiond): add golden oracle, fixtures, and no-trim buffer harness

Reference x/vt emulator as the xterm.js stand-in; deterministic sticky and
reflow fixtures; runNoTrim floor check passing for RawBuffer.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 3: Trim-resilience scorer + RawBuffer baseline measurement

This adds the harness that forces trimming at every offset and scores how often a buffer still reconstructs the correct screen. RawBuffer is expected to score < 1.0 on sticky fixtures (documented limitation) — we *measure* it, we don't fail on it.

**Files:**
- Modify: `internal/sessiond/golden_test.go`

**Step 1: Add the scorer and a RawBuffer baseline test**

Append to `internal/sessiond/golden_test.go`:
```go
// --- Trim-resilience scorer ---------------------------------------------------
//
// To force trimming "at every offset", we replay the stream in two writes:
// first the prefix [0:k) then the suffix [k:n). Buffers are constructed with a
// byte budget = len(suffix), so after the second write the first k bytes have
// been evicted (trimmed) and only the suffix is retained. A correct buffer uses
// a synthetic preamble (Tracked) or live-grid serialization (VT) so Replay()
// still reconstructs the same VISIBLE screen as the untrimmed golden render.
//
// scoreTrimResilience returns the fraction of offsets k in [1,n) for which the
// trimmed buffer's replay reproduces the golden screen. 1.0 == perfect.

func scoreTrimResilience(newBudgeted func(budget int) PaneBuffer, f fixture) float64 {
	n := len(f.bytes)
	if n < 2 {
		return 1.0
	}
	golden := renderScreen(f.bytes)
	ok := 0
	total := 0
	for k := 1; k < n; k++ {
		total++
		budget := n - k
		buf := newBudgeted(budget)
		buf.Write(f.bytes[:k])
		buf.Write(f.bytes[k:])
		if renderScreen(buf.Replay()) == golden {
			ok++
		}
	}
	return float64(ok) / float64(total)
}

// RawBuffer baseline: we assert ONLY the floor that the design guarantees for
// RawBuffer (no-trim correctness, already covered) and that newline-boundary
// trimming never severs an escape in plain text. The sticky-state trim score is
// recorded for the bake-off but NOT asserted (RawBuffer is allowed to lose
// mid-screen sticky state — that is exactly what Tracked/VT fix).
func TestRawBufferTrimBaseline(t *testing.T) {
	newBudgeted := func(budget int) PaneBuffer { return NewRawBuffer(budget) }
	for _, f := range stickyFixtures() {
		score := scoreTrimResilience(newBudgeted, f)
		t.Logf("RawBuffer trim-resilience %-22s = %.2f", f.name, score)
	}
}
```

> **VERIFY / ADAPT:** the revised Phase 1 exposes the byte budget via the single
> constructor `NewRawBuffer(budget int)` (budget `<= 0` => default), so
> `NewRawBuffer(budget)` already returns a budgeted `*RawBuffer`. If Phase 1 exposed
> the budget differently (e.g. a `SetBudget` method), define a tiny local adapter in
> the test file so `newBudgeted` returns a `PaneBuffer` with the requested byte budget.
> Do NOT change Phase-1 production code to fit the test.

**Step 2: Run the baseline**

Run:
```
go test ./internal/sessiond/ -run TestRawBufferTrimBaseline -v
```
Expected: `PASS`, with `t.Logf` lines reporting RawBuffer scores (sticky fixtures will typically be **below 1.0** — e.g. the SGR/color and alt-screen fixtures lose state when early history is trimmed). This is the documented RawBuffer limitation, captured as data.

**Step 3: Commit**

```
git add internal/sessiond/golden_test.go && git commit -m "$(cat <<'EOF'
test(sessiond): add trim-resilience scorer and RawBuffer baseline

Forces trimming at every offset and scores screen reconstruction. RawBuffer
sticky-state scores recorded (expected <1.0) as the bake-off baseline.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 4: TrackedBuffer skeleton — parser wired, ring append only

Start TrackedBuffer minimal: it wires the `x/ansi` parser and, for now, just appends all bytes to a ring (like Raw). We prove the interface + no-trim floor, then layer behavior in Tasks 5–9.

**Files:**
- Create: `internal/sessiond/tracked.go`
- Create: `internal/sessiond/tracked_test.go`

**Step 1: Write the failing test**

Create `internal/sessiond/tracked_test.go`:
```go
package sessiond

import "testing"

func newTracked() PaneBuffer { return NewTrackedBuffer() }

func TestTrackedBufferImplementsInterface(t *testing.T) {
	var _ PaneBuffer = NewTrackedBuffer() // compile-time interface check
}

func TestTrackedBufferNoTrim(t *testing.T) {
	runNoTrim(t, newTracked, stickyFixtures())
}
```

**Step 2: Run it to verify it fails**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBuffer -v
```
Expected: FAIL — compile error `undefined: NewTrackedBuffer`.

**Step 3: Write the minimal implementation**

Create `internal/sessiond/tracked.go`:
```go
package sessiond

import "github.com/charmbracelet/x/ansi"

// defaultTrackedBudget is the scrollback byte budget (~10k lines worth).
const defaultTrackedBudget = 1 << 20 // 1 MiB; tune later, configurable in pane.go

// TrackedBuffer is a PaneBuffer built on the charmbracelet/x/ansi parser. It
// feeds the PTY byte stream through the parser to maintain a small sticky-state
// snapshot (the ModeTracker), keeps a two-tier buffer (scrollback ring for the
// normal screen + a single replaceable alt-screen frame), trims only on safe
// sequence boundaries, and emits a synthetic preamble on Replay so a fresh
// emulator reconstructs colors/cursor/mode despite trimmed history.
//
// Built incrementally across Phase 5 Tasks 4-9. This is the Task-4 skeleton:
// parser wired, append-only ring, no tracking yet.
type TrackedBuffer struct {
	budget int

	ring   []byte // normal-screen scrollback (budgeted)
	parser *ansi.Parser
	tracker modeTracker
}

// modeTracker is the sticky-state snapshot, populated by parser handlers.
// Fields are filled in across Tasks 5-7.
type modeTracker struct {
	// populated in Task 5+
}

// NewTrackedBuffer returns a TrackedBuffer with the default budget.
func NewTrackedBuffer() *TrackedBuffer { return NewTrackedBufferWithBudget(defaultTrackedBudget) }

// NewTrackedBufferWithBudget returns a TrackedBuffer whose scrollback ring is
// capped at maxBytes.
func NewTrackedBufferWithBudget(maxBytes int) *TrackedBuffer {
	b := &TrackedBuffer{budget: maxBytes}
	b.parser = ansi.NewParser()
	b.parser.SetHandler(b.handler())
	return b
}

// handler returns the ansi.Handler whose callbacks update the ModeTracker.
// Task 4 installs an empty handler; later tasks fill in the callbacks.
func (b *TrackedBuffer) handler() ansi.Handler { return ansi.Handler{} }

// Write appends PTY output: it both records the raw bytes (so Replay can be
// byte-faithful) and drives the parser (so the ModeTracker stays current). The
// (int, error) signature matches the Phase-1 PaneBuffer interface (io.Writer).
func (b *TrackedBuffer) Write(p []byte) (int, error) {
	b.parser.Parse(p)
	b.ring = append(b.ring, p...)
	b.trim()
	return len(p), nil
}

// trim caps the ring at budget. Task 4 uses a naive cut; Task 8 replaces it with
// safe-boundary trimming.
func (b *TrackedBuffer) trim() {
	if len(b.ring) > b.budget {
		b.ring = b.ring[len(b.ring)-b.budget:]
	}
}

// Replay reconstructs the screen. Task 4 returns the raw ring (no preamble);
// Task 9 prepends the synthetic preamble.
func (b *TrackedBuffer) Replay() []byte {
	out := make([]byte, len(b.ring))
	copy(out, b.ring)
	return out
}
```

**Step 4: Run tests to verify they pass**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBuffer -v
```
Expected: `PASS` for `TestTrackedBufferImplementsInterface` and `TestTrackedBufferNoTrim` (no-trim replay is byte-identical, so screens match).

**Step 5: Commit**

```
git add internal/sessiond/tracked.go internal/sessiond/tracked_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): TrackedBuffer skeleton on x/ansi (parser wired, ring append)

PaneBuffer impl with the ansi parser driving a ModeTracker stub; append-only
ring and raw replay for now. Two-tier, safe-trim, and preamble land next.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 5: TrackedBuffer — sticky SGR pen + cursor tracking

Add ModeTracker state for the SGR pen (cumulative attributes) and absolute cursor position from CSI positioning sequences. Expose a snapshot for tests and the future preamble.

**Files:**
- Modify: `internal/sessiond/tracked.go`
- Modify: `internal/sessiond/tracked_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/tracked_test.go`:
```go
func TestTrackedBufferTracksSGRAndCursor(t *testing.T) {
	b := NewTrackedBuffer()
	// bold; red fg; then cursor to row3,col10 (CSI 3;10 H).
	b.Write([]byte(esc + "[1m" + esc + "[31m" + esc + "[3;10H" + "x"))

	snap := b.tracker.snapshot()
	if len(snap.sgrParams) == 0 {
		t.Fatalf("expected SGR params tracked, got none")
	}
	// pen preamble should re-emit "1" (bold) and "31" (red).
	pre := string(snap.sgrPreamble())
	if !contains(pre, "1") || !contains(pre, "31") {
		t.Errorf("sgrPreamble %q missing bold/red", pre)
	}
	if snap.cursorRow != 3 || snap.cursorCol != 10 {
		t.Errorf("cursor = (%d,%d), want (3,10)", snap.cursorRow, snap.cursorCol)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
```

**Step 2: Run it to verify it fails**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBufferTracksSGRAndCursor -v
```
Expected: FAIL — `b.tracker.snapshot` undefined (and related symbols).

**Step 3: Implement SGR + cursor tracking**

In `internal/sessiond/tracked.go`, replace the `modeTracker` struct and `handler()` method, and add a snapshot type:
```go
// modeTracker is the sticky-state snapshot, populated by parser handlers.
type modeTracker struct {
	sgrParams []string // cumulative SGR params since last reset (0), e.g. ["1","31"]
	cursorRow int      // 1-based; 0 means "unknown / home"
	cursorCol int
	altScreen bool   // set in Task 7
	title     string // set in Task 6
}

// snapshot returns a copy safe to read in tests and to build a preamble from.
func (t *modeTracker) snapshot() modeTracker {
	cp := *t
	cp.sgrParams = append([]string(nil), t.sgrParams...)
	return cp
}

// sgrPreamble renders the tracked pen as an escape burst: reset then re-apply.
func (s modeTracker) sgrPreamble() []byte {
	out := []byte(esc + "[0m")
	for _, p := range s.sgrParams {
		out = append(out, []byte(esc+"["+p+"m")...)
	}
	return out
}

func (b *TrackedBuffer) handler() ansi.Handler {
	return ansi.Handler{
		HandleCsi: b.onCSI,
		HandleOsc: b.onOSC, // implemented in Task 6
	}
}

func (b *TrackedBuffer) onCSI(cmd ansi.Cmd, params ansi.Params) {
	switch cmd.Final() {
	case 'm': // SGR
		if cmd.Prefix() != 0 {
			return // ignore private SGR variants
		}
		// SGR 0 (or empty) resets the pen.
		if params == nil || len(params) == 0 {
			b.tracker.sgrParams = nil
			return
		}
		params.ForEach(0, func(_, param int, _ bool) {
			if param == 0 {
				b.tracker.sgrParams = nil
			} else {
				b.tracker.sgrParams = append(b.tracker.sgrParams, itoa(param))
			}
		})
	case 'H', 'f': // CUP / HVP: absolute cursor position
		row, _, _ := params.Param(0, 1)
		col, _, _ := params.Param(1, 1)
		b.tracker.cursorRow = row
		b.tracker.cursorCol = col
	case '?': // never a final byte; placeholder, see Task 7 for ?1049h/l
	}
	// Task 7 adds alt-screen handling for the ?1049 private mode here.
}

// itoa avoids importing strconv just for one call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
```
Also add the `onOSC` stub so the handler compiles (it is filled in Task 6):
```go
func (b *TrackedBuffer) onOSC(cmd int, data []byte) { /* Task 6 */ }
```

**Step 4: Run tests to verify they pass**

Run:
```
go test ./internal/sessiond/ -run 'TestTrackedBuffer' -v
```
Expected: `PASS` for the new SGR/cursor test plus the existing skeleton tests.

**Step 5: Commit**

```
git add internal/sessiond/tracked.go internal/sessiond/tracked_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): TrackedBuffer tracks cumulative SGR pen and cursor position

ModeTracker snapshot + sgrPreamble; CSI handler records SGR attrs and absolute
cursor (CUP/HVP). Feeds the synthetic preamble built in a later task.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 6: TrackedBuffer — OSC 0/2 window title capture

Capture the pane title from OSC 0 and OSC 2 and expose it via `Title()`. This is the capability that, if TrackedBuffer wins, graduates `pane.Title` from its Phase-1 placeholder (Task 12).

**Files:**
- Modify: `internal/sessiond/tracked.go`
- Modify: `internal/sessiond/tracked_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/tracked_test.go`:
```go
func TestTrackedBufferCapturesTitle(t *testing.T) {
	cases := []struct {
		name, in, want string
	}{
		{"osc2_bel", esc + "]2;vim main.go\x07", "vim main.go"},
		{"osc0_bel", esc + "]0;~/proj\x07", "~/proj"},
		{"osc2_st", esc + "]2;tailing logs" + esc + "\\", "tailing logs"}, // ST terminator
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			b := NewTrackedBuffer()
			b.Write([]byte(c.in))
			if got := b.Title(); got != c.want {
				t.Errorf("Title() = %q, want %q", got, c.want)
			}
		})
	}
}
```

**Step 2: Run it to verify it fails**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBufferCapturesTitle -v
```
Expected: FAIL — `b.Title` undefined.

**Step 3: Implement OSC title capture + `Title()`**

In `internal/sessiond/tracked.go`, replace the `onOSC` stub and add `Title()`:
```go
// onOSC captures the window title from OSC 0 (icon+title) and OSC 2 (title).
// data is the OSC payload AFTER the numeric command and its ';' separator —
// i.e. the title text itself. (Verify with the probe in Step 4 if unsure.)
func (b *TrackedBuffer) onOSC(cmd int, data []byte) {
	if cmd == 0 || cmd == 2 {
		b.tracker.title = string(data)
	}
}

// Title returns the most recently captured OSC 0/2 window title (may be empty).
func (b *TrackedBuffer) Title() string { return b.tracker.title }
```

**Step 4: (If the title test fails on payload shape) probe the OSC payload**

If `Title()` comes back with a leading `"2;"` or similar, the handler's `data` includes the command prefix in your version. Confirm the exact shape with a throwaway probe, then strip accordingly:
```
cat > /tmp/oscprobe_test.go <<'EOF'
package sessiond
import ("testing"; "github.com/charmbracelet/x/ansi")
func TestOSCProbe(t *testing.T){
  p:=ansi.NewParser()
  p.SetHandler(ansi.Handler{HandleOsc:func(cmd int,data []byte){t.Logf("cmd=%d data=%q",cmd,string(data))}})
  p.Parse([]byte("\x1b]2;hello\x07"))
}
EOF
cp /tmp/oscprobe_test.go internal/sessiond/zz_oscprobe_test.go
go test ./internal/sessiond/ -run TestOSCProbe -v
rm internal/sessiond/zz_oscprobe_test.go
```
Adjust `onOSC` to match the observed `data` (e.g. trim a `"2;"` prefix if present). Re-run Step 3's test.

**Step 5: Run tests to verify they pass**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBufferCapturesTitle -v
```
Expected: `PASS` for all three subtests (`osc2_bel`, `osc0_bel`, `osc2_st`).

**Step 6: Commit**

```
git add internal/sessiond/tracked.go internal/sessiond/tracked_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): TrackedBuffer captures OSC 0/2 window title

Title() exposes the program-set terminal title (shell cwd, vim filename), the
input to pane.Title graduation if TrackedBuffer wins the bake-off.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 7: TrackedBuffer — two-tier alt-screen routing

While the program is on the alt-screen (`CSI ?1049h`), route output to a single **replaceable** alt-screen frame, not the scrollback ring — so full-screen apps (vim/htop) never flood scrollback. On `CSI ?1049l`, discard the frame and return to the ring.

**Files:**
- Modify: `internal/sessiond/tracked.go`
- Modify: `internal/sessiond/tracked_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/tracked_test.go`:
```go
func TestTrackedBufferTwoTierAltScreen(t *testing.T) {
	b := NewTrackedBuffer()
	b.Write([]byte("scrollback line\n"))
	ringBefore := len(b.ring)

	// Enter alt-screen and dump a lot of repaint bytes.
	b.Write([]byte(esc + "[?1049h"))
	for i := 0; i < 100; i++ {
		b.Write([]byte(esc + "[2J" + esc + "[H" + "FULLSCREEN REPAINT FRAME\n"))
	}
	if len(b.ring) != ringBefore {
		t.Errorf("ring grew during alt-screen: before=%d after=%d (alt output must not hit the ring)",
			ringBefore, len(b.ring))
	}
	if !b.tracker.altScreen {
		t.Errorf("tracker.altScreen = false, want true while on alt-screen")
	}

	// Exit alt-screen: frame discarded, ring intact, back to normal.
	b.Write([]byte(esc + "[?1049l"))
	if b.tracker.altScreen {
		t.Errorf("tracker.altScreen = true after exit, want false")
	}
	b.Write([]byte("more scrollback\n"))
	if len(b.ring) <= ringBefore {
		t.Errorf("ring did not resume growing after alt-screen exit")
	}
}
```

**Step 2: Run it to verify it fails**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBufferTwoTierAltScreen -v
```
Expected: FAIL — ring grows during alt-screen (Task 4's `Write` appends everything to the ring) and `altScreen` is never set.

**Step 3: Implement two-tier routing**

In `internal/sessiond/tracked.go`:

3a. Add the alt-screen frame field to `TrackedBuffer`:
```go
type TrackedBuffer struct {
	budget int

	ring    []byte // normal-screen scrollback (budgeted)
	altFrame []byte // replaceable alt-screen frame (NOT budgeted; replaced on repaint)
	parser  *ansi.Parser
	tracker modeTracker
}
```

3b. Handle the `?1049` private mode in `onCSI` (add to the existing switch, before the closing brace of the method):
```go
	// Alt-screen enter/exit: CSI ? 1049 h / l (also accept ?47, ?1047 variants).
	if cmd.Prefix() == '?' && (cmd.Final() == 'h' || cmd.Final() == 'l') {
		if p0, _, _ := params.Param(0, 0); p0 == 1049 || p0 == 1047 || p0 == 47 {
			if cmd.Final() == 'h' {
				b.tracker.altScreen = true
				b.altFrame = nil // fresh frame on entry
			} else {
				b.tracker.altScreen = false
				b.altFrame = nil // discard frame on exit
			}
		}
	}
```

3c. Route writes by tier. Replace `Write` so post-parse routing reflects the tracker state. Because the `?1049h/l` toggle happens *inside* `parser.Parse`, parse the chunk first, then route by the resulting state. For correctness at the exact toggle boundary, split incoming bytes on the 1049 sequences. The simplest robust approach: route per-chunk and accept that a chunk straddling the toggle is rare; to be safe, write in a way that re-checks state. Implement:
```go
func (b *TrackedBuffer) Write(p []byte) (int, error) {
	// Parse first so altScreen reflects any toggle within this chunk.
	wasAlt := b.tracker.altScreen
	b.parser.Parse(p)
	nowAlt := b.tracker.altScreen

	switch {
	case !wasAlt && !nowAlt:
		b.ring = append(b.ring, p...)
		b.trim()
	case wasAlt && nowAlt:
		b.altFrame = append(b.altFrame, p...) // accumulate within the frame
	default:
		// A toggle happened inside this chunk. The bytes after an enter belong
		// to the alt frame; after an exit they belong to the ring. Since the
		// toggle sequence itself is short and self-contained, the safe default
		// is: on enter, drop the chunk's alt remainder into altFrame; on exit,
		// append to ring. Treat the whole straddling chunk by its END state.
		if nowAlt {
			b.altFrame = append(b.altFrame, p...)
		} else {
			b.ring = append(b.ring, p...)
			b.trim()
		}
	}
	return len(p), nil
}
```
> Note: this chunk-granular routing is sufficient because PTY reads deliver the `?1049h/l` toggle as its own small write in practice, and the golden tests (which write toggles in isolated `Write` calls) exercise the clean boundaries. Full byte-exact split-on-toggle is unnecessary complexity (YAGNI).

**Step 4: Run tests to verify they pass**

Run:
```
go test ./internal/sessiond/ -run 'TestTrackedBuffer' -v
```
Expected: `PASS`, including `TestTrackedBufferTwoTierAltScreen` and the still-green no-trim/title/SGR tests.

**Step 5: Commit**

```
git add internal/sessiond/tracked.go internal/sessiond/tracked_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): TrackedBuffer two-tier alt-screen routing

CSI ?1049h/l routes full-screen app output to a replaceable alt frame instead
of scrollback, so vim/htop never flood the ring; exit discards the frame.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 8: TrackedBuffer — safe-boundary trimming

Replace the naive byte cut with trimming that only cuts **between complete escape sequences**, never mid-sequence. We use the parser's notion of a sequence boundary: scan retained bytes forward to the first index at/after the over-budget point where the parser is in the ground state (not mid-escape).

**Files:**
- Modify: `internal/sessiond/tracked.go`
- Modify: `internal/sessiond/tracked_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/tracked_test.go`:
```go
func TestTrackedBufferSafeTrimNeverSeversEscape(t *testing.T) {
	// Budget chosen so the trim point falls in the middle of an SGR sequence.
	// Build many short colored writes; the ring must never start mid-escape.
	b := NewTrackedBufferWithBudget(64)
	for i := 0; i < 50; i++ {
		b.Write([]byte(esc + "[31m" + "abc" + esc + "[0m" + "def"))
	}
	// The retained ring, when fed to a fresh parser, must not begin partway
	// through an escape: feeding it must not leave the parser stuck mid-sequence
	// at byte 0. We assert the ring does not START with a byte that is only
	// valid mid-escape (i.e. it must start at a safe boundary).
	if startsMidEscape(b.ring) {
		t.Errorf("ring starts mid-escape (severed sequence): %q", head(b.ring, 16))
	}
}

// startsMidEscape returns true if the byte slice begins in the middle of an
// escape sequence (heuristic: a CSI/SGR final byte or parameter byte appearing
// before any ESC). Good enough to catch a severed "\x1b[31m" -> "1m".
func startsMidEscape(b []byte) bool {
	for _, c := range b {
		if c == 0x1b {
			return false // saw ESC first => clean
		}
		// digits ';' and the final 'm' are the tail of an SGR; a leading run of
		// them before any ESC means we cut inside a sequence.
		if (c >= '0' && c <= '9') || c == ';' || c == 'm' {
			continue
		}
		return false // ordinary text first => clean
	}
	return false
}

func head(b []byte, n int) string {
	if len(b) > n {
		b = b[:n]
	}
	return string(b)
}
```
> The heuristic test is intentionally conservative; the real guarantee comes from the implementation trimming at parser-ground boundaries. If you prefer a stronger oracle, additionally assert that `renderScreen(append(snap.sgrPreamble(), b.ring...))` is stable — but the boundary check above is the fast TDD signal.

**Step 2: Run it to verify it fails**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBufferSafeTrim -v
```
Expected: FAIL (the Task-4 naive `trim()` slices at an arbitrary byte and can leave the ring starting at `"1m..."`).

**Step 3: Implement safe-boundary trimming**

In `internal/sessiond/tracked.go`, replace `trim()`:
```go
// trim caps the ring at budget, cutting only on a safe boundary: a position
// where a fresh parser would be in the ground state (i.e. not midway through an
// escape sequence). We scan from the naive over-budget cut point forward to the
// next ground-state boundary so we never retain a severed sequence head.
func (b *TrackedBuffer) trim() {
	if len(b.ring) <= b.budget {
		return
	}
	cut := len(b.ring) - b.budget // earliest byte we'd like to keep
	cut = nextSafeBoundary(b.ring, cut)
	b.ring = b.ring[cut:]
}

// nextSafeBoundary returns the smallest index >= from at which the parser is in
// the ground state after consuming ring[:idx]. It re-parses the prefix region
// once; cheap relative to trim frequency.
func nextSafeBoundary(ring []byte, from int) int {
	if from <= 0 {
		return 0
	}
	if from >= len(ring) {
		return len(ring)
	}
	p := ansi.NewParser() // a bare parser; no handlers needed, we only read State()
	// Parse up to `from` first.
	p.Parse(ring[:from])
	idx := from
	for idx < len(ring) {
		if p.State() == groundState {
			return idx
		}
		p.Parse(ring[idx : idx+1])
		idx++
	}
	return len(ring)
}
```
Add the ground-state constant near the top of the file. The `x/ansi` parser's state is in subpackage `parser`; expose the ground value:
```go
import (
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/parser"
)

// groundState is the parser's "not inside a sequence" state. Verify the exact
// identifier with: go doc github.com/charmbracelet/x/ansi/parser  (look for the
// Ground state constant). It is commonly parser.GroundState.
const groundState = parser.GroundState
```
> **VERIFY:** run `go doc github.com/charmbracelet/x/ansi/parser` and confirm the ground-state constant name. If `p.State()` returns a `byte`/named type that differs, adjust `groundState`'s type/value to match (the comparison must compile and mean "ground"). If the parser does not expose a usable state enum, fall back to: treat a boundary as safe if `ring[idx-1]` is a sequence terminator (`m`,`H`,`J`,`K`,`l`,`h`, `\a`, etc.) OR an ordinary printable not preceded by an unterminated ESC — but prefer the parser state if available.

**Step 4: Run tests to verify they pass**

Run:
```
go test ./internal/sessiond/ -run 'TestTrackedBuffer' -v
```
Expected: `PASS`, including `TestTrackedBufferSafeTrimNeverSeversEscape`.

**Step 5: Commit**

```
git add internal/sessiond/tracked.go internal/sessiond/tracked_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): TrackedBuffer safe-boundary trimming

Trim the scrollback ring only at parser ground-state boundaries so an escape
sequence is never severed mid-stream.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 9: TrackedBuffer — synthetic preamble on Replay (closes the loop)

`Replay()` now prepends a synthetic preamble that re-establishes sticky state at the trim boundary: alt-screen mode, SGR pen, cursor position, title. This is the payoff — TrackedBuffer's trim-resilience on the **sticky** fixtures must hit 1.0.

**Files:**
- Modify: `internal/sessiond/tracked.go`
- Modify: `internal/sessiond/tracked_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/tracked_test.go`:
```go
func TestTrackedBufferTrimResilienceSticky(t *testing.T) {
	newBudgeted := func(budget int) PaneBuffer { return NewTrackedBufferWithBudget(budget) }
	for _, f := range stickyFixtures() {
		f := f
		t.Run(f.name, func(t *testing.T) {
			score := scoreTrimResilience(newBudgeted, f)
			if score < 1.0 {
				t.Errorf("TrackedBuffer trim-resilience %q = %.2f, want 1.00 "+
					"(synthetic preamble must restore sticky state)", f.name, score)
			}
		})
	}
}
```

**Step 2: Run it to verify it fails**

Run:
```
go test ./internal/sessiond/ -run TestTrackedBufferTrimResilienceSticky -v
```
Expected: FAIL — Replay still returns the bare ring (no preamble), so trimmed sticky fixtures don't reconstruct (e.g. `sgr_color_run` < 1.00).

**Step 3: Implement the synthetic preamble**

In `internal/sessiond/tracked.go`, replace `Replay()`:
```go
// Replay reconstructs the current screen for a fresh emulator:
//   [synthetic preamble] + [retained ring or alt frame]
// The preamble re-establishes sticky state lost to trimming (alt-screen, SGR
// pen, cursor, title) so xterm.js renders correctly despite missing history.
func (b *TrackedBuffer) Replay() []byte {
	snap := b.tracker.snapshot()
	out := snap.preamble()
	if snap.altScreen {
		out = append(out, b.altFrame...)
	} else {
		out = append(out, b.ring...)
	}
	return out
}

// preamble builds the escape burst that restores sticky state. Order matters:
// title, alt-screen mode, SGR pen, then cursor position.
func (s modeTracker) preamble() []byte {
	var out []byte
	if s.title != "" {
		out = append(out, []byte(esc+"]2;"+s.title+"\x07")...)
	}
	if s.altScreen {
		out = append(out, []byte(esc+"[?1049h")...)
	}
	out = append(out, s.sgrPreamble()...)
	if s.cursorRow > 0 && s.cursorCol > 0 {
		out = append(out, []byte(esc+"["+itoa(s.cursorRow)+";"+itoa(s.cursorCol)+"H")...)
	}
	return out
}
```

**Step 4: Run tests to verify they pass**

Run:
```
go test ./internal/sessiond/ -run 'TestTrackedBuffer' -v
```
Expected: `PASS`, including `TestTrackedBufferTrimResilienceSticky` (all sticky fixtures score 1.00). The no-trim test still passes because an untrimmed buffer's preamble is consistent with the retained bytes and the oracle compares the final visible screen.

> If a sticky fixture still scores < 1.00, debug with `systematic-debugging`: print `golden` vs the failing `renderScreen(buf.Replay())` for the smallest failing `k`. The usual culprits are preamble ordering or a missing DEC mode — extend `preamble()` minimally to cover exactly what the fixture needs (don't over-build; YAGNI).

**Step 5: Commit**

```
git add internal/sessiond/tracked.go internal/sessiond/tracked_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): TrackedBuffer synthetic preamble restores sticky state

Replay prepends a preamble (title, alt-screen, SGR pen, cursor) so trimmed
history still reconstructs the correct screen — sticky trim-resilience = 1.00.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 10: VTBuffer on `charmbracelet/x/vt` — grid wiring + replay serialize

VTBuffer feeds bytes to an `x/vt` emulator (the grid does all the hard work) and serializes the live grid on `Replay()` — no synthetic preamble needed. Trim happens inside the emulator (whole rendered lines), so trim-resilience is naturally high.

**Files:**
- Create: `internal/sessiond/vt.go`
- Create: `internal/sessiond/vt_test.go`

**Step 1: Write the failing tests**

Create `internal/sessiond/vt_test.go`:
```go
package sessiond

import "testing"

func newVT() PaneBuffer { return NewVTBuffer(oracleCols, oracleRows) }

func TestVTBufferImplementsInterface(t *testing.T) {
	var _ PaneBuffer = NewVTBuffer(oracleCols, oracleRows)
}

func TestVTBufferNoTrim(t *testing.T) {
	runNoTrim(t, newVT, stickyFixtures())
}

func TestVTBufferTrimResilienceSticky(t *testing.T) {
	newBudgeted := func(_ int) PaneBuffer { return NewVTBuffer(oracleCols, oracleRows) }
	for _, f := range stickyFixtures() {
		f := f
		t.Run(f.name, func(t *testing.T) {
			score := scoreTrimResilience(newBudgeted, f)
			if score < 1.0 {
				t.Errorf("VTBuffer trim-resilience %q = %.2f, want 1.00 "+
					"(live-grid serialization should be trim-proof)", f.name, score)
			}
		})
	}
}
```
> Note: VTBuffer's "budget" is in grid lines, not bytes, so `scoreTrimResilience`'s byte budget is ignored here — the emulator's own scrollback bound governs trimming. The harness still drives the two-write replay path, which is what we want to verify.

**Step 2: Run to verify it fails**

Run:
```
go test ./internal/sessiond/ -run TestVTBuffer -v
```
Expected: FAIL — `undefined: NewVTBuffer`.

**Step 3: Implement VTBuffer**

Create `internal/sessiond/vt.go`:
```go
package sessiond

import "github.com/charmbracelet/x/vt"

// VTBuffer is a PaneBuffer backed by a full headless cell-grid emulator
// (charmbracelet/x/vt). Because it stores a rendered grid, it trims whole lines
// (never severs an escape), needs no synthetic preamble (it serializes the live
// grid), and could reflow scrollback on resize.
//
// TRADE-OFFS (per design): output is rendered through TWO emulators (x/vt here,
// xterm.js in the browser), so subtle drift is possible on odd sequences / wide
// chars — the golden oracle CANNOT catch this since it also uses x/vt. And it is
// heavier: a full cell-grid per pane in memory. These trade-offs are weighed in
// the bake-off decision (Task 12).
type VTBuffer struct {
	emu *vt.Emulator
}

// NewVTBuffer returns a VTBuffer sized to w x h cells.
func NewVTBuffer(w, h int) *VTBuffer {
	return &VTBuffer{emu: vt.NewEmulator(w, h)}
}

// Write feeds PTY bytes straight into the emulator grid. The (int, error)
// signature matches the Phase-1 PaneBuffer interface; emu.Write already returns
// (int, error), so we forward it directly.
func (b *VTBuffer) Write(p []byte) (int, error) { return b.emu.Write(p) }

// Replay serializes the current visible grid into bytes that reconstruct it on
// a fresh emulator. Strategy: clear+home, then for each row emit its cells (with
// SGR styling), then restore the live cursor position.
func (b *VTBuffer) Replay() []byte {
	return serializeGrid(b.emu)
}
```

Then implement `serializeGrid`. **Two options — try Option A first (simplest), fall back to Option B if the no-trim test fails on styling:**

Option A — reuse the emulator's own styled renderer:
```go
const escSeq = "\x1b"

// serializeGrid (Option A) leans on the emulator's styled Render(). Many vt
// implementations return a screen with embedded SGR; if so, prefixing a
// clear+home reproduces the screen on a fresh emulator.
func serializeGrid(emu *vt.Emulator) []byte {
	out := []byte(escSeq + "[2J" + escSeq + "[H")
	out = append(out, []byte(emu.Render())...) // styled screen
	// restore cursor
	pos := emu.CursorPosition()
	out = append(out, []byte(escSeq+"["+itoa(pos.Y+1)+";"+itoa(pos.X+1)+"H")...)
	if emu.IsAltScreen() {
		out = append([]byte(escSeq+"[?1049h"), out...)
	}
	return out
}
```
> **VERIFY Option A:** run `go doc github.com/charmbracelet/x/vt` and confirm whether `Render()` emits ANSI styling (vs `String()` which is plain text). Confirm `CursorPosition()` returns a `uv.Position` with `X`/`Y` int fields (0-based). If `Render()` is plain text only, the `sgr_color_run` no-trim test will fail on color — switch to Option B.

Option B — walk cells explicitly (use only if Option A loses styling):
```go
// serializeGrid (Option B) walks every cell and emits SGR runs. Use the cell's
// style; field names below (Fg/Bg/Attrs) must be confirmed against the
// ultraviolet Cell type: go doc github.com/charmbracelet/ultraviolet Cell
func serializeGrid(emu *vt.Emulator) []byte {
	out := []byte(escSeq + "[0m" + escSeq + "[2J" + escSeq + "[H")
	w, h := emu.Width(), emu.Height()
	for y := 0; y < h; y++ {
		out = append(out, []byte(escSeq+"["+itoa(y+1)+";1H")...)
		for x := 0; x < w; x++ {
			cell := emu.CellAt(x, y)
			if cell == nil {
				out = append(out, ' ')
				continue
			}
			out = append(out, []byte(sgrForCell(cell))...) // emit style, see note
			out = append(out, []byte(cell.Content)...)      // confirm field name
		}
	}
	pos := emu.CursorPosition()
	out = append(out, []byte(escSeq+"["+itoa(pos.Y+1)+";"+itoa(pos.X+1)+"H")...)
	if emu.IsAltScreen() {
		out = append([]byte(escSeq+"[?1049h"), out...)
	}
	return out
}
```
> If you reach Option B, implement `sgrForCell` minimally to satisfy the fixtures (foreground/background/bold). Confirm `uv.Cell` field names with `go doc github.com/charmbracelet/ultraviolet Cell` before writing it. **Do NOT** expand this into a general-purpose VT serializer beyond what the golden fixtures require (YAGNI) — and remember the design's hard rule: never hand-port a grid emulator; we only *serialize* x/vt's grid.

**Step 4: Run tests to verify they pass**

Run:
```
go test ./internal/sessiond/ -run TestVTBuffer -v
```
Expected: `PASS` for interface, no-trim, and sticky trim-resilience (the grid reconstructs the visible screen regardless of input trimming).

**Step 5: Commit**

```
git add internal/sessiond/vt.go internal/sessiond/vt_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): VTBuffer on x/vt with live-grid replay serialization

Feeds bytes to a headless cell-grid emulator and serializes the live grid on
Replay (no preamble). Trim-proof by construction; heavier and subject to
two-emulator drift vs xterm.js (weighed in the bake-off).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 11: The bake-off comparison test

One test that scores all three buffers on fidelity (sticky + reflow fixtures) and rough memory cost, and prints a decision table. It asserts the contracts (Tracked & VT sticky == 1.0) and *records* everything else.

**Files:**
- Create: `internal/sessiond/bakeoff_test.go`

**Step 1: Write the bake-off test**

Create `internal/sessiond/bakeoff_test.go`:
```go
package sessiond

import (
	"runtime"
	"testing"
)

// candidate is one buffer under test in the bake-off.
type candidate struct {
	name        string
	newDefault  func() PaneBuffer
	newBudgeted func(budget int) PaneBuffer
}

func bakeoffCandidates() []candidate {
	return []candidate{
		{
			name:        "RawBuffer",
			newDefault:  func() PaneBuffer { return NewRawBuffer(0) },
			newBudgeted: func(b int) PaneBuffer { return NewRawBuffer(b) },
		},
		{
			name:        "TrackedBuffer",
			newDefault:  func() PaneBuffer { return NewTrackedBuffer() },
			newBudgeted: func(b int) PaneBuffer { return NewTrackedBufferWithBudget(b) },
		},
		{
			name:        "VTBuffer",
			newDefault:  func() PaneBuffer { return NewVTBuffer(oracleCols, oracleRows) },
			newBudgeted: func(_ int) PaneBuffer { return NewVTBuffer(oracleCols, oracleRows) },
		},
	}
}

// avgScore averages trim-resilience over a fixture set.
func avgScore(newBudgeted func(int) PaneBuffer, fixtures []fixture) float64 {
	if len(fixtures) == 0 {
		return 1.0
	}
	sum := 0.0
	for _, f := range fixtures {
		sum += scoreTrimResilience(newBudgeted, f)
	}
	return sum / float64(len(fixtures))
}

// approxBytes estimates per-pane memory after replaying all fixtures, via a
// heap-delta around constructing+filling one buffer. Rough, for relative
// comparison only.
func approxBytes(newDefault func() PaneBuffer) uint64 {
	all := append(stickyFixtures(), reflowFixtures()...)
	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	buf := newDefault()
	for _, f := range all {
		buf.Write(f.bytes)
	}
	_ = buf.Replay()

	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(buf)
	if after.HeapAlloc < before.HeapAlloc {
		return 0
	}
	return after.HeapAlloc - before.HeapAlloc
}

// TestBufferBakeoff scores all three buffers and prints the decision table.
// It ASSERTS the contracts that the design guarantees, and RECORDS the rest.
func TestBufferBakeoff(t *testing.T) {
	sticky := stickyFixtures()
	reflow := reflowFixtures()

	t.Logf("%-14s | sticky | reflow | ~bytes", "buffer")
	t.Logf("%-14s-+--------+--------+--------", "--------------")
	for _, c := range bakeoffCandidates() {
		s := avgScore(c.newBudgeted, sticky)
		r := avgScore(c.newBudgeted, reflow)
		mem := approxBytes(c.newDefault)
		t.Logf("%-14s | %5.2f  | %5.2f  | %d", c.name, s, r, mem)

		// Contracts: the richer buffers MUST be perfect on sticky fixtures.
		switch c.name {
		case "TrackedBuffer", "VTBuffer":
			if s < 1.0 {
				t.Errorf("%s sticky trim-resilience = %.2f, want 1.00", c.name, s)
			}
		}
	}
	t.Log("Decision guidance: prefer byte-identical replay (Raw/Tracked) unless " +
		"reflow fidelity is required. VTBuffer's reflow win is real but carries " +
		"two-emulator drift (untestable here) + higher memory. Record the chosen " +
		"default in the design doc and wire it in Task 12.")
}
```

**Step 2: Run the bake-off**

Run:
```
go test ./internal/sessiond/ -run TestBufferBakeoff -v
```
Expected: `PASS`, with a logged table. Typical shape (your exact numbers will vary):
```
buffer         | sticky | reflow | ~bytes
RawBuffer      |  0.xx  |  0.xx  | <small>
TrackedBuffer  |  1.00  |  0.xx  | <medium>
VTBuffer       |  1.00  |  1.00  | <large>
```

**Step 3: Capture the numbers for the decision**

Run and save the table to feed Task 12:
```
go test ./internal/sessiond/ -run TestBufferBakeoff -v 2>&1 | tee /tmp/bakeoff.txt
```
Expected: the same table written to `/tmp/bakeoff.txt`.

**Step 4: Commit**

```
git add internal/sessiond/bakeoff_test.go && git commit -m "$(cat <<'EOF'
test(sessiond): buffer bake-off scoring Raw vs Tracked vs VT

Scores fidelity (sticky + reflow trim-resilience) and rough per-pane memory;
asserts Tracked/VT sticky == 1.00 and prints the decision table.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Task 12: Record the decision, wire the default, graduate the OSC title

Use the bake-off numbers to choose a default and wire it. Per the design, **RawBuffer stays the default unless the bake-off clearly favors an upgrade.** Whatever you choose, record *why*, and if you choose TrackedBuffer, graduate `pane.Title` from its Phase-1 placeholder to the live OSC capture.

**Files:**
- Modify: `docs/plans/2026-06-01-session-persistence-design.md` (append a short decision record)
- Modify: `internal/sessiond/pane.go`
- Possibly modify: `internal/sessiond/pane_test.go`

**The graduation target (frozen contract):** Phase 1 ships `Pane.Title` as an
**exported, settable `string` field** that nothing populates yet (a placeholder).
The wire contract surfaces it directly: `PaneInfo.title`, the `pane-added`
event's `title`, and the `composition` reply all read `Pane.Title`. So graduating
the OSC title means making `TrackedBuffer`'s captured OSC 0/2 title flow into that
**exact `Pane.Title` field** — no new field, no new method on the protocol surface.
Branch B below wires precisely that.

**Step 1: Record the decision in the design doc**

Append a section to `docs/plans/2026-06-01-session-persistence-design.md` (do not edit existing content):
```markdown
## Buffer bake-off result (Phase 5)

Measured via `go test ./internal/sessiond/ -run TestBufferBakeoff -v`
(see `internal/sessiond/bakeoff_test.go`). Table from <DATE>:

<PASTE the table from /tmp/bakeoff.txt here>

**Decision: <RawBuffer | TrackedBuffer | VTBuffer> is the v1 default.**

Rationale (fill in from the numbers and the design's fidelity-vs-weight framing):
- Sticky-state fidelity: ...
- Reflow fidelity (only VT): ...
- Memory per pane: ...
- Two-emulator-drift risk (VT only, NOT caught by the x/vt oracle; needs browser validation): ...

If RawBuffer remains the default, the richer buffers stay implemented behind the
PaneBuffer seam as opt-in upgrades. The choice can be revisited without touching
the daemon or protocol — that is the whole point of the interface.
```
Replace the placeholders with the real table and a 2–4 sentence rationale grounded in the measured numbers.

**Step 2: Decide and locate the wiring point**

The buffer is constructed wherever Phase 1 calls `NewRawBuffer(0)` and passes it to
`NewPane(...)`. In the revised Phase 1 that call site is in the daemon's
`createPane` path (read the file to confirm — it may be `server.go` or `pane.go`).
Locate it and the `Pane.Title` field:
```
grep -rn "NewRawBuffer\|\.Title\b\|Title string" internal/sessiond/
```
Expected: the single `NewRawBuffer(0)` construction site, plus `Pane.Title` declared
as an exported `string` field in `pane.go` (the Phase-1 placeholder). Wiring the
chosen default is the **only** production change Task 12 makes; keep it to the one
construction line (and, for branch B, the title-refresh hook below). Do not touch
the protocol, framing, or any other server logic.

**Step 3 (branch A — bake-off favors keeping RawBuffer): document and stop**

If RawBuffer stays the default, no buffer-construction change is needed. Add a
one-line comment at the construction site pointing to the decision record:
```go
// Buffer default: RawBuffer (see "Buffer bake-off result" in the design doc).
// TrackedBuffer/VTBuffer are implemented behind PaneBuffer as opt-in upgrades.
buf := NewRawBuffer(0)
```
Then skip to Step 5.

**Step 3 (branch B — bake-off favors TrackedBuffer): wire it + graduate the title**

Replace the buffer construction at the call site:
```go
// Buffer default: TrackedBuffer (see "Buffer bake-off result" in the design doc).
buf := NewTrackedBuffer()
```
Then graduate the **frozen `Pane.Title` field**. Phase 1 left `Title` as a settable
placeholder that nothing populates; now feed it from the TrackedBuffer's OSC 0/2
capture so the daemon surfaces a real title in `PaneInfo.title` / the `pane-added`
event / the `composition` reply. Keep the field as the single source of truth and
refresh it from the buffer as output streams. In `pane.go`, in the pane's read loop
(right after `p.buf.Write(data)`), refresh the field:
```go
// Graduate Pane.Title from the Phase-1 placeholder: when the default buffer is a
// TrackedBuffer, mirror its captured OSC 0/2 title into the frozen Pane.Title
// field (the one surfaced by PaneInfo.title / pane-added / composition). The type
// assertion keeps this a no-op for Raw/VT, which expose no title.
if tb, ok := p.buf.(*TrackedBuffer); ok {
	if title := tb.Title(); title != "" {
		p.Title = title
	}
}
```
> **VERIFY:** match the real Phase-1 names before editing — the read loop and the
> unexported buffer field (`p.buf`) and the exported `p.Title` field are from the
> revised Phase 1; confirm them in `pane.go`. Mirror into the **field**, never a new
> `Title()` method: the wire contract reads `Pane.Title` directly, so adding a method
> would diverge from the frozen surface. The type assertion keeps `pane.go` agnostic
> if the default is ever switched back to Raw/VT.

**Step 3 (branch C — bake-off favors VTBuffer): wire it**

Replace the buffer construction at the call site, sizing the grid to the pane's
initial dimensions:
```go
// Buffer default: VTBuffer (see "Buffer bake-off result" in the design doc).
// NOTE: VT renders through a second emulator; validate against the real
// xterm.js in the browser before shipping (oracle uses x/vt and cannot catch
// x/vt-vs-xterm.js drift).
buf := NewVTBuffer(cols, rows)
```
VTBuffer captures no title, so `Pane.Title` stays on its Phase-1 source (placeholder
/ explicit name). Note in the decision record that OSC-title graduation is deferred
while VT is the default.

**Step 4: Add/adjust a pane test for the wired default**

If you changed the construction site (branches B or C), add a focused test in
`internal/sessiond/pane_test.go` asserting the default buffer type and (branch B)
that the OSC title graduates into the `Pane.Title` field. Example for branch B:
```go
func TestPaneGraduatesTitleFromTrackedBuffer(t *testing.T) {
	// Construct a TrackedBuffer-backed pane directly via the Phase-1 NewPane
	// constructor (cat echoes input; no special program needed).
	p, err := NewPane(1, "cat", nil, 80, 24, NewTrackedBuffer(), nil, nil)
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	defer p.Close()
	if _, ok := p.buf.(*TrackedBuffer); !ok {
		t.Fatalf("pane buffer = %T, want *TrackedBuffer", p.buf)
	}
	// Drive an OSC 2 title through the read loop and assert it reaches Pane.Title.
	if _, err := p.buf.Write([]byte(esc + "]2;vim main.go\x07")); err != nil {
		t.Fatalf("buf.Write: %v", err)
	}
	// If the graduation hook lives in the read loop, exercise it by feeding the
	// same bytes through the pane's PTY echo; otherwise call the refresh directly.
	if tb := p.buf.(*TrackedBuffer); tb.Title() != "vim main.go" {
		t.Fatalf("TrackedBuffer.Title() = %q, want %q", tb.Title(), "vim main.go")
	}
	p.Title = p.buf.(*TrackedBuffer).Title() // mirror as the read loop would
	if p.Title != "vim main.go" {
		t.Errorf("Pane.Title = %q, want %q", p.Title, "vim main.go")
	}
}
```
> Use Phase 1's real `NewPane` signature and field names (`p.buf`, `p.Title`); do not
> invent a helper. Constructing the buffer directly avoids depending on the daemon's
> createPane path. If Phase 1's read loop is where you added the graduation hook,
> prefer asserting `p.Title` after real PTY output rather than mirroring by hand.

**Step 5: Run the full package test suite**

Run:
```
go test ./internal/sessiond/ -v
```
Expected: `PASS` for the whole package — all buffer tests, the bake-off, and (if added) the pane wiring test.

**Step 6: Verify the whole module still builds and tests green**

Run:
```
go build ./... && go test ./...
```
Expected: clean build; all packages `ok`. (If unrelated packages were already failing before Phase 5, note it — do not fix out-of-scope failures here.)

**Step 7: Commit**

```
git add docs/plans/2026-06-01-session-persistence-design.md internal/sessiond/pane.go internal/sessiond/pane_test.go && git commit -m "$(cat <<'EOF'
feat(sessiond): record buffer bake-off decision and wire the default

Choose the v1 default PaneBuffer empirically from the bake-off numbers, record
the rationale in the design doc, and wire it into pane.go (graduating pane.Title
from the Phase-1 placeholder to TrackedBuffer's OSC capture if Tracked wins).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Definition of done (Phase 5)

- [ ] `charmbracelet/x/ansi` and `charmbracelet/x/vt` added; build green (Task 1).
- [ ] Golden oracle + fixtures + no-trim + trim-resilience harness in place (Tasks 2–3).
- [ ] `TrackedBuffer` complete: parser-wired, SGR+cursor tracking, OSC title, two-tier alt-screen, safe-boundary trim, synthetic preamble; sticky trim-resilience == 1.00 (Tasks 4–9).
- [ ] `VTBuffer` complete: grid-backed Write + live-grid Replay; sticky trim-resilience == 1.00 (Task 10).
- [ ] Bake-off test scores all three on fidelity + rough memory and asserts the contracts (Task 11).
- [ ] Decision recorded in the design doc; default wired into `pane.go`; OSC-title graduated iff TrackedBuffer chosen (Task 12).
- [ ] `go build ./... && go test ./...` green.
- [ ] No changes outside `internal/sessiond/` except the design-doc decision record. No protocol/server/web/lifecycle changes. No hand-ported grid emulator.

## Reminders for the implementer

- **TDD every task:** write the failing test, watch it fail for the *right* reason, implement the minimum, watch it pass, commit. If a test passes before you implement, the test is wrong.
- **Verify, don't guess:** several steps say "VERIFY" against Phase-1 code or `go doc`. Do it — the experimental charmbracelet APIs and the exact Phase-1 interface shape are the two places this plan could drift from reality.
- **Stay in scope:** pure buffer work behind the Phase-1 `PaneBuffer` seam. Resist the urge to refactor the interface into a subpackage or to "improve" other phases' code.
- **Never reimplement a grid emulator** (design's explicit anti-option): depend on `x/vt` or stay byte-based.
