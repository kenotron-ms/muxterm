package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Client represents a connected WebSocket client. Each browser WebSocket is
// backed by its own DaemonConn; the Client relays the frozen sessiond.Message
// vocabulary in both directions, holding no terminal state of its own.
//
// The cid carried on each message lives in two independent domains: the
// browser<->serve cid is owned by the browser and echoed back by serve, while
// the serve<->daemon cid is owned by the DaemonConn internally. serve never
// rewrites browser cids onto daemon requests.
type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex

	// daemon is the per-browser connection this client relays to. nil until the
	// hub attaches the client.
	daemon DaemonConn

	// closeTickets retains browser-local target identity for opaque confirmation
	// tickets. It is touched only by this Client's readPump; the ticket remains
	// the sole daemon authorization input.
	closeTickets map[string]sessiond.CloseTarget

	// writeTextFn/writeBinaryFn perform the actual frame writes. Production
	// wires them to the real WebSocket writers in newClient; tests inject
	// capturing closures.
	writeTextFn   func([]byte) error
	writeBinaryFn func([]byte) error

	// wsMu guards workspaceID, the workspace this client is currently attached
	// to. It is set on a successful TypeAttach and read by daemon event relay
	// handlers (e.g. OnPaneAdded) that need to stamp WorkspaceID onto events
	// the daemon itself does not carry a workspace id on, since a client is
	// only ever attached to a single workspace at a time.
	wsMu        sync.Mutex
	workspaceID string

	// attachSeq enforces the frozen "composition FIRST" ordering guarantee
	// across the goroutine boundary between the daemon connection's read loop
	// (which delivers the composition reply via request/reply correlation on
	// one goroutine, then immediately continues its loop and dispatches the
	// following replay pane-data frames via OnPaneOutput on that SAME
	// goroutine) and this Client's own handleTextInput goroutine (which
	// receives the composition reply and must forward it to the browser/app
	// WebSocket). Without this lock, OnPaneOutput's writeBinary calls for
	// replay frames race ahead of handleTextInput's sendMessage(composition)
	// call and reach the wire first, since a buffered-channel handoff to the
	// pending request does not yield the daemon read-loop goroutine. Held by
	// handleTextInput for the full Attach()+sendMessage(composition) sequence,
	// and by OnPaneOutput around every binary relay, so pane-data can never be
	// written to the WebSocket while a composition send is in flight.
	attachSeq sync.Mutex
}

const (
	closeRelayFailureCode    = "close-relay-failed"
	closeRelayFailureMessage = "Close request could not be completed; try again."
)

// setWorkspaceID records the workspace this client is currently attached to.
func (c *Client) setWorkspaceID(id string) {
	c.wsMu.Lock()
	c.workspaceID = id
	c.wsMu.Unlock()
}

// getWorkspaceID returns the workspace this client is currently attached to,
// or "" if it has not attached yet.
func (c *Client) getWorkspaceID() string {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	return c.workspaceID
}

func validCloseTarget(target sessiond.CloseTarget) bool {
	if target.WorkspaceID == "" {
		return false
	}
	switch target.Kind {
	case sessiond.CloseTargetPane:
		return target.PaneID > 0
	case sessiond.CloseTargetWorkspace:
		return target.PaneID == 0
	default:
		return false
	}
}

func (c *Client) rememberCloseTicket(outcome sessiond.CloseOutcome) {
	target := sessiond.CloseTarget{
		Kind:        outcome.TargetKind,
		WorkspaceID: outcome.WorkspaceID,
		PaneID:      outcome.PaneID,
	}
	if outcome.Status != sessiond.CloseStatusConfirmationRequired ||
		outcome.Ticket == "" || !validCloseTarget(target) {
		return
	}

	if c.closeTickets == nil {
		c.closeTickets = make(map[string]sessiond.CloseTarget)
	}
	if _, exists := c.closeTickets[outcome.Ticket]; !exists &&
		len(c.closeTickets) >= sessiond.CloseTicketCapacity {
		for ticket := range c.closeTickets {
			delete(c.closeTickets, ticket)
			break
		}
	}
	c.closeTickets[outcome.Ticket] = target
}

