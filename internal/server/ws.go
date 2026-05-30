package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/user/muxterm/internal/tmux"
)

// TmuxEngine defines the interface for interacting with tmux.
type TmuxEngine interface {
	// State returns the in-memory cached state — used only for pane lookups
	// during event routing. Never use this for state syncs to clients.
	State() *tmux.TmuxState
	// LiveState queries tmux directly for current session/window/pane structure.
	// Always reflects ground truth regardless of missed events.
	LiveState() (*tmux.TmuxState, error)
	SendKeys(paneID, keys string) error
	SelectWindow(windowID string) error
	SelectPane(paneID string) error
	SplitWindow(targetPaneID string, horizontal bool) error
	ResizePane(paneID string, cols, rows int) error
	ScrollPane(paneID string, up bool, lines int) error
	NewWindow(sessionID string) error
	KillPane(paneID string) error
	CloseWindow(windowID string) error
	RenameWindow(windowID, name string) error
	NewSession(name string) error
	// CapturePaneContent returns the current screen content of a pane
	// (-e preserves ANSI escape sequences). Used to populate new clients
	// with existing terminal output on connect.
	CapturePaneContent(paneID string) ([]byte, error)
}

// Client represents a connected WebSocket client.
type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex
}

// newClient creates a new Client with a cancellable context.
func newClient(hub *Hub, conn *websocket.Conn) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		hub:    hub,
		conn:   conn,
		ctx:    ctx,
		cancel: cancel,
	}
}

// writeBinary writes a binary message with a 5-second timeout.
func (c *Client) writeBinary(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()

	return c.conn.Write(ctx, websocket.MessageBinary, data)
}

// writeText writes a text message with a 5-second timeout.
func (c *Client) writeText(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()

	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()

	return c.conn.Write(ctx, websocket.MessageText, data)
}

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

// handleBinaryInput decodes a binary frame and routes the payload to tmux SendKeys.
func (c *Client) handleBinaryInput(data []byte) {
	paneID, payload, err := DecodeBinaryFrame(data)
	if err != nil {
		log.Printf("handleBinaryInput: decode error: %v", err)
		return
	}

	if c.hub.engine == nil {
		log.Printf("handleBinaryInput: no engine available")
		return
	}

	if err := c.hub.engine.SendKeys(Uint32ToPaneID(paneID), string(payload)); err != nil {
		log.Printf("handleBinaryInput: SendKeys error: %v", err)
	}
}

// close cancels the client context and closes the connection.
func (c *Client) close() {
	c.cancel()
	c.conn.CloseNow()
}

// Hub manages WebSocket clients and their interaction with the tmux engine.
type Hub struct {
	clients map[*Client]bool
	mu      sync.RWMutex
	engine  TmuxEngine
}

// NewHub creates a new Hub with the given tmux engine.
func NewHub(engine TmuxEngine) *Hub {
	return &Hub{
		clients: make(map[*Client]bool),
		engine:  engine,
	}
}

// Add registers a client in the hub and sends a state sync.
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()
	h.sendStateSync(c)
}

