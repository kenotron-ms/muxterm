package sessiond

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// startTestServer creates a Server bound to a Unix socket under a fresh temp
// directory and runs ListenAndServe on a cancellable context in a goroutine.
// It returns the server, the socket path, a channel delivering the eventual
// ListenAndServe error, and the cancel func. It blocks until the socket exists.
func startTestServer(t *testing.T) (srv *Server, socketPath string, errCh <-chan error, cancel context.CancelFunc) {
	t.Helper()
	// Nest the socket inside a subdir so MkdirAll/Chmod 0700 is exercised and
	// the permissions test can observe the parent directory mode.
	socketPath = filepath.Join(t.TempDir(), "run", "sessiond.sock")
	srv, err := NewServer(socketPath)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	ec := make(chan error, 1)
	go func() { ec <- srv.ListenAndServe(ctx) }()
	waitForSocket(t, socketPath)
	return srv, socketPath, ec, cancel
}

// waitForSocket polls until the socket path exists or the deadline elapses.
func waitForSocket(t *testing.T, socketPath string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(socketPath); err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("socket %s did not appear in time", socketPath)
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
