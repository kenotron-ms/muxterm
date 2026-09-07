package mcp

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Client wraps a sessiond.Client with output buffering and prompt-wait
// resolution. It is the MCP server's connection handle to the running sessiond
// daemon: a single long-lived connection, attached to one workspace at a time.
//
// All fields except conn (set once at construction) are guarded by mu.
type Client struct {
	conn *sessiond.Client

	// machine is which daemon this client is connected to: LocalMachine for
	// the socket on this box, otherwise a transport.HostRef.ID.
	//
	// Set once at construction and never mutated, so it is safe to read
	// without mu. It is carried on the CLIENT rather than passed down through
	// every tool call because it is a property of the connection, and because
	// a tool that must label its rows with a machine should be unable to
	// forget which one it is talking to.
	machine string

	// dead is closed when the sessiond read loop exits, whatever the cause:
	// the far end went away, ssh died, the socket closed. deadErr records why.
	// A local socket effectively never closes; a remote one closing is the
	// normal end of a machine's life, and callers must be able to see it
	// without issuing a request first.
	dead    chan struct{}
	deadErr error

	mu             sync.Mutex
	workspace      string
	outputBufs     map[int][]byte
	promptChans    map[int]chan int
	outputNotifier func(paneID int) // called after each pane output append; nil = disabled

	// fleet is the latest session-state snapshot pushed by the daemon.
	//
	// Caching the LATEST push is not an optimisation, it is the whole design:
	// every TypeSessionState event carries the CURRENT FULL SET, not a delta
	// (protocol.go:124), so the most recent frame is by construction the
	// complete truth and a dropped frame is repaired by the next one. There is
	// nothing to merge and nothing to replay.
	//
	// GLOBAL, unlike everything else on this struct. The daemon fans this set
	// out across EVERY workspace, not just the one this connection is attached
	// to, which is exactly why the fleet tools are not workspace-scoped the way
	// create_pane and send_input are. An agent parked in one workspace can see
	// -- and only see -- the whole fleet through this field.
	fleet []sessiond.SessionState

	// fleetReady is closed by fleetReadyOnce when the first snapshot lands, so
	// the first caller can block on a real event instead of sleeping a fixed
	// interval. Never reassigned after construction; safe to read without mu.
	fleetReady     chan struct{}
	fleetReadyOnce sync.Once

	// fleetSubOnce guards the one SessionStateSubscribe attempt; fleetSubErr
	// caches its verdict so every caller gets the same answer. Written inside
	// the Once and read after it, which is the ordering sync.Once guarantees.
	fleetSubOnce sync.Once
	fleetSubErr  error
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
	return newClient(conn, LocalMachine), nil
}

// newClient wraps an already-established sessiond connection, installs the
// unsolicited-event handlers, and starts the read loop.
//
// It is the ONE constructor, shared by the local socket path (DialSocket) and
// the remote transport path (machines.dial). That sharing is the point: a
// remote client is not a different kind of client, it is the same client over
// a different stream, exactly as sessiond.DialConn's contract promises. Any
// behaviour added here is automatically true of both, which is what stops
// "works locally, subtly different remotely" from becoming possible.
func newClient(conn *sessiond.Client, machine string) *Client {
	c := &Client{
		conn:        conn,
		machine:     machine,
		dead:        make(chan struct{}),
		outputBufs:  make(map[int][]byte),
		promptChans: make(map[int]chan int),
		fleetReady:  make(chan struct{}),
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
		// OnSessionState REPLACES the cached fleet wholesale. msg.Sessions is
		// nil for the empty set (the field is omitempty), and replacing with
		// nil is correct: the ARRIVAL of the frame is the signal, never the
		// presence of the field. Merging instead of replacing here would
		// freeze the view showing sessions that have already ended.
		//
		// The handler is installed unconditionally but costs nothing until
		// something calls Fleet: the daemon pushes only to connections that
		// opted in, and this one has not until then.
		OnSessionState: func(msg *sessiond.Message) {
			c.mu.Lock()
			c.fleet = msg.Sessions
			c.mu.Unlock()
			c.fleetReadyOnce.Do(func() { close(c.fleetReady) })
		},
	})

	go func() {
		err := conn.Run()
		c.mu.Lock()
		c.deadErr = err
		c.mu.Unlock()
		close(c.dead)
	}()

	return c
}

// Close closes the underlying sessiond connection.
func (c *Client) Close() error {
	return c.conn.Close()
}

