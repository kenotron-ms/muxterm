package cos

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// What the clear op must do on the wire between muxterm and its sidecar.
//
// THE PROPERTY UNDER TEST IS HONESTY. The browser drops its rendered
// conversation the moment cos-clear-result says ok:true, so anything that
// turns a refusal into a success produces exactly the failure this whole path
// exists to prevent: an empty view over an agent that remembers everything.
// Supervisor.Clear is the last place that distinction can be lost, because it
// is where the sidecar's reply becomes a Go (removed, kept, error).
//
// These tests drive a SCRIPTED sidecar rather than the real one: the real
// sidecar needs a live amplifier session, and what is checked here is the
// protocol contract, not the prune. The prune itself -- including the part
// that actually makes the agent forget -- is covered by sidecar/clear_test.py,
// which drives the real _handle_clear (see sidecar_clear_test.go).

// fakeSidecar writes a python script that speaks the NDJSON protocol and
// answers a clear op with `reply`, a python dict literal.
//
// echoReqID decides whether the reply carries the req_id it is answering. A
// modern sidecar always does; false reproduces one that predates the op and
// answers unknown_op with no correlation at all.
func fakeSidecar(t *testing.T, reply string, echoReqID bool) string {
	t.Helper()
	script := filepath.Join(t.TempDir(), "fake_sidecar.py")
	body := `import json, sys

def emit(**ev):
    sys.stdout.write(json.dumps(ev) + "\n")
    sys.stdout.flush()

# --session-id / --log-level / --bundle arrive as flags; none of them matter to
# a scripted sidecar, so they are ignored.
emit(ev="ready", session_id="fake", bundle="fake", tools=0, boot_ms=1)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    op = msg.get("op")
    if op == "ping":
        emit(ev="pong")
    elif op == "clear":
        # Echoed to stderr so a test can assert the op's SHAPE, not just how
        # its reply was handled. The supervisor forwards every stderr line to
        # Config.Logf.
        sys.stderr.write("CLEAR_OP " + json.dumps(msg) + "\n")
        sys.stderr.flush()
        reply = __REPLY__
        if __ECHO__:
            reply["req_id"] = msg.get("req_id")
        emit(**reply)
    elif op == "shutdown":
        break
`
	body = strings.Replace(body, "__REPLY__", reply, 1)
	body = strings.Replace(body, "__ECHO__", map[bool]string{true: "True", false: "False"}[echoReqID], 1)
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatalf("write fake sidecar: %v", err)
	}
	return script
}

// startFake boots a supervisor against a scripted sidecar and returns it
// ready, plus a reader for everything the sidecar logged.
func startFake(t *testing.T, reply string, echoReqID bool) (*Supervisor, func() []string) {
	t.Helper()
	return startScript(t, fakeSidecar(t, reply, echoReqID))
}

func startScript(t *testing.T, script string) (*Supervisor, func() []string) {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available; the cos sidecar protocol needs an interpreter")
	}

	var mu sync.Mutex
	var lines []string
	logf := func(format string, v ...any) {
		mu.Lock()
		lines = append(lines, strings.TrimSpace(fmt.Sprintf(format, v...)))
		mu.Unlock()
	}

	sup := New(Config{
		SessionID: "test-cos",
		Python:    python,
		Script:    script,
		// "-" keeps the status file out of the real muxterm state directory:
		// a test must never write where a running daemon reads.
		StatePath: "-",
		Logf:      logf,
	})
	if err := sup.Start(context.Background()); err != nil {
		t.Fatalf("start supervisor: %v", err)
	}
	t.Cleanup(func() { _ = sup.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := sup.WaitReady(ctx); err != nil {
		t.Fatalf("sidecar never became ready: %v", err)
	}
	return sup, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), lines...)
	}
}

