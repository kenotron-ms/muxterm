package sessiond

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// startTestServer creates a Server bound to a Unix socket under a fresh short
// temp directory and runs ListenAndServe on a cancellable context in a
// goroutine. It returns the server, the socket path, a channel delivering the
// eventual ListenAndServe error, and the cancel func. It blocks until sessiond
// serves a non-empty workspace list.
func startTestServer(t *testing.T) (srv *Server, socketPath string, errCh <-chan error, cancel context.CancelFunc) {
	t.Helper()
	// testing.T.TempDir includes the test name, which can exceed Darwin's Unix
	// socket path limit. MkdirTemp keeps the owner-unique fixture root short.
	root, err := os.MkdirTemp("", "mxt-")
	if err != nil {
		t.Fatalf("create server temp root: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Errorf("remove server temp root: %v", err)
		}
	})

	// Nest the socket inside a subdir so MkdirAll/Chmod 0700 is exercised and
	// the permissions test can observe the parent directory mode.
	socketPath = filepath.Join(root, "run", "sessiond.sock")
	srv, err = NewServer(socketPath)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ec := make(chan error, 1)
	go func() { ec <- srv.ListenAndServe(ctx) }()
	waitForSocket(t, socketPath)
	return srv, socketPath, ec, cancel
}

var errReadinessEmptyWorkspaceList = errors.New("matching workspace-list was empty")

// waitForSocket is shared by test fixtures and waits until sessiond accepts
// and serves a non-empty workspace list or the existing startup deadline
// elapses.
func waitForSocket(t *testing.T, socketPath string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	lastErr := errors.New("no readiness probe attempted")
	for time.Now().Before(deadline) {
		err := probeServerReady(socketPath, deadline)
		if err == nil {
			return
		}
		if !isTransientReadinessError(err) {
			t.Fatalf("sessiond readiness probe failed: %v", err)
		}
		lastErr = err
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("sessiond readiness timed out after 5s waiting for a non-empty workspace-list from %s (last failure: %v)", socketPath, lastErr)
}

// probeServerReady opens a short-lived client connection and verifies that the
// server responds to a correlated workspace-list request.
func probeServerReady(socketPath string, deadline time.Time) error {
	const readinessProbeCID uint64 = 1

	conn, err := net.DialTimeout("unix", socketPath, time.Until(deadline))
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	if err := conn.SetDeadline(deadline); err != nil {
		return fmt.Errorf("set deadline: %w", err)
	}
	if err := WriteControl(conn, &Message{Type: TypeListWorkspaces, CID: readinessProbeCID}); err != nil {
		return fmt.Errorf("write list-workspaces: %w", err)
	}
	for {
		kind, payload, err := ReadFrame(conn)
		if err != nil {
			return fmt.Errorf("read frame: %w", err)
		}
		if kind != FrameControl {
			continue
		}
		var msg Message
		if err := json.Unmarshal(payload, &msg); err != nil {
			return fmt.Errorf("decode control frame: %w", err)
		}
		if msg.Type != TypeWorkspaceList || msg.CID != readinessProbeCID {
			continue
		}
		if len(msg.Workspaces) == 0 {
			return errReadinessEmptyWorkspaceList
		}
		return nil
	}
}

// isTransientReadinessError identifies failures that can occur before
// ListenAndServe has begun accepting or serving client requests.
func isTransientReadinessError(err error) bool {
	return errors.Is(err, errReadinessEmptyWorkspaceList) ||
		errors.Is(err, os.ErrNotExist) ||
		errors.Is(err, os.ErrDeadlineExceeded) ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, syscall.ECONNREFUSED) ||
		errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EPIPE)
}

