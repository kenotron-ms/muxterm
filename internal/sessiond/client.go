package sessiond

import (
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"
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

// closeRequestReplyTimeout bounds only the additive activity-aware close
// requests. An older still-live daemon ignores an unknown control type, so a
// newly hot-reloaded relay must turn that mismatch into its normal recoverable
// close failure instead of waiting forever.
const closeRequestReplyTimeout = 2 * time.Second

// recoveryRequestReplyTimeout bounds every browser-safe recovery request. An
// older still-live daemon may ignore an additive recovery type, so callers must
// fail closed rather than retain partial recovery authority indefinitely.
const recoveryRequestReplyTimeout = 2 * time.Second

// Handlers holds callbacks for unsolicited events (Messages with CID == 0)
// pushed by the daemon. It is guarded by Client.hmu. Every callback runs on the
// client's single read-loop goroutine and must not block for long; offload slow
// work to another goroutine. Any callback may be nil, in which case its event is
// dropped.
type Handlers struct {
	// OnPaneOutput receives live pane output (and attach replay) bytes for the
	// workspace-local paneID. data is owned by the caller for the duration of
	// the call only.
	OnPaneOutput func(paneID uint32, data []byte)
	// OnPaneAdded fires when a pane is created in the attached workspace,
	// carrying the frozen PaneInfo for the new pane.
	OnPaneAdded func(pane PaneInfo)
	// OnPaneClosed fires when the pane identified by the workspace-local paneID
	// is removed. processExitCode is non-nil only for a real process-exit-driven
	// close (nil for an explicit client-requested close); runtimeMs is the real
	// shell process wall-clock runtime, valid only when processExitCode is non-nil.
	OnPaneClosed func(paneID int, processExitCode *int, runtimeMs int64)
	// OnPaneClosedWithWorkspace carries the same lifecycle event with its
	// explicit workspace identity. It is additive so existing consumers of
	// OnPaneClosed retain their callback shape.
	OnPaneClosedWithWorkspace func(workspaceID string, paneID int, processExitCode *int, runtimeMs int64)
	// OnWorkspaceClosed fires when the workspace identified by workspaceID is
	// closed.
	OnWorkspaceClosed func(workspaceID string)
	// OnWorkspaceRenamed fires when the workspace identified by workspaceID is
	// relabeled to name.
	OnWorkspaceRenamed func(workspaceID, name string)
	// OnWorkspaceList fires when the server pushes a full workspace snapshot
	// (after any mutation that changes workspace state).
	OnWorkspaceList func(workspaces []WorkspaceInfo)
	// OnPaneRenamed fires when the pane identified by paneID is relabeled to
	// name.
	OnPaneRenamed func(paneID int, name string)
	// OnBrowserAction fires when a browser-action command is broadcast to the
	// workspace (CID == 0). paneID identifies the target browser pane; action
	// is the DOM verb (click/fill/press/eval/…); ref, value, key, and expr
	// carry the verb's operands.
	OnBrowserAction func(paneID int, action, ref, value, key, expr string)
	// OnLayoutCommand fires when a layout-command is broadcast to the workspace
	// (CID == 0). command is the verb (e.g. create-pane/rename-pane/close-pane/
	// switch-workspace); paneID identifies the target pane; placement carries
	// the split placement token; referencePane is the reference pane id.
	// Field mapping (placement=Selector, referencePane=Cols) is provisional —
	// Phase 3/4 finalizes the exact semantics.
	OnLayoutCommand func(command string, paneID int, placement string, referencePane int)
	// OnShellPrompt fires when the daemon broadcasts a TypeShellPrompt event
	// triggered by an OSC 133 ;D (command-done) marker in the pane's PTY output.
	// paneID is the workspace-local pane id; exitCode is the value carried in the
	// OSC 133 ;D;N sequence (0 when absent).
	OnShellPrompt func(paneID int, exitCode int)
	// OnPaneResized fires when the daemon broadcasts a TypePaneResized event:
	// the canonical PTY size for paneID changed because some other conn
	// became (or already was) authoritative. Non-authoritative clients use
	// this to resize their local terminal view to match without re-emitting
	// their own resize message.
	OnPaneResized func(paneID uint32, cols, rows int)
	// OnPaneRecoveryChanged fires for a validated CID-zero browser-safe recovery
	// projection transition. Invalid or authority-bearing events are dropped.
	OnPaneRecoveryChanged func(transition PaneRecoveryTransition)
	// OnRecoveredHistory fires for validated literal history only. The text has
	// bounded UTF-8/LF-only display content and never grants recovery authority.
	OnRecoveredHistory func(history RecoveredHistoryLiteral)
	// OnReplacementOutcome fires for a validated CID-zero redacted replacement
	// outcome. It contains no replacement plan or execution authority.
	OnReplacementOutcome func(outcome RecoveryReplacementOutcome)
	// OnBrowserActionResult fires when the daemon broadcasts a
	// TypeBrowserActionResult event (CID == 0). msg carries PaneID plus the
	// result fields (OK, Snapshot, Result, Error).
	OnBrowserActionResult func(msg *Message)
	// OnBrowserCommand fires when the daemon broadcasts a browser-command to the
	// workspace (CID carried for correlation). The client owning/focused on the
	// pane executes it against its live webview. msg carries PaneID, CID,
	// Action, Selector, and Params.
	OnBrowserCommand func(msg *Message)
	// OnBrowserResult fires when the daemon broadcasts a browser-result back to
	// the workspace (echoing the command CID). msg carries PaneID, CID, Result
	// (or Error).
	OnBrowserResult func(msg *Message)
	// OnBrowserURL fires when the daemon broadcasts a browser-url event: the
	// client owning a browser pane committed a navigation. msg carries PaneID
	// and URL.
	OnBrowserURL func(msg *Message)
	// OnBrowserLoad fires when the daemon broadcasts a browser-load event: the
	// client owning a browser pane finished loading a page. msg carries PaneID
	// and URL.
	OnBrowserLoad func(msg *Message)
}

// SetHandlers installs the unsolicited-event callbacks. It is hmu-guarded and
// must be called before Run so the read loop sees a fully-populated Handlers.
func (c *Client) SetHandlers(h Handlers) {
	c.hmu.Lock()
	c.handlers = h
	c.hmu.Unlock()
}

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
// reply to one of THIS connection's own pending requests (CID matches an
// entry in c.pend) is delivered to the waiting requester. Everything else —
// including events with CID == 0, and broadcasts that merely carry a
// correlation id with no matching pending request (e.g. the browser-command /
// browser-result relay, which preserves the caller's cid end-to-end but is
// never registered as a pending request since it is fire-and-forget) — is
// dispatched to the event handlers.
func (c *Client) dispatchControl(payload []byte) {
	var typeProbe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &typeProbe); err != nil {
		return
	}
	if isOwnerLocalRecoveryType(typeProbe.Type) {
		return
	}

	var msg Message
	if isBrowserRecoveryMessageType(typeProbe.Type) {
		decoded, err := DecodeBrowserRecoveryMessage(payload)
		if err != nil {
			return
		}
		msg = *decoded
	} else {
		if err := json.Unmarshal(payload, &msg); err != nil {
			return
		}
	}
	if msg.CID != 0 {
		c.pendMu.Lock()
		p := c.pend[msg.CID]
		delete(c.pend, msg.CID)
		c.pendMu.Unlock()
		if p != nil {
			p.ch <- &msg
			return
		}
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
	return c.requestWithin(msg, 0)
}

// requestWithin behaves like request, but returns a timeout error after timeout
// when it is positive. Timing out removes only this request's pending entry;
// a late reply is then treated as an unsolicited message rather than being
// delivered to a future request.
func (c *Client) requestWithin(msg *Message, timeout time.Duration) (*Message, error) {
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

	var reply *Message
	var ok bool
	if timeout <= 0 {
		reply, ok = <-p.ch
	} else {
		timer := time.NewTimer(timeout)
		defer timer.Stop()

		select {
		case reply, ok = <-p.ch:
		case <-timer.C:
			c.pendMu.Lock()
			if c.pend[cid] == p {
				delete(c.pend, cid)
			}
			c.pendMu.Unlock()
			return nil, fmt.Errorf("sessiond: timed out waiting for %q reply", msg.Type)
		}
	}
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

// CloseIntent asks the daemon to assess target and close it atomically when its
// current activity evidence is proven idle. Busy and unknown targets return an
// opaque confirmation ticket without mutation.
func (c *Client) CloseIntent(target CloseTarget) (CloseOutcome, error) {
	reply, err := c.requestWithin(&Message{
		Type:        TypeCloseIntent,
		TargetKind:  string(target.Kind),
		WorkspaceID: target.WorkspaceID,
		PaneID:      target.PaneID,
	}, closeRequestReplyTimeout)
	if err != nil {
		return CloseOutcome{}, err
	}
	return ParseCloseOutcomeMessage(reply)
}

// CloseConfirm forwards only the opaque ticket issued by a prior CloseIntent.
// The daemon revalidates its bound target and activity snapshot; callers never
// restate target identity or safety evidence.
func (c *Client) CloseConfirm(ticket string) (CloseOutcome, error) {
	reply, err := c.requestWithin(
		&Message{Type: TypeCloseConfirm, Ticket: ticket},
		closeRequestReplyTimeout,
	)
	if err != nil {
		return CloseOutcome{}, err
	}
	return ParseCloseOutcomeMessage(reply)
}

// recoveryRequest sends one browser-safe recovery request with a bounded
// timeout and verifies that the correlated reply has the exact expected type.
func (c *Client) recoveryRequest(msg *Message, expectedReplyType string) (*Message, error) {
	reply, err := c.requestWithin(msg, recoveryRequestReplyTimeout)
	if err != nil {
		return nil, err
	}
	if reply == nil || reply.CID != msg.CID || reply.Type != expectedReplyType {
		return nil, fmt.Errorf(
			"sessiond: expected correlated %q reply for %q request",
			expectedReplyType,
			msg.Type,
		)
	}
	return reply, nil
}

// ProtocolHello negotiates browser-safe recovery protocol support. It validates
// the offer before sending and returns only a complete, validated result.
func (c *Client) ProtocolHello(request ProtocolHelloRequest) (ProtocolHelloResult, error) {
	if err := ValidateRecoveryContract(request); err != nil {
		return ProtocolHelloResult{}, err
	}
	reply, err := c.recoveryRequest(
		&Message{Type: TypeProtocolHello, ProtocolHello: &request},
		TypeProtocolHelloResult,
	)
	if err != nil {
		return ProtocolHelloResult{}, err
	}
	if reply.ProtocolHelloResult == nil {
		return ProtocolHelloResult{}, fmt.Errorf("sessiond: protocol hello reply has no payload")
	}
	result := *reply.ProtocolHelloResult
	if err := ValidateRecoveryContract(result); err != nil {
		return ProtocolHelloResult{}, err
	}
	return result, nil
}

// RecoveryRetry requests one explicit retry for a workspace-qualified pane. The
// daemon resolves the current recovery authority internally.
func (c *Client) RecoveryRetry(request RecoveryRetryRequest) (RecoveryRetryResult, error) {
	if err := ValidateRecoveryContract(request); err != nil {
		return RecoveryRetryResult{}, err
	}
	reply, err := c.recoveryRequest(
		&Message{Type: TypeRecoveryRetry, RecoveryRetry: &request},
		TypeRecoveryRetryResult,
	)
	if err != nil {
		return RecoveryRetryResult{}, err
	}
	if reply.RecoveryRetryResult == nil {
		return RecoveryRetryResult{}, fmt.Errorf("sessiond: recovery retry reply has no payload")
	}
	result := *reply.RecoveryRetryResult
	if err := ValidateRecoveryContract(result); err != nil {
		return RecoveryRetryResult{}, err
	}
	return result, nil
}

// RecoverySelect submits only a daemon-issued opaque candidate handle. It
// validates the request and returns a complete redacted result or no authority.
func (c *Client) RecoverySelect(request RecoverySelectRequest) (RecoverySelectResult, error) {
	if err := ValidateRecoveryContract(request); err != nil {
		return RecoverySelectResult{}, err
	}
	reply, err := c.recoveryRequest(
		&Message{Type: TypeRecoverySelect, RecoverySelect: &request},
		TypeRecoverySelectResult,
	)
	if err != nil {
		return RecoverySelectResult{}, err
	}
	if reply.RecoverySelectResult == nil {
		return RecoverySelectResult{}, fmt.Errorf("sessiond: recovery selection reply has no payload")
	}
	result := *reply.RecoverySelectResult
	if err := ValidateRecoveryContract(result); err != nil {
		return RecoverySelectResult{}, err
	}
	return result, nil
}

// SetActivePane persists one workspace-qualified active-pane intent. It returns
// only a complete, validated daemon result.
func (c *Client) SetActivePane(
	request ActivePanePersistenceRequest,
) (ActivePanePersistenceResult, error) {
	if err := ValidateRecoveryContract(request); err != nil {
		return ActivePanePersistenceResult{}, err
	}
	reply, err := c.recoveryRequest(
		&Message{Type: TypeSetActivePane, ActivePanePersistence: &request},
		TypeSetActivePaneResult,
	)
	if err != nil {
		return ActivePanePersistenceResult{}, err
	}
	if reply.ActivePanePersistenceResult == nil {
		return ActivePanePersistenceResult{}, fmt.Errorf("sessiond: active-pane reply has no payload")
	}
	result := *reply.ActivePanePersistenceResult
	if err := ValidateRecoveryContract(result); err != nil {
		return ActivePanePersistenceResult{}, err
	}
	return result, nil
}

// Composition is the device-independent set of panes that make up a workspace,
// as returned by Attach. It carries the frozen PaneInfo values for each pane;
// empty Panes is valid (a workspace with no panes), not an error.
type Composition struct {
	WorkspaceID string
	Panes       []PaneInfo
	Layout      string
}

// Attach binds this connection to the workspace identified by workspaceID and
// returns its single composition reply. breakpoint is the active CSS breakpoint
// token (e.g. "desktop"); pass "" when unknown. clientKind identifies this
// connection as "interactive" (real browser/human) or "agent" (MCP/automation);
// it is threaded onto the wire as Message.ClientKind so the daemon can exclude
// agent input from pane focus-authority. Always replays the full retained
// buffer — no delta tracking. Empty Panes is valid (an empty workspace), not
// silence. After this reply, per-pane replay bytes arrive as pane-data frames
// (routed to Handlers), followed by live output. An unknown or stale workspace
// id surfaces as a *DaemonError with Code == CodeUnknownWorkspace.
func (c *Client) Attach(workspaceID, breakpoint, clientKind string) (Composition, error) {
	reply, err := c.request(&Message{
		Type:        TypeAttach,
		WorkspaceID: workspaceID,
		Breakpoint:  breakpoint,
		ClientKind:  clientKind,
	})
	if err != nil {
		return Composition{}, err
	}
	return Composition{WorkspaceID: reply.WorkspaceID, Panes: reply.Panes, Layout: reply.Layout}, nil
}

// ScreenSnapshot requests a VT-grid snapshot of the pane identified by the
// workspace-local paneID. The daemon replies with TypeScreenSnapshotResult
// carrying Text (visible cell content), Cursor (0-indexed row/col), and PaneID.
// For non-VT panes (browser pane or RawBuffer), the reply has empty Text and a
// nil Cursor; the *Message itself is always non-nil on success.
func (c *Client) ScreenSnapshot(paneID int) (*Message, error) {
	return c.request(&Message{Type: TypeScreenSnapshot, PaneID: paneID})
}

// ScrollbackPage requests one page of server-side scrollback history for the
// pane identified by the workspace-local paneID, paging BACKWARD from cursor.
//
// cursor is an exclusive upper bound expressed as an absolute line-sequence
// number; nil means "the most recent page of history" (the lines immediately
// preceding the current live viewport). limit is the maximum number of lines to
// return; 0 lets the daemon apply its default (500) and any value above the
// daemon's cap (5000) is capped server-side.
//
// It returns the page oldest-first, the absolute sequence of the first returned
// line, and the cursor to pass on the next call to page further back. A nil
// next means no more retained history in that direction and is the normal
// termination condition for a paging loop — not an error. A pane that exists
// but is not VT-backed (a browser pane) yields an empty page, also not an
// error. A daemon-side failure (unknown workspace, unknown pane) surfaces as a
// *DaemonError carrying the frozen error code.
func (c *Client) ScrollbackPage(paneID int, cursor *uint64, limit int) (lines []string, start uint64, next *uint64, err error) {
	reply, err := c.request(&Message{
		Type:       TypeScrollbackPage,
		PaneID:     paneID,
		LineCursor: cursor,
		Limit:      limit,
	})
	if err != nil {
		return nil, 0, nil, err
	}
	return reply.Lines, reply.StartLine, reply.NextCursor, nil
}

// GetLayout requests an ASCII layout diagram of the currently-attached
// workspace. The daemon replies with TypeLayoutResult carrying the ASCII field.
// Returns an empty string when no layout has been saved for the attached
// workspace.
func (c *Client) GetLayout() (string, error) {
	reply, err := c.request(&Message{Type: TypeGetLayout})
	if err != nil {
		return "", err
	}
	return reply.ASCII, nil
}

// RenamePane sets the display name of the pane identified by the
// workspace-local paneID to name.
func (c *Client) RenamePane(paneID int, name string) error {
	_, err := c.request(&Message{Type: TypeRenamePane, PaneID: paneID, Name: name})
	return err
}

// SaveLayout persists a serialised layout blob for the workspace identified by
// workspaceID at the given breakpoint.
func (c *Client) SaveLayout(workspaceID, breakpoint, layout string) error {
	_, err := c.request(&Message{Type: TypeSaveLayout, WorkspaceID: workspaceID, Breakpoint: breakpoint, Layout: layout})
	return err
}

// CreatePane forks a PTY in the connection's currently-attached workspace and
// returns the daemon-assigned workspace-local pane id from the pane-created
// reply. It is connection-scoped: the request carries no workspaceId, targeting
// whichever workspace this connection is attached to. cmd is the argv to exec;
// an empty cmd means the daemon's default $SHELL. placement and referencePaneID
// control how the browser-side dockview layer positions the new pane; pass ""
// and 0 for the default behaviour (append to active pane). The browser spawns
// its xterm.js instance on the resulting pane-added broadcast, NOT on this ack.
func (c *Client) CreatePane(cmd []string, placement string, referencePaneID int) (int, error) {
	reply, err := c.request(&Message{
		Type:            TypeCreatePane,
		Cmd:             cmd,
		Placement:       placement,
		ReferencePaneID: referencePaneID,
	})
	if err != nil {
		return 0, err
	}
	return reply.PaneID, nil
}

// CreateBrowserPane creates a client-rendered browser surface pane in the
// attached workspace and returns the server-assigned workspace-local pane ID.
// The daemon allocates only a pane handle (surfaceKind "browser"); the browser
// engine lives entirely on the client.
func (c *Client) CreateBrowserPane(placement string, referencePaneID int) (int, error) {
	reply, err := c.request(&Message{
		Type:            TypeCreateBrowserPane,
		Placement:       placement,
		ReferencePaneID: referencePaneID,
	})
	if err != nil {
		return 0, err
	}
	return reply.PaneID, nil
}

// ClosePane asks the daemon to kill the pane identified by paneID and remove it
// from the attached workspace. The daemon broadcasts a pane-closed event to all
// subscribers on success.
func (c *Client) ClosePane(paneID int) error {
	_, err := c.request(&Message{Type: TypeClosePane, PaneID: paneID})
	return err
}

// Input forwards keystroke bytes to the pane identified by the workspace-local
// paneID as a binary FramePaneData frame, matching the live-output framing so
// serve can bridge the body without rewriting it. It is connection-scoped: the
// frame carries no workspaceId and targets the attached workspace.
func (c *Client) Input(paneID uint32, data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WritePaneData(c.conn, paneID, data)
}

// Resize tells the daemon to resize the pane identified by the workspace-local
// paneID to cols x rows. It is a connection-scoped control message carrying no
// workspaceId and is fire-and-forget: the daemon sends no reply.
func (c *Client) Resize(paneID, cols, rows int) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeResize, PaneID: paneID, Cols: cols, Rows: rows})
}

