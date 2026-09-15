package server

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/kenotron-ms/muxterm/internal/cos"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/transport"
)

// Clearing the conversation, from the serve side.
//
// Two properties are load-bearing here and neither was covered by a test:
//
//   - EVERY TAB CONVERGES. cos-clear-result goes only to the browser that
//     asked; a second tab left rendering the old conversation would recreate
//     the exact mismatch -- a display that disagrees with the agent -- that
//     the clear is for. The post-clear replay is broadcast for that reason.
//
//   - RUNNING LANES SURVIVE. The chief of staff spawns lanes that run for many
//     minutes in other workspaces. Clearing a CONVERSATION must not terminate,
//     orphan or detach any of them. The confirm dialog promises this in so
//     many words ("Running lanes are unaffected -- no session is stopped,
//     closed or altered"), so it needs a test, not a comment.

// --- doubles ---------------------------------------------------------------

// recordingClient is a Client whose frames are captured instead of written to
// a socket, subscribed to the chief of staff the way cos-subscribe leaves it.
type recordingClient struct {
	*Client
	mu     sync.Mutex
	frames [][]byte
}

func newRecordingClient(t *testing.T, h *Hub, broker *cos.Broker, subscribed bool) *recordingClient {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	rc := &recordingClient{Client: &Client{hub: h, ctx: ctx, cancel: cancel}}
	rc.writeTextFn = func(data []byte) error {
		rc.mu.Lock()
		defer rc.mu.Unlock()
		rc.frames = append(rc.frames, append([]byte(nil), data...))
		return nil
	}
	rc.writeBinaryFn = func([]byte) error { return nil }
	if subscribed {
		// cosSub is what cosSubscribed() reads; a real subscription from a
		// real broker keeps this honest rather than poking a bool.
		rc.cosMu.Lock()
		rc.cosSub = broker.Subscribe(8)
		rc.cosMu.Unlock()
	}

	h.mu.Lock()
	h.clients[rc.Client] = true
	h.mu.Unlock()
	t.Cleanup(func() {
		h.mu.Lock()
		delete(h.clients, rc.Client)
		h.mu.Unlock()
	})
	return rc
}

func (rc *recordingClient) typed(kind string) []map[string]any {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	var out []map[string]any
	for _, raw := range rc.frames {
		var frame map[string]any
		if json.Unmarshal(raw, &frame) != nil {
			continue
		}
		if frame["type"] == kind {
			out = append(out, frame)
		}
	}
	return out
}

// fakeCosSidecar writes a scripted sidecar that answers clear with `reply` and
// history with one turn, so the whole cosRunClear path can run for real.
func fakeCosSidecar(t *testing.T, reply string) string {
	t.Helper()
	script := filepath.Join(t.TempDir(), "fake_sidecar.py")
	body := `import json, sys

def emit(**ev):
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()

emit(ev="ready", session_id="fake", bundle="fake", tools=0, boot_ms=1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    op = msg.get("op")
    if op == "clear":
        reply = __REPLY__
        reply["req_id"] = msg.get("req_id")
        emit(**reply)
    elif op == "history":
        emit(ev="history", req_id=msg.get("req_id"),
             turns=[{"id": "t-kept", "prompt": "what survived", "ts": "2026-01-01T00:00:00Z", "blocks": []}])
    elif op == "ping":
        emit(ev="pong")
    elif op == "shutdown":
        break
`
	body = strings.Replace(body, "__REPLY__", reply, 1)
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatalf("write fake sidecar: %v", err)
	}
	return script
}

// hubWithFakeCos wires a hub to a scripted sidecar and returns the broker its
// clients subscribe to.
func hubWithFakeCos(t *testing.T, reply string) (*Hub, *cos.Broker) {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available; the chief-of-staff sidecar needs an interpreter")
	}

	h := NewHub(nil)
	h.cos = &cosRelay{
		cfg: cos.Config{
			SessionID: "test-cos",
			Python:    python,
			Script:    fakeCosSidecar(t, reply),
			// Never the real state file: a test must not write where the
			// running daemon reads.
			StatePath: "-",
			Logf:      func(string, ...any) {},
		},
		subs: make(map[string]cosSubmission),
	}
	t.Cleanup(func() { h.cos.close() })
	return h, cos.NewBroker()
}

// --- multiple browsers -----------------------------------------------------

