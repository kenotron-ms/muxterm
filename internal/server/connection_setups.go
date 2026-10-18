package server

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"
)

const connectionSetupTTL = 15 * time.Minute

type connectionSetupRegistry struct {
	mu    sync.Mutex
	items map[string]*connectionSetup
}

type connectionSetup struct {
	ID, Owner, Provider, Callback, State string
	Inputs                               []remoteConnectionInput
	Expires                              time.Time
	Credentials                          *connectionCredentials
	Handle                               string
	HandleHash                           [32]byte
	ConnectionIDs                        []string
}

type connectionCredentials struct {
	ClientID, ClientSecret string
}

type connectionSetupResponse struct {
	http.ResponseWriter
	status int
	body   bytes.Buffer
}

func (response *connectionSetupResponse) WriteHeader(status int) {
	if response.status == 0 {
		response.status = status
	}
}

func (response *connectionSetupResponse) Write(value []byte) (int, error) {
	if response.status == 0 {
		response.status = http.StatusOK
	}
	return response.body.Write(value)
}

type connectionSetupInput struct {
	Provider string   `json:"provider"`
	Services []string `json:"services,omitempty"`
	Name     string   `json:"name,omitempty"`
	Endpoint string   `json:"endpoint,omitempty"`
	Issuer   string   `json:"issuer_url,omitempty"`
	Scopes   []string `json:"scopes,omitempty"`
}

func newConnectionSetupRegistry() *connectionSetupRegistry {
	return &connectionSetupRegistry{items: make(map[string]*connectionSetup)}
}

func (registry *connectionSetupRegistry) lockResponse(writer http.ResponseWriter) (http.ResponseWriter, func()) {
	registry.mu.Lock()
	response := &connectionSetupResponse{ResponseWriter: writer}
	return response, func() {
		registry.mu.Unlock()
		if response.status == 0 {
			response.status = http.StatusOK
		}
		writer.WriteHeader(response.status)
		_, _ = writer.Write(response.body.Bytes())
	}
}

func connectionSetupDecode(writer http.ResponseWriter, request *http.Request, value any) bool {
	request.Body = http.MaxBytesReader(writer, request.Body, 64<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(value) != nil || decoder.Decode(new(any)) != io.EOF {
		http.Error(writer, "Invalid setup request", http.StatusBadRequest)
		return false
	}
	return true
}

func (server *Server) connectionSetupIdentity(request *http.Request) string {
	_, bearer := bearerToken(request)
	_, cookieError := request.Cookie(SessionCookieName)
	if !server.noAuth && !bearer && cookieError != nil {
		parsed, err := url.Parse("http://" + request.Host)
		if err != nil {
			return ""
		}
		host := strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
		address := net.ParseIP(host)
		if host != "localhost" && (address == nil || !address.IsLoopback()) {
			return ""
		}
	}
	return server.browserAssistantOwner(request)
}

func (server *Server) connectionSetupOwner(writer http.ResponseWriter, request *http.Request) string {
	if request.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(writer, "Cross-site request denied", http.StatusForbidden)
		return ""
	}
	if !server.browserAssistantMutation(writer, request) {
		return ""
	}
	owner := server.connectionSetupIdentity(request)
	if owner == "" {
		http.Error(writer, "Authentication required", http.StatusUnauthorized)
	}
	return owner
}

func (server *Server) registerConnectionSetupRoutes(protect func(http.Handler) http.Handler) {
	server.mux.Handle("POST /api/connections/setups", protect(http.HandlerFunc(server.handleConnectionSetupPrepare)))
	server.mux.Handle("GET /api/connections/setups/{setup}", protect(http.HandlerFunc(server.handleConnectionSetupStatus)))
	server.mux.Handle("POST /api/connections/setups/{setup}/credentials", protect(http.HandlerFunc(server.handleConnectionSetupCredentials)))
	server.mux.Handle("POST /api/connections/setups/{setup}/configure", protect(http.HandlerFunc(server.handleConnectionSetupConfigure)))
	server.mux.Handle("DELETE /api/connections/setups/{setup}", protect(http.HandlerFunc(server.handleConnectionSetupCancel)))
	server.mux.Handle("GET /api/connections/setup-connections/{connection}", protect(http.HandlerFunc(server.handleSetupConnectionStatus)))
	server.mux.Handle("GET /connections/setup/{setup}", protect(http.HandlerFunc(server.handleConnectionSetupPage)))
}

