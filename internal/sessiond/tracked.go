package sessiond

import (
	"github.com/charmbracelet/x/ansi"
)

// defaultTrackedBudget is the default per-pane scrollback budget (~1 MiB) for a
// TrackedBuffer.
const defaultTrackedBudget = 1 << 20

// modeTracker accumulates "sticky" terminal state (SGR runs, modes, cursor,
// title) observed by the parser so it can later be synthesized into a replay
// preamble. It is a stub at Task 4 and is populated in Tasks 5-7.
type modeTracker struct{}

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

// handler returns the ansi.Handler the parser dispatches to. At Task 4 it is
// empty; mode-tracking callbacks are added in Tasks 5-7.
func (b *TrackedBuffer) handler() ansi.Handler {
	return ansi.Handler{}
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