// TestClear_SuccessCarriesTheCounts is the baseline: a sidecar that says it
// cleared is reported as a clear, with the numbers the browser is shown.
func TestClear_SuccessCarriesTheCounts(t *testing.T) {
	sup, _ := startFake(t, `{"ev": "cleared", "removed": 12, "kept": 3, "reloaded": True}`, true)

	removed, kept, err := sup.Clear(0)
	if err != nil {
		t.Fatalf("Clear: %v", err)
	}
	if removed != 12 || kept != 3 {
		t.Fatalf("counts = (%d, %d), want (12, 3)", removed, kept)
	}
}

// TestClear_AllIsSentAsZeroNotOmitted guards the op's shape.
//
// older_than_days is a POINTER on the op struct precisely so that "clear
// everything" (0) is transmitted rather than dropped by omitempty. A sidecar
// that receives no cut-off falls back to 0 today, so losing this would not
// break loudly -- it would break the day that default changes, which is
// exactly the kind of silent divergence this file exists to prevent.
func TestClear_AllIsSentAsZeroNotOmitted(t *testing.T) {
	sup, logged := startFake(t, `{"ev": "cleared", "removed": 1, "kept": 0, "reloaded": True}`, true)

	if _, _, err := sup.Clear(0); err != nil {
		t.Fatalf("Clear: %v", err)
	}

	// stdout and stderr are drained by separate goroutines, so the reply that
	// released Clear can beat the echo here. Poll rather than assume an
	// ordering the protocol does not promise.
	var seen string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		for _, line := range logged() {
			if i := strings.Index(line, "CLEAR_OP "); i >= 0 {
				seen = line[i+len("CLEAR_OP "):]
			}
		}
		if seen != "" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if seen == "" {
		t.Fatal("the sidecar never received a clear op")
	}
	var op map[string]any
	if err := json.Unmarshal([]byte(seen), &op); err != nil {
		t.Fatalf("clear op is not JSON (%q): %v", seen, err)
	}
	days, ok := op["older_than_days"]
	if !ok {
		t.Fatalf("clear op omitted older_than_days entirely: %s", seen)
	}
	if days != float64(0) {
		t.Fatalf("older_than_days = %v, want 0 (clear everything)", days)
	}
	if id, _ := op["req_id"].(string); id == "" {
		t.Fatalf("clear op carried no req_id, so no reply could be correlated: %s", seen)
	}
}

// TestClear_RefusalIsNeverReportedAsSuccess is the important one.
//
// This is the mid-turn refusal as it arrives on the wire. If it came back as a
// nil error, internal/server/cos.go would answer ok:true, the browser would
// throw away its transcript, and the chief of staff would still be holding
// every message the human just watched disappear -- the exact split between
// displayed state and real state that the refusal exists to avoid.
func TestClear_RefusalIsNeverReportedAsSuccess(t *testing.T) {
	sup, _ := startFake(t, `{"ev": "error", "code": "clear_failed", "fatal": False,
         "message": "turn t-42 is still running; clearing now would race it"}`, true)

	removed, kept, err := sup.Clear(0)
	if err == nil {
		t.Fatal("a refused clear came back as a success")
	}
	if !strings.Contains(err.Error(), "t-42") {
		t.Fatalf("the refusal lost its reason: %v", err)
	}
	if removed != 0 || kept != 0 {
		t.Fatalf("a refusal reported counts (%d, %d); nothing was pruned", removed, kept)
	}
}

// TestClear_PartialIsAFailureThatStillCarriesItsNumbers.
//
// clear_partial means the disk WAS pruned and the live session was not: the
// one state where the display and the agent genuinely disagree. It must fail,
// so the browser keeps showing the conversation the agent still has, and it
// must carry its counts, so the human is told what did happen on disk.
func TestClear_PartialIsAFailureThatStillCarriesItsNumbers(t *testing.T) {
	sup, _ := startFake(t, `{"ev": "error", "code": "clear_partial", "fatal": False,
         "removed": 9, "kept": 1, "reloaded": False,
         "message": "the transcript on disk was pruned but this session's live memory was NOT"}`, true)

	removed, kept, err := sup.Clear(0)
	if err == nil {
		t.Fatal("clear_partial was reported as a completed clear")
	}
	if removed != 9 || kept != 1 {
		t.Fatalf("counts = (%d, %d), want (9, 1): the partial state must travel", removed, kept)
	}
}