func (input connectionSetupInput) targets() ([]remoteConnectionInput, error) {
	if input.Provider == "google" {
		if len(input.Services) == 0 || len(input.Services) > len(googleConnectionPresets) || input.Name != "" || input.Endpoint != "" || input.Issuer != "" || len(input.Scopes) != 0 {
			return nil, errors.New("Select Google services without endpoint or scope overrides")
		}
		var targets []remoteConnectionInput
		seen := make(map[string]bool)
		for _, service := range input.Services {
			preset, ok := googleConnectionPresets[service]
			if !ok || seen[service] {
				return nil, errors.New("Unknown or repeated Google service")
			}
			seen[service] = true
			targets = append(targets, remoteConnectionInput{Provider: service, Name: preset.Name, Endpoint: preset.Endpoint, IssuerURL: "https://accounts.google.com", Scopes: strings.Join(preset.Scopes, " ")})
		}
		return targets, nil
	}
	if input.Provider != "remote-oauth" || len(input.Services) != 0 {
		return nil, errors.New("Supported providers are google and remote-oauth")
	}
	input.Name = strings.TrimSpace(input.Name)
	endpoint, err := validatedPublicURL(input.Endpoint)
	if err != nil || endpoint.RawQuery != "" || input.Name == "" || len(input.Name) > 80 || len(input.Endpoint) > 2048 || len(input.Issuer) > 2048 {
		return nil, errors.New("Provide a name and public HTTPS service endpoint")
	}
	issuer, err := validatedPublicURL(input.Issuer)
	if err != nil || issuer.RawQuery != "" {
		return nil, errors.New("Provide the public HTTPS OAuth issuer URL")
	}
	if len(input.Scopes) == 0 || len(input.Scopes) > 30 {
		return nil, errors.New("Provide the required scopes")
	}
	for _, scope := range input.Scopes {
		if len(scope) == 0 || len(scope) > 512 || len(strings.Fields(scope)) != 1 || strings.TrimSpace(scope) != scope {
			return nil, errors.New("Invalid scope")
		}
	}
	return []remoteConnectionInput{{Name: input.Name, Endpoint: endpoint.String(), IssuerURL: issuer.String(), Scopes: strings.Join(input.Scopes, " ")}}, nil
}

func (server *Server) handleConnectionSetupPrepare(writer http.ResponseWriter, request *http.Request) {
	owner := server.connectionSetupOwner(writer, request)
	if owner == "" {
		return
	}
	var input connectionSetupInput
	if !connectionSetupDecode(writer, request, &input) {
		return
	}
	targets, err := input.targets()
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	id, err := randomURLSafeString(24)
	if err != nil {
		http.Error(writer, "Cannot prepare connection", http.StatusInternalServerError)
		return
	}
	registry := server.connectionSetups
	writer, flush := registry.lockResponse(writer)
	defer flush()
	count := 0
	for _, setup := range registry.items {
		if setup.Owner == owner {
			count++
		}
	}
	if count >= 5 || len(registry.items) >= 64 {
		http.Error(writer, "Cancel old setups or wait for them to expire before adding more", http.StatusTooManyRequests)
		return
	}
	setup := &connectionSetup{ID: id, Owner: owner, Provider: input.Provider, Callback: server.remoteCallbackURL(), State: "awaiting-credentials", Inputs: targets, Expires: time.Now().Add(connectionSetupTTL)}
	registry.items[id] = setup
	time.AfterFunc(connectionSetupTTL, func() {
		registry.mu.Lock()
		delete(registry.items, id)
		setup.Credentials = nil
		setup.Handle = ""
		registry.mu.Unlock()
	})
	browserAssistantJSON(writer, http.StatusCreated, server.connectionSetupPublic(setup))
}

