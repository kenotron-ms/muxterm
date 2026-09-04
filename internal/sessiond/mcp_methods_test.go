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

// startMCPTestServer is a copy of startTestServer that uses os.MkdirTemp("/tmp", ...)
// to avoid macOS's 104-byte Unix socket path limit, which t.TempDir() can exceed
// when the test name is long (e.g. TestClientOnShellPromptFires).
func startMCPTestServer(t *testing.T) (srv *Server, socketPath string, cancel context.CancelFunc) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "mux")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socketPath = filepath.Join(dir, "s.sock")
	srv, err = NewServer(socketPath)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go srv.ListenAndServe(ctx)
	waitForSocket(t, socketPath)
	return srv, socketPath, cancel
}

// TestClientScreenSnapshotAndGetLayout verifies that the ScreenSnapshot and
// GetLayout client wrapper methods correctly encode requests and decode replies.
// A fake daemon simulates TypeScreenSnapshotResult (with cursor) and
// TypeLayoutResult so the test runs without a real PTY.
func TestClientScreenSnapshotAndGetLayout(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			if kind != FrameControl {
				continue
			}
			var req Message
			if err := json.Unmarshal(payload, &req); err != nil {
				continue
			}
			switch req.Type {
			case TypeAttach:
				_ = WriteControl(conn, &Message{
					Type:        TypeComposition,
					CID:         req.CID,
					WorkspaceID: req.WorkspaceID,
				})
			case TypeCreatePane:
				_ = WriteControl(conn, &Message{
					Type:   TypePaneCreated,
					CID:    req.CID,
					PaneID: 1,
				})
			case TypeScreenSnapshot:
				_ = WriteControl(conn, &Message{
					Type:   TypeScreenSnapshotResult,
					CID:    req.CID,
					PaneID: req.PaneID,
					Text:   "hello\r\nworld",
					Cursor: &CursorPos{Row: 1, Col: 5},
				})
			case TypeGetLayout:
				_ = WriteControl(conn, &Message{
					Type:  TypeLayoutResult,
					CID:   req.CID,
					ASCII: "[ pane-1 | 80x24 ]",
				})
			}
		}
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	if _, err := c.Attach("ws1", "", "interactive"); err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if _, err := c.CreatePane([]string{"bash"}, "", 0, ""); err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	// ScreenSnapshot must return a non-nil message with a non-nil cursor.
	snap, err := c.ScreenSnapshot(1)
	if err != nil {
		t.Fatalf("ScreenSnapshot: %v", err)
	}
	if snap == nil {
		t.Fatal("ScreenSnapshot returned nil *Message")
	}
	if snap.Cursor == nil {
		t.Fatal("ScreenSnapshot Cursor is nil, want non-nil")
	}

	// GetLayout must return a non-empty ASCII string.
	ascii, err := c.GetLayout()
	if err != nil {
		t.Fatalf("GetLayout: %v", err)
	}
	if ascii == "" {
		t.Fatal("GetLayout returned empty ASCII")
	}
}

// TestClientOnShellPromptFires verifies that a TypeShellPrompt event
// broadcast by the daemon (triggered by OSC 133 ;D;0 in PTY output) is routed
// to the OnShellPrompt handler with the correct exit code within 3 seconds.
func TestClientOnShellPromptFires(t *testing.T) {
	_, socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	c, err := Dial(socketPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	promptCh := make(chan int, 1)
	c.SetHandlers(Handlers{
		OnShellPrompt: func(paneID int, exitCode int) {
			select {
			case promptCh <- exitCode:
			default:
			}
		},
	})
	go c.Run()

	// Attach to the default workspace that EnsureDefault created on cold start.
	wss, err := c.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	wsID := wss[0].WorkspaceID

	if _, err := c.Attach(wsID, "", "interactive"); err != nil {
		t.Fatalf("Attach: %v", err)
	}

	// Create a pane whose sole output is an OSC 133 ;D;0 BEL sequence.
	// \033 = ESC (octal), \007 = BEL (octal) — interpreted by sh's printf.
	if _, err := c.CreatePane([]string{"sh", "-c", "printf '\\033]133;D;0\\007'"}, "", 0, ""); err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	select {
	case code := <-promptCh:
		if code != 0 {
			t.Errorf("OnShellPrompt exitCode = %d, want 0", code)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for OnShellPrompt within 3s")
	}
}