func (c *Client) closeTargetForTicket(ticket string) (sessiond.CloseTarget, bool) {
	target, ok := c.closeTickets[ticket]
	return target, ok
}

func (c *Client) forgetCloseTicket(ticket string) {
	delete(c.closeTickets, ticket)
}

func closeOutcomeWithFallbackTarget(outcome sessiond.CloseOutcome, fallback sessiond.CloseTarget) sessiond.CloseOutcome {
	if outcome.TargetKind == "" && validCloseTarget(fallback) {
		outcome.TargetKind = fallback.Kind
		outcome.WorkspaceID = fallback.WorkspaceID
		outcome.PaneID = fallback.PaneID
	}
	return outcome
}

func closeRelayFailure(target sessiond.CloseTarget) sessiond.CloseOutcome {
	return sessiond.CloseOutcome{
		Status:      sessiond.CloseStatusFailed,
		TargetKind:  target.Kind,
		WorkspaceID: target.WorkspaceID,
		PaneID:      target.PaneID,
		FailureCode: closeRelayFailureCode,
		Error:       closeRelayFailureMessage,
	}
}

// newClient creates a new Client with a cancellable context and real WebSocket
// writers.
func newClient(hub *Hub, conn *websocket.Conn) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		hub:          hub,
		conn:         conn,
		ctx:          ctx,
		cancel:       cancel,
		closeTickets: make(map[string]sessiond.CloseTarget),
	}
	c.writeTextFn = func(data []byte) error {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
		defer wcancel()
		return c.conn.Write(wctx, websocket.MessageText, data)
	}
	c.writeBinaryFn = func(data []byte) error {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
		defer wcancel()
		return c.conn.Write(wctx, websocket.MessageBinary, data)
	}
	return c
}

// writeBinary writes a binary frame via the client's binary writer.
func (c *Client) writeBinary(data []byte) error { return c.writeBinaryFn(data) }

// writeText writes a text frame via the client's text writer.
func (c *Client) writeText(data []byte) error { return c.writeTextFn(data) }

// readPump loops reading messages from the connection.
// On exit it removes the client from the hub.
func (c *Client) readPump() {
	defer c.hub.Remove(c)

	for {
		msgType, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}

		switch msgType {
		case websocket.MessageBinary:
			c.handleBinaryInput(data)
		case websocket.MessageText:
			c.handleTextInput(data)
		}
	}
}

// handleBinaryInput decodes a binary frame and forwards the payload to the
// daemon as pane input. Binary framing is unchanged from the legacy protocol:
// [4-byte LE uint32 paneId][raw bytes].
func (c *Client) handleBinaryInput(data []byte) {
	paneID, payload, err := DecodeBinaryFrame(data)
	if err != nil {
		log.Printf("handleBinaryInput: decode error: %v", err)
		return
	}
	if c.daemon == nil {
		log.Printf("handleBinaryInput: no daemon connection")
		return
	}
	if err := c.daemon.Input(paneID, payload); err != nil {
		log.Printf("handleBinaryInput: Input error: %v", err)
	}
}