func (server *Server) connectionSetupPublic(setup *connectionSetup) map[string]any {
	var targets []map[string]any
	var scopes []string
	for _, input := range setup.Inputs {
		targets = append(targets, map[string]any{"name": input.Name, "endpoint": input.Endpoint, "issuer": input.IssuerURL})
		for _, scope := range strings.Fields(input.Scopes) {
			if !slices.Contains(scopes, scope) {
				scopes = append(scopes, scope)
			}
		}
	}
	result := map[string]any{"setup_id": setup.ID, "provider": setup.Provider, "state": setup.State, "expires_at": setup.Expires, "callback_url": setup.Callback, "targets": targets, "scopes": scopes, "required_fields": []string{"client_id", "client_secret"}, "private_upload_url": server.connectionsCallbackBase() + "/connections/setup/" + setup.ID, "connection_ids": setup.ConnectionIDs}
	if setup.State == "credentials-ready" {
		result["credential_handle"] = setup.Handle
	}
	if setup.Provider == "google" {
		result["notice"] = "Workspace MCP eligibility and API enrollment still apply; app registration does not grant personal Gmail support."
	}
	return result
}

func (registry *connectionSetupRegistry) owned(id, owner string) *connectionSetup {
	setup := registry.items[id]
	if setup == nil || setup.Owner != owner || !time.Now().Before(setup.Expires) {
		return nil
	}
	return setup
}

func (server *Server) handleConnectionSetupStatus(writer http.ResponseWriter, request *http.Request) {
	owner := server.connectionSetupOwner(writer, request)
	if owner == "" {
		return
	}
	registry := server.connectionSetups
	writer, flush := registry.lockResponse(writer)
	defer flush()
	setup := registry.owned(request.PathValue("setup"), owner)
	if setup == nil {
		http.Error(writer, "Setup not found or expired", http.StatusNotFound)
		return
	}
	browserAssistantJSON(writer, http.StatusOK, server.connectionSetupPublic(setup))
}

func parseConnectionCredentials(provider, callback, format, document, clientID, secret string) (*connectionCredentials, error) {
	invalid := errors.New("Invalid OAuth credentials; no details were saved")
	if len(document) > 32<<10 {
		return nil, invalid
	}
	switch format {
	case "manual":
		if document != "" {
			return nil, invalid
		}
	case "google-web-json":
		if provider != "google" || clientID != "" || secret != "" {
			return nil, invalid
		}
		var imported struct {
			Web *struct {
				ClientID     string   `json:"client_id"`
				ClientSecret string   `json:"client_secret"`
				RedirectURIs []string `json:"redirect_uris"`
			} `json:"web"`
			Installed json.RawMessage `json:"installed"`
			Type      string          `json:"type"`
		}
		if json.Unmarshal([]byte(document), &imported) != nil || imported.Web == nil || len(imported.Installed) != 0 || imported.Type != "" || !slices.Contains(imported.Web.RedirectURIs, callback) {
			return nil, errors.New("Upload a Google Web OAuth client JSON with this exact callback; desktop and service-account files are not accepted")
		}
		clientID, secret = imported.Web.ClientID, imported.Web.ClientSecret
	case "oauth-client-json":
		if provider != "remote-oauth" || clientID != "" || secret != "" {
			return nil, invalid
		}
		var imported struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
		}
		decoder := json.NewDecoder(strings.NewReader(document))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&imported) != nil || decoder.Decode(new(any)) != io.EOF {
			return nil, invalid
		}
		clientID, secret = imported.ClientID, imported.ClientSecret
	default:
		return nil, invalid
	}
	clientID, secret = strings.TrimSpace(clientID), strings.TrimSpace(secret)
	if clientID == "" || len(clientID) > 512 || secret == "" || len(secret) > 2048 || strings.ContainsAny(clientID+secret, "\r\n\x00") {
		return nil, invalid
	}
	if provider == "google" && !strings.HasSuffix(clientID, ".apps.googleusercontent.com") {
		return nil, invalid
	}
	return &connectionCredentials{ClientID: clientID, ClientSecret: secret}, nil
}

