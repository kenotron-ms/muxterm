package server

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

type browserAssistantPairing struct {
	Owner   string
	Expires time.Time
}

type browserAssistantSnapshot struct {
	Title    string   `json:"title"`
	URL      string   `json:"url"`
	Headings []string `json:"headings"`
	Buttons  []string `json:"buttons"`
	Links    []string `json:"links"`
}

type browserAssistantRequest struct {
	ID           string                    `json:"id"`
	ConnectionID string                    `json:"connectionId"`
	Reason       string                    `json:"reason"`
	Status       string                    `json:"status"`
	Expires      time.Time                 `json:"expiresAt"`
	Snapshot     *browserAssistantSnapshot `json:"snapshot,omitempty"`
	Command      *browserAssistantCommand  `json:"command,omitempty"`
	ControlID    string                    `json:"controlId,omitempty"`
	Result       json.RawMessage           `json:"result,omitempty"`
	Error        string                    `json:"error,omitempty"`
}

type browserAssistantConnection struct {
	ID        string                              `json:"id"`
	Name      string                              `json:"name"`
	Expires   *time.Time                          `json:"expiresAt,omitempty"`
	LastSeen  time.Time                           `json:"lastSeen"`
	Owner     string                              `json:"-"`
	TokenHash [32]byte                            `json:"-"`
	Requests  map[string]*browserAssistantRequest `json:"-"`
	Control   *browserAssistantControl            `json:"control,omitempty"`
}

type browserAssistantRegistry struct {
	mu          sync.Mutex
	localToken  string
	pairings    map[string]browserAssistantPairing
	connections map[string]*browserAssistantConnection
}

type browserAssistantResponse struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (response *browserAssistantResponse) WriteHeader(status int) {
	if response.status == 0 {
		response.status = status
	}
}

func (response *browserAssistantResponse) Write(value []byte) (int, error) {
	if response.status == 0 {
		response.status = http.StatusOK
	}
	return response.body.Write(value)
}

func (registry *browserAssistantRegistry) lockResponse(writer http.ResponseWriter) (http.ResponseWriter, func()) {
	registry.mu.Lock()
	response := &browserAssistantResponse{ResponseWriter: writer}
	return response, func() {
		registry.mu.Unlock()
		if response.status == 0 {
			response.status = http.StatusOK
		}
		writer.WriteHeader(response.status)
		_, _ = writer.Write(response.body.Bytes())
	}
}

func newBrowserAssistantRegistry(localToken string) *browserAssistantRegistry {
	return &browserAssistantRegistry{localToken: localToken, pairings: make(map[string]browserAssistantPairing), connections: make(map[string]*browserAssistantConnection)}
}

func (registry *browserAssistantRegistry) prune() {
	now := time.Now()
	for code, pairing := range registry.pairings {
		if !now.Before(pairing.Expires) {
			delete(registry.pairings, code)
		}
	}
	for id, connection := range registry.connections {
		if connection.Expires != nil && !now.Before(*connection.Expires) {
			delete(registry.connections, id)
			continue
		}
		for id, request := range connection.Requests {
			if !now.Before(request.Expires) {
				request.Status = "expired"
				request.Snapshot = nil
				request.Result = nil
				clearBrowserCommandInput(request)
			}
			if now.After(request.Expires.Add(5 * time.Minute)) {
				delete(connection.Requests, id)
			}
		}
	}
}

func (server *Server) browserAssistantOwner(httpRequest *http.Request) string {
	if server.noAuth {
		return "user:local"
	}
	var token string
	if value, ok := bearerToken(httpRequest); ok {
		token = value
	}
	if token == "" {
		if cookie, err := httpRequest.Cookie(SessionCookieName); err == nil {
			token = cookie.Value
		}
	}
	if token != "" && server.authSrv != nil {
		if info, err := server.authSrv.Manager().LoadAccessToken(httpRequest.Context(), token); err == nil && info.GetUserID() != "" {
			return "user:" + info.GetUserID()
		}
	}
	if token != "" && server.browserAssistant.localToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(server.browserAssistant.localToken)) == 1 {
		return "user:local"
	}
	if token != "" {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(httpRequest.URL.Hostname()), ".")
	if host == "" {
		parsed, err := url.Parse("http://" + httpRequest.Host)
		if err == nil {
			host = strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
		}
	}
	address := net.ParseIP(host)
	if !server.behindReverseProxy && IsLocalhost(httpRequest) && (host == "localhost" || (address != nil && address.IsLoopback())) {
		return "user:local"
	}
	return ""
}

