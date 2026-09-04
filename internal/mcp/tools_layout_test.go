package mcp

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// TestCreateAndClosePane verifies that createPane returns a JSON object
// containing 'pane_id' and that closePane succeeds.
func TestCreateAndClosePane(t *testing.T) {
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

	lt := newLayoutTools(c)

	// createPane with default kind (terminal) should return a JSON object with pane_id.
	result, err := lt.createPane(map[string]any{})
	if err != nil {
		t.Fatalf("createPane: %v", err)
	}
	if !strings.Contains(result, "pane_id") {
		t.Errorf("createPane result does not contain 'pane_id': %s", result)
	}

	// Extract the pane_id from the result.
	var created map[string]any
	if err := json.Unmarshal([]byte(result), &created); err != nil {
		t.Fatalf("json.Unmarshal createPane result: %v", err)
	}
	paneIDFloat, ok := created["pane_id"].(float64)
	if !ok {
		t.Fatalf("createPane result pane_id is not a number: %v", created["pane_id"])
	}
	paneID := int(paneIDFloat)

	// closePane should succeed.
	closeResult, err := lt.closePane(map[string]any{"pane_id": float64(paneID)})
	if err != nil {
		t.Fatalf("closePane: %v", err)
	}
	if !strings.Contains(closeResult, "ok") {
		t.Errorf("closePane result does not contain 'ok': %s", closeResult)
	}
}

// TestGetLayoutReturnsASCII verifies that getLayout returns a non-empty ASCII
// diagram after a pane exists and a layout has been saved.
func TestGetLayoutReturnsASCII(t *testing.T) {
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
	wsID := wss[0].WorkspaceID
	if err := c.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}

	// Create a pane.
	paneID, err := c.conn.CreatePane(nil, "", 0, "")
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	// Save a minimal dockview layout JSON that references the pane.
	// The views array uses string pane IDs (dockview convention).
	paneStr := fmt.Sprintf("%d", paneID)
	layout := fmt.Sprintf(
		`{"grid":{"root":{"type":"leaf","data":{"id":"g1","views":[%q],"activeView":%q},"size":0},"orientation":"HORIZONTAL"},"panels":{%q:{"id":%q,"title":"terminal"}},"activeGroup":"g1"}`,
		paneStr, paneStr, paneStr, paneStr,
	)
	if err := c.conn.SaveLayout(wsID, "wide", layout); err != nil {
		t.Fatalf("SaveLayout: %v", err)
	}

	lt := newLayoutTools(c)

	result, err := lt.getLayout(map[string]any{})
	if err != nil {
		t.Fatalf("getLayout: %v", err)
	}
	if result == "" {
		t.Errorf("getLayout returned empty ASCII diagram; want non-empty")
	}
}

// TestRenamePane verifies that renamePane returns a JSON object containing 'true'.
func TestRenamePane(t *testing.T) {
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

	// Create a pane to rename.
	paneID, err := c.conn.CreatePane(nil, "", 0, "")
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	lt := newLayoutTools(c)

	result, err := lt.renamePane(map[string]any{
		"pane_id": float64(paneID),
		"name":    "my-pane",
	})
	if err != nil {
		t.Fatalf("renamePane: %v", err)
	}
	if !strings.Contains(result, "true") {
		t.Errorf("renamePane result does not contain 'true': %s", result)
	}
}

// TestCreatePaneWithPlacement verifies that createPane with a placement arg
// includes the placement key in the result.
func TestCreatePaneWithPlacement(t *testing.T) {
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

	lt := newLayoutTools(c)

	result, err := lt.createPane(map[string]any{
		"kind":      "terminal",
		"placement": "split-right",
	})
	if err != nil {
		t.Fatalf("createPane with placement: %v", err)
	}
	if !strings.Contains(result, "pane_id") {
		t.Errorf("createPane result missing pane_id: %s", result)
	}
	if !strings.Contains(result, "placement") {
		t.Errorf("createPane result missing placement key: %s", result)
	}
	if !strings.Contains(result, "split-right") {
		t.Errorf("createPane result missing placement value: %s", result)
	}
}

// TestCreatePaneUnknownKind verifies that createPane returns an error for an
// unknown pane kind.
func TestCreatePaneUnknownKind(t *testing.T) {
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

	lt := newLayoutTools(c)

	_, err = lt.createPane(map[string]any{"kind": "unknown-kind"})
	if err == nil {
		t.Error("expected error for unknown pane kind, got nil")
	}
	if !strings.Contains(err.Error(), "unknown pane kind") {
		t.Errorf("error message does not contain 'unknown pane kind': %v", err)
	}
}

// TestListPanesReturnsPaneID verifies that listPanes returns pane information
// including pane_id for panes in the attached workspace.
func TestListPanesReturnsPaneID(t *testing.T) {
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

	// Create a pane so there's something to list.
	if _, err := c.conn.CreatePane(nil, "", 0, ""); err != nil {
		t.Fatalf("CreatePane: %v", err)
	}

	lt := newLayoutTools(c)

	result, err := lt.listPanes(map[string]any{})
	if err != nil {
		t.Fatalf("listPanes: %v", err)
	}
	if !strings.Contains(result, "pane_id") {
		t.Errorf("listPanes result does not contain 'pane_id': %s", result)
	}
}

// TestListPanesErrorsWhenNotAttached verifies that listPanes returns an error
// when no workspace is attached and no workspace arg is provided.
func TestListPanesErrorsWhenNotAttached(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()

	c, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	defer c.Close()

	lt := newLayoutTools(c)

	_, err = lt.listPanes(map[string]any{})
	if err == nil {
		t.Error("expected error when not attached, got nil")
	}
	if !strings.Contains(err.Error(), "not attached to a workspace") {
		t.Errorf("error message does not contain 'not attached to a workspace': %v", err)
	}
}
