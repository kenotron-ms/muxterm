package sessiond

import (
	"github.com/charmbracelet/x/ansi"
)

// defaultTrackedBudget is the default per-pane scrollback budget (~1 MiB) for a
// TrackedBuffer.
const defaultTrackedBudget = 1 << 20

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
	budget  int
	ring    []byte
	parser  *ansi.Parser
	tracker modeTracker
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
		// Placeholder for private ('?') mode set/reset (alt screen, Task 7).
	}
}

// onOSC updates the modeTracker from OSC sequences. Title tracking lands in
// Task 6; this is a stub for now.
func (b *TrackedBuffer) onOSC(cmd int, data []byte) {
	_ = cmd
	_ = data
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
	b.parser.Parse(p)
	b.ring = append(b.ring, p...)
	b.trim()
	return len(p), nil
}

// trim performs a naive tail-retaining cut: when the ring exceeds budget it
// keeps only the last budget bytes. This is replaced by a smarter strategy in
// Task 8.
func (b *TrackedBuffer) trim() {
	if b.budget <= 0 || len(b.ring) <= b.budget {
		return
	}
	cut := len(b.ring) - b.budget
	retained := make([]byte, b.budget)
	copy(retained, b.ring[cut:])
	b.ring = retained
}

// Replay returns a copy of the retained bytes. No synthetic preamble is emitted
// yet (added in Task 9). The returned slice never aliases internal state.
func (b *TrackedBuffer) Replay() []byte {
	out := make([]byte, len(b.ring))
	copy(out, b.ring)
	return out
}