// TestClear_UnsupportedIsAFailure. A session whose context cannot be replaced
// refuses before writing anything; the caller must see that, not a clear.
func TestClear_UnsupportedIsAFailure(t *testing.T) {
	sup, _ := startFake(t, `{"ev": "error", "code": "clear_unsupported", "fatal": False,
         "message": "this session cannot forget anything"}`, true)

	if _, _, err := sup.Clear(0); err == nil {
		t.Fatal("clear_unsupported was reported as a completed clear")
	}
}

// TestClear_OldSidecarDoesNotHangTheConfirmDialog.
//
// A sidecar built before the clear op answers unknown_op with NO req_id, so
// nothing correlates it to the waiting caller and the browser's confirm dialog
// would spin until the request timeout. handleEvent resolves every outstanding
// request on that event instead; this proves it, quickly.
func TestClear_OldSidecarDoesNotHangTheConfirmDialog(t *testing.T) {
	sup, _ := startFake(t, `{"ev": "error", "code": "unknown_op", "fatal": False,
         "message": "unknown op 'clear'"}`, false)

	done := make(chan error, 1)
	go func() {
		_, _, err := sup.Clear(0)
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("unknown_op was reported as a completed clear")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("Clear hung on a sidecar that does not support the op")
	}
}

// TestClear_NegativeCutOffIsRefusedBeforeItIsSent. Nothing reaches the sidecar,
// so there is no window in which a nonsense cut-off could prune anything.
func TestClear_NegativeCutOffIsRefusedBeforeItIsSent(t *testing.T) {
	sup, logged := startFake(t, `{"ev": "cleared", "removed": 99, "kept": 0, "reloaded": True}`, true)

	if _, _, err := sup.Clear(-1); err == nil {
		t.Fatal("a negative cut-off was accepted")
	}

	// A legal clear behind it is the positive control: once ITS echo has been
	// logged, anything the sidecar received earlier has been logged too, so
	// "exactly one clear op, and it is the legal one" is a real assertion
	// rather than a race with the stderr drain.
	if _, _, err := sup.Clear(7); err != nil {
		t.Fatalf("Clear(7): %v", err)
	}
	var ops []string
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		ops = ops[:0]
		for _, line := range logged() {
			if i := strings.Index(line, "CLEAR_OP "); i >= 0 {
				ops = append(ops, line[i+len("CLEAR_OP "):])
			}
		}
		if len(ops) > 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(ops) != 1 {
		t.Fatalf("the sidecar saw %d clear ops, want 1 (the refused one must never be sent): %v", len(ops), ops)
	}
	var op map[string]any
	if err := json.Unmarshal([]byte(ops[0]), &op); err != nil {
		t.Fatalf("clear op is not JSON (%q): %v", ops[0], err)
	}
	if op["older_than_days"] != float64(7) {
		t.Fatalf("the op that reached the sidecar was not the legal one: %s", ops[0])
	}
}

// TestClear_SidecarDeathFailsTheCallerImmediately.
//
// A clear whose sidecar dies mid-request must fail, not time out: the human is
// sitting in front of a confirm dialog waiting to be told what happened.
func TestClear_SidecarDeathFailsTheCallerImmediately(t *testing.T) {
	script := filepath.Join(t.TempDir(), "dying_sidecar.py")
	body := `import json, sys, os
sys.stdout.write(json.dumps({"ev": "ready", "session_id": "fake", "bundle": "fake"}) + "\n")
sys.stdout.flush()
for line in sys.stdin:
    if not line.strip():
        continue
    if json.loads(line).get("op") == "clear":
        os._exit(1)
`
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		t.Fatalf("write script: %v", err)
	}
	sup, _ := startScript(t, script)

	done := make(chan error, 1)
	go func() {
		_, _, err := sup.Clear(0)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a clear whose sidecar died was reported as a success")
		}
	case <-time.After(30 * time.Second):
		t.Fatal("Clear did not fail when the sidecar died under it")
	}
}
