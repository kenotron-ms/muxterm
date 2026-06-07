package server

// ws_lifecycle_test.go exercises Hub lifecycle edge-cases that the relay tests
// don't cover: daemon connection drops, dial failures, and the distinction
// between expected teardown (net.ErrClosed) and unexpected daemon crashes.

import (
	"errors"
	"fmt"
	"net"
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

// ----------------------------------------------------------------------
// Test doubles
// ----------------------------------------------------------------------

// crashDaemonConn is a DaemonConn whose Run returns the given error immediately.
// All other methods delegate to a stock fakeDaemonConn.
type crashDaemonConn struct {
	*fakeDaemonConn
	runErr  error
	runDone chan struct{} // closed when Run has returned
}

func newCrashDaemon(err error) *crashDaemonConn {
	return &crashDaemonConn{
		fakeDaemonConn: &fakeDaemonConn{},
		runErr:         err,
		runDone:        make(chan struct{}),
	}
}

func (c *crashDaemonConn) Run() error {
	defer close(c.runDone)
	return c.runErr
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

// TestDaemonCrashRemovesClientFromHub verifies the fix for the "client never
// connects" bug: when dc.Run exits with an unexpected error (daemon crash, EOF,
// etc.) the Hub must remove the client so the browser can reconnect.
func TestDaemonCrashRemovesClientFromHub(t *testing.T) {
	dc := newCrashDaemon(fmt.Errorf("simulated daemon crash"))

	hub := newTestHub(dc)
	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)

	hub.Add(c)

	// Wait for the dc.Run goroutine to finish and h.Remove to execute.
	select {
	case <-dc.runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("dc.Run goroutine did not exit within timeout")
	}

	// Give hub.Remove a moment to complete after Run returns.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if hub.ClientCount() == 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	if hub.ClientCount() != 0 {
		t.Errorf("ClientCount() = %d after daemon crash, want 0 — client was not removed", hub.ClientCount())
	}
}

// TestNetErrClosedIsNormalTeardownNotACrash verifies that when dc.Run returns
// net.ErrClosed (the expected result when hub.Remove closes the connection
// during a normal browser disconnect), the goroutine does NOT call h.Remove a
// second time. The client count reflects what hub.Remove did separately; the
// goroutine itself exits silently.
func TestNetErrClosedIsNormalTeardownNotACrash(t *testing.T) {
	// Wrap net.ErrClosed in a *net.OpError, matching what Go's net package
	// actually returns: "read unix ...: use of closed network connection".
	opErr := &net.OpError{
		Op:  "read",
		Net: "unix",
		Err: net.ErrClosed,
	}
	dc := newCrashDaemon(opErr)

	hub := newTestHub(dc)
	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)

	hub.Add(c)

	// Wait for the dc.Run goroutine to finish.
	select {
	case <-dc.runDone:
	case <-time.After(2 * time.Second):
		t.Fatal("dc.Run goroutine did not exit within timeout")
	}

	// A brief pause to let any (buggy) async h.Remove() call run.
	time.Sleep(20 * time.Millisecond)

	// The client should still be in the hub — the goroutine must not have
	// removed it. Only a real readPump exit or explicit Hub.Remove call should
	// remove it. (In production this client was already removed by hub.Remove
	// before dc.Run returned net.ErrClosed; in this isolated test we just
	// verify the goroutine itself did not fire a redundant remove.)
	if hub.ClientCount() != 1 {
		t.Errorf("ClientCount() = %d after net.ErrClosed, want 1 — goroutine should NOT remove on normal teardown", hub.ClientCount())
	}
}

// TestDialFailureRemovesClientFromHub verifies that when attachClient fails
// (the daemon dial itself errors), Hub.Add removes the client immediately so
// the WebSocket is closed and the browser can reconnect rather than getting
// stuck in a no-daemon state.
func TestDialFailureRemovesClientFromHub(t *testing.T) {
	dialErr := errors.New("simulated dial failure: daemon not running")
	hub := NewHub(func() (DaemonConn, error) { return nil, dialErr })

	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)

	hub.Add(c) // attachClient returns error → hub.Remove should be called

	if hub.ClientCount() != 0 {
		t.Errorf("ClientCount() = %d after dial failure, want 0 — client should be removed on attach error", hub.ClientCount())
	}
}

// TestWorkspaceListSentOnAttach is a smoke-test that the happy path still
// works: a client attached to a healthy daemon receives a workspace-list
// message with the workspace the fake reports.
func TestWorkspaceListSentOnAttach(t *testing.T) {
	fake := &fakeDaemonConn{}
	hub := newTestHub(fake)
	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)

	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	msgs := cap.texts()
	if len(msgs) == 0 {
		t.Fatal("expected workspace-list message, got none")
	}
	wl, ok := firstOfType(msgs, sessiond.TypeWorkspaceList)
	if !ok {
		t.Fatalf("no workspace-list in %d messages", len(msgs))
	}
	if len(wl.Workspaces) == 0 || wl.Workspaces[0].WorkspaceID != "w1" {
		t.Errorf("workspace-list = %v, want [{w1 ...}]", wl.Workspaces)
	}
}