// TestCosClear_EveryOpenTabConvergesOnTheClearedState.
//
// The tab that clicked gets cos-clear-result and drops its transcript; every
// other subscribed tab is still rendering the old conversation and would keep
// rendering it forever, because nothing else pushes a replay until the next
// subscribe. The broadcast is what makes them agree.
func TestCosClear_EveryOpenTabConvergesOnTheClearedState(t *testing.T) {
	h, broker := hubWithFakeCos(t, `{"ev": "cleared", "removed": 4, "kept": 1, "reloaded": True}`)

	asked := newRecordingClient(t, h, broker, true)
	other := newRecordingClient(t, h, broker, true)
	unsubscribed := newRecordingClient(t, h, broker, false)

	asked.cosRunClear(h.cos, 0)

	results := asked.typed("cos-clear-result")
	if len(results) != 1 {
		t.Fatalf("the tab that asked got %d clear results, want 1", len(results))
	}
	if results[0]["ok"] != true {
		t.Fatalf("clear reported not-ok: %v", results[0])
	}
	if len(other.typed("cos-clear-result")) != 0 {
		t.Fatal("a clear result was sent to a tab that did not ask for one")
	}

	// Both subscribed tabs must receive the authoritative post-clear replay.
	for name, c := range map[string]*recordingClient{"asker": asked, "other tab": other} {
		history := c.typed("cos-history")
		if len(history) != 1 {
			t.Fatalf("%s got %d history frames after a clear, want 1", name, len(history))
		}
		if history[0]["reason"] != "clear" {
			t.Fatalf("%s got reason %q, want \"clear\" (a subscribe replay is not authoritative and the "+
				"browser keeps its local turns for one)", name, history[0]["reason"])
		}
	}
	if len(unsubscribed.typed("cos-history")) != 0 {
		t.Fatal("a replay was pushed to a connection that never subscribed to the chief of staff")
	}
}

// TestCosClear_RefusalTellsOnlyTheAskerAndWipesNoView.
//
// A refused clear (mid-turn, most often) must not look like a clear anywhere:
// the asker is told why, and no tab -- including the asker's -- is sent a
// replay it would treat as authoritative and reconcile its transcript against.
func TestCosClear_RefusalTellsOnlyTheAskerAndWipesNoView(t *testing.T) {
	h, broker := hubWithFakeCos(t, `{"ev": "error", "code": "clear_failed", "fatal": False,
         "message": "turn t-42 is still running; clearing now would race it"}`)

	asked := newRecordingClient(t, h, broker, true)
	other := newRecordingClient(t, h, broker, true)

	asked.cosRunClear(h.cos, 0)

	results := asked.typed("cos-clear-result")
	if len(results) != 1 {
		t.Fatalf("the asker got %d clear results, want 1: a confirm dialog is waiting on it", len(results))
	}
	if results[0]["ok"] != false {
		t.Fatalf("a refused clear was reported as ok: %v", results[0])
	}
	msg, _ := results[0]["error"].(string)
	if !strings.Contains(msg, "t-42") {
		t.Fatalf("the refusal reached the browser without its reason: %q", msg)
	}
	for name, c := range map[string]*recordingClient{"asker": asked, "other tab": other} {
		if n := len(c.typed("cos-history")); n != 0 {
			t.Fatalf("%s was sent %d replays after a clear that never happened", name, n)
		}
	}
}

// --- running lanes ---------------------------------------------------------

