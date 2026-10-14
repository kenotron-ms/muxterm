package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

type browserAssistantControl struct {
	ID      string `json:"id"`
	Origin  string `json:"origin"`
	Managed bool   `json:"managed"`
}

type browserAssistantCommand struct {
	Action   string  `json:"action"`
	Selector string  `json:"selector,omitempty"`
	Text     string  `json:"text,omitempty"`
	URL      string  `json:"url,omitempty"`
	Key      string  `json:"key,omitempty"`
	X        float64 `json:"x,omitempty"`
	Y        float64 `json:"y,omitempty"`
	DeltaX   float64 `json:"deltaX,omitempty"`
	DeltaY   float64 `json:"deltaY,omitempty"`
	TabID    int     `json:"tabId,omitempty"`
}

func stopBrowserControl(connection *browserAssistantConnection) {
	connection.Control = nil
	for _, request := range connection.Requests {
		if request.Command != nil && (request.Status == "pending" || request.Status == "running") {
			request.Status = "cancelled"
			request.Error = "Browser control stopped; an action already dispatched may have taken effect."
			clearBrowserCommandInput(request)
		}
	}
}

func clearBrowserCommandInput(request *browserAssistantRequest) {
	if request.Command != nil {
		request.Command.Text = ""
		request.Command.Selector = ""
		request.Command.URL = ""
	}
}

func (server *Server) registerBrowserAutomationRoutes(protect func(http.Handler) http.Handler) {
	server.mux.HandleFunc("GET /api/browser-assistant/workspace", func(writer http.ResponseWriter, httpRequest *http.Request) {
		writer.Header().Set("Content-Type", "text/html; charset=utf-8")
		writer.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
		_, _ = writer.Write([]byte(`<!doctype html><title>Muxterm browser workspace</title><style>body{font:18px system-ui;background:#f5f7fb;color:#202b42;padding:12vh 10vw}h1{font-size:36px}p{max-width:560px;line-height:1.7}</style><h1>Your browser workspace</h1><p>Ready for your muxterm agent. It can open pages here for setup, everyday work, and verification. Your other browser windows stay outside this workspace.</p><p>Use the Browser Assistant toggle to pause access at any time.</p>`))
	})
	server.mux.Handle("POST /api/browser-assistant/connections/{id}/commands", protect(http.HandlerFunc(server.handleBrowserCommand)))
	server.mux.Handle("DELETE /api/browser-assistant/connections/{id}/control", protect(http.HandlerFunc(server.handleBrowserControlStop)))
	server.mux.HandleFunc("POST /api/browser-assistant/bridge/{id}/control", server.handleBrowserControl)
	server.mux.HandleFunc("POST /api/browser-assistant/bridge/{id}/commands/{request}/start", server.handleBrowserCommandStart)
	server.mux.HandleFunc("POST /api/browser-assistant/bridge/{id}/commands/{request}/result", server.handleBrowserCommandResult)
}

func (server *Server) handleBrowserControl(writer http.ResponseWriter, httpRequest *http.Request) {
	var body struct {
		Active  bool   `json:"active"`
		Origin  string `json:"origin"`
		Managed bool   `json:"managed"`
	}
	if !browserAssistantDecode(writer, httpRequest, &body) {
		return
	}
	registry := server.browserAssistant
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.prune()
	connection := server.browserAssistantBridge(httpRequest)
	if connection == nil {
		http.Error(writer, "Browser pairing unavailable", http.StatusUnauthorized)
		return
	}
	stopBrowserControl(connection)
	if body.Active {
		if len(body.Origin) > 300 || (!strings.HasPrefix(body.Origin, "https://") && !strings.HasPrefix(body.Origin, "http://")) {
			http.Error(writer, "Invalid origin", http.StatusBadRequest)
			return
		}
		id, err := randomURLSafeString(16)
		if err != nil {
			http.Error(writer, "Cannot authorize control", http.StatusInternalServerError)
			return
		}
		connection.Control = &browserAssistantControl{ID: id, Origin: body.Origin, Managed: body.Managed}
	}
	browserAssistantJSON(writer, http.StatusOK, map[string]any{"control": connection.Control})
}

func (server *Server) handleBrowserControlStop(writer http.ResponseWriter, httpRequest *http.Request) {
	if !server.browserAssistantMutation(writer, httpRequest) {
		return
	}
	registry := server.browserAssistant
	registry.mu.Lock()
	defer registry.mu.Unlock()
	connection := registry.connections[httpRequest.PathValue("id")]
	if connection == nil || connection.Owner != server.browserAssistantOwner(httpRequest) {
		http.Error(writer, "Browser not found", http.StatusNotFound)
		return
	}
	stopBrowserControl(connection)
	browserAssistantJSON(writer, http.StatusOK, map[string]bool{"stopped": true})
}

