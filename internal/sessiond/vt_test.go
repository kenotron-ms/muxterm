package sessiond

import "testing"

// newVT constructs a VTBuffer sized to the oracle grid for use as a PaneBuffer
// in the shared golden-test harness.
func newVT() PaneBuffer {
	return NewVTBuffer(oracleCols, oracleRows)
}

// TestVTBufferImplementsInterface is a compile-time assertion that *VTBuffer
// satisfies the PaneBuffer seam.
func TestVTBufferImplementsInterface(t *testing.T) {
	var _ PaneBuffer = NewVTBuffer(oracleCols, oracleRows)
}

// TestVTBufferNoTrim verifies that VTBuffer, feeding bytes to a headless
// cell-grid emulator and serializing the live grid on Replay, reproduces the
// oracle screen for every sticky fixture with no forced trimming.
func TestVTBufferNoTrim(t *testing.T) {
	runNoTrim(t, newVT, stickyFixtures())
}

// TestVTBufferTrimResilienceSticky is the payoff: VTBuffer trims whole lines
// inside the emulator, so even when the harness forces the two-write replay
// path under a (here ignored) byte budget, the live grid still reconstructs the
// visible screen. The emulator's own scrollback bound governs trimming, so each
// sticky fixture must score 1.00.
func TestVTBufferTrimResilienceSticky(t *testing.T) {
	newBudgeted := func(_ int) PaneBuffer { return NewVTBuffer(oracleCols, oracleRows) }
	for _, f := range stickyFixtures() {
		f := f
		t.Run(f.name, func(t *testing.T) {
			if score := scoreTrimResilience(newBudgeted, f); score < 1.0 {
				t.Errorf("trim-resilience %q = %.2f, want 1.00; live grid must reconstruct the screen", f.name, score)
			}
		})
	}
}