// TestCosClear_RunningLaneSurvives is the safety property of the whole change.
//
// A lane is two things at once: a live process doing work, and an entry in the
// session-state roster muxterm keeps under XDG_RUNTIME_DIR. A clear that
// killed the first would destroy minutes of work; one that disturbed the
// second would orphan the lane -- it would still be running but muxterm would
// no longer believe in it, which is worse, because nothing would ever be
// reconciled again.
//
// So a real child process stands in for the lane, with a real roster entry,
// and both are checked after a full clear has run end to end.
func TestCosClear_RunningLaneSurvives(t *testing.T) {
	h, broker := hubWithFakeCos(t, `{"ev": "cleared", "removed": 4, "kept": 0, "reloaded": True}`)

	// A real lane process. sleep is the honest stand-in: what matters is that
	// something the chief of staff started is still executing afterwards.
	lane := exec.Command("sleep", "120")
	if err := lane.Start(); err != nil {
		t.Fatalf("start stand-in lane: %v", err)
	}
	defer func() {
		_ = lane.Process.Kill()
		_ = lane.Wait()
	}()

	// ...and its roster entry, written where muxterm writes them. The sidecar
	// is spawned with this process's environment, so pointing XDG_RUNTIME_DIR
	// at a temp dir does two things: it keeps the test off the real roster a
	// running daemon owns, and it means the roster checked below is the one
	// the clear path would actually have reached.
	runtimeDir := t.TempDir()
	t.Setenv("XDG_RUNTIME_DIR", runtimeDir)
	roster := filepath.Join(runtimeDir, "muxterm", "session-state")
	if err := os.MkdirAll(roster, 0o700); err != nil {
		t.Fatalf("make roster: %v", err)
	}
	laneID := "9f8e7d6c-5b4a-4938-8271-6f5e4d3c2b1a"
	entry := filepath.Join(roster, laneID+".json")
	if err := os.WriteFile(entry, []byte(`{"sessionId":"`+laneID+`","state":"working"}`), 0o600); err != nil {
		t.Fatalf("write roster entry: %v", err)
	}
	before, err := os.ReadFile(entry)
	if err != nil {
		t.Fatalf("read roster entry: %v", err)
	}
	beforeStat, err := os.Stat(entry)
	if err != nil {
		t.Fatalf("stat roster entry: %v", err)
	}

	// A daemon connection that fails the test if the clear path touches a
	// session at all. Closing a pane, killing a session or detaching a
	// workspace all travel through here, so "no calls" is the assertion.
	guard := &laneGuardDaemon{t: t}
	client := newRecordingClient(t, h, broker, true)
	client.adoptSession(transport.HostRef{}, guard)

	client.cosRunClear(h.cos, 0)

	results := client.typed("cos-clear-result")
	if len(results) != 1 || results[0]["ok"] != true {
		t.Fatalf("the clear under test did not run: %v", results)
	}

	// 1. The lane process is still executing.
	if err := lane.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("the lane process did not survive the clear: %v", err)
	}
	var status syscall.WaitStatus
	pid, err := syscall.Wait4(lane.Process.Pid, &status, syscall.WNOHANG, nil)
	if err == nil && pid == lane.Process.Pid {
		t.Fatal("the lane process exited during the clear")
	}

	// 2. Its roster entry is byte-for-byte where it was, so muxterm still
	//    believes in it: not removed, not rewritten, not even touched.
	after, err := os.ReadFile(entry)
	if err != nil {
		t.Fatalf("the clear removed the lane's session-state file: %v", err)
	}
	if string(after) != string(before) {
		t.Fatalf("the clear rewrote the lane's session-state file:\n before: %s\n after:  %s", before, after)
	}
	afterStat, err := os.Stat(entry)
	if err != nil {
		t.Fatalf("stat roster entry after clear: %v", err)
	}
	if !afterStat.ModTime().Equal(beforeStat.ModTime()) {
		t.Fatal("the clear touched the lane's session-state file")
	}

	// 3. Nothing in the clear path spoke to the session daemon at all, which
	//    is what rules out a cascade nobody thought to assert on.
	if n := guard.calls(); n != 0 {
		t.Fatalf("the clear made %d session-daemon call(s): %v", n, guard.names())
	}
}

// laneGuardDaemon is a DaemonConn that records every call made to it. The clear
// path must make none: a conversation prune has no business closing a pane,
// killing a session or detaching a workspace.
type laneGuardDaemon struct {
	fakeDaemonConn
	t   *testing.T
	mu  sync.Mutex
	log []string
}

func (d *laneGuardDaemon) note(name string) {
	d.mu.Lock()
	d.log = append(d.log, name)
	d.mu.Unlock()
}

func (d *laneGuardDaemon) calls() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.log)
}

func (d *laneGuardDaemon) names() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.log...)
}

func (d *laneGuardDaemon) ClosePane(paneID int) error {
	d.note("ClosePane")
	return d.fakeDaemonConn.ClosePane(paneID)
}

func (d *laneGuardDaemon) CloseWorkspace(workspaceID string) error {
	d.note("CloseWorkspace")
	return d.fakeDaemonConn.CloseWorkspace(workspaceID)
}

