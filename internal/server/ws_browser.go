package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// browserConnCounter generates stable per-connection client IDs. IDs are
// monotonically increasing and unique within one process lifetime.
var browserConnCounter atomic.Uint64

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

// handleWSBrowserImpl handles the /ws/browser WebSocket upgrade and client
// lifecycle. Each connection dials its own daemon connection and relays frames
// bidirectionally between the WebSocket and the daemon.
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

	// Assign a stable client ID for this WebSocket connection.
	clientID := fmt.Sprintf("ws-%d", browserConnCounter.Add(1))

	// Dial a dedicated daemon connection for this browser WebSocket.
	dc, err := s.hub.Dial()
	if err != nil {
		log.Printf("handleWSBrowserImpl: dial daemon: %v", err)
		conn.CloseNow()
		return
	}
	defer dc.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var writeMu sync.Mutex

	writeBinary := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
		defer wcancel()
		if err := conn.Write(wctx, websocket.MessageBinary, data); err != nil {
			log.Printf("handleWSBrowserImpl: writeBinary: %v", err)
		}
	}
	writeText := func(data []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
		defer wcancel()
		if err := conn.Write(wctx, websocket.MessageText, data); err != nil {
			log.Printf("handleWSBrowserImpl: writeText: %v", err)
		}
	}

	// Install relay handlers: JPEG frames → binary WebSocket frames;
	// browser JSON events → text WebSocket frames.
	dc.SetHandlers(sessiond.Handlers{
		OnBrowserFrame: func(paneID uint32, jpeg []byte) {
			writeBinary(EncodeBinaryFrame(paneID, jpeg))
		},
		OnBrowserMsg: func(msg *sessiond.Message) {
			// Prefer the original JSON (RawPayload) to preserve field names
			// like "cursor" and "url" that don't have Message struct fields.
			if len(msg.RawPayload) > 0 {
				writeText(msg.RawPayload)
				return
			}
			data, err := json.Marshal(msg)
			if err != nil {
				log.Printf("handleWSBrowserImpl: marshal OnBrowserMsg: %v", err)
				return
			}
			writeText(data)
		},
	})

	// Start daemon read loop in background. When it exits, cancel context so
	// the WebSocket read loop also exits.
	go func() {
		if err := dc.Run(); err != nil && !errors.Is(err, net.ErrClosed) {
			log.Printf("handleWSBrowserImpl: daemon run: %v", err)
		}
		cancel()
	}()

	defer conn.CloseNow()

	// Read loop: forward WebSocket input events to the daemon.
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}

		var env struct {
			Type         string          `json:"type"`
			PaneID       int             `json:"paneId"`
			Event        json.RawMessage `json:"event"`
			DeviceID     string          `json:"deviceId"`
			RenderWidth  int             `json:"renderWidth"`
			RenderHeight int             `json:"renderHeight"`
		}
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}

		switch env.Type {
		case sessiond.TypeBrowserFocus:
			if err := dc.BrowserFocus(env.PaneID, clientID, env.DeviceID, env.RenderWidth, env.RenderHeight); err != nil {
				log.Printf("handleWSBrowserImpl: BrowserFocus: %v", err)
			}
		case sessiond.TypeBrowserBlur:
			if err := dc.BrowserBlur(env.PaneID, clientID, env.DeviceID); err != nil {
				log.Printf("handleWSBrowserImpl: BrowserBlur: %v", err)
			}
		case sessiond.TypeBrowserInput:
			if len(env.Event) == 0 {
				continue
			}
			if err := dc.BrowserInput(env.PaneID, clientID, env.Event); err != nil {
				log.Printf("handleWSBrowserImpl: BrowserInput: %v", err)
			}
		}
	}
}