func (server *Server) browserAssistantMutation(writer http.ResponseWriter, httpRequest *http.Request) bool {
	if httpRequest.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(writer, "Cross-site browser request denied", http.StatusForbidden)
		return false
	}
	if httpRequest.Header.Get("X-Muxterm-Browser-Request") != "1" {
		http.Error(writer, "Missing browser request header", http.StatusForbidden)
		return false
	}
	if origin := httpRequest.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		expected := httpRequest.Host
		expectedScheme := "http"
		if httpRequest.TLS != nil {
			expectedScheme = "https"
		}
		if base := server.publicBaseURL(); base != "" {
			if configured, err := url.Parse(base); err == nil {
				expected = configured.Host
				expectedScheme = configured.Scheme
			}
		}
		if err != nil || parsed.Host != expected || parsed.Scheme != expectedScheme {
			http.Error(writer, "Cross-origin browser request denied", http.StatusForbidden)
			return false
		}
	}
	return true
}

func browserAssistantJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func browserAssistantDecode(writer http.ResponseWriter, httpRequest *http.Request, value any) bool {
	httpRequest.Body = http.MaxBytesReader(writer, httpRequest.Body, 48<<10)
	decoder := json.NewDecoder(httpRequest.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		http.Error(writer, "Invalid browser request", http.StatusBadRequest)
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		http.Error(writer, "Only one browser request is allowed", http.StatusBadRequest)
		return false
	}
	return true
}

func (server *Server) registerBrowserAssistantRoutes(protect func(http.Handler) http.Handler) {
	server.registerBrowserAutomationRoutes(protect)
	server.mux.Handle("GET /api/browser-assistant/connections", protect(http.HandlerFunc(server.handleBrowserAssistantConnections)))
	server.mux.Handle("POST /api/browser-assistant/pairings", protect(http.HandlerFunc(server.handleBrowserAssistantPairing)))
	server.mux.Handle("DELETE /api/browser-assistant/connections/{id}", protect(http.HandlerFunc(server.handleBrowserAssistantRevoke)))
	server.mux.Handle("POST /api/browser-assistant/connections/{id}/requests", protect(http.HandlerFunc(server.handleBrowserAssistantRequest)))
	server.mux.Handle("GET /api/browser-assistant/requests/{id}", protect(http.HandlerFunc(server.handleBrowserAssistantRequestResult)))
	server.mux.HandleFunc("POST /api/browser-assistant/claim", server.handleBrowserAssistantClaim)
	server.mux.HandleFunc("GET /api/browser-assistant/bridge/{id}", server.handleBrowserAssistantPoll)
	server.mux.HandleFunc("DELETE /api/browser-assistant/bridge/{id}", server.handleBrowserAssistantBridgeRevoke)
	server.mux.HandleFunc("POST /api/browser-assistant/bridge/{id}/results/{request}", server.handleBrowserAssistantResult)
}

func (server *Server) handleBrowserAssistantConnections(writer http.ResponseWriter, httpRequest *http.Request) {
	owner := server.browserAssistantOwner(httpRequest)
	if owner == "" {
		http.Error(writer, "Authentication required", http.StatusUnauthorized)
		return
	}
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	items := []*browserAssistantConnection{}
	for _, connection := range registry.connections {
		if connection.Owner == owner {
			items = append(items, connection)
		}
	}
	sort.Slice(items, func(first, second int) bool { return items[first].ID < items[second].ID })
	browserAssistantJSON(writer, http.StatusOK, map[string]any{"items": items})
}

