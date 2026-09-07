package mcp

import "fmt"

// workspaceTools groups the MCP workspace tool handlers and holds a reference
// to the Client so handlers can invoke sessiond operations.
type workspaceTools struct {
	c *Client
}

// newWorkspaceTools creates a workspaceTools instance backed by c.
func newWorkspaceTools(c *Client) *workspaceTools {
	return &workspaceTools{c: c}
}

// listWorkspaces returns a JSON array of all workspaces on the machine this
// client is connected to. Each element has the fields id, name, pane_count,
// active (true when that workspace is the one this MCP session is currently
// attached to), and machine.
func (wt *workspaceTools) listWorkspaces(_ map[string]any) (string, error) {
	workspaces, err := wt.c.conn.ListWorkspaces()
	if err != nil {
		return "", fmt.Errorf("listing workspaces: %w", err)
	}

	current := wt.c.Workspace()
	items := make([]map[string]any, 0, len(workspaces))
	for _, ws := range workspaces {
		items = append(items, map[string]any{
			"id":         ws.WorkspaceID,
			"name":       ws.Name,
			"pane_count": ws.PaneCount,
			"active":     ws.WorkspaceID == current,
			// Which machine this row came from. Present on EVERY row,
			// including local ones, so a caller never has to infer the
			// machine from the absence of a field -- and so a row can be fed
			// straight back to another tool's machine argument.
			"machine": wt.c.Machine(),
		})
	}

	return jsonText(items), nil
}

// createWorkspace creates a new empty workspace with the given name and returns
// a JSON object containing the daemon-assigned workspace_id.
func (wt *workspaceTools) createWorkspace(args map[string]any) (string, error) {
	name, err := argString(args, "name")
	if err != nil {
		return "", err
	}

	id, err := wt.c.conn.CreateWorkspace(name)
	if err != nil {
		return "", fmt.Errorf("creating workspace %q: %w", name, err)
	}

	return jsonText(map[string]any{"workspace_id": id, "machine": wt.c.Machine()}), nil
}

// switchWorkspace attaches the MCP session to the workspace identified by
// workspace_id. Subsequent terminal and layout tool calls will target the new
// workspace. The previous workspace is implicitly detached.
func (wt *workspaceTools) switchWorkspace(args map[string]any) (string, error) {
	id, err := argString(args, "workspace_id")
	if err != nil {
		return "", err
	}

	if err := wt.c.AttachWorkspace(id); err != nil {
		return "", fmt.Errorf("switching to workspace %q on machine %s: %w", id, wt.c.Machine(), err)
	}

	return jsonText(map[string]any{"ok": true, "machine": wt.c.Machine()}), nil
}

// closeWorkspace closes the workspace identified by workspace_id, terminating
// all of its panes. This operation cannot be undone.
func (wt *workspaceTools) closeWorkspace(args map[string]any) (string, error) {
	id, err := argString(args, "workspace_id")
	if err != nil {
		return "", err
	}

	if err := wt.c.conn.CloseWorkspace(id); err != nil {
		return "", fmt.Errorf("closing workspace %q: %w", id, err)
	}

	return jsonText(map[string]any{"ok": true, "machine": wt.c.Machine()}), nil
}
