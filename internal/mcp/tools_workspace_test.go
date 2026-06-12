package mcp

import (
	"strings"
	"testing"
)

// TestListAndCreateWorkspace verifies that createWorkspace returns a JSON object
// containing 'workspace_id' and that listWorkspaces returns a list that includes
// the name 'alpha'.
func TestListAndCreateWorkspace(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	// Attach to the default workspace so the client has a workspace context.
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

	wt := newWorkspaceTools(c)

	// createWorkspace should return a JSON object with workspace_id.
	created, err := wt.createWorkspace(map[string]any{"name": "alpha"})
	if err != nil {
		t.Fatalf("createWorkspace: %v", err)
	}
	if !strings.Contains(created, "workspace_id") {
		t.Errorf("createWorkspace result does not contain 'workspace_id': %s", created)
	}

	// listWorkspaces should include the newly created 'alpha' workspace.
	listed, err := wt.listWorkspaces(map[string]any{})
	if err != nil {
		t.Fatalf("listWorkspaces: %v", err)
	}
	if !strings.Contains(listed, "alpha") {
		t.Errorf("listWorkspaces result does not contain 'alpha': %s", listed)
	}
}

// TestSwitchAndCloseWorkspace verifies that switchWorkspace updates c.Workspace()
// to the new workspace id, and that closeWorkspace succeeds.
func TestSwitchAndCloseWorkspace(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	// List workspaces to get id1 (the default workspace).
	wss, err := c.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(wss) == 0 {
		t.Fatal("no workspaces")
	}
	id1 := wss[0].WorkspaceID

	// Attach to id1 so we have a current workspace context.
	if err := c.AttachWorkspace(id1); err != nil {
		t.Fatalf("AttachWorkspace id1: %v", err)
	}

	// Create a second workspace to switch to.
	id2, err := c.conn.CreateWorkspace("beta")
	if err != nil {
		t.Fatalf("CreateWorkspace beta: %v", err)
	}

	wt := newWorkspaceTools(c)

	// switchWorkspace to id2 should attach to id2 and update c.Workspace().
	_, err = wt.switchWorkspace(map[string]any{"workspace_id": id2})
	if err != nil {
		t.Fatalf("switchWorkspace: %v", err)
	}

	if c.Workspace() != id2 {
		t.Errorf("after switchWorkspace, c.Workspace() = %q, want %q", c.Workspace(), id2)
	}

	// closeWorkspace(id1) should succeed.
	closeResult, err := wt.closeWorkspace(map[string]any{"workspace_id": id1})
	if err != nil {
		t.Fatalf("closeWorkspace: %v", err)
	}
	if !strings.Contains(closeResult, "ok") {
		t.Errorf("closeWorkspace result does not contain 'ok': %s", closeResult)
	}
}
