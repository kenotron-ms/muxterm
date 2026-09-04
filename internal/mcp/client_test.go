package mcp

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// startMCPTestServer starts a real sessiond daemon on a short socket path
// (under /tmp to stay under macOS's 104-byte Unix socket path limit) and
// returns the socket path and a cancel func. The server is shut down when
// cancel is called.
func startMCPTestServer(t *testing.T) (string, context.CancelFunc) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "muxmcp")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })

	socketPath := filepath.Join(dir, "s.sock")
	srv, err := sessiond.NewServer(socketPath)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go srv.ListenAndServe(ctx) //nolint:errcheck

	// Wait for the socket to appear.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(socketPath); err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := os.Stat(socketPath); err != nil {
		cancel()
		t.Fatalf("socket %s did not appear: %v", socketPath, err)
	}
	return socketPath, cancel
}

// TestDialAndAttach verifies that DialSocket + AttachWorkspace correctly records
// the workspace ID inside the Client (c.workspace == wsID).
func TestDialAndAttach(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	// The cold-start server always has a default workspace.
	wss, err := c.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(wss) == 0 {
		t.Fatal("no workspaces returned")
	}
	wsID := wss[0].WorkspaceID

	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	c.mu.Lock()
	got := c.workspace
	c.mu.Unlock()
	if got != wsID {
		t.Errorf("c.workspace = %q, want %q", got, wsID)
	}
}

// TestOutputBufferAccumulates verifies that pane output from the daemon is
// appended to the client's outputBufs map so that OutputBuffer returns
// non-empty bytes within 3 seconds after the pane produces output.
func TestOutputBufferAccumulates(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	wss, err := c.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	wsID := wss[0].WorkspaceID

	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	// Create a pane that repeatedly writes output.
	paneID, err := c.conn.CreatePane([]string{"echo", "hello-from-mcp"}, "", 0, "")
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	// Wait up to 3s for the buffer to become non-empty.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		buf := c.OutputBuffer(paneID)
		if len(buf) > 0 {
			return // success
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("OutputBuffer(%d) still empty after 3s", paneID)
}

// TestSendBrowserActionResolves and TestSendBrowserActionTimeout were removed
// when browser pane support was dropped from muxterm. Neither SendBrowserAction
// nor the browser-action relay it rode on exists any more. See git history for
// the original test bodies.

// TestWaitForPromptResolves verifies that WaitForPrompt returns exit code 0
// within 3 seconds after a pane emits an OSC 133 ;D;0 sequence.
func TestWaitForPromptResolves(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	wss, err := c.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	wsID := wss[0].WorkspaceID

	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	// Create a pane that emits an OSC 133 ;D;0 BEL sequence.
	paneID, err := c.conn.CreatePane([]string{"sh", "-c", "printf '\\033]133;D;0\\007'"}, "", 0, "")
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	// ArmPrompt so WaitForPrompt will receive the signal.
	c.ArmPrompt(paneID)

	ctx, ctxCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer ctxCancel()

	code, err := c.WaitForPrompt(ctx, paneID)
	if err != nil {
		t.Fatalf("WaitForPrompt: %v", err)
	}
	if code != 0 {
		t.Errorf("WaitForPrompt exit code = %d, want 0", code)
	}
}
