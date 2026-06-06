package sessiond

import (
	"bytes"
	"sync"
)

// defaultBufferBudget is the default per-pane scrollback budget (~1 MiB).
const defaultBufferBudget = 1 << 20

// PaneBuffer is the per-pane scrollback seam. The production default is
// VTBuffer (screen-state replay). RawBuffer remains available for testing;
// TrackedBuffer is a third alternative behind this same interface.
type PaneBuffer interface {
	Write(p []byte) (int, error)
	Replay() []byte
	// ReplayFrom returns the bytes whose absolute sequence is >= since,
	// and the absolute sequence (start) of the first returned byte.
	// If since is at or beyond total, returns (nil, total).
	// Implementations that are not byte-log–based (e.g. VTBuffer) may
	// ignore since and always return (Replay(), 0).
	ReplayFrom(since uint64) (data []byte, start uint64)
	// Seq returns the total bytes ever written to this buffer (including
	// bytes that have since been trimmed).
	Seq() uint64
	// Resize notifies the buffer that the terminal dimensions have changed.
	// Implementations that model a cell grid (VTBuffer) must resize their
	// internal state so subsequent Replay output matches the new dimensions.
	// Implementations that are dimension-agnostic (RawBuffer) may ignore it.
	Resize(cols, rows int)
}

// RawBuffer is a budgeted byte ring with newline-boundary trimming and
// copy-on-replay. Replay is byte-identical because xterm.js (the client) is
// itself the VT emulator, so no server-side interpretation is required.
type RawBuffer struct {
	mu     sync.Mutex
	buf    []byte
	budget int
	total  uint64 // total bytes ever written, including trimmed bytes
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
	b.total += uint64(len(p))
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

// Resize is a no-op for RawBuffer; raw byte replay carries no grid state and
// is dimension-agnostic.
func (b *RawBuffer) Resize(cols, rows int) {}

// Replay returns a copy of the retained bytes. The returned slice never aliases
// internal state.
func (b *RawBuffer) Replay() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]byte, len(b.buf))
	copy(out, b.buf)
	return out
}

// ReplayFrom returns the retained bytes whose absolute sequence is >= since,
// and the absolute sequence (start) of the first returned byte. The absolute
// sequence of the byte at retained index i is (b.total - uint64(len(b.buf))) + i.
// If since is at or beyond total, returns (nil, total).
func (b *RawBuffer) ReplayFrom(since uint64) (data []byte, start uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	oldest := b.total - uint64(len(b.buf)) // absolute seq of buf[0]
	from := since
	if from < oldest {
		from = oldest
	}
	if from >= b.total {
		return nil, b.total
	}
	idx := int(from - oldest) // index into b.buf
	out := make([]byte, len(b.buf)-idx)
	copy(out, b.buf[idx:])
	return out, from
}

// Seq returns the absolute total bytes ever written (including trimmed bytes).
func (b *RawBuffer) Seq() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.total
}