func (d *laneGuardDaemon) CloseIntent(target sessiond.CloseTarget) (sessiond.CloseOutcome, error) {
	d.note("CloseIntent")
	return d.fakeDaemonConn.CloseIntent(target)
}

func (d *laneGuardDaemon) CloseConfirm(ticket string) (sessiond.CloseOutcome, error) {
	d.note("CloseConfirm")
	return d.fakeDaemonConn.CloseConfirm(ticket)
}

func (d *laneGuardDaemon) Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error) {
	d.note("Attach")
	return d.fakeDaemonConn.Attach(workspaceID, breakpoint, clientKind)
}

func (d *laneGuardDaemon) Input(paneID uint32, data []byte) error {
	d.note("Input")
	return d.fakeDaemonConn.Input(paneID, data)
}

func (d *laneGuardDaemon) Close() error {
	d.note("Close")
	return d.fakeDaemonConn.Close()
}

// TestCosClear_MidTurnLeavesTheTurnRunning.
//
// The refusal is only half the mid-turn contract. The other half is that the
// turn the human is waiting on keeps going: a clear that aborted it would
// silently throw away work in exchange for a button press the sidecar had
// already declined to honour.
func TestCosClear_MidTurnLeavesTheTurnRunning(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}

	// A sidecar with a genuinely slow turn, which refuses a clear while that
	// turn is in flight -- exactly what internal/cos/sidecar/main.py does.
	script := filepath.Join(t.TempDir(), "busy_sidecar.py")
	body := `import json, sys, threading, time

lock = threading.Lock()
active = {"turn": None}

def emit(**ev):
    with lock:
        sys.stdout.write(json.dumps(ev) + "\n")
        sys.stdout.flush()

def run_turn(turn_id):
    emit(ev="turn_start", turn_id=turn_id)
    time.sleep(1.5)
    active["turn"] = None
    emit(ev="turn_end", turn_id=turn_id, response="finished anyway", ms=1500)

emit(ev="ready", session_id="fake", bundle="fake", tools=0, boot_ms=1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    op = msg.get("op")
    if op == "turn":
        active["turn"] = msg.get("turn_id")
        threading.Thread(target=run_turn, args=(msg.get("turn_id"),), daemon=True).start()
    elif op == "clear":
        if active["turn"]:
            emit(ev="error", req_id=msg.get("req_id"), code="clear_failed", fatal=False,
                 message="turn %s is still running; clearing now would race it" % active["turn"])
        else:
            emit(ev="cleared", req_id=msg.get("req_id"), removed=0, kept=0, reloaded=True)
    elif op == "shutdown":
        break
`
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatalf("write busy sidecar: %v", err)
	}

	h := NewHub(nil)
	h.cos = &cosRelay{
		cfg:  cos.Config{SessionID: "test-cos", Python: python, Script: script, StatePath: "-", Logf: func(string, ...any) {}},
		subs: make(map[string]cosSubmission),
	}
	t.Cleanup(func() { h.cos.close() })
	broker := cos.NewBroker()
	client := newRecordingClient(t, h, broker, true)

	sup, err := h.cos.get()
	if err != nil {
		t.Fatalf("start sidecar: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := sup.WaitReady(ctx); err != nil {
		t.Fatalf("sidecar never became ready: %v", err)
	}

	turn := h.cos.submit(sup, "a long question", "tab-1")

	// Clear, mid-turn, while that turn is demonstrably still in flight.
	client.cosRunClear(h.cos, 0)

	results := client.typed("cos-clear-result")
	if len(results) != 1 {
		t.Fatalf("got %d clear results, want 1", len(results))
	}
	if results[0]["ok"] != false {
		t.Fatalf("a mid-turn clear was accepted: %v", results[0])
	}
	if msg, _ := results[0]["error"].(string); !strings.Contains(msg, turn.ID) {
		t.Fatalf("the refusal did not name the turn that blocked it (%s): %q", turn.ID, msg)
	}

	// The turn survives the refusal and finishes on its own.
	select {
	case <-turn.Done():
	case <-time.After(30 * time.Second):
		t.Fatal("the turn never finished: a refused clear must leave it running, not abandon it")
	}
	ev, err := turn.Result()
	if err != nil {
		t.Fatalf("the turn failed after a refused clear: %v", err)
	}
	if ev.Response != "finished anyway" {
		t.Fatalf("turn response = %q, want the work to have completed untouched", ev.Response)
	}
}
