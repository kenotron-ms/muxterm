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

// head returns the first n bytes of b (or all of b if shorter), for compact
// failure messages.
func head(b []byte, n int) []byte {
	if n > len(b) {
		n = len(b)
	}
	return b[:n]
}

// startsMidEscape reports whether b appears to begin in the middle of a severed
// CSI escape sequence. It is a heuristic: a buffer that starts with ESC is a
// clean sequence boundary (false), and a buffer that starts with ordinary text
// is also fine (false). But a leading run of CSI param/final bytes
// (digits, ';', or 'm') appearing before any ESC indicates the buffer was sliced
// mid-sequence, leaving a dangling tail like "1m..." (true).
func startsMidEscape(b []byte) bool {
	if len(b) == 0 {
		return false
	}
	if b[0] == 0x1b {
		return false // ESC-first: clean boundary.
	}
	c := b[0]
	if (c >= '0' && c <= '9') || c == ';' || c == 'm' {
		return true // looks like a severed CSI tail.
	}
	return false // ordinary-text-first: clean boundary.
}

// TestTrackedBufferSafeTrimNeverSeversEscape drives far more bytes than the
// budget through the buffer so trimming fires repeatedly, then asserts the
// retained ring never begins partway through an escape sequence. A naive
// byte-cut can leave the ring starting at e.g. "1m..."; safe-boundary trimming
// must cut only at parser ground-state boundaries.
func TestTrackedBufferSafeTrimNeverSeversEscape(t *testing.T) {
	b := NewTrackedBufferWithBudget(64)
	for i := 0; i < 50; i++ {
		b.Write([]byte("\x1b[31mabc\x1b[0mdef"))
	}
	if startsMidEscape(b.ring) {
		t.Errorf("ring starts mid-escape: head=%q", head(b.ring, 8))
	}
}
