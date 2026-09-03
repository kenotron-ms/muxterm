package sessiond

import (
	"fmt"
	"strings"
	"sync"

	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/vt"
)

const (
	// vtHistoryMax is the target retention of the per-pane scrolled-off line
	// ring, matching the browser's xterm.js 10,000-line retention so
	// CLI-visible history and browser-visible history agree.
	vtHistoryMax = 10000
	// vtHistoryCompactAt is the length at which the ring is compacted back
	// down to vtHistoryMax. Compaction is amortized (one O(vtHistoryMax) copy
	// per vtHistoryMax appended lines) rather than per-append, so retention
	// oscillates between 10,000 and 20,000 lines. Both ends are bounded, which
	// is what the design's "~10,000 lines" cap requires.
	vtHistoryCompactAt = 2 * vtHistoryMax

	// vtEmuScrollbackKeep is how many lines the underlying x/vt emulator's own
	// main-screen scrollback retains whenever b.mu is not held. It is exactly
	// the value NewVTBuffer used before this change, which is what keeps
	// Replay()/serializeGrid() output unchanged.
	vtEmuScrollbackKeep = 2000
	// vtEmuScrollbackHeadroom is the emulator scrollback's configured maxLines.
	// It is far above vtEmuScrollbackKeep so the emulator never evicts a line
	// on its own between two of our observations (see
	// captureScrolledOffLocked for why that matters). A single PTY read is at
	// most 32 KiB (pane.go's chunk size), so it can push at most ~32,768 lines
	// in one Write; 40,000 leaves headroom above that plus the 2,000 resident.
	vtEmuScrollbackHeadroom = 40000

	// defaultScrollbackPageLimit is the page size used when a caller omits
	// Limit; maxScrollbackPageLimit is the hard server-side cap so a single
	// control frame cannot balloon unbounded.
	defaultScrollbackPageLimit = 500
	maxScrollbackPageLimit     = 5000
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
	// shadow-scan for DECSC/SCOSC and alt-screen-entry sequences — mirroring
	// TrackedBuffer's pattern of constructing the parser once and calling
	// Reset() before each Parse(), rather than allocating a fresh
	// ansi.NewParser() (32-int params slice + 64KB data buffer) on every
	// 32KB PTY read. scanFound/scanEnteredAltScreen are the handler's output
	// for the call in progress; all of these fields are safe to reuse
	// without locking because Write holds b.mu.Lock() for its entire body,
	// so no two scans ever overlap.
	scanParser           *ansi.Parser
	scanFound            bool
	scanEnteredAltScreen bool

	// mouseTrackingMode and mouseSGR shadow-track the PTY-side application's
	// current mouse-tracking DECSET mode, since x/vt's Emulator exposes no
	// public accessor for its private mode map (same reason savedCursor is
	// shadow-tracked above). Unlike scanFound/scanEnteredAltScreen (reset on
	// every Write call to answer "did THIS chunk contain X"), these are
	// sticky across the pane's whole lifetime, updated in place whenever a
	// matching DECSET/DECRST sequence is observed.
	//
	// Why this matters: on a full browser page refresh, xterm.js recreates
	// its Terminal instance from scratch with mouse tracking disabled by
	// default. The replay stream is the ONLY way the fresh client learns the
	// PTY-side app (e.g. a modern TUI like OpenCode) already turned mouse
	// tracking on. Without replaying the enabling DECSET sequence, xterm.js
	// falls back to its legacy wheel-to-arrow-key emulation, which most TUIs
	// interpret as scrollback/history navigation rather than mouse-wheel
	// scroll — see serializeGrid.
	//
	//   - mouseTrackingMode: 0 (off) or the last of 1000 (X10)/1002 (button-
	//     event)/1003 (any-event) DECSET'd. These are mutually exclusive by
	//     convention (an app enables at most one at a time), so a single int
	//     suffices; setting one implicitly does not clear another explicitly
	//     enabled mode, matching how most TUIs actually toggle between them.
	//   - mouseSGR: 1006 (SGR extended mouse coordinate encoding), tracked
	//     independently since it can be toggled alongside any of the above.
	mouseTrackingMode int
	mouseSGR          bool

	// mainScreenSnapshot holds the rendered main-screen (scrollback + visible
	// grid, same form serializeGrid's primary-screen branch already emits)
	// captured at the moment this pane's byte stream was observed entering
	// alt-screen mode. x/vt's public Emulator API exposes no accessor for the
	// inactive/saved screen once alt-screen is active, so this must be
	// captured proactively, in Write, before the switch is applied. Nil until
	// the first alt-screen entry is observed; serializeGrid falls back to
	// today's behavior (no pre-emission) when nil.
	mainScreenSnapshot []byte

	// history is this pane's bounded ring of finalized, plain-text lines that
	// have scrolled off the top of the live grid, oldest first. A line enters
	// here exactly once, at the moment it leaves the viewport and becomes
	// immutable — never while it is still on-screen and still being rewritten
	// (progress bars, TUI redraws). Guarded by b.mu.
	history []string
	// historySeq is the absolute sequence number that will be assigned to the
	// NEXT appended line, i.e. the count of lines ever appended to history. It
	// never resets and never reuses a value, even after the ring evicts the
	// line it named. The absolute sequence of history[i] is
	// historySeq - len(history) + i — the same relation RawBuffer's
	// total/len(buf) pair already uses for bytes.
	historySeq uint64
	// sbSeen is how many lines of the emulator's own main-screen scrollback
	// have already been mirrored into history. See captureScrolledOffLocked.
	sbSeen int
}

