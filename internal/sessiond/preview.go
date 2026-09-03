package sessiond

import (
	"encoding/binary"
	"hash/fnv"
	"strings"
	"unicode/utf8"
)

// Sidebar preview tiles are rendered in a 5x8 bitmap font (Spleen 5x8) that
// covers ASCII, Latin-1, the eleven LIGHT box-drawing glyphs, and the block
// elements U+2580..U+2593 — and nothing else. Every other code point would
// render as tofu, so the daemon folds or replaces it here, server-side, which
// keeps the client dumb and the wire small. See
// docs/designs/2026-09-02-sidebar-live-preview-design.md ("Sanitization").
//
// Two substitutions carry meaning rather than being pure damage control:
//
//   - A width-2 cell (CJK, emoji) becomes "▒▒". It is unrenderable at 5x8, but
//     "dense content here" is more honest than a hole.
//   - An unrenderable width-1 cell becomes "·" (U+00B7), not a space:
//     preserving the fact that a character was there is what keeps a TUI
//     recognisable. A space would silently turn foreign text into blank canvas.
const (
	previewWideFill    = "▒" // one column of a width-2 (CJK/emoji) cell
	previewUnknownCell = "·" // width-1 cell outside the renderable set
	previewBlankCell   = " "
)

// previewFold maps every code point the daemon knows how to approximate onto a
// glyph the preview font actually has. It covers the box-drawing block
// U+2501..U+257F exhaustively (heavy, double, dashed, arc and stub variants all
// collapse onto their LIGHT equivalent — a table in code beats 100 glyphs in a
// font), plus the arrows, check/cross marks, geometric shapes, dashes and curly
// quotes that real terminal output leans on.
//
// INVARIANT: every VALUE here must itself satisfy previewRenderable, otherwise
// a fold would substitute one piece of tofu for another. Verified exhaustively
// when this table was written: zero fold targets fall outside previewRenderable,
// and every code point in U+2500..U+257F is either kept (the eleven light
// glyphs) or folded (the other 117). Re-check both when adding an entry.
var previewFold = map[rune]rune{
	// ---- Symbols the browser-side table also folds (parity is load-bearing:
	//      the attached workspace sanitizes in TypeScript, every other one
	//      here, and a divergence shows as a character changing when you
	//      switch workspaces) ----
	'∙': '•', '⋅': '•',
	'◻': '▒', '◼': '▒',
	'⨯': 'x',
	// ---- Box drawing: horizontals and verticals (heavy/dashed -> light) ----
	'━': '─', '┃': '│',
	'┄': '─', '┅': '─', '┆': '│', '┇': '│',
	'┈': '─', '┉': '─', '┊': '│', '┋': '│',
	'╌': '─', '╍': '─', '╎': '│', '╏': '│',
	'═': '─', '║': '│',

	// ---- Box drawing: down-and-right corners -> ┌ ----
	'┍': '┌', '┎': '┌', '┏': '┌',
	'╒': '┌', '╓': '┌', '╔': '┌',
	'╭': '┌', // light arc

	// ---- Box drawing: down-and-left corners -> ┐ ----
	'┑': '┐', '┒': '┐', '┓': '┐',
	'╕': '┐', '╖': '┐', '╗': '┐',
	'╮': '┐', // light arc

	// ---- Box drawing: up-and-right corners -> └ ----
	'┕': '└', '┖': '└', '┗': '└',
	'╘': '└', '╙': '└', '╚': '└',
	'╰': '└', // light arc

	// ---- Box drawing: up-and-left corners -> ┘ ----
	'┙': '┘', '┚': '┘', '┛': '┘',
	'╛': '┘', '╜': '┘', '╝': '┘',
	'╯': '┘', // light arc

	// ---- Box drawing: vertical-and-right tees -> ├ ----
	'┝': '├', '┞': '├', '┟': '├', '┠': '├',
	'┡': '├', '┢': '├', '┣': '├',
	'╞': '├', '╟': '├', '╠': '├',

	// ---- Box drawing: vertical-and-left tees -> ┤ ----
	'┥': '┤', '┦': '┤', '┧': '┤', '┨': '┤',
	'┩': '┤', '┪': '┤', '┫': '┤',
	'╡': '┤', '╢': '┤', '╣': '┤',

	// ---- Box drawing: down-and-horizontal tees -> ┬ ----
	'┭': '┬', '┮': '┬', '┯': '┬', '┰': '┬',
	'┱': '┬', '┲': '┬', '┳': '┬',
	'╤': '┬', '╥': '┬', '╦': '┬',

	// ---- Box drawing: up-and-horizontal tees -> ┴ ----
	'┵': '┴', '┶': '┴', '┷': '┴', '┸': '┴',
	'┹': '┴', '┺': '┴', '┻': '┴',
	'╧': '┴', '╨': '┴', '╩': '┴',

	// ---- Box drawing: crosses -> ┼ ----
	'┽': '┼', '┾': '┼', '┿': '┼', '╀': '┼',
	'╁': '┼', '╂': '┼', '╃': '┼', '╄': '┼',
	'╅': '┼', '╆': '┼', '╇': '┼', '╈': '┼',
	'╉': '┼', '╊': '┼', '╋': '┼',
	'╪': '┼', '╫': '┼', '╬': '┼',

	// ---- Box drawing: diagonals and half-length stubs ----
	'╱': '/', '╲': '\\', '╳': 'X',
	'╴': '─', '╵': '│', '╶': '─', '╷': '│',
	'╸': '─', '╹': '│', '╺': '─', '╻': '│',
	'╼': '─', '╽': '│', '╾': '─', '╿': '│',

	// ---- Arrows ----
	'→': '>', '⇒': '>', '▶': '>', '►': '>',
	'←': '<', '⇐': '<', '◀': '<', '◄': '<',
	'↑': '^', '⇑': '^', '▲': '^',
	'↓': 'v', '⇓': 'v', '▼': 'v',

	// ---- Status marks ----
	'✓': '+', '✔': '+', '√': '+',
	'✗': 'x', '✘': 'x', '×': 'x', // × is U+00D7: folded even though Latin-1 is
	// otherwise kept, because a multiplication sign in terminal output is
	// almost always a failure mark. Folds are applied before the keep set.

	// ---- Geometric shapes: "something solid here" ----
	'■': '▒', '□': '▒', '▪': '▒', '▫': '▒',
	'●': '▒', '○': '▒', '◆': '▒', '◇': '▒',

	// ---- Punctuation ----
	'–': '-', '—': '-', '―': '-',
	'‘': '\'', '’': '\'', '‚': '\'', '‛': '\'',
	'“': '"', '”': '"', '„': '"', '‟': '"',
}

