package server

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// orderRecorder captures the relative order in which composition (text) and
// pane-data (binary) frames are written to the simulated WebSocket, so tests
// can assert the frozen "composition FIRST" guarantee holds even under
// adversarial goroutine timing.
type orderRecorder struct {
	mu    sync.Mutex
	order []string
}

func (r *orderRecorder) text(data []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	r.order = append(r.order, "text:"+string(cp))
	return nil
}

func (r *orderRecorder) binary(data []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.order = append(r.order, "binary")
	return nil
}

func (r *orderRecorder) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, len(r.order))
	copy(out, r.order)
	return out
}

// racyDaemonConn reproduces the real sessiond.Client daemon connection's
// timing: its read loop (Run) delivers the composition reply to the pending
// channel and then, on the SAME goroutine and without yielding, immediately
// dispatches the following replay pane-data frame via OnPaneOutput -- well
// before the requester goroutine (handleTextInput, blocked in Attach()) is
// even scheduled to forward the composition reply to the real client
// WebSocket. This double fires OnPaneOutput from a background goroutine and
// gives it a healthy head start via a short sleep before Attach() returns,
// mimicking that hazard deterministically enough for a test.
type racyDaemonConn struct {
	*fakeDaemonConn
}

func (f *racyDaemonConn) Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error) {
	comp, err := f.fakeDaemonConn.Attach(workspaceID, breakpoint, clientKind)
	go f.handlers.OnPaneOutput(1, []byte("replay"))
	// Head start: give the background goroutine every opportunity to win the
	// race and write to the wire before this call returns and
	// handleTextInput resumes to send the composition.
	time.Sleep(20 * time.Millisecond)
	return comp, err
}

// TestAttachCompositionOrderingSurvivesConcurrentReplay reproduces the M3
// live-verification failure: with a daemon connection whose replay pane-data
// callback fires concurrently (as the real sessiond.Client read loop does),
// the composition control message must still reach the WebSocket strictly
// before any replay pane-data frame for the panes it announces. Without the
// attachSeq guard in ws.go, the background OnPaneOutput call wins the race
// and the replay frame is written first, which the Android client silently
// drops (TerminalRegistry has no pane registered yet) -- producing the
// observed "12 of 13 panes ZERO bytes" / RC-1 timeout symptom.
func TestAttachCompositionOrderingSurvivesConcurrentReplay(t *testing.T) {
	fake := &racyDaemonConn{fakeDaemonConn: &fakeDaemonConn{}}
	hub := newTestHub(fake)
	rec := &orderRecorder{}
	c := newTestClient(hub, rec.text, rec.binary)

	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	// attachClient itself seeds the browser with an initial workspace-list
	// frame; only frames from this point on are relevant to the attach ->
	// composition -> replay ordering under test.
	baseline := len(rec.snapshot())

	c.handleTextInput([]byte(`{"type":"attach","cid":11,"workspaceId":"w1"}`))

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && len(rec.snapshot()) < baseline+2 {
		time.Sleep(time.Millisecond)
	}

	order := rec.snapshot()[baseline:]
	if len(order) < 2 {
		t.Fatalf("expected composition + replay frames, got %v", order)
	}
	if !strings.HasPrefix(order[0], "text:") {
		t.Fatalf("first relayed frame = %q, want composition (text) FIRST -- replay frame overtook it", order[0])
	}
	var comp sessiond.Message
	if err := json.Unmarshal([]byte(strings.TrimPrefix(order[0], "text:")), &comp); err != nil {
		t.Fatalf("decode composition: %v", err)
	}
	if comp.Type != sessiond.TypeComposition {
		t.Fatalf("first text frame type = %q, want composition", comp.Type)
	}
	if order[1] != "binary" {
		t.Fatalf("second frame = %q, want binary replay frame -- got %v", order[1], order)
	}
}