// scanWriteEvents reports two independent conditions found in p during a
// single ansi-parser pass, using the persistent b.scanParser set up once in
// NewVTBuffer:
//
//   - savedCursor: p contains a DECSC (ESC 7) or SCOSC (CSI s) save-cursor
//     sequence. DECRC (ESC 8) and SCORC (CSI u) are intentionally not
//     tracked here — x/vt's own internal restore is correct for the live
//     session; this exists solely to inform replay's synthetic preamble
//     (see serializeGrid), not to implement save/restore semantics itself.
//
//   - enteredAltScreen: p contains a DECSET private-mode set (CSI ?h) for
//     mode 1049, 1047, or 47 — the sequences that enter alternate-screen
//     mode. Matches the same mode set tracked.go's onCSI already treats as
//     alt-screen entry/exit.
//
// As a side effect (not returned — see mouseTrackingMode/mouseSGR's doc
// comment for why these are sticky rather than per-call), the same parser
// pass also updates b.mouseTrackingMode and b.mouseSGR directly whenever a
// DECSET/DECRST for mode 1000/1002/1003/1006 is observed.
//
// It resets and reuses b.scanParser (constructed once in NewVTBuffer) rather
// than allocating a new *ansi.Parser per call. Callers must hold b.mu for the
// duration of the call — the shared scan fields are not otherwise
// synchronized.
func (b *VTBuffer) scanWriteEvents(p []byte) (savedCursor, enteredAltScreen bool) {
	b.scanFound = false
	b.scanEnteredAltScreen = false
	b.scanParser.Reset()
	b.scanParser.Parse(p)
	return b.scanFound, b.scanEnteredAltScreen
}

// captureMainScreenSnapshot renders the current main screen — scrollback
// lines followed by the visible grid, in exactly the form serializeGrid's
// primary-screen branch already emits them — and stores it as
// mainScreenSnapshot. Callers must hold b.mu and must call this BEFORE
// b.emu.Emulator.Write has processed the alt-screen-entering sequence for the
// current chunk, so Scrollback()/Render() here still reflect main-screen
// state, not the about-to-be-entered alt screen.
func (b *VTBuffer) captureMainScreenSnapshot() {
	var out []byte
	sb := b.emu.Emulator.Scrollback()
	for _, line := range sb.Lines() {
		out = append(out, line.Render()...)
		out = append(out, "\r\n"...)
	}
	out = append(out, strings.ReplaceAll(b.emu.Emulator.Render(), "\n", "\r\n")...)
	b.mainScreenSnapshot = out
}

