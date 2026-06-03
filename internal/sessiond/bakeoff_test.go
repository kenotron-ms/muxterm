package sessiond

import (
	"runtime"
	"testing"
)

// candidate is a PaneBuffer implementation under evaluation in the bake-off. It
// carries constructors for both an unbudgeted "default" buffer (used for the
// rough memory estimate) and a budgeted buffer (used to force trimming via
// scoreTrimResilience).
type candidate struct {
	name        string
	newDefault  func() PaneBuffer
	newBudgeted func(budget int) PaneBuffer
}

// bakeoffCandidates returns the three PaneBuffer implementations compared in the
// bake-off: RawBuffer (byte-identical replay), TrackedBuffer (synthetic sticky
// preamble), and VTBuffer (live-grid serialization). VTBuffer ignores the byte
// budget -- its trimming is governed by the emulator's own scrollback bound, so
// both constructors build a fresh oracle-sized emulator.
func bakeoffCandidates() []candidate {
	return []candidate{
		{
			name:        "RawBuffer",
			newDefault:  func() PaneBuffer { return NewRawBuffer(0) },
			newBudgeted: func(budget int) PaneBuffer { return NewRawBuffer(budget) },
		},
		{
			name:        "TrackedBuffer",
			newDefault:  func() PaneBuffer { return NewTrackedBuffer() },
			newBudgeted: func(budget int) PaneBuffer { return NewTrackedBufferWithBudget(budget) },
		},
		{
			name:        "VTBuffer",
			newDefault:  func() PaneBuffer { return NewVTBuffer(oracleCols, oracleRows) },
			newBudgeted: func(_ int) PaneBuffer { return NewVTBuffer(oracleCols, oracleRows) },
		},
	}
}

// avgScore averages scoreTrimResilience across a fixture set. An empty set
// scores 1.0 by definition.
func avgScore(newBudgeted func(budget int) PaneBuffer, fixtures []fixture) float64 {
	if len(fixtures) == 0 {
		return 1.0
	}
	var sum float64
	for _, f := range fixtures {
		sum += scoreTrimResilience(newBudgeted, f)
	}
	return sum / float64(len(fixtures))
}

// approxBytes gives a rough, RELATIVE estimate of per-pane memory by measuring
// the live-heap delta around constructing and filling a buffer with the sticky
// and reflow fixtures, then replaying. GC nondeterminism makes the absolute
// numbers unreliable; only the ordering across candidates is meaningful. A
// negative delta (the GC reclaimed more than the buffer retained) clamps to 0.
func approxBytes(newDefault func() PaneBuffer) uint64 {
	var all []fixture
	all = append(all, stickyFixtures()...)
	all = append(all, reflowFixtures()...)

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)

	buf := newDefault()
	for _, f := range all {
		_, _ = buf.Write(f.bytes)
	}
	_ = buf.Replay()

	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	runtime.KeepAlive(buf)

	if after.HeapAlloc < before.HeapAlloc {
		return 0
	}
	return after.HeapAlloc - before.HeapAlloc
}

// TestBufferBakeoff scores all three PaneBuffer candidates on sticky and reflow
// trim-resilience plus rough per-pane memory, logging a decision table for the
// design record. It ASSERTS the strict reconstruction contract (sticky avgScore
// == 1.00) only for VTBuffer, whose live grid can fully reconstruct mid-screen
// sticky state under forced trimming. RawBuffer and TrackedBuffer are byte-ring
// designs: a synthetic preamble restores sticky *state* but cannot re-emit
// glyphs evicted from the ring, so 1.00 is mathematically unachievable for them.
// Their sticky scores (and all reflow scores plus memory estimates) are
// therefore only RECORDED here; Tracked's baseline is logged by
// TestTrackedBufferTrimBaseline and Raw's by TestRawBufferTrimBaseline.
func TestBufferBakeoff(t *testing.T) {
	sticky := stickyFixtures()
	reflow := reflowFixtures()

	t.Logf("%-14s %10s %10s %12s", "buffer", "sticky", "reflow", "mem(bytes)")
	for _, c := range bakeoffCandidates() {
		stickyScore := avgScore(c.newBudgeted, sticky)
		reflowScore := avgScore(c.newBudgeted, reflow)
		mem := approxBytes(c.newDefault)
		t.Logf("%-14s %10.2f %10.2f %12d", c.name, stickyScore, reflowScore, mem)

		// Contract: only VTBuffer's live grid can fully reconstruct mid-screen
		// sticky state under forced trimming. Raw/Tracked are byte-ring designs
		// whose evicted glyphs cannot be re-emitted, so 1.00 is unachievable and
		// their scores are recorded, not asserted (see TestTrackedBufferTrimBaseline
		// and TestRawBufferTrimBaseline).
		if c.name == "VTBuffer" {
			if stickyScore < 1.0 {
				t.Errorf("%s sticky trim-resilience = %.2f, want 1.00; sticky state must be reconstructed under trimming",
					c.name, stickyScore)
			}
		}
	}

	// Decision guidance for the design record / Task 12 wiring.
	t.Logf("decision: prefer byte-identical replay (Raw/Tracked) unless reflow fidelity is required.")
	t.Logf("decision: VTBuffer's reflow win is real but carries untestable two-emulator drift (x/vt vs xterm.js) + higher memory.")
	t.Logf("decision: record the chosen default in the design doc and wire it in Task 12.")
}
