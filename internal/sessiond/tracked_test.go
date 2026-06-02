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
