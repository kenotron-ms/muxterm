package mcp

import (
	"fmt"
	"sync"
)

// lazyClient dials the sessiond daemon exactly once, on the first tool call.
// The initialize and tools/list methods must NOT trigger a dial so that MCP
// servers work without a running daemon.
type lazyClient struct {
	once sync.Once
	c    *Client
	err  error
}

// get returns the Client, dialing on the first call. Subsequent calls return
// the same cached result. On dial failure the error is wrapped as
// "connect to sessiond: <cause>".
func (lc *lazyClient) get() (*Client, error) {
	lc.once.Do(func() {
		c, err := Dial()
		if err != nil {
			lc.err = fmt.Errorf("connect to sessiond: %w", err)
			return
		}
		lc.c = c
	})
	return lc.c, lc.err
}

// NewStdioServer creates a Server wired to os.Stdin/Stdout and registers all
// 12 MCP tools. The sessiond client is dialed lazily on the first tool call,
// so initialize and tools/list work without a running daemon.
//
// The returned closer must be called when the server exits: it closes the
// sessiond client connection if one was opened.
func NewStdioServer() (*Server, func() error) {
	srv := NewServer()
	lc := &lazyClient{}
	registerWithLazy(srv, lc)
	closer := func() error {
		if lc.c != nil {
			return lc.c.Close()
		}
		return nil
	}
	return srv, closer
}

// registerWithLazy registers all 12 MCP tools on srv, wrapping each handler
// so the sessiond client is resolved lazily via lc.get() on each tool call.
func registerWithLazy(srv *Server, lc *lazyClient) {
	wrap := func(fn func(*Client, map[string]any) (string, error)) ToolFunc {
		return func(args map[string]any) (string, error) {
			c, err := lc.get()
			if err != nil {
				return "", err
			}
			return fn(c, args)
		}
	}
	registerAllTools(srv, wrap)

	srv.SetResourceProvider(
		// list closure: dial lazily, install output notifier, attach workspace,
		// return one descriptor per pane.
		func() []map[string]any {
			c, err := lc.get()
			if err != nil {
				return nil
			}
			c.SetOutputNotifier(func(paneID int) {
				srv.NotifyResourceUpdated(fmt.Sprintf("pane://%d", paneID))
			})
			ws := c.Workspace()
			comp, err := c.conn.Attach(ws, "wide")
			if err != nil {
				return nil
			}
			resources := make([]map[string]any, 0, len(comp.Panes))
			for _, p := range comp.Panes {
				resources = append(resources, map[string]any{
					"uri":      fmt.Sprintf("pane://%d", p.PaneID),
					"name":     fmt.Sprintf("Pane %d output", p.PaneID),
					"mimeType": "text/plain",
				})
			}
			return resources
		},
		// read closure: dial lazily, parse paneID from uri, return screen text.
		func(uri string) (string, error) {
			c, err := lc.get()
			if err != nil {
				return "", err
			}
			var paneID int
			fmt.Sscanf(uri, "pane://%d", &paneID)
			snap, err := c.conn.ScreenSnapshot(paneID)
			if err != nil {
				return "", err
			}
			return snap.Text, nil
		},
	)
}

// registerAllTools registers all 12 MCP tools on srv using wrap to convert
// func(*Client, map[string]any)(string,error) handlers into ToolFuncs.
// Tools are registered in the canonical order:
//
//	Terminal:   run_command, send_input, get_screen
//	Workspace:  list_workspaces, create_workspace, switch_workspace, close_workspace
//	Layout:     create_pane, rename_pane, close_pane, list_panes, get_layout
func registerAllTools(srv *Server, wrap func(func(*Client, map[string]any) (string, error)) ToolFunc) {
	// --- Terminal tools ---

	srv.Register(
		"run_command",
		"run command and wait for completion via OSC 133, returns output+exit code; for long-running use send_input",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id":    map[string]any{"type": "integer"},
				"command":    map[string]any{"type": "string"},
				"timeout_ms": map[string]any{"type": "integer"},
			},
			"required": []string{"pane_id", "command"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newTerminalTools(c).runCommand(args)
		}),
	)

	srv.Register(
		"send_input",
		"send raw input without waiting, for interactive programs/control sequences",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"text":    map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "text"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newTerminalTools(c).sendInput(args)
		}),
	)

	srv.Register(
		"get_screen",
		"current screen state as plain text + cursor",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
			},
			"required": []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newTerminalTools(c).getScreen(args)
		}),
	)

	// --- Workspace tools ---

	srv.Register(
		"list_workspaces",
		"list all workspaces with id/name/pane count/active flag",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newWorkspaceTools(c).listWorkspaces(args)
		}),
	)

	srv.Register(
		"create_workspace",
		"create new empty workspace by name, return id",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name": map[string]any{"type": "string"},
			},
			"required": []string{"name"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newWorkspaceTools(c).createWorkspace(args)
		}),
	)

	srv.Register(
		"switch_workspace",
		"switch MCP session to a different workspace \u2014 detach current, attach given id; subsequent terminal/layout tools target new workspace",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspace_id": map[string]any{"type": "string"},
			},
			"required": []string{"workspace_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newWorkspaceTools(c).switchWorkspace(args)
		}),
	)

	srv.Register(
		"close_workspace",
		"close workspace by id, terminating all panes, cannot be undone",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspace_id": map[string]any{"type": "string"},
			},
			"required": []string{"workspace_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newWorkspaceTools(c).closeWorkspace(args)
		}),
	)

	// --- Layout tools ---

	srv.Register(
		"create_pane",
		"create new pane, kind terminal|browser, placement tab|split-right|split-left|split-above|split-below advisory \u2014 split executed by browser; for browser provide url/browser_port; browser automation lands Phase 5 see playwright-cli",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"kind": map[string]any{
					"type": "string",
					"enum": []string{"terminal", "browser"},
				},
				"placement": map[string]any{
					"type": "string",
					"enum": []string{"tab", "split-right", "split-left", "split-above", "split-below"},
				},
				"reference_pane": map[string]any{"type": "integer"},
				"url":            map[string]any{"type": "string"},
				"browser_port":   map[string]any{"type": "integer"},
			},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).createPane(args)
		}),
	)

	srv.Register(
		"rename_pane",
		"rename pane by id, sets display label",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"name":    map[string]any{"type": "string"},
			},
			"required": []string{"pane_id", "name"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).renamePane(args)
		}),
	)

	srv.Register(
		"close_pane",
		"close pane by id, terminating its process",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
			},
			"required": []string{"pane_id"},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).closePane(args)
		}),
	)

	srv.Register(
		"list_panes",
		"list all panes in the current or specified workspace with pane_id, kind, and name",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspace": map[string]any{"type": "string"},
			},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).listPanes(args)
		}),
	)

	srv.Register(
		"get_layout",
		"get ASCII layout diagram of the current workspace; empty string when no layout saved",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspace": map[string]any{"type": "string"},
			},
		},
		wrap(func(c *Client, args map[string]any) (string, error) {
			return newLayoutTools(c).getLayout(args)
		}),
	)
}
