package sessiond

import (
	"fmt"
	"strings"
	"sync"

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
}

// NewVTBuffer returns a VTBuffer backed by a w×h SafeEmulator with a 2000-line
// scrollback. The 2000-line budget is comparable to the old RawBuffer's ~1 MiB
// byte ring.
func NewVTBuffer(w, h int) *VTBuffer {
	emu := vt.NewSafeEmulator(w, h)
	emu.SetScrollbackSize(2000)
	return &VTBuffer{emu: emu}
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
	return b.emu.Emulator.Write(p)
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
	// Pass the underlying *vt.Emulator: we hold b.mu.RLock(), so all state is
	// stable for the duration of the call.
	return serializeGrid(b.emu.Emulator)
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
//  4. Cursor restored to its live position via an absolute CUP sequence.
//
// NOTE: uv.Line.Render() emits fully ANSI-styled output.  If a scrollback line
// carries no SGR attributes (typical for plain-text shells) the output is the
// same as the plain-text form.  Styled scrollback (coloured prompts, vim
// status lines that scrolled away) is preserved with full colour fidelity.
func serializeGrid(emu *vt.Emulator) []byte {
	var out []byte

	if emu.IsAltScreen() {
		// Reconnecting into alt-screen mode: switch the fresh terminal into
		// alt screen first, then paint the current grid.
		out = append(out, esc+"[?1049h"...)
		out = append(out, esc+"[2J"...)
		out = append(out, esc+"[H"...)
		out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)
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

	// Restore the cursor to its live position. uv.Position (image.Point) X/Y
	// are 0-based; terminal CUP rows/cols are 1-based.
	pos := emu.CursorPosition()
	out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
	return out
}