// handleTextInput unmarshals a frozen sessiond.Message from the browser and
// relays it to the daemon, re-emitting the reply with the browser's cid echoed.
func (c *Client) handleTextInput(data []byte) {
	var msg sessiond.Message
	if err := json.Unmarshal(data, &msg); err != nil {
		c.sendError(0, "", fmt.Errorf("invalid JSON: %w", err))
		return
	}
	if c.daemon == nil {
		c.sendError(msg.CID, msg.WorkspaceID, fmt.Errorf("no daemon connection"))
		return
	}

	switch msg.Type {
	case sessiond.TypeAttach:
		// attachSeq must be held for the entire Attach()+sendMessage sequence:
		// it also gates OnPaneOutput's binary relay (see attachClient), so no
		// replay pane-data frame can reach the WebSocket before the
		// composition reply that announces its pane, preserving the frozen
		// "composition FIRST" wire ordering across the goroutine boundary.
		c.attachSeq.Lock()
		comp, err := c.daemon.Attach(msg.WorkspaceID, msg.Breakpoint, "interactive")
		if err != nil {
			c.attachSeq.Unlock()
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.setWorkspaceID(comp.WorkspaceID)
		c.sendMessage(&sessiond.Message{
			Type:        sessiond.TypeComposition,
			CID:         msg.CID,
			WorkspaceID: comp.WorkspaceID,
			Panes:       comp.Panes,
			Layout:      comp.Layout,
		})
		c.attachSeq.Unlock()

	case sessiond.TypeListWorkspaces:
		workspaces, err := c.daemon.ListWorkspaces()
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:       sessiond.TypeWorkspaceList,
			CID:        msg.CID,
			Workspaces: workspaces,
		})

	case sessiond.TypeCreateWorkspace:
		id, err := c.daemon.CreateWorkspace(msg.Name)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:        sessiond.TypeWorkspaceCreated,
			CID:         msg.CID,
			WorkspaceID: id,
			Name:        msg.Name,
			ClientRef:   msg.ClientRef,
		})

	case sessiond.TypeRenameWorkspace:
		if err := c.daemon.RenameWorkspace(msg.WorkspaceID, msg.Name); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		if wsList, err := c.daemon.ListWorkspaces(); err == nil {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: wsList})
		}

	case sessiond.TypeCloseWorkspace:
		if err := c.daemon.CloseWorkspace(msg.WorkspaceID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		if wsList, err := c.daemon.ListWorkspaces(); err == nil {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: wsList})
		}

	case sessiond.TypeCloseIntent:
		target := sessiond.CloseTarget{
			Kind:        sessiond.CloseTargetKind(msg.TargetKind),
			WorkspaceID: msg.WorkspaceID,
			PaneID:      msg.PaneID,
		}
		outcome, err := c.daemon.CloseIntent(target)
		if err != nil {
			c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, closeRelayFailure(target)))
			return
		}
		c.rememberCloseTicket(outcome)
		c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, outcome))

	case sessiond.TypeCloseConfirm:
		target, knownTarget := c.closeTargetForTicket(msg.Ticket)
		outcome, err := c.daemon.CloseConfirm(msg.Ticket)
		if err != nil {
			c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, closeRelayFailure(target)))
			return
		}
		c.forgetCloseTicket(msg.Ticket)
		if knownTarget {
			outcome = closeOutcomeWithFallbackTarget(outcome, target)
		}
		c.rememberCloseTicket(outcome)
		c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, outcome))

	case sessiond.TypeCreatePane:
		paneID, err := c.daemon.CreatePane(msg.Cmd, msg.Placement, msg.ReferencePaneID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:   sessiond.TypePaneCreated,
			CID:    msg.CID,
			PaneID: paneID,
		})

	case sessiond.TypeResize:
		// Fire-and-forget: the daemon sends no reply.
		if err := c.daemon.Resize(msg.PaneID, msg.Cols, msg.Rows); err != nil {
			log.Printf("handleTextInput: resize error: %v", err)
		}

	case sessiond.TypePaneFocus:
		// Fire-and-forget: the daemon sends no reply.
		if err := c.daemon.PaneFocus(uint32(msg.PaneID), msg.Cols, msg.Rows); err != nil {
			log.Printf("handleTextInput: pane-focus error: %v", err)
		}

	case sessiond.TypeRenamePane:
		if err := c.daemon.RenamePane(msg.PaneID, msg.Name); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeClosePane:
		if err := c.daemon.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		// The daemon broadcasts pane-closed to all subscribers; the ok
		// here is just an ack back to the requesting client.
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeSaveLayout:
		if err := c.daemon.SaveLayout(msg.WorkspaceID, msg.Breakpoint, msg.Layout); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeCreateBrowserPane:
		paneID, err := c.daemon.CreateBrowserPane(msg.Placement, msg.ReferencePaneID)
		if err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneCreated, CID: msg.CID, PaneID: paneID, ClientRef: msg.ClientRef})

	case sessiond.TypeCloseBrowserPane:
		if err := c.daemon.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, msg.WorkspaceID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeBrowserCommand:
		// Client (or agent, once MCP is wired) relays a command; daemon broadcasts
		// it to the workspace so the pane's owner executes it. Fire-and-forget.
		if err := c.daemon.BrowserCommand(msg.PaneID, msg.CID, msg.Params); err != nil {
			log.Printf("handleTextInput: BrowserCommand error: %v", err)
		}

	case sessiond.TypeBrowserResult:
		// Executing client returns the result; daemon broadcasts it back to the
		// workspace (echoing cid) so the waiting requester receives it.
		if err := c.daemon.BrowserResult(msg.PaneID, msg.CID, msg.Result); err != nil {
			log.Printf("handleTextInput: BrowserResult error: %v", err)
		}

	case sessiond.TypeBrowserURL:
		// Client-to-server notification: URL navigation committed. Daemon
		// broadcasts to workspace subscribers so MCP agents can observe
		// navigation. Fire-and-forget.
		if err := c.daemon.BrowserURL(msg.PaneID, msg.URL); err != nil {
			log.Printf("handleTextInput: BrowserURL error: %v", err)
		}

	case sessiond.TypeBrowserLoad:
		// Client-to-server notification: page load complete. Daemon broadcasts
		// to workspace subscribers. Fire-and-forget.
		if err := c.daemon.BrowserLoad(msg.PaneID, msg.URL); err != nil {
			log.Printf("handleTextInput: BrowserLoad error: %v", err)
		}

	default:
		c.sendError(msg.CID, msg.WorkspaceID, fmt.Errorf("unknown action: %s", msg.Type))
	}
}

