package sessiond

import (
	"bytes"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/charmbracelet/x/vt"
)

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

// TestVTBufferResize verifies that resizing the VTBuffer does not lose visible
// content. It writes content at the original size, resizes, writes more, then
// confirms that Replay fed into a fresh emulator at the new size contains the
// post-resize content.
func TestVTBufferResize(t *testing.T) {
	b := NewVTBuffer(80, 24)

	// Write before resize.
	if _, err := b.Write([]byte("before-resize\r\n")); err != nil {
		t.Fatalf("Write before resize: %v", err)
	}

	// Resize to a larger terminal.
	b.Resize(120, 40)

	// Write after resize.
	if _, err := b.Write([]byte("after-resize\r\n")); err != nil {
		t.Fatalf("Write after resize: %v", err)
	}

	replay := b.Replay()
	if len(replay) == 0 {
		t.Fatal("Replay returned empty slice after resize")
	}

	// Feed replay into a fresh emulator at the new size. The post-resize line
	// must be visible in the rendered screen.
	fresh := vt.NewEmulator(120, 40)
	if _, err := fresh.Write(replay); err != nil {
		t.Fatalf("Write replay to fresh emulator: %v", err)
	}
	screen := fresh.String()
	if !strings.Contains(screen, "after-resize") {
		t.Errorf("after-resize not found in fresh emulator screen after resize:\n%s", screen)
	}
}

// TestVTBufferScrollbackRoundTrip writes enough lines to push early content
// into the emulator's scrollback, calls Replay, feeds the replay into a fresh
// emulator, and asserts that the earliest line (which has scrolled off the
// visible grid) is present in the fresh emulator's scrollback.
func TestVTBufferScrollbackRoundTrip(t *testing.T) {
	// Use an 80x24 emulator. Writing 30 lines pushes the first ~7 lines into
	// scrollback (scroll occurs once the terminal is full at row 23).
	const (
		cols      = 80
		rows      = 24
		totalLines = 30
	)
	b := NewVTBuffer(cols, rows)

	for i := 1; i <= totalLines; i++ {
		line := fmt.Sprintf("line-%03d\r\n", i)
		if _, err := b.Write([]byte(line)); err != nil {
			t.Fatalf("Write line %d: %v", i, err)
		}
	}

	replay := b.Replay()
	if len(replay) == 0 {
		t.Fatal("Replay returned empty slice")
	}

	// Feed replay into a fresh emulator sized identically.
	fresh := vt.NewEmulator(cols, rows)
	fresh.SetScrollbackSize(2000)
	if _, err := fresh.Write(replay); err != nil {
		t.Fatalf("Write replay to fresh emulator: %v", err)
	}

	// The earliest lines scrolled off the original visible grid. They must
	// appear somewhere in the fresh emulator's scrollback.
	sb := fresh.Scrollback()
	var foundEarly bool
	for i := 0; i < sb.Len(); i++ {
		line := sb.Line(i)
		// uv.Line.String() returns plain text (trailing spaces stripped).
		if strings.Contains(line.String(), "line-001") {
			foundEarly = true
			break
		}
	}
	if !foundEarly {
		t.Errorf("line-001 (scrolled off original visible grid) not found in fresh emulator scrollback after replay; scrollback len=%d", sb.Len())
	}

	// The last line written must be visible on screen.
	screen := fresh.String()
	if !strings.Contains(screen, fmt.Sprintf("line-%03d", totalLines)) {
		t.Errorf("last line not visible on fresh emulator screen:\n%s", screen)
	}
}

// TestVTBufferSeq verifies that Seq() tracks total bytes ever written.
func TestVTBufferSeq(t *testing.T) {
	b := NewVTBuffer(80, 24)
	if got := b.Seq(); got != 0 {
		t.Fatalf("Seq() before any writes = %d, want 0", got)
	}
	data := []byte("hello\r\n")
	if _, err := b.Write(data); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got := b.Seq(); got != uint64(len(data)) {
		t.Fatalf("Seq() after Write = %d, want %d", got, len(data))
	}
}

// TestVTBufferReplayFromIgnoresSince verifies that VTBuffer.ReplayFrom always
// returns the full screen-state replay from seq 0, ignoring the since argument.
// VTBuffer is a degraded (screen-state) implementation: it cannot seek into a
// raw byte log, so every caller gets the full current screen regardless of since.
func TestVTBufferReplayFromIgnoresSince(t *testing.T) {
	b := NewVTBuffer(80, 24)
	if _, err := b.Write([]byte("content\r\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	seq := b.Seq()
	if seq == 0 {
		t.Fatal("expected non-zero Seq after write")
	}

	// Both calls must return the same full screen-state replay, starting at 0.
	data0, start0 := b.ReplayFrom(0)
	dataSeq, startSeq := b.ReplayFrom(seq)

	if start0 != 0 {
		t.Fatalf("ReplayFrom(0) start = %d, want 0", start0)
	}
	if startSeq != 0 {
		t.Fatalf("ReplayFrom(seq) start = %d, want 0 (VTBuffer always replays from 0)", startSeq)
	}
	if len(data0) == 0 {
		t.Fatal("ReplayFrom(0) returned empty data")
	}
	// since is ignored: both calls must produce identical output.
	if !bytes.Equal(data0, dataSeq) {
		t.Fatalf("VTBuffer.ReplayFrom: data for since=0 (%d bytes) != data for since=Seq (%d bytes)",
			len(data0), len(dataSeq))
	}
}

// TestVTBufferConcurrent exercises concurrent Write and Replay to confirm
// there are no data races. Run with -race (the CI harness already passes -race
// to go test).
func TestVTBufferConcurrent(t *testing.T) {
	b := NewVTBuffer(80, 24)

	const iterations = 200
	var wg sync.WaitGroup

	// Writer goroutine: hammers Write concurrently with the reader below.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			_, _ = b.Write([]byte(fmt.Sprintf("concurrent line %d\r\n", i)))
		}
	}()

	// Reader (main goroutine): calls Replay concurrently.
	for i := 0; i < iterations; i++ {
		r := b.Replay()
		_ = r // discard; we only care about the race detector
	}

	wg.Wait()

	// After all writes, Replay must still return non-empty bytes.
	if got := b.Replay(); len(got) == 0 {
		t.Error("Replay returned empty slice after concurrent writes")
	}
}
