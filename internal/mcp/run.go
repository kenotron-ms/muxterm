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
//
// After a successful dial, get auto-attaches to the first available workspace
// so that pane and terminal tools work immediately without requiring an
// explicit switch_workspace call. If no workspaces exist yet (empty daemon),
// the connection remains unattached and switch_workspace must be called once
// a workspace is created.
func (lc *lazyClient) get() (*Client, error) {
	lc.once.Do(func() {
		c, err := Dial()
		if err != nil {
			lc.err = fmt.Errorf("connect to sessiond: %w", err)
			return
		}
		// Record the first workspace ID so resources/list knows which workspace to
		// attach later. We intentionally do NOT call AttachWorkspace here: that
		// would trigger a full scrollback replay from the sessiond right now, and
		// the resources/list Attach (below) will do the same replay — so doing it
		// twice doubles the data on the Unix socket and risks the MCP-pipe
		// deadlock on Linux that was the root cause of the v0.5.0 regression.
		if workspaces, wsErr := c.conn.ListWorkspaces(); wsErr == nil && len(workspaces) > 0 {
			c.setWorkspaceOnly(workspaces[0].WorkspaceID)
		}
		lc.c = c
	})
	return lc.c, lc.err
}

// NewStdioServer creates a Server wired to os.Stdin/Stdout and registers all
// 15 MCP tools. The sessiond client is dialed lazily on the first tool call,
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

// registerWithLazy registers all MCP tools on srv, wrapping sessiond-backed
// handlers so the client is resolved lazily via lc.get() on each tool call.
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
	registerTunnelTools(srv)
	registerConfigTools(srv)

	// attachOnce guards the one-time workspace attach for resources/list.
	// Calling c.conn.Attach repeatedly replays the full retained output buffer
	// for every pane, generating spurious notifications/resources/updated events
	// on every resources/list call. We attach once and cache the pane list.
	var (
		attachOnce  sync.Once
		attachedRes []map[string]any
	)
	srv.SetResourceProvider(
		// list closure: dial lazily, attach workspace exactly once, return cached
		// pane descriptors. Subsequent resources/list calls return the same list
		// without re-attaching or replaying output buffers.
		func() []map[string]any {
			c, err := lc.get()
			if err != nil {
				return nil
			}
			attachOnce.Do(func() {
				ws := c.Workspace()
				comp, attachErr := c.conn.Attach(ws, "wide", "agent")
				if attachErr != nil {
					return
				}
				// Set the notifier AFTER Attach completes.
				// Attach replays the full scrollback for every pane; if the notifier
				// is live during replay, conn.Run tries to write MCP notifications
				// while the resources/list response is still pending — Amplifier is
				// waiting for that response and not draining the pipe, so it fills up,
				// conn.Run blocks, the sessiond socket backs up, and Attach never
				// finishes. Setting the notifier here means replay is silent; only
				// future live output fires notifications, at which point Amplifier is
				// actively reading.
				c.SetOutputNotifier(func(paneID int) {
					srv.NotifyResourceUpdated(fmt.Sprintf("pane://%d", paneID))
				})
				res := make([]map[string]any, 0, len(comp.Panes))
				for _, p := range comp.Panes {
					res = append(res, map[string]any{
						"uri":      fmt.Sprintf("pane://%d", p.PaneID),
						"name":     fmt.Sprintf("Pane %d output", p.PaneID),
						"mimeType": "text/plain",
					})
				}
				attachedRes = res
			})
			return attachedRes
		},
		// read closure: dial lazily, parse paneID from uri, return screen text.
		// Returns an error immediately on malformed URIs to avoid sending pane 0
		// to the daemon with a confusing error message.
		func(uri string) (string, error) {
			c, err := lc.get()
			if err != nil {
				return "", err
			}
			var paneID int
			if n, _ := fmt.Sscanf(uri, "pane://%d", &paneID); n != 1 {
				return "", fmt.Errorf("invalid resource URI: %q", uri)
			}
			snap, err := c.conn.ScreenSnapshot(paneID)
			if err != nil {
				return "", err
			}
			return snap.Text, nil
		},
	)
}

// registerAllTools registers the 12 sessiond-backed MCP tools on srv using
// wrap to convert func(*Client, map[string]any)(string,error) handlers into
// ToolFuncs. Tools are registered in the canonical order:
//
//	Terminal:   run_command, send_input, get_screen
//	Workspace:  list_workspaces, create_workspace, switch_workspace, close_workspace
//	Layout:     create_pane, rename_pane, close_pane, list_panes, get_layout
//
// The 3 tunnel tools (list_tunnels, create_tunnel, close_tunnel) are registered
// separately via registerTunnelTools because they go through the HTTP REST API
// of the serve layer rather than the sessiond daemon.
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
		"send input without waiting, for interactive programs/control sequences; text (optional) is always sent as literal bytes, unchanged, safe for any payload including strings that happen to match a key name; keys (optional) is an array of key names (Enter, Tab, Escape, Backspace, Up, Down, Left, Right, C-c, C-d, C-z) each translated to its byte sequence, e.g. keys: [\"Enter\"] to press Enter; if both are given, text is sent first, then keys, e.g. text: \"ls -la\", keys: [\"Enter\"]; at least one of text/keys is required",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pane_id": map[string]any{"type": "integer"},
				"text":    map[string]any{"type": "string"},
				"keys":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			},
			"required": []string{"pane_id"},
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
		"create new terminal pane, placement tab|split-right|split-left|split-above|split-below advisory \u2014 split executed by the web UI",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"kind": map[string]any{
					"type": "string",
					"enum": []string{"terminal"},
				},
				"placement": map[string]any{
					"type": "string",
					"enum": []string{"tab", "split-right", "split-left", "split-above", "split-below"},
				},
				"reference_pane": map[string]any{"type": "integer"},
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

// registerTunnelTools registers the 3 tunnel MCP tools directly on srv,
// without going through the lazyClient. Tunnel tools communicate with the
// serve-layer HTTP REST API (not the sessiond daemon), so they must not
// require sessiond to be running.
func registerTunnelTools(srv *Server) {
	tt := newTunnelTools()

	srv.Register(
		"list_tunnels",
		"list all active tunnels with id and port",
		map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		},
		func(args map[string]any) (string, error) {
			return tt.listTunnels(args)
		},
	)

	srv.Register(
		"create_tunnel",
		"create a new port-forward tunnel for the given local port; returns id and the /t/{id}/ proxy path",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"port": map[string]any{"type": "integer"},
			},
			"required": []string{"port"},
		},
		func(args map[string]any) (string, error) {
			return tt.createTunnel(args)
		},
	)

	srv.Register(
		"close_tunnel",
		"close tunnel by id, removing the port-forward",
		map[string]any{
			"type": "object",
			"properties": map[string]any{
				"tunnel_id": map[string]any{"type": "string"},
			},
			"required": []string{"tunnel_id"},
		},
		func(args map[string]any) (string, error) {
			return tt.closeTunnel(args)
		},
	)
}