// sendMessage marshals a frozen sessiond.Message and writes it as a text frame.
func (c *Client) sendMessage(msg *sessiond.Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("sendMessage: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendMessage: write error: %v", err)
	}
}

// sendConfig writes the serve-owned resolved configuration as a text frame.
// This is a serve-local envelope ({"type":"config","config":cfg}), NOT a
// sessiond message.
func (c *Client) sendConfig(cfg any) {
	data, err := json.Marshal(map[string]any{"type": "config", "config": cfg})
	if err != nil {
		log.Printf("sendConfig: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendConfig: write error: %v", err)
	}
}

// sendError relays a TypeError envelope to the browser, echoing cid. A
// *sessiond.DaemonError preserves the machine-readable Code (and its
// human-readable text and workspace id) so the browser sees the original error.
func (c *Client) sendError(cid uint64, workspaceID string, err error) {
	m := &sessiond.Message{
		Type:        sessiond.TypeError,
		CID:         cid,
		WorkspaceID: workspaceID,
		Error:       err.Error(),
	}
	var de *sessiond.DaemonError
	if errors.As(err, &de) {
		m.Code = de.Code
		m.Error = de.Err
		if de.WorkspaceID != "" {
			m.WorkspaceID = de.WorkspaceID
		}
	}
	c.sendMessage(m)
}

// close cancels the client context and closes the connection.
func (c *Client) close() {
	c.cancel()
	if c.conn != nil {
		c.conn.CloseNow()
	}
}

// Hub manages WebSocket clients, dialing one DaemonConn per browser.
type Hub struct {
	clients        map[*Client]bool
	mu             sync.RWMutex
	dial           DialFunc
	resolvedConfig any             // muxterm-owned resolved config, shipped to clients on connect
	tunnels        *TunnelRegistry // shared tunnel registry for /t/{id}/ proxy
}

// SetResolvedConfig stores the resolved configuration on the hub. The config is
// stored as any so the server package takes no dependency on config package's
// concrete type (only marshals to JSON when sending to clients).
func (h *Hub) SetResolvedConfig(cfg any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.resolvedConfig = cfg
}

// BroadcastConfig updates the hub's stored config and sends a {type:"config"}
// frame to every currently-connected client. Used after a PATCH /api/config
// write so all open browser tabs receive the updated configuration immediately.
func (h *Hub) BroadcastConfig(cfg any) {
	h.mu.Lock()
	h.resolvedConfig = cfg
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendConfig(cfg)
	}
}

