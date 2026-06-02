package sessiond

import (
	"github.com/charmbracelet/x/ansi"
	"github.com/charmbracelet/x/ansi/parser"
)

// defaultTrackedBudget is the default per-pane scrollback budget (~1 MiB) for a
// TrackedBuffer.
const defaultTrackedBudget = 1 << 20

// groundState is the parser's neutral state: no escape sequence is in progress,
// so a byte offset where the parser sits in groundState is a safe cut boundary
// that never severs a sequence.
const groundState = parser.GroundState

// modeTracker accumulates "sticky" terminal state (SGR runs, modes, cursor,
// title) observed by the parser so it can later be synthesized into a replay
// preamble. SGR and cursor tracking land in Task 5; title (Task 6) and alt
// screen (Task 7) fields are reserved here.
type modeTracker struct {
	// sgrParams holds the cumulative SGR params applied since the last reset,
	// e.g. ["1", "31"] for bold + red.
	sgrParams []string
	// cursorRow is the 1-based absolute cursor row (0 = unknown/home).
	cursorRow int
	// cursorCol is the 1-based absolute cursor column (0 = unknown/home).
	cursorCol int
	// altScreen reports whether the alternate screen buffer is active (Task 7).
	altScreen bool
	// title is the last OSC window/icon title observed (Task 6).
	title string
}

// snapshot returns a copy of the tracker with sgrParams deep-copied so callers
// cannot mutate internal state.
func (t modeTracker) snapshot() modeTracker {
	cp := t
	if t.sgrParams != nil {
		cp.sgrParams = make([]string, len(t.sgrParams))
		copy(cp.sgrParams, t.sgrParams)
	}
	return cp
}

// sgrPreamble renders an SGR reset (ESC[0m) followed by ESC[<p>m for each
// accumulated param, reconstructing the sticky pen.
func (t modeTracker) sgrPreamble() []byte {
	out := []byte("\x1b[0m")
	for _, p := range t.sgrParams {
		out = append(out, "\x1b["...)
		out = append(out, p...)
		out = append(out, 'm')
	}
	return out
}

// TrackedBuffer is a PaneBuffer that feeds writes through an ANSI parser while
// retaining the raw byte stream in an append-only scrollback ring. At Task 4 the
// parser handler is empty and Replay returns a raw copy of the ring; trimming is
// naive (replaced in Task 8) and no synthetic preamble is emitted yet (Task 9).
type TrackedBuffer struct {
	budget int
	ring   []byte
	// altFrame holds the single replaceable alternate-screen frame. It is NOT
	// counted against budget and is discarded when the alt screen is exited.
	altFrame []byte
	parser   *ansi.Parser
	tracker  modeTracker
}

// NewTrackedBuffer returns a TrackedBuffer with the default budget.
func NewTrackedBuffer() *TrackedBuffer {
	return NewTrackedBufferWithBudget(defaultTrackedBudget)
}

// NewTrackedBufferWithBudget returns a TrackedBuffer with the given byte budget,
// wiring an ANSI parser to the buffer's handler.
func NewTrackedBufferWithBudget(maxBytes int) *TrackedBuffer {
	b := &TrackedBuffer{budget: maxBytes}
	b.parser = ansi.NewParser()
	b.parser.SetHandler(b.handler())
	return b
}

// handler returns the ansi.Handler the parser dispatches to. CSI and OSC
// callbacks feed the modeTracker (SGR/cursor in Task 5, title in Task 6, alt
// screen in Task 7).
func (b *TrackedBuffer) handler() ansi.Handler {
	return ansi.Handler{
		HandleCsi: b.onCSI,
		HandleOsc: b.onOSC,
	}
}