func (server *Server) handleBrowserAssistantPairing(writer http.ResponseWriter, httpRequest *http.Request) {
	if !server.browserAssistantMutation(writer, httpRequest) {
		return
	}
	owner := server.browserAssistantOwner(httpRequest)
	if owner == "" {
		http.Error(writer, "Authentication required", http.StatusUnauthorized)
		return
	}
	code, err := randomURLSafeString(24)
	if err != nil {
		http.Error(writer, "Cannot create pairing", http.StatusInternalServerError)
		return
	}
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	for prior, pairing := range registry.pairings {
		if pairing.Owner == owner {
			delete(registry.pairings, prior)
		}
	}
	if len(registry.pairings) >= 128 {
		http.Error(writer, "Too many pending pairings", http.StatusTooManyRequests)
		return
	}
	expires := time.Now().Add(5 * time.Minute)
	registry.pairings[code] = browserAssistantPairing{Owner: owner, Expires: expires}
	browserAssistantJSON(writer, http.StatusCreated, map[string]any{"code": code, "expiresAt": expires})
}

func (server *Server) handleBrowserAssistantClaim(writer http.ResponseWriter, httpRequest *http.Request) {
	var body struct {
		Code string `json:"code"`
		Name string `json:"name"`
	}
	if !browserAssistantDecode(writer, httpRequest, &body) {
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len(body.Name) > 80 {
		http.Error(writer, "Supply a browser name up to 80 characters", http.StatusBadRequest)
		return
	}
	id, err := randomURLSafeString(12)
	if err != nil {
		http.Error(writer, "Cannot pair browser", http.StatusInternalServerError)
		return
	}
	token, err := randomURLSafeString(32)
	if err != nil {
		http.Error(writer, "Cannot pair browser", http.StatusInternalServerError)
		return
	}
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	pairing, valid := registry.pairings[body.Code]
	if !valid {
		http.Error(writer, "Pairing code invalid, expired, or already used", http.StatusUnauthorized)
		return
	}
	count := 0
	for _, connection := range registry.connections {
		if connection.Owner == pairing.Owner {
			count++
		}
	}
	if count >= 8 || len(registry.connections) >= 128 {
		http.Error(writer, "Browser pairing limit reached", http.StatusTooManyRequests)
		return
	}
	delete(registry.pairings, body.Code)
	connection := &browserAssistantConnection{ID: id, Name: body.Name, Owner: pairing.Owner, TokenHash: sha256.Sum256([]byte(token)), LastSeen: time.Now(), Requests: make(map[string]*browserAssistantRequest)}
	registry.connections[id] = connection
	browserAssistantJSON(writer, http.StatusCreated, map[string]any{"id": id, "token": token})
}

func (server *Server) browserAssistantBridgeLocked(httpRequest *http.Request) *browserAssistantConnection {
	connection := server.browserAssistant.connections[httpRequest.PathValue("id")]
	token, valid := bearerToken(httpRequest)
	hash := sha256.Sum256([]byte(token))
	if !valid || connection == nil || subtle.ConstantTimeCompare(hash[:], connection.TokenHash[:]) != 1 {
		return nil
	}
	return connection
}

func (server *Server) handleBrowserAssistantPoll(writer http.ResponseWriter, httpRequest *http.Request) {
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	connection := server.browserAssistantBridgeLocked(httpRequest)
	if connection == nil {
		http.Error(writer, "Browser pairing unavailable; pair again", http.StatusUnauthorized)
		return
	}
	connection.LastSeen = time.Now()
	items := []*browserAssistantRequest{}
	for _, request := range connection.Requests {
		if request.Status == "pending" {
			items = append(items, request)
		}
	}
	sort.Slice(items, func(first, second int) bool { return items[first].Expires.Before(items[second].Expires) })
	browserAssistantJSON(writer, http.StatusOK, map[string]any{"requests": items, "control": connection.Control})
}

func (server *Server) handleBrowserAssistantRevoke(writer http.ResponseWriter, httpRequest *http.Request) {
	if !server.browserAssistantMutation(writer, httpRequest) {
		return
	}
	owner := server.browserAssistantOwner(httpRequest)
	if owner == "" {
		http.Error(writer, "Authentication required", http.StatusUnauthorized)
		return
	}
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	connection := registry.connections[httpRequest.PathValue("id")]
	if connection == nil || connection.Owner != owner {
		http.Error(writer, "Browser not found", http.StatusNotFound)
		return
	}
	delete(registry.connections, connection.ID)
	browserAssistantJSON(writer, http.StatusOK, map[string]bool{"revoked": true})
}

func (server *Server) handleBrowserAssistantBridgeRevoke(writer http.ResponseWriter, httpRequest *http.Request) {
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	connection := server.browserAssistantBridgeLocked(httpRequest)
	if connection == nil {
		http.Error(writer, "Browser pairing unavailable", http.StatusUnauthorized)
		return
	}
	delete(registry.connections, connection.ID)
	browserAssistantJSON(writer, http.StatusOK, map[string]bool{"revoked": true})
}

func (server *Server) handleBrowserAssistantRequest(writer http.ResponseWriter, httpRequest *http.Request) {
	if !server.browserAssistantMutation(writer, httpRequest) {
		return
	}
	owner := server.browserAssistantOwner(httpRequest)
	if owner == "" {
		http.Error(writer, "Authentication required", http.StatusUnauthorized)
		return
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if !browserAssistantDecode(writer, httpRequest, &body) {
		return
	}
	body.Reason = strings.TrimSpace(body.Reason)
	if body.Reason == "" || len(body.Reason) > 300 {
		http.Error(writer, "Supply a purpose up to 300 characters", http.StatusBadRequest)
		return
	}
	id, err := randomURLSafeString(12)
	if err != nil {
		http.Error(writer, "Cannot create request", http.StatusInternalServerError)
		return
	}
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	connection := registry.connections[httpRequest.PathValue("id")]
	if connection == nil || connection.Owner != owner {
		http.Error(writer, "Browser not found", http.StatusNotFound)
		return
	}
	if len(connection.Requests) >= 8 {
		http.Error(writer, "Request limit reached; wait for existing requests to expire", http.StatusTooManyRequests)
		return
	}
	request := &browserAssistantRequest{ID: id, ConnectionID: connection.ID, Reason: body.Reason, Status: "pending", Expires: time.Now().Add(2 * time.Minute)}
	connection.Requests[id] = request
	browserAssistantJSON(writer, http.StatusAccepted, request)
}

func (server *Server) handleBrowserAssistantRequestResult(writer http.ResponseWriter, httpRequest *http.Request) {
	owner := server.browserAssistantOwner(httpRequest)
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	for _, connection := range registry.connections {
		if connection.Owner == owner {
			if request := connection.Requests[httpRequest.PathValue("id")]; request != nil {
				browserAssistantJSON(writer, http.StatusOK, request)
				return
			}
		}
	}
	http.Error(writer, "Request not found", http.StatusNotFound)
}

func (server *Server) handleBrowserAssistantResult(writer http.ResponseWriter, httpRequest *http.Request) {
	var body struct {
		Approved bool                      `json:"approved"`
		Snapshot *browserAssistantSnapshot `json:"snapshot"`
	}
	if !browserAssistantDecode(writer, httpRequest, &body) {
		return
	}
	if body.Approved && body.Snapshot == nil {
		http.Error(writer, "Snapshot required", http.StatusBadRequest)
		return
	}
	registry := server.browserAssistant
	writer, flush := registry.lockResponse(writer)
	defer flush()
	registry.prune()
	connection := server.browserAssistantBridgeLocked(httpRequest)
	if connection == nil {
		http.Error(writer, "Browser pairing unavailable", http.StatusUnauthorized)
		return
	}
	request := connection.Requests[httpRequest.PathValue("request")]
	if request == nil || request.Status != "pending" || request.Command != nil {
		http.Error(writer, "Request expired or already answered", http.StatusConflict)
		return
	}
	request.Status = "denied"
	if body.Approved {
		request.Status = "approved"
		request.Snapshot = body.Snapshot
	}
	browserAssistantJSON(writer, http.StatusOK, map[string]bool{"accepted": true})
}
