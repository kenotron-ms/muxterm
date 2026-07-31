package sessiond

import (
	"fmt"
	"strings"
	"sync"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

// VTBuffer feeds bytes to a concurrency-safe headless cell-grid emulator
// (charmbracelet/x/vt SafeEmulator) and serializes the live grid plus
// scrollback history on Replay.
//
// Compared with RawBuffer, this fixes garbled terminal text on reconnect:
// raw ANSI cursor-positioning sequences replay incorrectly when the terminal
// dimensions differ from when they were recorded, but a grid snapshot is
// always correct regardless of dimensions.
//
// Documented trade-offs:
//   - Two-emulator drift: x/vt here vs xterm.js in the browser. Golden tests
//     CANNOT catch this drift because they measure Replay against the same x/vt
//     implementation.
//   - Heavier memory: a full cell grid (plus emulator scrollback) per pane,
//     versus a flat byte ring.
type VTBuffer struct {
	// mu serialises all accesses to emu.  Using our own RWMutex (rather than
	// relying solely on SafeEmulator's internal lock) ensures that Replay's
	// multi-step read — IsAltScreen, Scrollback, Render, CursorPosition — is
	// atomic: no Write can slip in between those calls and leave us with a
	// partially-updated snapshot.
	mu    sync.RWMutex
	emu   *vt.SafeEmulator
	total uint64 // total bytes ever written

	// savedCursor shadow-tracks charmbracelet/x/vt's private DECSC/SCOSC
	// saved-cursor register, since x/vt exposes no public accessor for it.
	// It exists solely to inform replay (serializeGrid) — the live emulator
	// handles its own internal DECRC/SCORC restore correctly regardless of
	// this tracker.
	savedCursor      struct{ row, col int }
	savedCursorValid bool

	// scanParser is a single ansi.Parser reused across every Write call to
	// shadow-scan for DECSC/SCOSC (and, later, alt-screen-entry) sequences —
	// mirroring TrackedBuffer's pattern of constructing the parser once and
	// calling Reset() before each Parse(), rather than allocating a fresh
	// ansi.NewParser() (32-int params slice + 64KB data buffer) on every
	// 32KB PTY read. scanFound is the handler's output for the call in
	// progress; both fields are safe to reuse without locking because Write
	// holds b.mu.Lock() for its entire body, so no two scans ever overlap.
	scanParser *ansi.Parser
	scanFound  bool
}

// scanSavedCursor reports whether p contains a DECSC (ESC 7) or SCOSC (CSI s)
// save-cursor sequence. DECRC (ESC 8) and SCORC (CSI u) are intentionally not
// tracked here — x/vt's own internal restore is correct for the live session;
// this shadow tracker exists solely to inform replay's synthetic preamble
// (see serializeGrid), not to implement save/restore semantics itself.
//
// It resets and reuses b.scanParser (constructed once in NewVTBuffer) rather
// than allocating a new *ansi.Parser per call. Callers must hold b.mu for the
// duration of the call — the shared scanFound flag is not otherwise
// synchronized.
func (b *VTBuffer) scanSavedCursor(p []byte) bool {
	b.scanFound = false
	b.scanParser.Reset()
	b.scanParser.Parse(p)
	return b.scanFound
}

// NewVTBuffer returns a VTBuffer backed by a w×h SafeEmulator with a 2000-line
// scrollback. The 2000-line budget is comparable to the old RawBuffer's ~1 MiB
// byte ring.
func NewVTBuffer(w, h int) *VTBuffer {
	emu := vt.NewSafeEmulator(w, h)
	emu.SetScrollbackSize(2000)
	b := &VTBuffer{emu: emu}
	b.scanParser = ansi.NewParser()
	b.scanParser.SetHandler(ansi.Handler{
		HandleEsc: func(cmd ansi.Cmd) {
			if cmd.Final() == '7' { // DECSC
				b.scanFound = true
			}
		},
		HandleCsi: func(cmd ansi.Cmd, params ansi.Params) {
			// SCOSC: CSI s, no private prefix, no parameters.
			if cmd.Final() == 's' && cmd.Prefix() == 0 {
				b.scanFound = true
			}
		},
	})
	return b
}

// Read drains the emulator's internal reply pipe. When the emulator parses
// terminal query sequences from the application — DA1 (\x1b[c), DA2 (\x1b[>c),
// DSR / cursor-position (\x1b[6n), OSC 10/11/12 color queries, in-band resize
// negotiation, etc. — it writes its responses into a synchronous io.Pipe
// (e.pw). If nothing consumes the read side (e.pr), the very first such query
// causes Emulator.Write to block forever, hanging the readLoop goroutine.
//
// Callers must drain this continuously in a dedicated goroutine and forward the
// bytes back to the PTY so the application actually receives the responses.
//
// Safe to call concurrently with Write: SafeEmulator.Read is deliberately not
// mutex-guarded because the io.Pipe itself provides the synchronisation.
func (b *VTBuffer) Read(p []byte) (int, error) {
	return b.emu.Read(p)
}

// Write forwards p directly to the underlying emulator under the write lock,
// which interprets the byte stream and updates the live grid.
func (b *VTBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.total += uint64(len(p))
	// Access the underlying Emulator directly: b.mu already excludes
	// concurrent reads, so the SafeEmulator's own per-method lock is not
	// needed here and calling the raw method avoids nested locking.
	n, err := b.emu.Emulator.Write(p)
	if b.scanSavedCursor(p) {
		// Read position directly from the underlying Emulator (not via the
		// locking CursorPos() method) — we already hold b.mu, and Write has
		// just applied p, so this reflects state as of the end of this
		// chunk. A save sequence followed by further cursor movement within
		// the SAME chunk is a rare edge case this shadow tracker does not
		// attempt to resolve exactly; per the design, an imperfect or
		// uncaught case is a no-regression, opportunistic-only gap.
		pos := b.emu.Emulator.CursorPosition()
		b.savedCursor.row, b.savedCursor.col = pos.Y, pos.X
		b.savedCursorValid = true
	}
	return n, err
}

// Resize updates the emulator grid to the new dimensions.  Non-positive values
// are ignored to guard against invalid PTY states during pane teardown.
func (b *VTBuffer) Resize(cols, rows int) {
	if cols <= 0 || rows <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.emu.Emulator.Resize(cols, rows)
}

// Replay serializes the current emulator grid into a byte stream that, when fed
// to a fresh emulator, reproduces the visible screen and scrollback history.
func (b *VTBuffer) Replay() []byte {
	b.mu.RLock()
	defer b.mu.RUnlock()
	var saved *struct{ row, col int }
	if b.savedCursorValid {
		saved = &b.savedCursor
	}
	// Pass the underlying *vt.Emulator: we hold b.mu.RLock(), so all state is
	// stable for the duration of the call.
	return serializeGrid(b.emu.Emulator, saved)
}

// ReplayFrom ignores since and returns (b.Replay(), 0): VTBuffer serializes the
// live cell grid (not a seekable raw byte log), so every caller always receives
// the full current screen-state replay anchored at absolute sequence 0.
func (b *VTBuffer) ReplayFrom(_ uint64) (data []byte, start uint64) {
	return b.Replay(), 0
}

// ScreenText returns a plain-text snapshot of the visible screen with trailing
// whitespace-only rows trimmed. String() (not Render()) is used because String()
// emits the cell content without ANSI SGR attributes, exactly as noted in
// serializeGrid's comment ("String() which is plain text").
func (b *VTBuffer) ScreenText() string {
	b.mu.RLock()
	defer b.mu.RUnlock()
	plain := b.emu.Emulator.String()
	lines := strings.Split(plain, "\n")
	// Trim trailing whitespace-only lines (the emulator pads the grid to its
	// full height; unused rows appear as blank strings or spaces).
	for len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) == "" {
		lines = lines[:len(lines)-1]
	}
	return strings.Join(lines, "\n")
}

