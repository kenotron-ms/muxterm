package mcp

import (
	"context"
	"sync"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Client wraps a sessiond.Client with output buffering and prompt-wait
// resolution. It is the MCP server's connection handle to the running sessiond
// daemon: a single long-lived connection, attached to one workspace at a time.
//
// All fields except conn (set once at construction) are guarded by mu.
type Client struct {
	conn *sessiond.Client

	mu             sync.Mutex
	workspace      string
	outputBufs     map[int][]byte
	promptChans    map[int]chan int
	outputNotifier func(paneID int) // called after each pane output append; nil = disabled
}

// Dial resolves the sessiond Unix socket path via sessiond.SocketPath and
// calls DialSocket. It is the top-level entry point for production use.
func Dial() (*Client, error) {
	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return nil, err
	}
	return DialSocket(socketPath)
}

// DialSocket connects to the sessiond daemon at socketPath, installs the
// unsolicited-event handlers (OnPaneOutput, OnShellPrompt), and starts the
// read loop in its own goroutine. It is the entry point for tests, which
// supply their own test-server socket paths.
func DialSocket(socketPath string) (*Client, error) {
	conn, err := sessiond.Dial(socketPath)
	if err != nil {
		return nil, err
	}

	c := &Client{
		conn:        conn,
		outputBufs:  make(map[int][]byte),
		promptChans: make(map[int]chan int),
	}

	conn.SetHandlers(sessiond.Handlers{
		// OnPaneOutput appends raw PTY bytes to the per-pane output buffer.
		// The handler runs on the read-loop goroutine so it must be fast.
		OnPaneOutput: func(paneID uint32, data []byte) {
			c.mu.Lock()
			id := int(paneID)
			c.outputBufs[id] = append(c.outputBufs[id], data...)
			notify := c.outputNotifier
			c.mu.Unlock()
			if notify != nil {
				notify(id)
			}
		},
		// OnShellPrompt delivers an OSC 133 command-done exit code to the
		// armed prompt channel for the pane (if one exists). The send is
		// non-blocking so a slow consumer never stalls the read loop.
		OnShellPrompt: func(paneID int, exitCode int) {
			c.mu.Lock()
			ch := c.promptChans[paneID]
			c.mu.Unlock()
			if ch != nil {
				select {
				case ch <- exitCode:
				default:
				}
			}
		},
	})

	go conn.Run()

	return c, nil
}

// Close closes the underlying sessiond connection.
func (c *Client) Close() error {
	return c.conn.Close()
}

// SetOutputNotifier installs fn as the callback invoked (best-effort) after each
// pane output append. fn receives the pane ID. Replaces any previous notifier.
// Safe to call from any goroutine.
func (c *Client) SetOutputNotifier(fn func(paneID int)) {
	c.mu.Lock()
	c.outputNotifier = fn
	c.mu.Unlock()
}

// AttachWorkspace attaches this connection to workspaceID with breakpoint "wide",
// records the workspace ID, and resets all output buffers and prompt channels.
// Any previously accumulated output or armed prompts from a prior workspace are
// discarded.
func (c *Client) AttachWorkspace(workspaceID string) error {
	if _, err := c.conn.Attach(workspaceID, "wide"); err != nil {
		return err
	}
	c.mu.Lock()
	c.workspace = workspaceID
	c.outputBufs = make(map[int][]byte)
	c.promptChans = make(map[int]chan int)
	c.mu.Unlock()
	return nil
}

// Workspace returns the workspace ID this connection is attached to. Returns
// an empty string before the first successful AttachWorkspace call.
func (c *Client) Workspace() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.workspace
}

// OutputBuffer returns a copy of the accumulated output for the pane identified
// by paneID. Returns nil when no output has been received yet. Callers receive
// a snapshot; later output does not appear in the returned slice.
func (c *Client) OutputBuffer(paneID int) []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	buf := c.outputBufs[paneID]
	if len(buf) == 0 {
		return nil
	}
	cp := make([]byte, len(buf))
	copy(cp, buf)
	return cp
}

// ClearOutput removes the accumulated output buffer for paneID. It is a no-op
// for unknown pane IDs.
func (c *Client) ClearOutput(paneID int) {
	c.mu.Lock()
	delete(c.outputBufs, paneID)
	c.mu.Unlock()
}

// ArmPrompt installs a fresh buffered-1 channel for paneID. The next
// OnShellPrompt event for this pane will deliver its exit code to the channel.
// Call before WaitForPrompt to avoid missing a prompt that fires before
// WaitForPrompt blocks.
func (c *Client) ArmPrompt(paneID int) {
	c.mu.Lock()
	c.promptChans[paneID] = make(chan int, 1)
	c.mu.Unlock()
}

// WaitForPrompt blocks until the pane identified by paneID emits an OSC 133
// command-done marker (delivered via OnShellPrompt) or ctx is cancelled.
// If no channel is armed for paneID, WaitForPrompt arms one automatically
// before blocking. On success it returns the exit code and deletes the channel.
// On ctx cancellation it returns -1 and ctx.Err().
func (c *Client) WaitForPrompt(ctx context.Context, paneID int) (int, error) {
	c.mu.Lock()
	ch := c.promptChans[paneID]
	if ch == nil {
		ch = make(chan int, 1)
		c.promptChans[paneID] = ch
	}
	c.mu.Unlock()

	select {
	case code := <-ch:
		c.mu.Lock()
		delete(c.promptChans, paneID)
		c.mu.Unlock()
		return code, nil
	case <-ctx.Done():
		return -1, ctx.Err()
	}
}