// PaneFocus tells the daemon that this connection's pane identified by the
// workspace-local paneID has become the visible+OS-focused view, carrying the
// client's current measured size so the daemon can claim focus authority and
// resize the PTY in the same round-trip. It is a connection-scoped control
// message carrying no workspaceId and is fire-and-forget: the daemon sends no
// reply. Only meaningful for interactive (non-agent) connections — the daemon
// silently ignores it from an agent-kind conn.
func (c *Client) PaneFocus(paneID uint32, cols, rows int) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypePaneFocus, PaneID: int(paneID), Cols: cols, Rows: rows})
}

// BrowserActionResult forwards a browser-action-result envelope from the
// browser shim to the daemon, which broadcasts it to all workspace subscribers
// (including the MCP client waiting for the result). It is fire-and-forget:
// the daemon sends no reply.
func (c *Client) BrowserActionResult(msg Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	msg.Type = TypeBrowserActionResult
	return WriteControl(c.conn, &msg)
}

// SendBrowserAction sends a browser-action envelope to the daemon, which
// broadcasts it to all workspace subscribers (including the browser shim
// listening for DOM commands). It is fire-and-forget: the daemon sends no
// reply. The caller must separately wait for a TypeBrowserActionResult event
// (e.g., via Handlers.OnBrowserActionResult) to obtain the result.
func (c *Client) SendBrowserAction(msg Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	msg.Type = TypeBrowserAction
	return WriteControl(c.conn, &msg)
}