// CursorPos returns the cursor's 0-based (row, col) on the visible screen.
// uv.Position is image.Point with X = column and Y = row.
func (b *VTBuffer) CursorPos() (row, col int) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	pos := b.emu.Emulator.CursorPosition()
	return pos.Y, pos.X
}

// Seq returns the total bytes ever written to this buffer.
func (b *VTBuffer) Seq() uint64 {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.total
}

// serializeGrid emits a self-contained byte stream that reconstructs the
// emulator's scrollback history and visible screen.
//
// Alt-screen path: switches into the alt screen, clears, renders, restores
// cursor.  Scrollback is not applicable in alt-screen mode.
//
// Primary-screen path:
//  1. Clear + home.
//  2. Scrollback lines (oldest→newest), each rendered with ANSI styling via
//     uv.Line.Render() and terminated with CRLF.  A reconnecting client feeds
//     these to its own terminal emulator; they scroll into the emulator's
//     scrollback as new visible content arrives.
//  3. Visible grid: emu.Render() with bare LF promoted to CRLF so the fresh
//     emulator doesn't stair-step each row.
//  4. If savedCursor is non-nil, re-establish the client's fresh saved-cursor
//     register (DECSC) at that position so a subsequent DECRC restores
//     correctly — this is the shadow-tracker's whole purpose (x/vt's own
//     saved-cursor register is private and cannot otherwise be replayed).
//  5. Cursor restored to its live position via an absolute CUP sequence.
//
// NOTE: uv.Line.Render() emits fully ANSI-styled output.  If a scrollback line
// carries no SGR attributes (typical for plain-text shells) the output is the
// same as the plain-text form.  Styled scrollback (coloured prompts, vim
// status lines that scrolled away) is preserved with full colour fidelity.
func serializeGrid(emu *vt.Emulator, savedCursor *struct{ row, col int }) []byte {
	var out []byte

	if emu.IsAltScreen() {
		// Reconnecting into alt-screen mode: switch the fresh terminal into
		// alt screen first, then paint the current grid.
		out = append(out, esc+"[?1049h"...)
		out = append(out, esc+"[2J"...)
		out = append(out, esc+"[H"...)
		out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)
		if savedCursor != nil {
			out = append(out, fmt.Sprintf(esc+"[%d;%dH", savedCursor.row+1, savedCursor.col+1)...)
			out = append(out, esc+"7"...)
		}
		pos := emu.CursorPosition()
		out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
		return out
	}

	// Primary screen: clear, emit scrollback, then the visible grid.
	out = append(out, esc+"[2J"...)
	out = append(out, esc+"[H"...)

	// Emit scrollback lines so reconnecting clients see prior output.
	// uv.Line.Render() produces the ANSI-styled form of each scrollback line.
	// Lines have had trailing blank cells trimmed by the emulator already
	// (Scrollback.Push trims trailing empty cells before storing).
	sb := emu.Scrollback()
	for _, line := range sb.Lines() {
		out = append(out, line.Render()...)
		out = append(out, "\r\n"...)
	}

	// Visible grid: Render() emits the styled screen (ANSI SGR + content),
	// unlike String() which is plain text. Rows are separated by bare LF;
	// promote each to CR+LF so a fresh emulator doesn't stair-step.
	out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)

	if savedCursor != nil {
		out = append(out, fmt.Sprintf(esc+"[%d;%dH", savedCursor.row+1, savedCursor.col+1)...)
		out = append(out, esc+"7"...)
	}

	// Restore the cursor to its live position. uv.Position (image.Point) X/Y
	// are 0-based; terminal CUP rows/cols are 1-based.
	pos := emu.CursorPosition()
	out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
	return out
}
