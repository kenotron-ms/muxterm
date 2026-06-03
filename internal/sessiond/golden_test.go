package sessiond

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/x/vt"
)

// Golden-test infrastructure shared across the PaneBuffer bake-off.
//
// HONEST CAVEAT: the oracle here is charmbracelet/x/vt. The real client-side
// emulator is xterm.js. Because both the oracle and any future server-side
// VTBuffer would be measured against the *same* x/vt implementation, this
// harness CANNOT detect drift between x/vt and the real xterm.js. It only
// proves that a PaneBuffer's Replay() reproduces the same screen that x/vt
// would render from the original byte stream. Treat green here as "consistent
// with our reference oracle", not "pixel-identical to the browser".

const (
	oracleCols = 80
	oracleRows = 24
)

// renderScreen feeds b to a fresh x/vt emulator and returns the canonical
// plain-text grid (emu.String()). This is the oracle: two byte streams that
// render to the same screen are considered equivalent.
func renderScreen(b []byte) string {
	emu := vt.NewEmulator(oracleCols, oracleRows)
	_, _ = emu.Write(b)
	return emu.String()
}

// fixture is a named, deterministic byte stream built from explicit escape
// sequences. Fixtures never shell out to vim/htop/etc. so results are stable.
type fixture struct {
	name  string
	bytes []byte
}

// stickyFixtures returns fixtures exercising "sticky" terminal state (SGR runs,
// alt-screen transitions, cursor positioning, window title) that must survive
// trimming. Each sets state via a preamble and then paints trailing content, so
// a buffer that drops the preamble would render a different screen.
func stickyFixtures() []fixture {
	return []fixture{
		{
			name: "sgr_color_run",
			bytes: []byte(esc + "[1;31m" + "bold red text" + esc + "[0m\r\n" +
				esc + "[44;37m" + "white on blue" + esc + "[0m\r\n" +
				"trailing line one\r\n" +
				"trailing line two\r\n"),
		},
		{
			name: "altscreen_enter_exit",
			bytes: []byte("normal scrollback line one\r\n" +
				"normal scrollback line two\r\n" +
				esc + "[?1049h" + // enter alt screen
				esc + "[2J" + esc + "[H" + // clear + home
				"alt screen paint\r\n" +
				esc + "[?1049l" + // exit alt screen
				"back to normal\r\n"),
		},
		{
			name: "cursor_moves_and_color",
			bytes: []byte(esc + "[2J" + esc + "[H" + // clear + home
				esc + "[5;10H" + esc + "[32m" + "green here" + esc + "[0m" +
				esc + "[10;20H" + esc + "[33m" + "yellow there" + esc + "[0m" +
				esc + "[15;1H" + "bottom row"),
		},
		{
			name: "osc2_window_title",
			bytes: []byte(esc + "]2;vim main.go" + "\x07" + // OSC 2 ; title BEL
				"editing main.go\r\n"),
		},
	}
}

// reflowFixtures returns a long wrapping paragraph with no explicit newlines.
// It is used in the bake-off to measure reflow behavior; it is NOT asserted for
// the Raw/Tracked buffers (which do not reflow), only measured.
func reflowFixtures() []fixture {
	var sb strings.Builder
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&sb, "word%03d ", i)
	}
	return []fixture{
		{
			name:  "wrapping_paragraph",
			bytes: []byte(sb.String()),
		},
	}
}

// runNoTrim asserts that, for each fixture, writing the bytes to a buffer and
// rendering its Replay() produces the same oracle screen as rendering the
// original bytes directly. Buffers are constructed with no trimming so this is
// a pure round-trip / no-corruption check.
func runNoTrim(t *testing.T, newBuf func() PaneBuffer, fixtures []fixture) {
	t.Helper()
	for _, f := range fixtures {
		f := f
		t.Run(f.name, func(t *testing.T) {
			golden := renderScreen(f.bytes)
			buf := newBuf()
			if _, err := buf.Write(f.bytes); err != nil {
				t.Fatalf("buf.Write returned error: %v", err)
			}
			got := renderScreen(buf.Replay())
			if got != golden {
				t.Errorf("screen mismatch for fixture %q:\n--- golden ---\n%s\n--- got ---\n%s",
					f.name, golden, got)
			}
		})
	}
}

// TestRawBufferNoTrim verifies that RawBuffer, with an effectively unlimited
// budget, replays byte-identically so every sticky fixture renders the same
// screen as the oracle.
func TestRawBufferNoTrim(t *testing.T) {
	runNoTrim(t, func() PaneBuffer { return NewRawBuffer(0) }, stickyFixtures())
}

// scoreTrimResilience measures how well a budgeted PaneBuffer survives forced
// trimming. For each split offset k in [1,n) it constructs a buffer whose
// budget equals the suffix length (n-k), writes the prefix f.bytes[:k] and then
// the suffix f.bytes[k:]. Because the budget exactly fits the suffix, the
// prefix is evicted, so only a buffer that reconstructs the dropped sticky
// state (a Tracked synthetic preamble, or VT live-grid serialization) can still
// render the golden screen. The score is the fraction of offsets whose Replay()
// renders identically to the un-trimmed oracle screen; 1.0 means fully
// trim-resilient. Streams shorter than 2 bytes have no interior split and score
// 1.0 by definition.
func scoreTrimResilience(newBudgeted func(budget int) PaneBuffer, f fixture) float64 {
	n := len(f.bytes)
	if n < 2 {
		return 1.0
	}
	golden := renderScreen(f.bytes)
	ok := 0
	total := 0
	for k := 1; k < n; k++ {
		budget := n - k
		buf := newBudgeted(budget)
		_, _ = buf.Write(f.bytes[:k])
		_, _ = buf.Write(f.bytes[k:])
		if renderScreen(buf.Replay()) == golden {
			ok++
		}
		total++
	}
	return float64(ok) / float64(total)
}

// TestRawBufferTrimBaseline records RawBuffer's trim-resilience scores for the
// sticky fixtures as documented baseline data for the buffer bake-off. The
// no-trim floor for Raw is asserted separately by TestRawBufferNoTrim; here the
// sticky-state trim scores are only logged, NOT asserted. RawBuffer is allowed
// to lose mid-screen sticky state under forced eviction (typically scoring
// below 1.0 for SGR/color and alt-screen fixtures) -- that is precisely the
// gap a TrackedBuffer/VTBuffer is expected to close.
func TestRawBufferTrimBaseline(t *testing.T) {
	newBudgeted := func(budget int) PaneBuffer { return NewRawBuffer(budget) }
	for _, f := range stickyFixtures() {
		score := scoreTrimResilience(newBudgeted, f)
		t.Logf("RawBuffer trim-resilience %-22s = %.2f", f.name, score)
	}
}
