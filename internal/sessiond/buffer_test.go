package sessiond

import (
	"bytes"
	"testing"
)

// Compile-time assertion that RawBuffer satisfies PaneBuffer.
var _ PaneBuffer = NewRawBuffer(0)

func TestRawBufferReplayRoundTrip(t *testing.T) {
	b := NewRawBuffer(0)
	if _, err := b.Write([]byte("hello ")); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	if _, err := b.Write([]byte("world\n")); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	got := b.Replay()
	want := []byte("hello world\n")
	if !bytes.Equal(got, want) {
		t.Fatalf("Replay = %q, want %q", got, want)
	}
}

func TestRawBufferTrimsAtNewlineBoundary(t *testing.T) {
	b := NewRawBuffer(8)
	if _, err := b.Write([]byte("123\n456\n789")); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	got := b.Replay()
	// 11 bytes written, budget 8 -> cut=3, newline at index 3 -> drop through it.
	want := []byte("456\n789")
	if !bytes.Equal(got, want) {
		t.Fatalf("Replay = %q, want %q", got, want)
	}
	if len(got) > 8 {
		t.Fatalf("retained %d bytes, want <= 8", len(got))
	}
	if len(got) > 0 && got[0] == '\n' {
		t.Fatalf("retained bytes start with a newline: %q", got)
	}
}

func TestRawBufferReplayReturnsCopy(t *testing.T) {
	b := NewRawBuffer(0)
	if _, err := b.Write([]byte("abc")); err != nil {
		t.Fatalf("Write returned error: %v", err)
	}
	got := b.Replay()
	if len(got) == 0 {
		t.Fatal("Replay returned empty slice")
	}
	got[0] = 'X'
	again := b.Replay()
	if !bytes.Equal(again, []byte("abc")) {
		t.Fatalf("internal state mutated via returned slice: %q", again)
	}
}

func TestRawBufferImplementsPaneBuffer(t *testing.T) {
	var _ PaneBuffer = NewRawBuffer(0)
}

// TestRawBufferSeqAndReplayFrom verifies the absolute-sequence tracking and
// delta-replay semantics of RawBuffer without any trimming.
func TestRawBufferSeqAndReplayFrom(t *testing.T) {
	b := NewRawBuffer(0)
	_, _ = b.Write([]byte("abc"))
	_, _ = b.Write([]byte("def"))

	// Seq tracks total bytes ever written.
	if got := b.Seq(); got != 6 {
		t.Fatalf("Seq() = %d, want 6", got)
	}

	// ReplayFrom(0): all retained bytes, start=0.
	data, start := b.ReplayFrom(0)
	if !bytes.Equal(data, []byte("abcdef")) {
		t.Fatalf("ReplayFrom(0) data = %q, want \"abcdef\"", data)
	}
	if start != 0 {
		t.Fatalf("ReplayFrom(0) start = %d, want 0", start)
	}

	// ReplayFrom(3): bytes from absolute seq 3 onwards.
	data, start = b.ReplayFrom(3)
	if !bytes.Equal(data, []byte("def")) {
		t.Fatalf("ReplayFrom(3) data = %q, want \"def\"", data)
	}
	if start != 3 {
		t.Fatalf("ReplayFrom(3) start = %d, want 3", start)
	}

	// ReplayFrom(6): at or beyond total → nil, total.
	data, start = b.ReplayFrom(6)
	if data != nil {
		t.Fatalf("ReplayFrom(6) data = %q, want nil", data)
	}
	if start != 6 {
		t.Fatalf("ReplayFrom(6) start = %d, want 6", start)
	}
}

// TestRawBufferSeqAndReplayFromAfterTrim verifies that ReplayFrom clamps to the
// oldest retained byte when since is before the trim boundary.
func TestRawBufferSeqAndReplayFromAfterTrim(t *testing.T) {
	b := NewRawBuffer(8)
	// Write 11 bytes; trimLocked drops "123\n" (cut=4) → retained="456\n789" (7 bytes).
	// total=11, oldest=11-7=4.
	_, _ = b.Write([]byte("123\n456\n789"))

	if got := b.Seq(); got != 11 {
		t.Fatalf("Seq() = %d, want 11", got)
	}

	// ReplayFrom(0) clamps to oldest retained byte (seq=4).
	data, start := b.ReplayFrom(0)
	if start != 4 {
		t.Fatalf("ReplayFrom(0) start = %d, want 4 (oldest retained)", start)
	}
	if !bytes.Equal(data, []byte("456\n789")) {
		t.Fatalf("ReplayFrom(0) data = %q, want \"456\\n789\"", data)
	}

	// ReplayFrom(4) starts at exactly the oldest retained byte.
	data, start = b.ReplayFrom(4)
	if start != 4 {
		t.Fatalf("ReplayFrom(4) start = %d, want 4", start)
	}
	if !bytes.Equal(data, []byte("456\n789")) {
		t.Fatalf("ReplayFrom(4) data = %q, want \"456\\n789\"", data)
	}

	// ReplayFrom(8): from index 8-4=4 into retained buf → "789".
	data, start = b.ReplayFrom(8)
	if start != 8 {
		t.Fatalf("ReplayFrom(8) start = %d, want 8", start)
	}
	if !bytes.Equal(data, []byte("789")) {
		t.Fatalf("ReplayFrom(8) data = %q, want \"789\"", data)
	}

	// ReplayFrom(11): at or beyond total → nil, total.
	data, start = b.ReplayFrom(11)
	if data != nil {
		t.Fatalf("ReplayFrom(11) data = %q, want nil", data)
	}
	if start != 11 {
		t.Fatalf("ReplayFrom(11) start = %d, want 11", start)
	}
}

func TestRawBufferResizeIsNoOp(t *testing.T) {
	b := NewRawBuffer(0)
	if _, err := b.Write([]byte("before resize\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	snapshot := b.Replay()

	// Resize must not alter the stored bytes in any way.
	b.Resize(120, 40)

	after := b.Replay()
	if !bytes.Equal(snapshot, after) {
		t.Fatalf("Resize mutated RawBuffer content:\nbefore: %q\nafter:  %q", snapshot, after)
	}

	// Second resize with edge-case dimensions is also a no-op.
	b.Resize(0, 0)
	b.Resize(-1, -1)
	afterEdge := b.Replay()
	if !bytes.Equal(snapshot, afterEdge) {
		t.Fatalf("Resize(0,0) or Resize(-1,-1) mutated RawBuffer content: %q", afterEdge)
	}
}
