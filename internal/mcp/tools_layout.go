package mcp

import "fmt"

// layoutTools groups the MCP pane-layout tool handlers and holds a reference
// to the Client so handlers can invoke sessiond operations.
type layoutTools struct {
	c *Client
}

// newLayoutTools creates a layoutTools instance backed by c.
func newLayoutTools(c *Client) *layoutTools {
	return &layoutTools{c: c}
}

// createPane creates a new pane in the attached workspace. "terminal" is the
// only pane kind; kind may be omitted and defaults to it.
// placement (tab|split-right|split-left|split-above|split-below)
// and reference_pane (integer pane ID) are forwarded to the browser-side
// dockview layer via the pane-added broadcast; the actual split is executed
// there, not by the MCP server.
func (lt *layoutTools) createPane(args map[string]any) (string, error) {
	kind, _ := args["kind"].(string)

	placement, _ := args["placement"].(string)

	// reference_pane is an optional integer; 0 means "use the active pane".
	referencePaneID := 0
	if v, ok := args["reference_pane"]; ok {
		switch n := v.(type) {
		case float64:
			referencePaneID = int(n)
		case int:
			referencePaneID = n
		}
	}

	var paneID int

	// Single-arm switch retained as a validation guard: an explicit kind other
	// than "terminal" is a caller error, not something to silently ignore.
	switch kind {
	case "terminal", "":
		id, err := lt.c.conn.CreatePane(nil, placement, referencePaneID, "")
		if err != nil {
			return "", fmt.Errorf("creating terminal pane: %w", err)
		}
		paneID = id

	default:
		return "", fmt.Errorf("unknown pane kind: %s", kind)
	}

	result := map[string]any{"pane_id": paneID}
	if placement != "" {
		result["placement"] = placement
	}
	if referencePaneID != 0 {
		result["reference_pane"] = referencePaneID
	}
	return jsonText(result), nil
}

// renamePane sets the display name of the pane identified by pane_id to name.
// Returns {ok: true} on success.
func (lt *layoutTools) renamePane(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	name, err := argString(args, "name")
	if err != nil {
		return "", err
	}
	if err := lt.c.conn.RenamePane(paneID, name); err != nil {
		return "", fmt.Errorf("renaming pane %d: %w", paneID, err)
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// closePane kills the pane identified by pane_id and removes it from the
// attached workspace. Returns {ok: true} on success.
func (lt *layoutTools) closePane(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	if err := lt.c.conn.ClosePane(paneID); err != nil {
		return "", fmt.Errorf("closing pane %d: %w", paneID, err)
	}
	return jsonText(map[string]any{"ok": true}), nil
}

// listPanes returns a JSON array of all panes in the workspace. The workspace
// defaults to the one this session is attached to; pass workspace to override.
// Each element has pane_id, kind, and name.
func (lt *layoutTools) listPanes(args map[string]any) (string, error) {
	ws := lt.c.Workspace()
	if wsArg, ok := args["workspace"].(string); ok && wsArg != "" {
		ws = wsArg
	}
	if ws == "" {
		return "", fmt.Errorf("not attached to a workspace")
	}

	comp, err := lt.c.conn.Attach(ws, "wide", "agent")
	if err != nil {
		return "", fmt.Errorf("attaching to workspace %q: %w", ws, err)
	}

	items := make([]map[string]any, 0, len(comp.Panes))
	for _, p := range comp.Panes {
		item := map[string]any{
			"pane_id": p.PaneID,
			"kind":    "terminal",
			"name":    p.Title,
		}
		items = append(items, item)
	}
	return jsonText(items), nil
}

// getLayout returns the ASCII layout diagram for the currently-attached
// workspace. Returns an empty string when no layout has been saved.
func (lt *layoutTools) getLayout(_ map[string]any) (string, error) {
	return lt.c.conn.GetLayout()
}
