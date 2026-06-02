package sessiond

import "testing"

// newTracked constructs a TrackedBuffer with the default budget for use as a
// PaneBuffer in the shared golden-test harness.
func newTracked() PaneBuffer {
	return NewTrackedBuffer()
}

// TestTrackedBufferImplementsInterface is a compile-time assertion that
// *TrackedBuffer satisfies the PaneBuffer seam.
func TestTrackedBufferImplementsInterface(t *testing.T) {
	var _ PaneBuffer = NewTrackedBuffer()
}

// TestTrackedBufferNoTrim verifies that TrackedBuffer, with no forced trimming,
// replays so every sticky fixture renders the same screen as the oracle. At
// Task 4 the parser handler is empty and Replay is a raw copy of the ring, so
// this is the no-trim floor: byte-identical replay must match.
func TestTrackedBufferNoTrim(t *testing.T) {
	runNoTrim(t, newTracked, stickyFixtures())
}

// contains reports whether sub occurs within s.
func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// TestTrackedBufferTracksSGRAndCursor verifies that the modeTracker accumulates
// the sticky cumulative SGR pen (bold + red) and the absolute cursor position
// from a CUP sequence, and that sgrPreamble renders those params.
func TestTrackedBufferTracksSGRAndCursor(t *testing.T) {
	b := NewTrackedBuffer()
	b.Write([]byte("\x1b[1m"))
	b.Write([]byte("\x1b[31m"))
	b.Write([]byte("\x1b[3;10H"))
	b.Write([]byte("x"))

	snap := b.tracker.snapshot()
	if len(snap.sgrParams) == 0 {
		t.Fatalf("expected sgrParams to be tracked, got none")
	}
	pre := string(snap.sgrPreamble())
	if !contains(pre, "1") {
		t.Errorf("sgrPreamble %q does not contain bold param '1'", pre)
	}
	if !contains(pre, "31") {
		t.Errorf("sgrPreamble %q does not contain red param '31'", pre)
	}
	if snap.cursorRow != 3 || snap.cursorCol != 10 {
		t.Errorf("cursor = (%d,%d), want (3,10)", snap.cursorRow, snap.cursorCol)
	}
}
