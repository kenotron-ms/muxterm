package sessiond

import (
	"bytes"
	"sync"
)

// defaultBufferBudget is the default per-pane scrollback budget (~1 MiB).
const defaultBufferBudget = 1 << 20

// PaneBuffer is the per-pane scrollback seam. v1 ships RawBuffer; richer
// implementations (TrackedBuffer/VTBuffer) are deferred to Phase 5 behind
// this interface.
type PaneBuffer interface {
	Write(p []byte) (int, error)
	Replay() []byte
}

// RawBuffer is a budgeted byte ring with newline-boundary trimming and
// copy-on-replay. Replay is byte-identical because xterm.js (the client) is
// itself the VT emulator, so no server-side interpretation is required.
type RawBuffer struct {
	mu     sync.Mutex
	buf    []byte
	budget int
}

// NewRawBuffer returns a RawBuffer with the given budget. A budget <= 0 uses
// defaultBufferBudget.
func NewRawBuffer(budget int) *RawBuffer {
	if budget <= 0 {
		budget = defaultBufferBudget
	}
	return &RawBuffer{budget: budget}
}

// Write appends p to the buffer under lock, then trims to budget. It always
// returns len(p), nil.
func (b *RawBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	b.trimLocked()
	return len(p), nil
}

// trimLocked drops the oldest bytes when the buffer exceeds budget, preferring
// to cut through a newline so lines/escape sequences are never severed. Callers
// must hold b.mu.
func (b *RawBuffer) trimLocked() {
	if len(b.buf) <= b.budget {
		return
	}
	cut := len(b.buf) - b.budget
	if idx := bytes.IndexByte(b.buf[cut:], '\n'); idx >= 0 {
		cut = cut + idx + 1
	}
	retained := make([]byte, len(b.buf)-cut)
	copy(retained, b.buf[cut:])
	b.buf = retained
}

// Replay returns a copy of the retained bytes. The returned slice never aliases
// internal state.
func (b *RawBuffer) Replay() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]byte, len(b.buf))
	copy(out, b.buf)
	return out
}