// BrowserCommand relays a browser-command to the daemon, which broadcasts it to
// all subscribers of the attached workspace. payload is the pre-marshalled
// command JSON ({action, params, ...}) stored in Params for passthrough.
// Fire-and-forget: the daemon sends no direct reply; the executing client
// returns a browser-result event.
func (c *Client) BrowserCommand(paneID int, cid uint64, payload json.RawMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeBrowserCommand, PaneID: paneID, CID: cid, Params: payload})
}

// BrowserResult relays a browser-result back to the daemon, which broadcasts it
// to all subscribers of the attached workspace (echoing the command CID).
// Fire-and-forget.
func (c *Client) BrowserResult(paneID int, cid uint64, payload json.RawMessage) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeBrowserResult, PaneID: paneID, CID: cid, Result: payload})
}

// BrowserURL relays a browser-url notification to the daemon (URL navigation
// committed in a client-rendered browser pane), which broadcasts it to all
// subscribers of the attached workspace. Fire-and-forget: the daemon sends no
// reply.
func (c *Client) BrowserURL(paneID int, url string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeBrowserURL, PaneID: paneID, URL: url})
}

// BrowserLoad relays a browser-load notification to the daemon (page load
// complete in a client-rendered browser pane), which broadcasts it to all
// subscribers of the attached workspace. Fire-and-forget: the daemon sends no
// reply.
func (c *Client) BrowserLoad(paneID int, url string) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return WriteControl(c.conn, &Message{Type: TypeBrowserLoad, PaneID: paneID, URL: url})
}

