package mcp

import (
	"strings"
	"testing"
)

// TestRunCommandReturnsOutput verifies that runCommand sends a command to a
// pane's shell, waits for the OSC 133 ;D prompt marker, and returns output
// containing the expected text.
func TestRunCommandReturnsOutput(t *testing.T) {
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
	if len(wss) == 0 {
		t.Fatal("no workspaces")
	}
	if err := c.AttachWorkspace(wss[0].WorkspaceID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	// Create a pane running sh interactively so runCommand can send input to it.
	paneID, err := c.conn.CreatePane([]string{"sh"}, "", 0)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	tt := newTerminalTools(c)

	// The command emits "mcp_marker" then the OSC 133 ;D;0 BEL sequence so
	// WaitForPrompt resolves. Shell's printf handles \n, \033, and \007.
	result, err := tt.runCommand(map[string]any{
		"pane_id":    float64(paneID),
		"command":    `printf 'mcp_marker\n'; printf '\033]133;D;0\007'`,
		"timeout_ms": float64(5000),
	})
	if err != nil {
		t.Fatalf("runCommand: %v", err)
	}

	if !strings.Contains(result, "mcp_marker") {
		t.Errorf("runCommand result does not contain 'mcp_marker': %s", result)
	}
}

// TestSendInputReturnsOK verifies that sendInput sends raw bytes to a pane and
// returns a JSON object containing {ok: true}.
func TestSendInputReturnsOK(t *testing.T) {
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
	if len(wss) == 0 {
		t.Fatal("no workspaces")
	}
	if err := c.AttachWorkspace(wss[0].WorkspaceID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	paneID, err := c.conn.CreatePane([]string{"sh"}, "", 0)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	tt := newTerminalTools(c)

	result, err := tt.sendInput(map[string]any{
		"pane_id": float64(paneID),
		"text":    "hello\n",
	})
	if err != nil {
		t.Fatalf("sendInput: %v", err)
	}

	if !strings.Contains(result, "true") {
		t.Errorf("sendInput result does not contain 'true': %s", result)
	}
}

// TestGetScreenReturnsText verifies that getScreen returns a JSON object
// containing a "cursor" field.
func TestGetScreenReturnsText(t *testing.T) {
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
	if len(wss) == 0 {
		t.Fatal("no workspaces")
	}
	if err := c.AttachWorkspace(wss[0].WorkspaceID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	paneID, err := c.conn.CreatePane([]string{"sh"}, "", 0)
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	tt := newTerminalTools(c)

	result, err := tt.getScreen(map[string]any{
		"pane_id": float64(paneID),
	})
	if err != nil {
		t.Fatalf("getScreen: %v", err)
	}

	if !strings.Contains(result, "cursor") {
		t.Errorf("getScreen result does not contain 'cursor': %s", result)
	}
}