// Remove deletes a client from the hub and closes it.
func (h *Hub) Remove(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
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
	// Auth: allow localhost OR valid token
	if !IsLocalhost(r) {
		token := r.URL.Query().Get("token")
		if !ValidateToken(token, s.secret, 30*time.Second) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

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

// NewErrorMsg marshals {"error": msg}.
func NewErrorMsg(msg string) []byte {
	data, _ := json.Marshal(map[string]string{"error": msg})
	return data
}

// BroadcastEvent creates a JSON message via NewServerMsg and broadcasts it
// as a text frame to all connected clients.
func (h *Hub) BroadcastEvent(eventType string, payload interface{}) {
	data, err := NewServerMsg(eventType, payload)
	if err != nil {
		log.Printf("BroadcastEvent: marshal error: %v", err)
		return
	}
	h.broadcastText(data)
}

// broadcastText sends data as a text frame to all connected clients.
// Clients that fail to receive are removed.
func (h *Hub) broadcastText(data []byte) {
	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		if err := c.writeText(data); err != nil {
			h.Remove(c)
		}
	}
}

// sendStateSync sends the live tmux state to a client using the "full-sync"
// key (distinct from the periodic "state" key). The browser uses "full-sync" to
// do a full state replace + terminal reset, whereas periodic "state" pushes only
// trigger structural reconciliation without clearing terminal content.
// Uses LiveState() (direct tmux query) so the snapshot is always accurate
// regardless of any missed %window-close events.
// After the JSON frame, binary pane-content frames are sent for every pane.
func (h *Hub) sendStateSync(c *Client) {
	if h.engine == nil {
		return
	}
	// LiveState() queries tmux directly — always accurate, never stale.
	state, liveErr := h.engine.LiveState()
	if liveErr != nil {
		// Fall back to cached state if the live query fails (e.g. tmux not responding).
		log.Printf("sendStateSync: live query failed: %v (using cached state)", liveErr)
		state = h.engine.State()
	}
	// "full-sync" (not "state") tells the browser to do a full replace + terminal
	// reset. Periodic pushes use "state" for structural reconciliation only.
	data, err := json.Marshal(map[string]interface{}{"full-sync": state})
	if err != nil {
		log.Printf("sendStateSync: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendStateSync: write error: %v", err)
		return
	}

	// Send captured screen content for every pane so the browser shows
	// what was already on screen before this client connected.
	// tmux control mode only emits %output for new data, so without this
	// the browser would show a blank terminal until the next keystroke.
	state.ForEachPane(func(paneID string) {
		content, captureErr := h.engine.CapturePaneContent(paneID)
		if captureErr != nil || len(content) == 0 {
			return
		}
		id, parseErr := PaneIDToUint32(paneID)
		if parseErr != nil {
			return
		}
		frame := EncodeBinaryFrame(id, content)
		if err := c.writeBinary(frame); err != nil {
			log.Printf("sendStateSync: pane %s write error: %v", paneID, err)
		}
	})
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

// PaneIDToUint32 converts a tmux pane ID string like "%N" to uint32 N.
func PaneIDToUint32(id string) (uint32, error) {
	if !strings.HasPrefix(id, "%") {
		return 0, fmt.Errorf("pane ID %q missing '%%' prefix", id)
	}
	n, err := strconv.ParseUint(id[1:], 10, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid pane ID %q: %w", id, err)
	}
	return uint32(n), nil
}

// Uint32ToPaneID converts uint32 N to the tmux pane ID string "%N".
func Uint32ToPaneID(id uint32) string {
	return "%" + strconv.FormatUint(uint64(id), 10)
}

// parseClientMessage unmarshals a JSON object and returns the first key+value.
// Returns an error on invalid JSON or empty object.
func parseClientMessage(data []byte) (string, json.RawMessage, error) {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return "", nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if len(msg) == 0 {
		return "", nil, fmt.Errorf("empty message")
	}
	for k, v := range msg {
		return k, v, nil
	}
	return "", nil, fmt.Errorf("empty message")
}

// dispatchAction routes a client action to the appropriate tmux engine method.
func (h *Hub) dispatchAction(action string, payload json.RawMessage) error {
	if h.engine == nil {
		return fmt.Errorf("no engine available")
	}

	switch action {
	case "select-window":
		var windowID string
		if err := json.Unmarshal(payload, &windowID); err != nil {
			return fmt.Errorf("select-window: %w", err)
		}
		return h.engine.SelectWindow(windowID)

	case "select-pane":
		var paneID string
		if err := json.Unmarshal(payload, &paneID); err != nil {
			return fmt.Errorf("select-pane: %w", err)
		}
		return h.engine.SelectPane(paneID)

	case "split":
		var p struct {
			Direction string `json:"direction"`
			Pane      string `json:"pane"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("split: %w", err)
		}
		return h.engine.SplitWindow(p.Pane, p.Direction == "horizontal")

	case "resize-pane":
		var p struct {
			ID   string `json:"id"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("resize-pane: %w", err)
		}
		return h.engine.ResizePane(p.ID, p.Cols, p.Rows)

	case "pane-scroll":
		var p struct {
			ID    string `json:"id"`
			Up    bool   `json:"up"`
			Lines int    `json:"lines"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("pane-scroll: %w", err)
		}
		return h.engine.ScrollPane(p.ID, p.Up, p.Lines)

	case "new-window":
		return h.engine.NewWindow("")

	case "close-pane":
		var paneID string
		if err := json.Unmarshal(payload, &paneID); err != nil {
			return fmt.Errorf("close-pane: %w", err)
		}
		return h.engine.KillPane(paneID)

	case "close-window":
		var windowID string
		if err := json.Unmarshal(payload, &windowID); err != nil {
			return fmt.Errorf("close-window: %w", err)
		}
		return h.engine.CloseWindow(windowID)

	case "rename-window":
		var p struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("rename-window: %w", err)
		}
		return h.engine.RenameWindow(p.ID, p.Name)

	case "create-session":
		var p struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("create-session: %w", err)
		}
		return h.engine.NewSession(p.Name)

	default:
		return fmt.Errorf("unknown action: %s", action)
	}
}

// handleTextInput parses a text message as a JSON action and dispatches it.
func (c *Client) handleTextInput(data []byte) {
	action, payload, err := parseClientMessage(data)
	if err != nil {
		c.writeText(NewErrorMsg(err.Error()))
		return
	}

	// request-sync: client asks for a fresh full-sync (state + capture-pane for all
	// panes). Sent by the browser after its first pane-resize so that capture-pane
	// content is re-delivered at the correct terminal dimensions instead of the stale
	// dimensions tmux had before the browser reported its size.
	if action == "request-sync" {
		go func() {
			// Brief pause so tmux has time to finish processing the preceding
			// resize-pane command before we call capture-pane.
			timer := time.NewTimer(50 * time.Millisecond)
			select {
			case <-timer.C:
				c.hub.sendStateSync(c)
			case <-c.ctx.Done():
				timer.Stop()
			}
		}()
		_ = payload
		return
	}

	if err := c.hub.dispatchAction(action, payload); err != nil {
		c.writeText(NewErrorMsg(err.Error()))
	}
}

// HandleTmuxDisconnect handles a tmux control mode disconnection by
// broadcasting a detached event to all clients, attempting reconnect with
// exponential backoff, and broadcasting a full state sync on success.
// If reconnect fails, a final detached message is broadcast.
func (h *Hub) HandleTmuxDisconnect(ctrl *tmux.ControlMode, readErr error) {
	h.BroadcastEvent("detached", map[string]string{"reason": readErr.Error()})

	cfg := tmux.DefaultReconnectConfig()
	err := ctrl.Reconnect(cfg,
		func(reason string) {
			log.Printf("tmux disconnected: %s", reason)
		},
		func() {
			if h.engine != nil {
				h.BroadcastEvent("state", h.engine.State())
			}
		},
	)

	if err != nil {
		h.BroadcastEvent("detached", map[string]string{"reason": err.Error()})
	}
}

// BroadcastPaneCapture runs CapturePaneContent for paneID and broadcasts the
// result to all connected clients as a binary pane-output frame. Used when
// the active window changes so clients immediately see existing terminal content
// rather than waiting for the next live %output event.
func (h *Hub) BroadcastPaneCapture(paneID string) {
	if h.engine == nil {
		return
	}
	content, err := h.engine.CapturePaneContent(paneID)
	if err != nil || len(content) == 0 {
		return
	}
	h.BroadcastPaneOutput(paneID, content)
}

// BroadcastPaneOutput encodes pane output as a binary frame and broadcasts
// it to all connected clients. Clients that fail to receive are removed.
func (h *Hub) BroadcastPaneOutput(paneID string, data []byte) {
	id, err := PaneIDToUint32(paneID)
	if err != nil {
		return
	}
	frame := EncodeBinaryFrame(id, data)

	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		if err := c.writeBinary(frame); err != nil {
			h.Remove(c)
		}
	}
}
