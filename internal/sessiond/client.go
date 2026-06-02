package sessiond

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
)

// Client is the serve-side handle to a single sessiond Unix-socket connection.
//
// One Client wraps exactly one Unix-socket connection. The serve layer creates
// one Client per browser WebSocket. A Client is connection-scoped: after Attach,
// create-pane/resize/input target the attached workspace and carry no
// workspaceId.
type Client struct {
	conn net.Conn

	writeMu sync.Mutex // serializes frame writes onto conn

	nextCID atomic.Uint64 // monotonic correlation-id source

	pendMu sync.Mutex
	pend   map[uint64]*pending // in-flight requests keyed by CID

	hmu      sync.Mutex
	handlers Handlers // unsolicited-event handlers

	closeOnce sync.Once
}

// pending tracks a single in-flight request awaiting its reply.
type pending struct {
	ch chan *Message
}

// Handlers holds callbacks for unsolicited events (Messages with CID == 0)
// pushed by the daemon. It is guarded by Client.hmu. Fields are added by later
// tasks as event types are wired up.
type Handlers struct{}

// Dial opens a Unix-socket connection to the sessiond daemon at socketPath and
// returns a connection-scoped Client.
func Dial(socketPath string) (*Client, error) {
	conn, err := net.Dial("unix", socketPath)
	if err != nil {
		return nil, err
	}
	return &Client{
		conn: conn,
		pend: make(map[uint64]*pending),
	}, nil
}

// Close closes the underlying connection. It is idempotent: repeated calls are
// safe and only the first closes the connection.
func (c *Client) Close() error {
	var err error
	c.closeOnce.Do(func() {
		err = c.conn.Close()
	})
	return err
}

// DaemonError is the typed error returned when the daemon replies with a
// TypeError envelope. Code is the stable machine-readable error code; Err is the
// human-readable text; WorkspaceID names the workspace the error refers to (if
// any).
type DaemonError struct {
	Code        string
	Err         string
	WorkspaceID string
}

// Error implements the error interface.
func (e *DaemonError) Error() string {
	return e.Code + ": " + e.Err
}

// Run is the single background read loop. It reads frames off the connection and
// routes them: pane-data frames go to dispatchPaneData, control frames go to
// dispatchControl (which correlates replies by cid and dispatches events). It
// runs until the connection errors, at which point it fails all pending
// requests and returns the error. Run MUST be started in its own goroutine
// before any requests are issued.
func (c *Client) Run() error {
	for {
		kind, payload, err := ReadFrame(c.conn)
		if err != nil {
			c.failAllPending(err)
			return err
		}
		switch kind {
		case FramePaneData:
			paneID, data := DecodePaneData(payload)
			c.dispatchPaneData(paneID, data)
		case FrameControl:
			c.dispatchControl(payload)
		}
	}
}

// dispatchControl decodes a control payload into a Message and routes it. A
// reply (CID != 0) is delivered to the waiting requester; an unsolicited event
// (CID == 0) is dispatched to the event handlers.
func (c *Client) dispatchControl(payload []byte) {
	var msg Message
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	if msg.CID != 0 {
		c.pendMu.Lock()
		p := c.pend[msg.CID]
		delete(c.pend, msg.CID)
		c.pendMu.Unlock()
		if p != nil {
			p.ch <- &msg
		}
		return
	}
	c.dispatchEvent(&msg)
}

// failAllPending closes every pending request channel and clears the map. It is
// called once when the read loop exits so blocked requesters observe a closed
// connection instead of hanging.
func (c *Client) failAllPending(err error) {
	c.pendMu.Lock()
	defer c.pendMu.Unlock()
	for cid, p := range c.pend {
		close(p.ch)
		delete(c.pend, cid)
	}
}