// Machine reports which daemon this client is connected to: LocalMachine, or a
// transport.HostRef.ID. Never empty.
func (c *Client) Machine() string {
	if c.machine == "" {
		return LocalMachine
	}
	return c.machine
}

// IsRemote reports whether this client crosses a machine boundary.
func (c *Client) IsRemote() bool { return !isLocal(c.machine) }

// Dead reports whether the sessiond read loop has exited, i.e. this connection
// can no longer carry a request. Non-blocking.
func (c *Client) Dead() bool {
	select {
	case <-c.dead:
		return true
	default:
		return false
	}
}

// DeadErr returns why the read loop exited, or nil while it is still running.
func (c *Client) DeadErr() error {
	select {
	case <-c.dead:
		c.mu.Lock()
		defer c.mu.Unlock()
		return c.deadErr
	default:
		return nil
	}
}

// primeWorkspace issues one bounded ListWorkspaces and records the first
// workspace it names, so pane and terminal tools work immediately without an
// explicit switch_workspace call.
//
// It is BOTH the liveness handshake and the priming step, deliberately, because
// they are the same round trip and separating them would spend two.
//
// The handshake half matters most for a remote. A stream being ACQUIRED says
// nothing about a daemon being THERE: an ssh dial returns the moment ssh
// execs, so "no muxterm on that host", "muxterm present but no daemon
// running", and "the login shell printed a banner into the protocol stream"
// all look like a healthy connection until the first request either fails or
// hangs forever (internal/sessiond/client.go:242). One bounded round trip at
// dial time turns all three into a dial-time error that can name the machine.
//
// It deliberately does NOT Attach: Attach replays every pane's full retained
// output, and doing it here would double the replay that resources/list must
// already do, which is the v0.5.0 MCP-pipe deadlock. Recording the id is
// enough; the attach happens when something needs it.
func (c *Client) primeWorkspace(timeout time.Duration) error {
	return c.within(timeout, func() error {
		ws, err := c.conn.ListWorkspaces()
		if err != nil {
			return err
		}
		if len(ws) > 0 {
			c.setWorkspaceOnly(ws[0].WorkspaceID)
		}
		return nil
	})
}

// attachRemote attaches a REMOTE client to the workspace primeWorkspace
// recorded, so its pane and terminal tools work without an explicit
// switch_workspace call.
//
// The local client does not do this, and the asymmetry is deliberate rather
// than an oversight. Locally the attach is performed by the resources/list
// handler, timed to avoid the v0.5.0 MCP-pipe deadlock: Attach replays every
// pane's retained output, and if the output notifier is live during that
// replay the server writes notifications into a stdout pipe the client is not
// draining, and everything wedges (see registerWithLazy). A remote client is
// not exposed as MCP resources and never has a notifier installed, so its
// replay lands in an in-memory buffer and reaches no pipe. The hazard that
// forces the local timing simply does not exist here.
//
// A daemon with no workspaces at all is not an error: there is nothing to
// attach to yet, and create_workspace is the next call.
func (c *Client) attachRemote(timeout time.Duration) error {
	ws := c.Workspace()
	if ws == "" {
		return nil
	}
	return c.within(timeout, func() error { return c.AttachWorkspace(ws) })
}

// within runs fn on its own goroutine and bounds its wall-clock time, also
// returning early if the connection dies underneath it.
//
// Every crossing of a machine boundary goes through here or through
// callWithin in run.go. There is no path that can block forever.
func (c *Client) within(timeout time.Duration, fn func() error) error {
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		return err
	case <-c.dead:
		if err := c.DeadErr(); err != nil {
			return err
		}
		return errors.New("connection closed before the daemon replied")
	case <-time.After(timeout):
		return fmt.Errorf("no reply within %s", timeout)
	}
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
	if _, err := c.conn.Attach(workspaceID, "wide", "agent"); err != nil {
		return err
	}
	c.mu.Lock()
	c.workspace = workspaceID
	c.outputBufs = make(map[int][]byte)
	c.promptChans = make(map[int]chan int)
	c.mu.Unlock()
	return nil
}

// setWorkspaceOnly records workspaceID as the current workspace without
// issuing an Attach request to the sessiond. Used by lc.get() to prime the
// workspace field from ListWorkspaces, deferring the actual Attach (and its
// scrollback replay) to the first resources/list call so the MCP stdout pipe
// is never flooded before the client can read from it.
func (c *Client) setWorkspaceOnly(workspaceID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.workspace = workspaceID
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