// sendAIStatus writes the AI capability status as a text frame. Serve-local
// envelope ({"aiStatus":status}), NOT a sessiond message. Deliberately has no
// "type" field -- ws.ts routes flat sessiond messages by their top-level
// "type" string and this frame must never match that path (see sendConfig).
func (c *Client) sendAIStatus(status any) {
	data, err := json.Marshal(map[string]any{"aiStatus": status})
	if err != nil {
		log.Printf("sendAIStatus: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendAIStatus: write error: %v", err)
	}
}

// BroadcastAIStatus sends an {"aiStatus":...} frame to every connected client
// so a key saved in one browser tab flips the capability in all others.
//
// It carries the ai.Status struct only -- which contains no secret by
// construction -- and, unlike BroadcastConfig, caches nothing on the hub: the
// status is cheap to recompute and the browser fetches it on load via
// GET /api/ai/status.
func (h *Hub) BroadcastAIStatus(status any) {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendAIStatus(status)
	}
}

// NewHub creates a new Hub that dials a fresh daemon connection per browser via
// dial. dial may be nil and supplied later via SetDialer. tunnels is nil until
// set by the caller (server.New sets it via hub.tunnels = tunnels).
func NewHub(dial DialFunc) *Hub {
	return &Hub{
		clients: make(map[*Client]bool),
		dial:    dial,
	}
}

// SetDialer installs (or replaces) the per-browser daemon dialer.
func (h *Hub) SetDialer(d DialFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.dial = d
}

// Dial creates a new daemon connection using the hub's configured dialer.
// Returns an error if no dialer is set (server not fully initialized).
func (h *Hub) Dial() (DaemonConn, error) {
	h.mu.Lock()
	dial := h.dial
	h.mu.Unlock()
	if dial == nil {
		return nil, fmt.Errorf("server: no sessiond dialer configured")
	}
	return dial()
}

// attachClient dials a daemon for the browser, installs relay handlers that
// forward daemon events to the browser, starts the connection's read loop, and
// seeds the browser with config and the workspace list.
func (h *Hub) attachClient(c *Client) error {
	h.mu.RLock()
	dial := h.dial
	cfg := h.resolvedConfig
	h.mu.RUnlock()

	if dial == nil {
		return fmt.Errorf("attachClient: no dialer configured")
	}

	dc, err := dial()
	if err != nil {
		return fmt.Errorf("attachClient: dial: %w", err)
	}
	c.daemon = dc

	dc.SetHandlers(sessiond.Handlers{
		OnPaneOutput: func(paneID uint32, data []byte) {
			// Blocks while an Attach() reply is being forwarded to the
			// browser/app WebSocket (see attachSeq), so replay frames for the
			// pane just announced in that composition can never overtake it
			// on the wire.
			c.attachSeq.Lock()
			err := c.writeBinary(EncodeBinaryFrame(paneID, data))
			c.attachSeq.Unlock()
			if err != nil {
				log.Printf("attachClient: pane output write error: %v", err)
			}
		},
		OnPaneAdded: func(pane sessiond.PaneInfo) {
			c.sendMessage(&sessiond.Message{
				Type:            sessiond.TypePaneAdded,
				WorkspaceID:     c.getWorkspaceID(),
				PaneID:          pane.PaneID,
				Cols:            pane.Cols,
				Rows:            pane.Rows,
				Title:           pane.Title,
				SurfaceKind:     pane.SurfaceKind,
				Placement:       pane.Placement,
				ReferencePaneID: pane.ReferencePaneID,
			})
		},
		OnPaneClosedWithWorkspace: func(workspaceID string, paneID int, processExitCode *int, runtimeMs int64) {
			c.sendMessage(&sessiond.Message{
				Type: sessiond.TypePaneClosed, WorkspaceID: workspaceID, PaneID: paneID,
				ProcessExitCode: processExitCode, RuntimeMs: runtimeMs,
			})
		},
		OnWorkspaceClosed: func(workspaceID string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceClosed, WorkspaceID: workspaceID})
		},
		OnWorkspaceRenamed: func(workspaceID, name string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceRenamed, WorkspaceID: workspaceID, Name: name})
		},
		OnWorkspaceList: func(workspaces []sessiond.WorkspaceInfo) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: workspaces})
		},
		OnPaneRenamed: func(paneID int, name string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneRenamed, PaneID: paneID, Name: name})
		},
		OnPaneResized: func(paneID uint32, cols, rows int) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneResized, PaneID: int(paneID), Cols: cols, Rows: rows})
		},
		OnBrowserCommand: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:     sessiond.TypeBrowserCommand,
				PaneID:   msg.PaneID,
				CID:      msg.CID,
				Action:   msg.Action,
				Selector: msg.Selector,
				Params:   msg.Params,
			})
		},
		OnBrowserResult: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:   sessiond.TypeBrowserResult,
				PaneID: msg.PaneID,
				CID:    msg.CID,
				Result: msg.Result,
				Error:  msg.Error,
			})
		},
		OnBrowserURL: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:   sessiond.TypeBrowserURL,
				PaneID: msg.PaneID,
				URL:    msg.URL,
			})
		},
		OnBrowserLoad: func(msg *sessiond.Message) {
			c.sendMessage(&sessiond.Message{
				Type:   sessiond.TypeBrowserLoad,
				PaneID: msg.PaneID,
				URL:    msg.URL,
			})
		},
	})

	go func() {
		if err := dc.Run(); err != nil {
			// net.ErrClosed means hub.Remove closed the daemon connection while
			// dc.Run was blocked in ReadFrame — this is the normal teardown path
			// (readPump exited → hub.Remove → c.daemon.Close → dc.Run unblocks).
			// Don't log noise on every normal browser disconnect.
			//
			// Any other error means the daemon dropped unexpectedly (crash, EOF,
			// etc.) while the browser WebSocket may still be open. Remove the
			// client so the WebSocket is closed and the browser reconnects.
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("attachClient: daemon run exited: %v", err)
			h.Remove(c)
		}
	}()

	if cfg != nil {
		c.sendConfig(cfg)
	}

	workspaces, err := dc.ListWorkspaces()
	if err != nil {
		log.Printf("attachClient: ListWorkspaces error: %v", err)
	} else {
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceList, Workspaces: workspaces})
	}

	return nil
}