// request sends msg as a control frame and blocks until the daemon's correlated
// reply arrives. It assigns a fresh cid (>=1; 0 is reserved for events),
// registers a pending entry, writes the frame under writeMu, and waits on the
// pending channel. A TypeError reply is converted to a *DaemonError.
func (c *Client) request(msg *Message) (*Message, error) {
	cid := c.nextCID.Add(1)
	msg.CID = cid

	p := &pending{ch: make(chan *Message, 1)}
	c.pendMu.Lock()
	c.pend[cid] = p
	c.pendMu.Unlock()

	c.writeMu.Lock()
	err := WriteControl(c.conn, msg)
	c.writeMu.Unlock()
	if err != nil {
		c.pendMu.Lock()
		delete(c.pend, cid)
		c.pendMu.Unlock()
		return nil, err
	}

	reply, ok := <-p.ch
	if !ok {
		return nil, fmt.Errorf("sessiond: connection closed before reply")
	}
	if reply.Type == TypeError {
		return nil, &DaemonError{Code: reply.Code, Err: reply.Error, WorkspaceID: reply.WorkspaceID}
	}
	return reply, nil
}

// ListWorkspaces requests the daemon's current workspace list.
func (c *Client) ListWorkspaces() ([]WorkspaceInfo, error) {
	reply, err := c.request(&Message{Type: TypeListWorkspaces})
	if err != nil {
		return nil, err
	}
	return reply.Workspaces, nil
}

// CreateWorkspace asks the daemon to create a new workspace named name and
// returns the daemon-assigned workspace id from the workspace-created reply.
func (c *Client) CreateWorkspace(name string) (string, error) {
	reply, err := c.request(&Message{Type: TypeCreateWorkspace, Name: name})
	if err != nil {
		return "", err
	}
	return reply.WorkspaceID, nil
}

// RenameWorkspace sets the label of the workspace identified by workspaceID to
// name. An empty name clears the label.
func (c *Client) RenameWorkspace(workspaceID, name string) error {
	_, err := c.request(&Message{Type: TypeRenameWorkspace, WorkspaceID: workspaceID, Name: name})
	return err
}

// CloseWorkspace asks the daemon to close the workspace identified by
// workspaceID, which kills all of its panes and removes the workspace.
func (c *Client) CloseWorkspace(workspaceID string) error {
	_, err := c.request(&Message{Type: TypeCloseWorkspace, WorkspaceID: workspaceID})
	return err
}

// Composition is the device-independent set of panes that make up a workspace,
// as returned by Attach. It carries the frozen PaneInfo values for each pane;
// empty Panes is valid (a workspace with no panes), not an error.
type Composition struct {
	WorkspaceID string
	Panes       []PaneInfo
}

// Attach binds this connection to the workspace identified by workspaceID and
// returns its single composition reply. Empty Panes is valid (an empty
// workspace), not silence. After this reply, per-pane replay bytes arrive as
// pane-data frames (routed to Handlers), followed by live output. An unknown or
// stale workspace id surfaces as a *DaemonError with Code == CodeUnknownWorkspace.
func (c *Client) Attach(workspaceID string) (Composition, error) {
	reply, err := c.request(&Message{Type: TypeAttach, WorkspaceID: workspaceID})
	if err != nil {
		return Composition{}, err
	}
	return Composition{WorkspaceID: reply.WorkspaceID, Panes: reply.Panes}, nil
}

// CreatePane forks a PTY in the connection's currently-attached workspace and
// returns the daemon-assigned workspace-local pane id from the pane-created
// reply. It is connection-scoped: the request carries no workspaceId, targeting
// whichever workspace this connection is attached to. cmd is the argv to exec;
// an empty cmd means the daemon's default $SHELL. The browser spawns its
// xterm.js instance on the resulting pane-added broadcast, NOT on this ack.
func (c *Client) CreatePane(cmd []string) (int, error) {
	reply, err := c.request(&Message{Type: TypeCreatePane, Cmd: cmd})
	if err != nil {
		return 0, err
	}
	return reply.PaneID, nil
}

// dispatchPaneData routes a decoded pane-data frame to the registered handler.
// Wired up by a later task; a no-op stub for now.
func (c *Client) dispatchPaneData(paneID uint32, data []byte) {}

// dispatchEvent routes an unsolicited event Message (CID == 0) to the registered
// handlers. Wired up by a later task; a no-op stub for now.
func (c *Client) dispatchEvent(msg *Message) {}