// onCSI updates the modeTracker from CSI sequences: SGR ('m') accumulates the
// sticky pen, CUP/HVP ('H'/'f') records the absolute cursor position. Private
// ('?') modes are handled in Task 7.
func (b *TrackedBuffer) onCSI(cmd ansi.Cmd, params ansi.Params) {
	switch cmd.Final() {
	case 'm':
		// Ignore SGR variants with a prefix (e.g. '?').
		if cmd.Prefix() != 0 {
			return
		}
		if len(params) == 0 {
			b.tracker.sgrParams = nil
			return
		}
		params.ForEach(0, func(_, param int, _ bool) {
			if param == 0 {
				b.tracker.sgrParams = nil
				return
			}
			b.tracker.sgrParams = append(b.tracker.sgrParams, itoa(param))
		})
	case 'H', 'f':
		row, _, _ := params.Param(0, 1)
		col, _, _ := params.Param(1, 1)
		b.tracker.cursorRow = row
		b.tracker.cursorCol = col
	case 'h', 'l':
		// Private ('?') alt-screen modes: 1049 (save+alt), 1047 (alt), 47 (alt).
		if cmd.Prefix() != '?' {
			return
		}
		mode, _, _ := params.Param(0, 0)
		switch mode {
		case 1049, 1047, 47:
			// On set ('h') enter alt screen; on reset ('l') exit. Either way the
			// alt-screen frame is reset (fresh on entry, discarded on exit).
			b.tracker.altScreen = cmd.Final() == 'h'
			b.altFrame = nil
		}
	}
}

// onOSC updates the modeTracker from OSC sequences. OSC 0 (icon+window) and
// OSC 2 (window) carry the pane title. The parser's data payload includes the
// numeric command and ';' separator (e.g. "2;vim main.go"), so we strip that
// prefix before recording the title.
func (b *TrackedBuffer) onOSC(cmd int, data []byte) {
	if cmd != 0 && cmd != 2 {
		return
	}
	title := string(data)
	if i := indexByte(title, ';'); i >= 0 {
		title = title[i+1:]
	}
	b.tracker.title = title
}

// Title returns the last OSC 0/2 window title observed, or "" if none.
func (b *TrackedBuffer) Title() string {
	return b.tracker.title
}

// indexByte returns the index of the first occurrence of c in s, or -1.
func indexByte(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}

// itoa converts a non-negative int to its decimal string without pulling in
// strconv.
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

// Write parses p (for future mode tracking), appends it to the ring, trims to
// budget, and reports len(p) bytes consumed. The (int, error) signature matches
// the Phase-1 PaneBuffer seam and io.Writer.
func (b *TrackedBuffer) Write(p []byte) (int, error) {
	wasAlt := b.tracker.altScreen
	b.parser.Parse(p)
	nowAlt := b.tracker.altScreen

	switch {
	case !wasAlt && !nowAlt:
		// Normal scrollback: append to the budgeted ring.
		b.ring = append(b.ring, p...)
		b.trim()
	case wasAlt && nowAlt:
		// Steady-state alt screen: route full-screen repaints to the single
		// replaceable frame, never the ring.
		b.altFrame = append(b.altFrame, p...)
	default:
		// The alt-screen mode toggled inside this chunk. PTY reads deliver the
		// ?1049h/l toggle as its own small write in practice and golden tests
		// write toggles in isolated Write calls, so we route the whole
		// straddling chunk by its END state rather than splitting byte-exactly
		// at the toggle (YAGNI).
		if nowAlt {
			b.altFrame = append(b.altFrame, p...)
		} else {
			b.ring = append(b.ring, p...)
			b.trim()
		}
	}
	return len(p), nil
}

// trim caps the ring at budget by dropping its head, but only at a safe escape
// boundary: the initial byte-cut is advanced forward to the next offset where
// the ANSI parser sits in its ground state, so the retained ring never begins
// partway through an escape sequence (which would render as garbage on replay).
func (b *TrackedBuffer) trim() {
	if b.budget <= 0 || len(b.ring) <= b.budget {
		return
	}
	cut := len(b.ring) - b.budget
	cut = nextSafeBoundary(b.ring, cut)
	retained := make([]byte, len(b.ring)-cut)
	copy(retained, b.ring[cut:])
	b.ring = retained
}

// nextSafeBoundary returns the smallest offset >= from at which a cut leaves the
// remainder starting on a clean escape-sequence boundary. It replays ring[:from]
// through a throwaway parser to recover the mid-stream state, then advances one
// byte at a time until the parser returns to ground state. If no such boundary
// exists before the end, it returns len(ring) (drop everything).
func nextSafeBoundary(ring []byte, from int) int {
	if from <= 0 {
		return 0
	}
	if from >= len(ring) {
		return len(ring)
	}
	p := ansi.NewParser()
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

// Replay returns a copy of the retained bytes. No synthetic preamble is emitted
// yet (added in Task 9). The returned slice never aliases internal state.
func (b *TrackedBuffer) Replay() []byte {
	out := make([]byte, len(b.ring))
	copy(out, b.ring)
	return out
}