// dialMust dials the Unix socket and registers a cleanup that closes it.
func dialMust(t *testing.T, socketPath string) net.Conn {
	t.Helper()
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		t.Fatalf("dial %s: %v", socketPath, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// readControlUntil reads frames from conn until a control message whose Type
// equals wantType is seen, returning it. Non-matching control frames and all
// pane-data frames are skipped. It fails the test on timeout or read error.
func readControlUntil(t *testing.T, conn net.Conn, wantType string) *Message {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		kind, payload, err := ReadFrame(conn)
		if err != nil {
			t.Fatalf("read frame waiting for %q: %v", wantType, err)
		}
		if kind != FrameControl {
			continue
		}
		var msg Message
		if err := json.Unmarshal(payload, &msg); err != nil {
			t.Fatalf("decode control frame: %v", err)
		}
		if msg.Type == wantType {
			return &msg
		}
	}
}

func writeControlMust(t *testing.T, conn net.Conn, msg *Message) {
	t.Helper()
	if err := WriteControl(conn, msg); err != nil {
		t.Fatalf("write control %q: %v", msg.Type, err)
	}
}

func TestServerGracefulShutdownReturnsNil(t *testing.T) {
	_, _, errCh, cancel := startTestServer(t)
	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("ListenAndServe returned %v, want nil on cancel", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("ListenAndServe did not return after cancel")
	}
}

func TestServerSocketPermissions(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	si, err := os.Stat(socketPath)
	if err != nil {
		t.Fatalf("stat socket: %v", err)
	}
	if perm := si.Mode().Perm(); perm != 0o600 {
		t.Fatalf("socket perm = %o, want 0600", perm)
	}

	di, err := os.Stat(filepath.Dir(socketPath))
	if err != nil {
		t.Fatalf("stat socket dir: %v", err)
	}
	if perm := di.Mode().Perm(); perm != 0o700 {
		t.Fatalf("socket dir perm = %o, want 0700", perm)
	}
}

func TestServerColdStartCreatesDefault(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()

	list := srv.Registry().List()
	if len(list) != 1 {
		t.Fatalf("cold start produced %d workspaces, want exactly 1", len(list))
	}
	if list[0].Name != "" {
		t.Fatalf("cold-start workspace name = %q, want unnamed", list[0].Name)
	}
}

func TestServerEchoesCID(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	conn := dialMust(t, socketPath)
	writeControlMust(t, conn, &Message{Type: TypeCreateWorkspace, CID: 99, Name: "dev"})

	reply := readControlUntil(t, conn, TypeWorkspaceCreated)
	if reply.CID != 99 {
		t.Fatalf("reply CID = %d, want 99", reply.CID)
	}
	if reply.WorkspaceID == "" {
		t.Fatal("reply WorkspaceID is empty")
	}
	if reply.Name != "dev" {
		t.Fatalf("reply Name = %q, want dev", reply.Name)
	}
}

func TestServerAttachRepliesComposition(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	wsID := srv.Registry().List()[0].WorkspaceID

	conn := dialMust(t, socketPath)
	writeControlMust(t, conn, &Message{Type: TypeAttach, CID: 7, WorkspaceID: wsID})

	reply := readControlUntil(t, conn, TypeComposition)
	if reply.CID != 7 {
		t.Fatalf("composition CID = %d, want 7", reply.CID)
	}
	if reply.WorkspaceID != wsID {
		t.Fatalf("composition WorkspaceID = %q, want %q", reply.WorkspaceID, wsID)
	}
	if len(reply.Panes) != 0 {
		t.Fatalf("composition Panes = %d, want 0 for empty workspace", len(reply.Panes))
	}
}

// TestReattachUnsubscribesFromPriorWorkspace proves that a connection which
// attaches to ws1 and then re-attaches to ws2 stops receiving ws1's pane
// output. Without unsubscribing on re-attach the conn stays in BOTH workspaces'
// subscriber sets and keeps leaking the prior workspace's traffic after a
// switch.
func TestReattachUnsubscribesFromPriorWorkspace(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Client A owns ws1 (with a live `cat` pane) and also creates ws2.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "ws1"})
	ws1 := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeCreateWorkspace, CID: 2, Name: "ws2"})
	ws2 := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID

	a.send(&Message{Type: TypeAttach, CID: 3, WorkspaceID: ws1})
	a.waitCtrl(TypeComposition)
	a.send(&Message{Type: TypeCreatePane, CID: 4, Cmd: []string{"cat"}})
	ws1Pane := a.waitCtrl(TypePaneCreated).PaneID
	a.waitCtrl(TypePaneAdded)

	// Client B attaches ws1 first, then RE-ATTACHES to ws2 with the SAME conn.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 10, WorkspaceID: ws1})
	b.waitCtrl(TypeComposition)
	b.send(&Message{Type: TypeAttach, CID: 11, WorkspaceID: ws2})
	b.waitCtrl(TypeComposition)

	// B spins up its own live pane in ws2 so it can drive ws2 traffic itself.
	b.send(&Message{Type: TypeCreatePane, CID: 12, Cmd: []string{"cat"}})
	ws2Pane := b.waitCtrl(TypePaneCreated).PaneID
	b.waitCtrl(TypePaneAdded)

	// Produce output on a ws1 pane. broadcastPaneData enqueues to every ws1
	// subscriber synchronously under the server lock, so once A (still on ws1)
	// observes the line, any conn still subscribed to ws1 has ALREADY had the
	// frame enqueued ahead of whatever it enqueues next.
	a.sendInput(ws1Pane, []byte("ws1-leak\n"))
	a.waitData("ws1-leak")

	// Now drive ws2 traffic to B. By FIFO queue order, a leaked ws1 frame (if
	// B were still subscribed) would arrive strictly BEFORE this marker.
	b.sendInput(ws2Pane, []byte("ws2-only\n"))
	acc := b.waitData("ws2-only")

	if bytes.Contains(acc, []byte("ws1-leak")) {
		t.Fatalf("re-attached conn leaked ws1 output after switching to ws2: %q", acc)
	}
}

func TestServerAttachUnknownWorkspaceErrors(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	conn := dialMust(t, socketPath)
	writeControlMust(t, conn, &Message{Type: TypeAttach, CID: 42, WorkspaceID: "does-not-exist"})

	reply := readControlUntil(t, conn, TypeError)
	if reply.CID != 42 {
		t.Fatalf("error CID = %d, want 42", reply.CID)
	}
	if reply.Code != CodeUnknownWorkspace {
		t.Fatalf("error Code = %q, want %q", reply.Code, CodeUnknownWorkspace)
	}

	// Recovery: list-workspaces still shows the cold-start default.
	writeControlMust(t, conn, &Message{Type: TypeListWorkspaces, CID: 43})
	list := readControlUntil(t, conn, TypeWorkspaceList)
	if list.CID != 43 {
		t.Fatalf("list CID = %d, want 43", list.CID)
	}
	if len(list.Workspaces) == 0 {
		t.Fatal("list-workspaces returned no workspaces after error")
	}
	_ = srv
}
