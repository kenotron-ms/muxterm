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

	// Cache the frame so reconnecting clients receive it immediately on connect.
	h.browserMu.Lock()
	h.lastBrowserFrames[paneID] = frame
	h.browserMu.Unlock()
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

	// Register in browserClients and replay any cached frames so the canvas is
	// not blank after a page refresh (Chromium's screencast only emits new
	// frames when the page changes; a static loaded page produces none).
	s.hub.browserMu.Lock()
	s.hub.browserClients[c] = true
	for _, frame := range s.hub.lastBrowserFrames {
		c.writeBinary(frame) // ignore error — buffer absorbs it before the read loop starts
	}
	s.hub.browserMu.Unlock()

	// Take a fresh screenshot for each active browser pane so the canvas is
	// never blank on reconnect even when Chrome has stopped screencasting a
	// static page (no visual changes → no new frames → stale or empty cache).
	if s.hub.browserManager != nil {
		for _, paneID := range s.hub.browserManager.ActivePaneIDs() {
			if shot, err := s.hub.browserManager.ScreenshotPage(paneID); err == nil && len(shot) > 0 {
				frame := EncodeBinaryFrame(uint32(paneID), shot)
				c.writeBinary(frame) // ignore error — client just connected
			}
		}
	}

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
		if err := bp.HandleInput(ctx, env.Event); err != nil {
			log.Printf("handleWSBrowserImpl: HandleInput error: %v", err)
		}
		// For browser-ready: send a fresh screenshot directly to this client
		// (not broadcast) so the canvas is immediately populated on mount.
		if env.Event.Type == "browser-ready" && s.hub.browserManager != nil {
			if shot, err := s.hub.browserManager.ScreenshotPage(env.PaneID); err == nil && len(shot) > 0 {
				frame := EncodeBinaryFrame(uint32(env.PaneID), shot)
				c.writeBinary(frame)
			}
		}
	}
}