// dispatchPaneData routes a decoded pane-data frame to OnPaneOutput if set. It
// runs on the read-loop goroutine, so the handler must not block for long.
func (c *Client) dispatchPaneData(paneID uint32, data []byte) {
	c.hmu.Lock()
	fn := c.handlers.OnPaneOutput
	c.hmu.Unlock()
	if fn != nil {
		fn(paneID, data)
	}
}

// dispatchEvent routes an unsolicited event Message (CID == 0) to the matching
// lifecycle handler. It runs on the read-loop goroutine, so handlers must not
// block for long. Unknown event types are ignored.
func (c *Client) dispatchEvent(msg *Message) {
	c.hmu.Lock()
	h := c.handlers
	c.hmu.Unlock()
	switch msg.Type {
	case TypePaneAdded:
		if h.OnPaneAdded != nil {
			h.OnPaneAdded(PaneInfo{
				PaneID:          msg.PaneID,
				Cols:            msg.Cols,
				Rows:            msg.Rows,
				Title:           msg.Title,
				SurfaceKind:     msg.SurfaceKind,
				Placement:       msg.Placement,
				ReferencePaneID: msg.ReferencePaneID,
			})
		}
	case TypePaneClosed:
		if h.OnPaneClosed != nil {
			h.OnPaneClosed(msg.PaneID, msg.ProcessExitCode, msg.RuntimeMs)
		}
		if h.OnPaneClosedWithWorkspace != nil {
			h.OnPaneClosedWithWorkspace(msg.WorkspaceID, msg.PaneID, msg.ProcessExitCode, msg.RuntimeMs)
		}
	case TypeWorkspaceClosed:
		if h.OnWorkspaceClosed != nil {
			h.OnWorkspaceClosed(msg.WorkspaceID)
		}
	case TypeWorkspaceRenamed:
		if h.OnWorkspaceRenamed != nil {
			h.OnWorkspaceRenamed(msg.WorkspaceID, msg.Name)
		}
	case TypeWorkspaceList:
		if h.OnWorkspaceList != nil {
			h.OnWorkspaceList(msg.Workspaces)
		}
	case TypePaneRenamed:
		if h.OnPaneRenamed != nil {
			h.OnPaneRenamed(msg.PaneID, msg.Name)
		}
	case TypeBrowserAction:
		if h.OnBrowserAction != nil {
			h.OnBrowserAction(msg.PaneID, msg.Action, msg.Ref, msg.Value, msg.Key, msg.Expression)
		}
	case TypeBrowserActionResult:
		if h.OnBrowserActionResult != nil {
			h.OnBrowserActionResult(msg)
		}
	case TypeLayoutCommand:
		if h.OnLayoutCommand != nil {
			h.OnLayoutCommand(msg.Action, msg.PaneID, msg.Selector, msg.Cols)
		}
	case TypeShellPrompt:
		if h.OnShellPrompt != nil {
			h.OnShellPrompt(msg.PaneID, msg.ExitCode)
		}
	case TypePaneResized:
		if h.OnPaneResized != nil {
			h.OnPaneResized(uint32(msg.PaneID), msg.Cols, msg.Rows)
		}
	case TypePaneRecoveryChanged:
		if msg.CID != 0 || ValidateBrowserRecoveryMessage(msg) != nil || msg.RecoveryTransition == nil {
			return
		}
		if h.OnPaneRecoveryChanged != nil {
			h.OnPaneRecoveryChanged(*msg.RecoveryTransition)
		}
	case TypeRecoveredHistory:
		if msg.CID != 0 || ValidateBrowserRecoveryMessage(msg) != nil || msg.RecoveredHistory == nil {
			return
		}
		if h.OnRecoveredHistory != nil {
			h.OnRecoveredHistory(*msg.RecoveredHistory)
		}
	case TypeReplacementOutcome:
		if msg.CID != 0 || ValidateBrowserRecoveryMessage(msg) != nil || msg.ReplacementOutcome == nil {
			return
		}
		if h.OnReplacementOutcome != nil {
			h.OnReplacementOutcome(*msg.ReplacementOutcome)
		}
	case TypeBrowserCommand:
		if h.OnBrowserCommand != nil {
			h.OnBrowserCommand(msg)
		}
	case TypeBrowserResult:
		if h.OnBrowserResult != nil {
			h.OnBrowserResult(msg)
		}
	case TypeBrowserURL:
		if h.OnBrowserURL != nil {
			h.OnBrowserURL(msg)
		}
	case TypeBrowserLoad:
		if h.OnBrowserLoad != nil {
			h.OnBrowserLoad(msg)
		}
	}
}
