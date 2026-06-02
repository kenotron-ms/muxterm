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

// TestTrackedBufferCapturesTitle verifies that the modeTracker captures the pane
// title from OSC 0 (icon+window) and OSC 2 (window) sequences, handling both the
// BEL terminator and the ST (ESC\) terminator, and exposes it via Title().
func TestTrackedBufferCapturesTitle(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"osc2_bel", "\x1b]2;vim main.go\x07", "vim main.go"},
		{"osc0_bel", "\x1b]0;~/proj\x07", "~/proj"},
		{"osc2_st", "\x1b]2;tailing logs\x1b\\", "tailing logs"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := NewTrackedBuffer()
			b.Write([]byte(tc.input))
			if got := b.Title(); got != tc.want {
				t.Errorf("Title() = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestTrackedBufferTwoTierAltScreen verifies the two-tier routing: while on the
// alternate screen (CSI ?1049h) full-screen repaint output is routed to a single
// replaceable alt-screen frame instead of growing the scrollback ring, and on
// exit (CSI ?1049l) the frame is discarded and the ring resumes growing.
func TestTrackedBufferTwoTierAltScreen(t *testing.T) {
	b := NewTrackedBuffer()
	b.Write([]byte("scrollback line\n"))
	ringBefore := len(b.ring)

	b.Write([]byte("\x1b[?1049h"))
	for i := 0; i < 100; i++ {
		b.Write([]byte("\x1b[2J\x1b[HFULLSCREEN REPAINT FRAME\n"))
	}
	if len(b.ring) != ringBefore {
		t.Errorf("ring grew during alt-screen: len(ring)=%d, want %d", len(b.ring), ringBefore)
	}
	if !b.tracker.altScreen {
		t.Errorf("altScreen = false during alt-screen, want true")
	}

	b.Write([]byte("\x1b[?1049l"))
	if b.tracker.altScreen {
		t.Errorf("altScreen = true after exit, want false")
	}

	b.Write([]byte("more scrollback\n"))
	if len(b.ring) <= ringBefore {
		t.Errorf("ring did not resume growing after exit: len(ring)=%d, want > %d", len(b.ring), ringBefore)
	}
}