func (server *Server) handleConnectionSetupCredentials(writer http.ResponseWriter, request *http.Request) {
	owner := server.connectionSetupOwner(writer, request)
	if owner == "" {
		return
	}
	if request.Header.Get("Origin") != connectionSetupOrigin(server.remoteCallbackURL()) || !connectionSetupSecure(server.remoteCallbackURL()) {
		http.Error(writer, "Use the private upload page", http.StatusForbidden)
		return
	}
	var input struct {
		Format       string `json:"format"`
		Document     string `json:"document,omitempty"`
		ClientID     string `json:"client_id,omitempty"`
		ClientSecret string `json:"client_secret,omitempty"`
		Approved     bool   `json:"approved"`
	}
	if !connectionSetupDecode(writer, request, &input) {
		return
	}
	if !input.Approved {
		http.Error(writer, "Approve the target and callback on the private page", http.StatusBadRequest)
		return
	}
	registry := server.connectionSetups
	writer, flush := registry.lockResponse(writer)
	defer flush()
	setup := registry.owned(request.PathValue("setup"), owner)
	if setup == nil {
		http.Error(writer, "Setup not found or expired", http.StatusNotFound)
		return
	}
	if setup.State != "awaiting-credentials" && setup.State != "credentials-ready" {
		http.Error(writer, "This setup no longer accepts credentials", http.StatusConflict)
		return
	}
	credentials, err := parseConnectionCredentials(setup.Provider, setup.Callback, input.Format, input.Document, input.ClientID, input.ClientSecret)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	handle, err := randomURLSafeString(32)
	if err != nil {
		http.Error(writer, "Cannot stage credentials", http.StatusInternalServerError)
		return
	}
	setup.Credentials, setup.Handle, setup.HandleHash, setup.State = credentials, handle, sha256.Sum256([]byte(handle)), "credentials-ready"
	browserAssistantJSON(writer, http.StatusCreated, map[string]string{"state": setup.State})
}