// Add registers a client in the hub and attaches its daemon connection. If
// attachment fails the client is immediately removed so the WebSocket is
// closed and the browser can reconnect rather than hanging in a broken state.
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
	if err := h.attachClient(c); err != nil {
		log.Printf("Add: attachClient error: %v", err)
		h.Remove(c)
	}
}

// Remove deletes a client from the hub, closes its daemon connection, and
// closes the client.
func (h *Hub) Remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		if c.daemon != nil {
			_ = c.daemon.Close()
		}
		c.close()
	}
}

// ClientCount returns the number of connected clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// handleWSImpl handles the WebSocket upgrade and client lifecycle.
func (s *Server) handleWSImpl(w http.ResponseWriter, r *http.Request) {
	// Auth is now handled uniformly by AuthMiddleware at the mux level
	// (GET /ws is wrapped in server.go's New()) — no inline check needed
	// here anymore.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}

	conn.SetReadLimit(1 << 20) // 1MB

	client := newClient(s.hub, conn)
	s.hub.Add(client)
	go client.readPump()
}

// NewServerMsg marshals a single-key JSON object: {msgType: payload}.
func NewServerMsg(msgType string, payload interface{}) ([]byte, error) {
	m := map[string]interface{}{msgType: payload}
	return json.Marshal(m)
}

// EncodeBinaryFrame creates a binary frame: [4-byte LE uint32 pane_id][data].
func EncodeBinaryFrame(paneID uint32, data []byte) []byte {
	frame := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(frame[:4], paneID)
	copy(frame[4:], data)
	return frame
}

// DecodeBinaryFrame extracts pane ID and data from a binary frame.
// Returns an error if the frame is shorter than 4 bytes.
func DecodeBinaryFrame(frame []byte) (uint32, []byte, error) {
	if len(frame) < 4 {
		return 0, nil, fmt.Errorf("binary frame too short: %d bytes, need at least 4", len(frame))
	}
	paneID := binary.LittleEndian.Uint32(frame[:4])
	return paneID, frame[4:], nil
}