// previewRenderable reports whether r has a glyph in the preview font:
// printable ASCII, printable Latin-1, the eleven LIGHT box-drawing glyphs, the
// block elements U+2580..U+2593, and the two punctuation marks the pipeline
// hand-authored (• and …).
func previewRenderable(r rune) bool {
	switch {
	case r >= 0x20 && r <= 0x7E: // printable ASCII
		return true
	case r >= 0xA0 && r <= 0xFF: // printable Latin-1 supplement
		return true
	case r >= 0x2580 && r <= 0x2593: // block elements (eighths, shades, full)
		return true
	case r == '•' || r == '…':
		return true
	}
	// The eleven light box-drawing glyphs Spleen 5x8 actually ships. Every
	// other member of U+2500..U+257F reaches here only after previewFold has
	// had its chance, and is therefore genuinely unrenderable.
	switch r {
	case '─', '│', '┌', '┐', '└', '┘', '├', '┤', '┬', '┴', '┼':
		return true
	}
	return false
}

// sanitizeCell renders one emulator cell as exactly width preview characters.
//
// Returning exactly width characters is the contract that keeps columns
// aligned: the caller walks the grid by cell, not by rune, and a cell that
// returned the wrong length would shear every column to its right. A width-2
// cell therefore always yields two characters, never one wide glyph.
//
// content is the cell's grapheme cluster; only its base rune decides the
// outcome (combining marks have no 5x8 glyph of their own). Folds are applied
// before the keep test, so an explicitly-folded code point wins even when it
// would otherwise have been kept.
func sanitizeCell(content string, width int) string {
	if width <= 0 {
		return ""
	}
	// Blank BEFORE width: a vacated wide cell (a CJK glyph cleared or
	// overwritten) carries width 2 with no content, and filling it with shade
	// would paint phantom blocks where nothing is. TypeScript's sanitizeChar
	// checks blank first for the same reason, and the two must agree -- the
	// attached workspace sanitizes there, every other one here, so a
	// divergence shows up as a cell changing when you switch workspaces.
	if content == "" || strings.TrimSpace(content) == "" {
		return strings.Repeat(previewBlankCell, max(width, 1))
	}
	if width >= 2 {
		// CJK, emoji, and anything else the emulator measured as wide. No 5x8
		// glyph can represent these, so fill every column they occupy with the
		// medium-shade block: "dense content here" rather than a hole.
		return strings.Repeat(previewWideFill, width)
	}
	r, _ := utf8.DecodeRuneInString(content)
	if r == utf8.RuneError {
		return previewUnknownCell
	}
	if to, ok := previewFold[r]; ok {
		return string(to)
	}
	if previewRenderable(r) {
		return string(r)
	}
	return previewUnknownCell
}

// previewTileHash is the change gate for a rendered tile: FNV-1a over the pane
// id plus every emitted line. The pane id is mixed in so a workspace whose
// preview pane switches (the most-recently-written pane changed) always emits,
// even in the degenerate case where two panes happen to show identical text.
func previewTileHash(paneID int, lines []string) uint64 {
	h := fnv.New64a()
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], uint64(paneID))
	_, _ = h.Write(id[:])
	for _, line := range lines {
		_, _ = h.Write([]byte(line))
		// Separator, so ["ab",""] and ["a","b"] cannot collide.
		_, _ = h.Write([]byte{'\n'})
	}
	return h.Sum64()
}