func (server *Server) handleConnectionSetupConfigure(writer http.ResponseWriter, request *http.Request) {
	owner := server.connectionSetupOwner(writer, request)
	if owner == "" {
		return
	}
	var input struct {
		Handle string `json:"credential_handle"`
	}
	if !connectionSetupDecode(writer, request, &input) {
		return
	}
	hash := sha256.Sum256([]byte(input.Handle))
	registry := server.connectionSetups
	registry.mu.Lock()
	setup := registry.owned(request.PathValue("setup"), owner)
	if setup == nil {
		registry.mu.Unlock()
		http.Error(writer, "Setup not found or expired", http.StatusNotFound)
		return
	}
	if len(input.Handle) != 43 || subtle.ConstantTimeCompare(hash[:], setup.HandleHash[:]) != 1 {
		registry.mu.Unlock()
		http.Error(writer, "Invalid credential handle", http.StatusForbidden)
		return
	}
	if setup.State == "configured" {
		result := server.connectionSetupPublic(setup)
		registry.mu.Unlock()
		browserAssistantJSON(writer, http.StatusOK, result)
		return
	}
	if setup.State != "credentials-ready" || setup.Credentials == nil {
		registry.mu.Unlock()
		http.Error(writer, "Credentials are not ready or configuration is in progress", http.StatusConflict)
		return
	}
	credentials := *setup.Credentials
	inputs := slices.Clone(setup.Inputs)
	setup.State = "configuring"
	registry.mu.Unlock()
	defer func() { credentials = connectionCredentials{} }()
	var connections []remoteConnection
	for _, target := range inputs {
		target.ClientID, target.ClientSecret = credentials.ClientID, credentials.ClientSecret
		connection, _, err := server.buildRemoteConnection(request.Context(), target)
		if err != nil {
			registry.mu.Lock()
			if registry.owned(setup.ID, owner) == setup {
				setup.State = "credentials-ready"
			}
			registry.mu.Unlock()
			http.Error(writer, "Service metadata could not be validated; no connections were created. Check provider eligibility and endpoint configuration", http.StatusBadGateway)
			return
		}
		connection.SetupOwner = owner
		connections = append(connections, connection)
	}
	writer, flush := registry.lockResponse(writer)
	defer flush()
	if registry.owned(setup.ID, owner) != setup {
		http.Error(writer, "Setup expired or was cancelled; no connections were created", http.StatusConflict)
		return
	}
	err := withRemoteConnections(func(records map[string]remoteConnection) error {
		if !time.Now().Before(setup.Expires) {
			return errors.New("setup expired")
		}
		if len(records)+len(connections) > 20 {
			return errors.New("connection limit reached")
		}
		for _, connection := range connections {
			records[connection.ID] = connection
		}
		return saveRemoteConnections(records)
	})
	if err != nil {
		setup.State = "credentials-ready"
		http.Error(writer, "Could not save connections; no credentials were consumed", http.StatusInternalServerError)
		return
	}
	for _, connection := range connections {
		setup.ConnectionIDs = append(setup.ConnectionIDs, connection.ID)
	}
	setup.State, setup.Handle, setup.Credentials = "configured", "", nil
	browserAssistantJSON(writer, http.StatusCreated, server.connectionSetupPublic(setup))
}

func (server *Server) handleConnectionSetupCancel(writer http.ResponseWriter, request *http.Request) {
	owner := server.connectionSetupOwner(writer, request)
	if owner == "" {
		return
	}
	registry := server.connectionSetups
	writer, flush := registry.lockResponse(writer)
	defer flush()
	setup := registry.owned(request.PathValue("setup"), owner)
	if setup == nil {
		http.Error(writer, "Setup not found or expired", http.StatusNotFound)
		return
	}
	setup.Credentials, setup.Handle = nil, ""
	delete(registry.items, setup.ID)
	browserAssistantJSON(writer, http.StatusOK, map[string]string{"state": "cancelled"})
}

func (server *Server) handleSetupConnectionStatus(writer http.ResponseWriter, request *http.Request) {
	owner := server.connectionSetupOwner(writer, request)
	if owner == "" {
		return
	}
	records, err := loadRemoteConnections()
	connection, exists := records[request.PathValue("connection")]
	if err != nil || !exists || connection.SetupOwner != owner {
		http.Error(writer, "Connection not found", http.StatusNotFound)
		return
	}
	var tools []string
	for _, tool := range connection.DiscoveredTools {
		blocked := false
		values := []string{connection.ClientSecret, connection.ClientID}
		if connection.Token != nil {
			values = append(values, connection.Token.AccessToken, connection.Token.RefreshToken)
		}
		for _, value := range values {
			if value != "" && strings.Contains(tool.Name, value) {
				blocked = true
			}
		}
		if !blocked {
			tools = append(tools, tool.Name)
		}
	}
	browserAssistantJSON(writer, http.StatusOK, map[string]any{"connection_id": connection.ID, "state": connection.public().State, "available_tools": tools, "enabled_tool_count": len(connection.AllowedTools), "checked_at": connection.CheckedAt, "needs_attention": connection.CheckError != "", "authorization_required": connection.Token == nil})
}

func connectionSetupOrigin(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}