func (server *Server) handleBrowserCommand(writer http.ResponseWriter, httpRequest *http.Request) {
	if !server.browserAssistantMutation(writer, httpRequest) {
		return
	}
	var body struct {
		Reason  string                  `json:"reason"`
		Command browserAssistantCommand `json:"command"`
	}
	if !browserAssistantDecode(writer, httpRequest, &body) {
		return
	}
	switch body.Command.Action {
	case "inspect", "screenshot", "navigate", "click", "type", "key", "scroll", "tabs", "new_tab", "select_tab":
	default:
		http.Error(writer, "Unsupported browser action", http.StatusBadRequest)
		return
	}
	if len(body.Reason) == 0 || len(body.Reason) > 300 || len(body.Command.Selector) > 1000 || len(body.Command.Text) > 16000 || len(body.Command.URL) > 4000 || len(body.Command.Key) > 40 {
		http.Error(writer, "Invalid command size or purpose", http.StatusBadRequest)
		return
	}
	registry := server.browserAssistant
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.prune()
	connection := registry.connections[httpRequest.PathValue("id")]
	if connection == nil || connection.Owner != server.browserAssistantOwner(httpRequest) {
		http.Error(writer, "Browser not found", http.StatusNotFound)
		return
	}
	if connection.Control == nil {
		http.Error(writer, "Authorize tab control in the local extension first", http.StatusConflict)
		return
	}
	for _, request := range connection.Requests {
		if request.Command != nil && (request.Status == "pending" || request.Status == "running") {
			http.Error(writer, "One browser action at a time; retrieve the previous result first", http.StatusConflict)
			return
		}
	}
	if len(connection.Requests) >= 64 {
		var oldest *browserAssistantRequest
		for _, previous := range connection.Requests {
			if previous.Status != "pending" && previous.Status != "running" && (oldest == nil || previous.Expires.Before(oldest.Expires)) {
				oldest = previous
			}
		}
		if oldest == nil {
			http.Error(writer, "Browser history full", http.StatusTooManyRequests)
			return
		}
		delete(connection.Requests, oldest.ID)
	}
	id, err := randomURLSafeString(12)
	if err != nil {
		http.Error(writer, "Cannot create command", http.StatusInternalServerError)
		return
	}
	request := &browserAssistantRequest{ID: id, ConnectionID: connection.ID, Reason: body.Reason, Command: &body.Command, ControlID: connection.Control.ID, Status: "pending", Expires: time.Now().Add(time.Minute)}
	connection.Requests[id] = request
	browserAssistantJSON(writer, http.StatusAccepted, request)
}

func (server *Server) handleBrowserCommandStart(writer http.ResponseWriter, httpRequest *http.Request) {
	registry := server.browserAssistant
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.prune()
	connection := server.browserAssistantBridge(httpRequest)
	if connection == nil {
		http.Error(writer, "Browser pairing unavailable", http.StatusUnauthorized)
		return
	}
	request := connection.Requests[httpRequest.PathValue("request")]
	if request == nil || request.Command == nil || request.Status != "pending" || connection.Control == nil || request.ControlID != connection.Control.ID {
		http.Error(writer, "Command no longer authorized", http.StatusConflict)
		return
	}
	request.Status = "running"
	browserAssistantJSON(writer, http.StatusOK, request)
}

func (server *Server) handleBrowserCommandResult(writer http.ResponseWriter, httpRequest *http.Request) {
	var body struct {
		Result json.RawMessage `json:"result"`
		Error  string          `json:"error"`
	}
	httpRequest.Body = http.MaxBytesReader(writer, httpRequest.Body, 2<<20)
	decoder := json.NewDecoder(httpRequest.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil || len(body.Error) > 1000 {
		http.Error(writer, "Invalid browser result", http.StatusBadRequest)
		return
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		http.Error(writer, "Only one browser result is allowed", http.StatusBadRequest)
		return
	}
	registry := server.browserAssistant
	registry.mu.Lock()
	defer registry.mu.Unlock()
	registry.prune()
	connection := server.browserAssistantBridge(httpRequest)
	if connection == nil {
		http.Error(writer, "Browser pairing unavailable", http.StatusUnauthorized)
		return
	}
	request := connection.Requests[httpRequest.PathValue("request")]
	if request == nil || request.Command == nil || request.Status != "running" || connection.Control == nil || request.ControlID != connection.Control.ID {
		http.Error(writer, "Command no longer authorized", http.StatusConflict)
		return
	}
	request.Status = "completed"
	clearBrowserCommandInput(request)
	retained := 0
	for _, browser := range registry.connections {
		for _, previous := range browser.Requests {
			retained += len(previous.Result)
		}
	}
	for retained+len(body.Result) > 16<<20 {
		var oldest *browserAssistantRequest
		for _, browser := range registry.connections {
			for _, previous := range browser.Requests {
				if len(previous.Result) > 0 && (oldest == nil || previous.Expires.Before(oldest.Expires)) {
					oldest = previous
				}
			}
		}
		if oldest == nil {
			break
		}
		retained -= len(oldest.Result)
		oldest.Result = nil
		oldest.Error = "Result evicted from bounded history; action already completed."
	}
	request.Result = body.Result
	request.Error = body.Error
	if body.Error != "" {
		request.Status = "failed"
	}
	browserAssistantJSON(writer, http.StatusOK, map[string]bool{"accepted": true})
}
