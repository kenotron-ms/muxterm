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