// NewVTBuffer returns a VTBuffer backed by a w×h SafeEmulator with a 2000-line
// scrollback. The 2000-line budget is comparable to the old RawBuffer's ~1 MiB
// byte ring.
func NewVTBuffer(w, h int) *VTBuffer {
	emu := vt.NewSafeEmulator(w, h)
	// Headroom, not retention: captureScrolledOffLocked trims this back to
	// vtEmuScrollbackKeep (== the 2000 lines this line used to set) at the end
	// of every Write, so external readers still see exactly 2000. The large
	// configured maximum only guarantees the emulator never silently evicts a
	// line before we have mirrored it.
	emu.SetScrollbackSize(vtEmuScrollbackHeadroom)
	b := &VTBuffer{emu: emu}
	b.scanParser = ansi.NewParser()
	b.scanParser.SetHandler(ansi.Handler{
		HandleEsc: func(cmd ansi.Cmd) {
			if cmd.Final() == '7' { // DECSC
				b.scanFound = true
			}
		},
		HandleCsi: func(cmd ansi.Cmd, params ansi.Params) {
			switch cmd.Final() {
			case 's':
				// SCOSC: CSI s, no private prefix, no parameters.
				if cmd.Prefix() == 0 {
					b.scanFound = true
				}
			case 'h', 'l':
				if cmd.Prefix() != '?' {
					return
				}
				set := cmd.Final() == 'h'
				mode, _, _ := params.Param(0, 0)
				switch mode {
				case 1049, 1047, 47:
					if set {
						b.scanEnteredAltScreen = true
					}
				case 1000, 1002, 1003:
					// Sticky across calls (unlike scanEnteredAltScreen):
					// mutated directly here rather than staged through a
					// return value, since Write already holds b.mu for
					// scanWriteEvents' entire call. See
					// mouseTrackingMode's doc comment.
					if set {
						b.mouseTrackingMode = mode
					} else {
						b.mouseTrackingMode = 0
					}
				case 1006:
					b.mouseSGR = set
				}
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
	savedCursor, enteredAltScreen := b.scanWriteEvents(p)
	// Critical ordering: this check and the resulting snapshot capture MUST
	// happen before b.emu.Emulator.Write below. Emulator.IsAltScreen() here
	// still reflects the PRE-switch state for this chunk, since Write for
	// this chunk hasn't run yet. If the emulator is already in alt-screen
	// (a redundant/nested enter sequence, e.g. nested TUI calls), this is
	// false and we correctly skip re-capturing.
	if enteredAltScreen && !b.emu.Emulator.IsAltScreen() {
		b.captureMainScreenSnapshot()
	}
	// Access the underlying Emulator directly: b.mu already excludes
	// concurrent reads, so the SafeEmulator's own per-method lock is not
	// needed here and calling the raw method avoids nested locking.
	n, err := b.emu.Emulator.Write(p)
	// Mirror anything this chunk scrolled off the top of the live grid into
	// the pane's own history ring. Must run while b.mu is still held.
	b.captureScrolledOffLocked()
	if savedCursor {
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
	return serializeGrid(b.emu.Emulator, saved, b.mainScreenSnapshot, b.mouseTrackingMode, b.mouseSGR)
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

// Size returns the emulator grid's current dimensions. Like CursorPos and
// ScreenText it reads the underlying Emulator directly: b.mu.RLock() already
// excludes Write (the only mutator), so SafeEmulator's own per-method lock
// would be redundant nesting.
func (b *VTBuffer) Size() (cols, rows int) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return b.emu.Emulator.Width(), b.emu.Emulator.Height()
}

// PreviewTile renders a monochrome, bottom-left crop of the visible screen for
// the sidebar preview cards: at most rows lines of at most cols characters,
// each trailing-space trimmed (the client re-pads and top-pads). See
// docs/designs/2026-09-02-sidebar-live-preview-design.md, D3/D4.
//
// Why not ScreenText: ScreenText trims trailing blank ROWS, which destroys the
// vertical alignment this crop exists to preserve. It also cannot express the
// two rules below, both of which need per-cell access.
//
// The crop is anchored to CONTENT, not to the grid:
//
//	lastInk = greatest row index carrying any non-blank cell (0 if all blank)
//	bottom  = min(H-1, max(lastInk, cursorRow))
//	top     = max(0, bottom-rows+1)
//
// Anchoring on the last inked row (rather than the emulator's literal bottom)
// is what keeps the card alive: a 50-row pane holding 8 rows of output would
// otherwise render as a tile of nothing. Including cursorRow keeps a freshly
// cleared screen — cursor parked below the last ink — from scrolling its own
// prompt out of frame. Fewer than rows lines may be returned; the client pads
// at the TOP so content sits on the floor, exactly like a fresh shell.
//
// A blank row INSIDE top..bottom is emitted as an empty string rather than
// dropped — most often the cursor row sitting just below the last output. It is
// a real screen row, and keeping it is what makes the card stable: dropping it
// would shift every line down one row, and the tile would then jitter by a row
// each time the cursor line toggles between blank and inked. Only rows below
// bottom are omitted, which is what lets the slice be shorter than rows.
//
// Every cell is passed through sanitizeCell, which guarantees exactly
// Cell.Width characters per cell so columns stay aligned (see preview.go).
func (b *VTBuffer) PreviewTile(cols, rows int) []string {
	if cols <= 0 || rows <= 0 {
		return nil
	}

	b.mu.RLock()
	defer b.mu.RUnlock()
	emu := b.emu.Emulator

	w, h := emu.Width(), emu.Height()
	if w <= 0 || h <= 0 {
		return nil
	}

	lastInk := 0
	for y := h - 1; y >= 0; y-- {
		if rowHasInk(emu, y, w) {
			lastInk = y
			break
		}
	}

	bottom := lastInk
	if cursorRow := emu.CursorPosition().Y; cursorRow > bottom {
		bottom = cursorRow
	}
	if bottom > h-1 {
		bottom = h - 1
	}
	top := bottom - rows + 1
	if top < 0 {
		top = 0
	}

	out := make([]string, 0, bottom-top+1)
	var line strings.Builder
	for y := top; y <= bottom; y++ {
		line.Reset()
		for x := 0; x < cols; {
			cell := emu.CellAt(x, y)
			if cell == nil {
				// Past the right edge of a pane narrower than cols. The
				// remainder of the row is padding, and padding is trimmed.
				break
			}
			if cell.Width <= 0 {
				// Width 0 is a wide cell's continuation slot — but a wide cell
				// advances x past its own continuations below, so landing here
				// means an untouched zero cell instead. Emit one blank so the
				// columns to its right stay where they belong.
				line.WriteString(previewBlankCell)
				x++
				continue
			}
			line.WriteString(sanitizeCell(cell.Content, cell.Width))
			x += cell.Width
		}
		out = append(out, strings.TrimRight(line.String(), " "))
	}
	return out
}

// rowHasInk reports whether row y holds any cell that is not blank, scanning
// the full emulator width (not the tile width) so a card never goes dark just
// because the only content on screen sits to the right of the crop. Callers
// must hold b.mu.
func rowHasInk(emu *vt.Emulator, y, w int) bool {
	for x := 0; x < w; x++ {
		cell := emu.CellAt(x, y)
		if cell == nil {
			break
		}
		if cell.Content != "" && cell.Content != " " {
			return true
		}
	}
	return false
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

// captureScrolledOffLocked mirrors every line the VT engine has pushed onto the
// emulator's main-screen scrollback since the last call into this buffer's own
// history ring, then trims the emulator's scrollback back to
// vtEmuScrollbackKeep lines. Callers must hold b.mu (write lock).
//
// Why this IS the scroll-off hook: charmbracelet/x/vt pushes a line onto the
// main screen's Scrollback exactly when that line scrolls off the top of the
// live grid — LF at the bottom margin goes Emulator.index -> Screen.ScrollUp ->
// Screen.DeleteLine -> Scrollback.PushN, and ED 2 goes through
// Screen.ClearWithScrollback. It never pushes a line that is still on-screen.
// That is precisely the design's "append only on scroll-off" rule, obtained by
// observing the engine rather than by re-deriving it. Alt-screen output does
// NOT land here: Emulator.Scrollback() is the MAIN screen's scrollback, so a
// full-screen TUI's redraws never pollute history.
//
// Why the explicit trim: Scrollback evicts its own oldest line once it is full
// and exposes no eviction count, so a self-evicting scrollback makes "how many
// lines were pushed since I last looked?" unanswerable. NewVTBuffer therefore
// configures a large maxLines (vtEmuScrollbackHeadroom) so the emulator does
// not self-evict, and this function performs the eviction itself, by an exact
// amount: SetMaxLines(keep) trims to the newest keep lines (and never grows),
// then SetMaxLines(headroom) restores the headroom without touching content.
// Net effect for every other reader (Replay/serializeGrid/
// captureMainScreenSnapshot): whenever b.mu is released, the emulator
// scrollback holds at most vtEmuScrollbackKeep == the pre-existing 2000 lines,
// so replay output is unchanged.
//
// Known, accepted edge cases:
//   - ED 3 (ESC[3J) clears the emulator's scrollback. sbSeen resynchronises
//     downward, and lines already mirrored stay in history: the daemon's own
//     record of what scrolled past is not erased by an application repainting.
//   - A single 32 KiB chunk that pushes more lines than the headroom would let
//     the emulator drop lines we never saw. Those lines are, by definition,
//     older than the newest 10,000 the ring keeps anyway; historySeq stays
//     monotonic and pagination stays internally consistent.
func (b *VTBuffer) captureScrolledOffLocked() {
	sb := b.emu.Emulator.Scrollback()
	if sb == nil {
		return
	}
	n := sb.Len()
	if n > b.sbSeen {
		// uv.Line.String() is the plain-text (ANSI-stripped) form and already
		// drops trailing spaces; Scrollback.Push already trimmed trailing
		// empty cells before storing.
		for _, line := range sb.Lines()[b.sbSeen:n] {
			b.history = append(b.history, line.String())
			b.historySeq++
		}
	}
	b.sbSeen = n

	if n > vtEmuScrollbackKeep {
		sb.SetMaxLines(vtEmuScrollbackKeep)
		sb.SetMaxLines(vtEmuScrollbackHeadroom)
		b.sbSeen = sb.Len()
	}

	if len(b.history) > vtHistoryCompactAt {
		// copy-down in place; copy handles the overlapping ranges correctly.
		b.history = append(b.history[:0], b.history[len(b.history)-vtHistoryMax:]...)
	}
}

// ScrollbackPage returns one page of this pane's scrolled-off history, paging
// BACKWARD from cursor.
//
// cursor is an EXCLUSIVE upper bound expressed as an absolute line-sequence
// number: the returned page is the (up to) limit lines immediately BEFORE
// cursor. A nil cursor means "start just before the current live viewport",
// i.e. the most recent page of history. start is the absolute sequence of the
// first returned line. next is the cursor to pass on the following call to page
// further back, and is nil when the page already begins at the oldest retained
// line — the normal termination condition for a paging loop. Consecutive pages
// never overlap: a page covering [start, end) is followed by one ending exactly
// at start.
//
// Clamping mirrors RawBuffer.ReplayFrom, generalized from bytes to lines: a
// request whose range reaches below the oldest retained line is clamped to the
// oldest retained line rather than erroring, and the returned start reveals the
// clamp. A cursor at or beyond the end of available history (at or below the
// oldest retained sequence, or any cursor against an empty history) returns an
// empty page with a nil next — not an error.
//
// limit is normalised here as well as in the server handler, so a direct caller
// can never request an unbounded page.
func (b *VTBuffer) ScrollbackPage(cursor *uint64, limit int) (lines []string, start uint64, next *uint64) {
	if limit <= 0 {
		limit = defaultScrollbackPageLimit
	}
	if limit > maxScrollbackPageLimit {
		limit = maxScrollbackPageLimit
	}

	b.mu.RLock()
	defer b.mu.RUnlock()

	oldest := b.historySeq - uint64(len(b.history)) // absolute seq of history[0]
	end := b.historySeq
	if cursor != nil {
		end = *cursor
	}
	if end > b.historySeq {
		end = b.historySeq
	}
	if end <= oldest {
		return nil, oldest, nil
	}

	start = oldest
	if uint64(limit) < end-oldest { // end > oldest here, so end-oldest > 0
		start = end - uint64(limit)
	}

	idx0 := int(start - oldest)
	idx1 := int(end - oldest)
	// Copy rather than aliasing b.history: the returned slice outlives the
	// read lock, and captureScrolledOffLocked's compaction copies lines DOWN
	// over exactly this index range, so an aliased page would be mutated (and
	// raced on) by a later Write.
	lines = append([]string(nil), b.history[idx0:idx1]...)

	if start > oldest {
		s := start
		next = &s
	}
	return lines, start, next
}

// serializeGrid emits a self-contained byte stream that reconstructs the
// emulator's scrollback history and visible screen.
//
// Alt-screen path: if mainScreenSnapshot is non-nil (this pane's main screen
// was captured just before it entered alt-screen mode, since x/vt's public
// Emulator API exposes no accessor for the inactive main screen once
// alt-screen is active — see VTBuffer.mainScreenSnapshot), it is pre-emitted
// on the primary screen first: clear + home + the saved scrollback/grid
// render. This means a reconnecting client's own primary-screen scrollback
// is preserved underneath the alt-screen switch that follows, so exiting the
// alt-screen app (e.g. closing a pager) reveals the shell session rather than
// a blank screen. If mainScreenSnapshot is nil (no alt-screen entry was ever
// observed on this pane's byte stream — e.g. the pane started already in
// alt-screen, or shadow-tracking missed it), this step is skipped and
// behavior falls back to what it was before this pre-emission existed. After
// that, the stream switches into the alt screen, clears, renders, restores
// cursor.  Scrollback is not applicable in alt-screen mode itself.
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
//
// mouseMode/mouseSGR: if mouseMode is non-zero (1000/1002/1003) and/or
// mouseSGR is true, the corresponding DECSET sequence(s) are emitted first,
// before either branch below, so a fresh client (e.g. xterm.js recreated by
// a full browser page refresh, which always starts with mouse tracking
// disabled) re-learns that the PTY-side application already turned mouse
// tracking on. Without this, wheel-scroll input over the pane falls back to
// xterm.js's legacy arrow-key emulation, which most TUIs interpret as
// scrollback/history navigation instead of an actual mouse-wheel scroll.
// Order relative to the alt-screen/primary-screen branches below does not
// matter — DECSET mode changes produce no visible output of their own.
func serializeGrid(emu *vt.Emulator, savedCursor *struct{ row, col int }, mainScreenSnapshot []byte, mouseMode int, mouseSGR bool) []byte {
	var out []byte

	switch mouseMode {
	case 1000, 1002, 1003:
		out = append(out, fmt.Sprintf(esc+"[?%dh", mouseMode)...)
	}
	if mouseSGR {
		out = append(out, esc+"[?1006h"...)
	}

	if emu.IsAltScreen() {
		// If we captured this pane's main screen just before it entered
		// alt-screen mode, pre-emit it on the primary screen first so a
		// reconnecting client's terminal has the shell's scrollback/grid
		// underneath the alt-screen switch that follows (see
		// VTBuffer.mainScreenSnapshot).
		if len(mainScreenSnapshot) > 0 {
			out = append(out, esc+"[2J"...)
			out = append(out, esc+"[H"...)
			out = append(out, mainScreenSnapshot...)
		}
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
