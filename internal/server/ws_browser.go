package server

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// browserWSConn represents a connected /ws/browser WebSocket client. It owns
// no terminal state; it only relays JPEG frames from the headless browser and
// forwards input events back to the BrowserManager.
type browserWSConn struct {
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex
}

// writeBinary writes a binary frame to the connection with a 5-second timeout.
// Errors are logged but not returned; a slow or dead client times out without
// blocking the broadcast loop.
func (c *browserWSConn) writeBinary(data []byte) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer wcancel()
	if err := c.conn.Write(wctx, websocket.MessageBinary, data); err != nil {
		log.Printf("browserWSConn.writeBinary: %v", err)
	}
}

// writeText writes a text frame to the connection with a 5-second timeout.
// Errors are logged but not returned.
func (c *browserWSConn) writeText(data []byte) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer wcancel()
	if err := c.conn.Write(wctx, websocket.MessageText, data); err != nil {
		log.Printf("browserWSConn.writeText: %v", err)
	}
}

// BroadcastBrowserFrame sends [4-byte LE paneId][JPEG bytes] to every
// connected /ws/browser client. The frame is encoded once and fanned out;
// the 5-second write timeout in writeBinary ensures a slow client cannot
// stall others.
func (h *Hub) BroadcastBrowserFrame(paneID int, data []byte) {
	frame := EncodeBinaryFrame(uint32(paneID), data)

	h.browserMu.RLock()
	clients := make([]*browserWSConn, 0, len(h.browserClients))
	for c := range h.browserClients {
		clients = append(clients, c)
	}
	h.browserMu.RUnlock()

	for _, c := range clients {
		c.writeBinary(frame)
	}
}

// BroadcastBrowserJSON marshals msg to JSON and sends it as a text frame to
// every connected /ws/browser client. Marshal errors are logged and the
// broadcast is aborted early.
func (h *Hub) BroadcastBrowserJSON(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("BroadcastBrowserJSON: marshal error: %v", err)
		return
	}

	h.browserMu.RLock()
	clients := make([]*browserWSConn, 0, len(h.browserClients))
	for c := range h.browserClients {
		clients = append(clients, c)
	}
	h.browserMu.RUnlock()

	for _, c := range clients {
		c.writeText(data)
	}
}

// handleWSBrowserImpl handles the /ws/browser WebSocket upgrade and client
// lifecycle. It mirrors the auth and upgrade pattern of handleWSImpl but
// routes to the BrowserManager rather than the sessiond daemon.
func (s *Server) handleWSBrowserImpl(w http.ResponseWriter, r *http.Request) {
	// Auth: same policy as /ws. Allow localhost unconditionally; require a
	// valid token for remote callers unless --no-auth is set.
	if !s.noAuth && !IsLocalhost(r) {
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

	conn.SetReadLimit(1 << 20) // 1 MB

	ctx, cancel := context.WithCancel(context.Background())
	c := &browserWSConn{
		conn:   conn,
		ctx:    ctx,
		cancel: cancel,
	}

	// Register in browserClients.
	s.hub.browserMu.Lock()
	s.hub.browserClients[c] = true
	s.hub.browserMu.Unlock()

	// Deferred cleanup: remove from registry, cancel context, close connection.
	defer func() {
		s.hub.browserMu.Lock()
		delete(s.hub.browserClients, c)
		s.hub.browserMu.Unlock()
		cancel()
		conn.CloseNow()
	}()

	// Read loop: block until the client disconnects or sends browser input.
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			// Normal disconnect or context cancellation.
			return
		}

		// Unmarshal the JSON envelope: {type, paneId, event}.
		var env struct {
			Type   string                   `json:"type"`
			PaneID int                      `json:"paneId"`
			Event  sessiond.BrowserInputMsg `json:"event"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			continue // Skip malformed frames.
		}
		if env.Type != sessiond.TypeBrowserInput {
			continue // Skip unrecognised message types.
		}
		if s.hub.browserManager == nil {
			continue // BrowserManager not yet initialised.
		}
		bp, ok := s.hub.browserManager.GetPage(env.PaneID)
		if !ok {
			continue // No open page for this pane.
		}
		if err := bp.HandleInput(env.Event); err != nil {
			log.Printf("handleWSBrowserImpl: HandleInput error: %v", err)
		}
	}
}
