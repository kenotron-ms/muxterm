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
	go srv.ListenAndServe(ctx)

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
	paneID, err := c.conn.CreatePane([]string{"echo", "hello-from-mcp"})
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

// TestSendBrowserActionResolves verifies that SendBrowserAction delivers the
// browser-action broadcast to a second ("browser side") client attached to the
// same workspace, receives the browser-action-result reply, and returns it with
// OK == true.
func TestSendBrowserActionResolves(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	mc, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer mc.Close()

	wss, err := mc.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(wss) == 0 {
		t.Fatal("no workspaces returned")
	}
	wsID := wss[0].WorkspaceID

	if err := mc.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	// 'browser side': raw sessiond client that handles the action and sends a result.
	browserConn, err := sessiond.Dial(socketPath)
	if err != nil {
		t.Fatalf("browser Dial: %v", err)
	}
	defer browserConn.Close()

	type obsType struct {
		paneID int
		action string
		ref    string
	}
	observed := make(chan obsType, 1)

	browserConn.SetHandlers(sessiond.Handlers{
		OnBrowserAction: func(paneID int, action, ref, value, key, expr string) {
			observed <- obsType{paneID: paneID, action: action, ref: ref}
			_ = browserConn.BrowserActionResult(sessiond.Message{PaneID: paneID, OK: true})
		},
	})
	go browserConn.Run()
	if _, err := browserConn.Attach(wsID, ""); err != nil {
		t.Fatalf("browser Attach: %v", err)
	}

	ctx, ctxCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer ctxCancel()

	res, err := mc.SendBrowserAction(ctx, 7, "click", map[string]any{"ref": "e5"})
	if err != nil {
		t.Fatalf("SendBrowserAction: %v", err)
	}
	if !res.OK {
		t.Errorf("result.OK = false, want true")
	}

	// By the time SendBrowserAction returns the browser side has already
	// written to observed (write-to-channel happens before BrowserActionResult,
	// which happens before the result broadcast reaches the MCP client).
	select {
	case o := <-observed:
		if o.paneID != 7 {
			t.Errorf("browser observed paneID = %d, want 7", o.paneID)
		}
		if o.action != "click" {
			t.Errorf("browser observed action = %q, want click", o.action)
		}
		if o.ref != "e5" {
			t.Errorf("browser observed ref = %q, want e5", o.ref)
		}
	default:
		t.Error("browser did not observe any action before SendBrowserAction returned")
	}
}

// TestSendBrowserActionTimeout verifies that SendBrowserAction returns a
// non-nil error when the context expires before a result arrives.
func TestSendBrowserActionTimeout(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	mc, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer mc.Close()

	wss, err := mc.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(wss) == 0 {
		t.Fatal("no workspaces returned")
	}
	wsID := wss[0].WorkspaceID

	if err := mc.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	// 100 ms context with no browser client to respond.
	ctx, ctxCancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer ctxCancel()

	_, err = mc.SendBrowserAction(ctx, 99, "click", nil)
	if err == nil {
		t.Fatal("SendBrowserAction: expected timeout error, got nil")
	}
}

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
	paneID, err := c.conn.CreatePane([]string{"sh", "-c", "printf '\\033]133;D;0\\007'"})
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
