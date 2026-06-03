package sessiond

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/x/vt"
)

// VTBuffer feeds bytes to a headless cell-grid emulator (charmbracelet/x/vt)
// and serializes the live grid on Replay. Unlike RawBuffer/TrackedBuffer, there
// is no scrollback ring and no synthetic preamble: trimming happens inside the
// emulator on whole lines, so sticky state (SGR pen, cursor, alt-screen) is
// always reconstructed from the live grid.
//
// Documented trade-offs:
//   - Two-emulator drift: x/vt here vs xterm.js in the browser. The x/vt oracle
//     in the golden tests CANNOT catch this drift because it measures Replay
//     against the same x/vt implementation.
//   - Heavier memory: a full cell grid (plus emulator scrollback) per pane,
//     versus a flat byte ring.
type VTBuffer struct {
	emu *vt.Emulator
}

// NewVTBuffer returns a VTBuffer backed by a w x h emulator grid.
func NewVTBuffer(w, h int) *VTBuffer {
	return &VTBuffer{emu: vt.NewEmulator(w, h)}
}

// Write forwards p directly to the emulator, which interprets the byte stream
// and updates the live grid.
func (b *VTBuffer) Write(p []byte) (int, error) {
	return b.emu.Write(p)
}

// Replay serializes the current emulator grid into a byte stream that, when fed
// to a fresh emulator, reproduces the visible screen.
func (b *VTBuffer) Replay() []byte {
	return serializeGrid(b.emu)
}

// serializeGrid emits a self-contained byte stream that reconstructs the
// emulator's visible screen: clear + home, the styled grid render, then a
// restored cursor position. If the emulator is on the alternate screen, the
// stream first switches into it.
func serializeGrid(emu *vt.Emulator) []byte {
	var out []byte
	if emu.IsAltScreen() {
		out = append(out, esc+"[?1049h"...)
	}
	// Clear screen and home the cursor before painting the grid.
	out = append(out, esc+"[2J"...)
	out = append(out, esc+"[H"...)
	// Render() emits the styled screen (ANSI SGR + content), unlike String()
	// which is plain text. It separates rows with a bare LF; feeding that to a
	// fresh emulator would stair-step each row (LF moves down but not to column
	// 0), so promote each LF to CR+LF.
	out = append(out, strings.ReplaceAll(emu.Render(), "\n", "\r\n")...)
	// Restore the cursor to its live position. uv.Position (image.Point) X/Y
	// are 0-based; terminal CUP rows/cols are 1-based.
	pos := emu.CursorPosition()
	out = append(out, fmt.Sprintf(esc+"[%d;%dH", pos.Y+1, pos.X+1)...)
	return out
}
