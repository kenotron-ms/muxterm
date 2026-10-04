package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"golang.org/x/oauth2"
)

// Remote MCP registration is deliberately a pre-registered OAuth client. Dynamic
// registration and arbitrary local commands are outside this connection surface.
type remoteConnection struct {
	ID                    string              `json:"id"`
	Provider              string              `json:"provider,omitempty"`
	Name                  string              `json:"name"`
	Endpoint              string              `json:"endpoint"`
	Issuer                string              `json:"issuer"`
	RequireIssuerResponse bool                `json:"requireIssuerResponse,omitempty"`
	AuthURL               string              `json:"authUrl"`
	TokenURL              string              `json:"tokenUrl"`
	ClientID              string              `json:"clientId"`
	ClientSecret          string              `json:"clientSecret,omitempty"`
	Scopes                []string            `json:"scopes"`
	Token                 *oauth2.Token       `json:"token,omitempty"`
	AuthRevision          string              `json:"authRevision,omitempty"`
	ToolCount             int                 `json:"toolCount,omitempty"`
	CheckedAt             time.Time           `json:"checkedAt,omitempty"`
	CheckError            string              `json:"checkError,omitempty"`
	DiscoveredTools       []remoteToolSummary `json:"discoveredTools,omitempty"`
	AllowedTools          []string            `json:"allowedTools,omitempty"`
}

type remoteToolSummary struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type remoteConnectionPublic struct {
	ID              string              `json:"id"`
	Provider        string              `json:"provider,omitempty"`
	Name            string              `json:"name"`
	Endpoint        string              `json:"endpoint"`
	State           string              `json:"state"`
	ToolCount       int                 `json:"toolCount"`
	CheckedAt       time.Time           `json:"checkedAt"`
	Error           string              `json:"error,omitempty"`
	DiscoveredTools []remoteToolSummary `json:"discoveredTools"`
	AllowedTools    []string            `json:"allowedTools"`
}

func (c remoteConnection) public() remoteConnectionPublic {
	state := "authorization-required"
	if c.Token != nil {
		state = "authorized"
	}
	if c.Token != nil && c.CheckError != "" {
		state = "needs-attention"
	}
	if c.Token != nil && c.CheckError == "" && !c.CheckedAt.IsZero() && time.Since(c.CheckedAt) < 5*time.Minute {
		state = "ready"
	}
	tools := c.DiscoveredTools
	if tools == nil {
		tools = []remoteToolSummary{}
	}
	allowed := c.AllowedTools
	if allowed == nil {
		allowed = []string{}
	}
	return remoteConnectionPublic{ID: c.ID, Provider: c.Provider, Name: c.Name, Endpoint: c.Endpoint, State: state, ToolCount: c.ToolCount, CheckedAt: c.CheckedAt, Error: c.CheckError, DiscoveredTools: tools, AllowedTools: allowed}
}

var remotePending = struct {
	sync.Mutex
	items map[string]remoteAuthAttempt
}{items: make(map[string]remoteAuthAttempt)}

type remoteAuthAttempt struct {
	ID, Provider, Verifier, Issuer, Endpoint, ClientID string
	Expires                                            time.Time
}

func remoteConnectionsPath() string { return filepath.Join(sdkDataDir(), "connections", "remote.json") }

func loadRemoteConnections() (map[string]remoteConnection, error) {
	b, err := os.ReadFile(remoteConnectionsPath())
	if errors.Is(err, os.ErrNotExist) {
		return map[string]remoteConnection{}, nil
	}
	if err != nil {
		return nil, err
	}
	var records map[string]remoteConnection
	if err = json.Unmarshal(b, &records); err != nil {
		return nil, err
	}
	if records == nil {
		records = map[string]remoteConnection{}
	}
	return records, nil
}

func saveRemoteConnections(records map[string]remoteConnection) error {
	path := remoteConnectionsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	b, err := json.Marshal(records)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	if err = os.Chmod(tmp, 0600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err = os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// Browser writes and refresh commits share this short-lived interprocess lock.
// A deleted connection is unavailable on its next call.
func withRemoteConnections(fn func(map[string]remoteConnection) error) error {
	return withRemoteConnectionFileLock(remoteConnectionsPath(), func() error {
		records, err := loadRemoteConnections()
		if err != nil {
			return err
		}
		return fn(records)
	})
}

func withRemoteConnectionFileLock(path string, run func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	return run()
}

func (s *Server) connectionsCallbackBase() string {
	if s.noAuth {
		// dev-local may inherit a production public_origin from config.toml.
		// The isolated test listener must advertise its own callback.
		host, port, err := net.SplitHostPort(s.addr)
		if err == nil {
			if host == "" || host == "0.0.0.0" {
				host = "127.0.0.1"
			}
			return "http://" + net.JoinHostPort(host, port)
		}
	}
	// webRedirectURI comes from the configured public origin, never request headers.
	return strings.TrimSuffix(s.webRedirectURI, "/auth/callback")
}

func validatedPublicURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" {
		return nil, errors.New("URL must be public HTTPS without credentials or fragment")
	}
	if u.Port() != "" && u.Port() != "443" {
		return nil, errors.New("only HTTPS port 443 is supported")
	}
	// A default port is the same resource identity as an omitted port. Keep
	// OAuth resource parameters and protected-resource metadata comparisons in
	// the canonical form, including bracketed IPv6 hosts.
	if u.Port() == "443" {
		u.Host = u.Hostname()
		if strings.Contains(u.Host, ":") {
			u.Host = "[" + u.Host + "]"
		}
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || !strings.Contains(host, ".") {
		return nil, errors.New("private hosts are not supported")
	}
	if ip, err := netip.ParseAddr(host); err == nil && !publicRemoteIP(ip) {
		return nil, errors.New("private IP addresses are not supported")
	}
	return u, nil
}

// RFC 8414 metadata commonly omits the slash on a root issuer even when a
// resource advertises it with one (notably accounts.google.com). This is the
// only normalization allowed when comparing the two issuer identities.
func canonicalRootIssuer(raw string) string {
	u, err := url.Parse(raw)
	if err == nil && u.Path == "/" && u.RawQuery == "" && u.Fragment == "" {
		u.Path = ""
		return u.String()
	}
	return raw
}

func usesResourceIndicator(c remoteConnection) bool { return c.Issuer != "https://accounts.google.com" }

func publicRemoteIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	// IPv6 ranges outside 2000::/3 include well-known NAT64 prefixes that
	// can route an apparently public IPv6 address to an embedded private IPv4.
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, raw := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001::/23", "2001:db8::/32", "2002::/16"} {
		if netip.MustParsePrefix(raw).Contains(ip) {
			return false
		}
	}
	return true
}

func safeRemoteHTTPClient(timeout time.Duration) *http.Client {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil // Environment proxies must not bypass the public-address dial check.
	if timeout == 0 {
		// A bridge SSE response can live for the entire chat. Bound the wait
		// for response headers without imposing a deadline on its open body.
		tr.ResponseHeaderTimeout = 2 * time.Minute
	}
	tr.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if port != "443" {
			return nil, errors.New("remote connection attempted a non-HTTPS port")
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil {
			return nil, err
		}
		if len(ips) == 0 {
			return nil, errors.New("remote host has no address")
		}
		for _, ip := range ips {
			if !publicRemoteIP(ip) {
				return nil, errors.New("remote host resolved to a private address")
			}
		}
		dialer := &net.Dialer{Timeout: 5 * time.Second}
		var lastErr error
		for _, ip := range ips {
			conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			lastErr = err
		}
		return nil, lastErr
	}
	return &http.Client{Transport: tr, Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

var errRemoteMetadataUnavailable = errors.New("protected-resource metadata unavailable")

func discoverProtectedResource(ctx context.Context, endpoint *url.URL) ([]string, error) {
	metadataURL := *endpoint
	metadataURL.Path = "/.well-known/oauth-protected-resource" + endpoint.Path
	metadataURL.RawPath = ""
	metadataURL.RawQuery = ""
	client := safeRemoteHTTPClient(12 * time.Second)
	read := func(raw string) ([]string, error) {
		if _, err := validatedPublicURL(raw); err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
		if err != nil {
			return nil, err
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			if resp.StatusCode == 404 || resp.StatusCode == 410 {
				return nil, errRemoteMetadataUnavailable
			}
			return nil, errors.New("protected-resource metadata returned an error")
		}
		var meta struct {
			Resource             string   `json:"resource"`
			AuthorizationServers []string `json:"authorization_servers"`
		}
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&meta); err != nil {
			return nil, err
		}
		if meta.Resource != endpoint.String() {
			return nil, fmt.Errorf("service resource URL must exactly match endpoint %q", endpoint.String())
		}
		if len(meta.AuthorizationServers) == 0 {
			return nil, errors.New("service did not advertise an OAuth issuer")
		}
		for _, issuer := range meta.AuthorizationServers {
			if _, err := validatedPublicURL(issuer); err != nil {
				return nil, err
			}
		}
		return meta.AuthorizationServers, nil
	}
	if issuers, err := read(metadataURL.String()); err == nil {
		return issuers, nil
	} else if !errors.Is(err, errRemoteMetadataUnavailable) {
		return nil, err
	}
	// A resource may advertise a different metadata URL in its challenge.
	req, err := http.NewRequestWithContext(ctx, "GET", endpoint.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, errors.New("protected-resource metadata unavailable")
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	resp.Body.Close()
	for _, header := range resp.Header.Values("WWW-Authenticate") {
		idx := strings.Index(strings.ToLower(header), "resource_metadata=\"")
		if idx < 0 {
			continue
		}
		rest := header[idx+len("resource_metadata=\""):]
		end := strings.IndexByte(rest, '"')
		if end < 0 {
			continue
		}
		return read(rest[:end])
	}
	return nil, errors.New("protected-resource metadata unavailable")
}

// The pinned Go MCP SDK gates OAuth discovery behind an opt-in build tag.
// Read standard issuer metadata here until that API is available normally.
func discoverRemoteOAuth(ctx context.Context, issuer *url.URL) (string, string, bool, error) {
	base := *issuer
	issuerPath := strings.TrimSuffix(base.Path, "/")
	base.RawQuery = ""
	var lastErr error
	for _, wellKnown := range []string{"oauth-authorization-server", "openid-configuration"} {
		base.Path = "/.well-known/" + wellKnown + issuerPath
		if wellKnown == "openid-configuration" {
			base.Path = issuerPath + "/.well-known/openid-configuration"
		}
		base.RawPath = ""
		req, err := http.NewRequestWithContext(ctx, "GET", base.String(), nil)
		if err != nil {
			return "", "", false, err
		}
		resp, err := safeRemoteHTTPClient(12 * time.Second).Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			lastErr = errors.New("metadata endpoint did not respond")
			continue
		}
		var meta struct {
			Issuer         string   `json:"issuer"`
			AuthURL        string   `json:"authorization_endpoint"`
			TokenURL       string   `json:"token_endpoint"`
			PKCE           []string `json:"code_challenge_methods_supported"`
			IssuerResponse bool     `json:"authorization_response_iss_parameter_supported"`
		}
		err = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&meta)
		resp.Body.Close()
		if err != nil {
			lastErr = err
			continue
		}
		if canonicalRootIssuer(meta.Issuer) != canonicalRootIssuer(issuer.String()) {
			return "", "", false, errors.New("OAuth metadata issuer mismatch")
		}
		if !slices.Contains(meta.PKCE, "S256") {
			return "", "", false, errors.New("OAuth issuer does not advertise PKCE S256")
		}
		if _, err = validatedPublicURL(meta.AuthURL); err != nil {
			return "", "", false, err
		}
		if _, err = validatedPublicURL(meta.TokenURL); err != nil {
			return "", "", false, err
		}
		return meta.AuthURL, meta.TokenURL, meta.IssuerResponse, nil
	}
	return "", "", false, lastErr
}

func (s *Server) remoteCallbackURL() string {
	return s.connectionsCallbackBase() + "/api/connections/remote/callback"
}

func (s *Server) handleRemoteConnections(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		var items []remoteConnectionPublic
		// Writes use an atomic rename, so a read-only listing can load a
		// coherent snapshot without waiting for a rotating token's file lock.
		records, err := loadRemoteConnections()
		if err != nil {
			http.Error(w, "connections could not be loaded", 500)
			return
		}
		for _, c := range records {
			items = append(items, c.public())
		}
		slices.SortFunc(items, func(a, b remoteConnectionPublic) int {
			if byName := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); byName != 0 {
				return byName
			}
			return strings.Compare(a.ID, b.ID)
		})
		if items == nil {
			items = []remoteConnectionPublic{}
		}
		writeSDKJSON(w, 200, map[string]any{"items": items, "callbackUrl": s.remoteCallbackURL()})
	case "POST":
		s.handleRemoteCreate(w, r)
	default:
		http.Error(w, "method not allowed", 405)
	}
}

func (s *Server) handleRemoteCreate(w http.ResponseWriter, r *http.Request) {
	var input struct{ Provider, Name, Endpoint, IssuerURL, ClientID, ClientSecret, Scopes string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&input); err != nil {
		http.Error(w, "invalid connection details", 400)
		return
	}
	if input.Provider != "" {
		preset, ok := googleConnectionPresets[input.Provider]
		if !ok {
			http.Error(w, "unknown service preset", 400)
			return
		}
		// The endpoint and read scopes belong to this preset, not the caller.
		input.Name = preset.Name
		input.Endpoint = preset.Endpoint
		input.IssuerURL = "https://accounts.google.com"
		input.Scopes = strings.Join(preset.Scopes, " ")
	}
	input.Name = strings.TrimSpace(input.Name)
	input.ClientID = strings.TrimSpace(input.ClientID)
	input.ClientSecret = strings.TrimSpace(input.ClientSecret)
	if input.Name == "" || len(input.Name) > 80 || input.ClientID == "" || len(input.ClientID) > 512 || len(input.ClientSecret) > 2048 {
		http.Error(w, "name and OAuth client ID are required", 400)
		return
	}
	if input.Provider != "" && strings.TrimSpace(input.ClientSecret) == "" {
		http.Error(w, "Google Web OAuth client secret is required", 400)
		return
	}
	endpoint, err := validatedPublicURL(strings.TrimSpace(input.Endpoint))
	if err != nil {
		http.Error(w, "invalid service endpoint: "+err.Error(), 400)
		return
	}
	if endpoint.RawQuery != "" {
		http.Error(w, "service endpoint cannot contain a query", 400)
		return
	}
	issuers, err := discoverProtectedResource(r.Context(), endpoint)
	if err != nil {
		http.Error(w, "service OAuth metadata could not be verified", 400)
		return
	}
	selectedIssuer := canonicalRootIssuer(strings.TrimSpace(input.IssuerURL))
	if selectedIssuer == "" {
		selectedIssuer = canonicalRootIssuer(issuers[0])
	}
	if !slices.ContainsFunc(issuers, func(issuer string) bool { return canonicalRootIssuer(issuer) == selectedIssuer }) {
		http.Error(w, "OAuth issuer is not advertised by this service", 400)
		return
	}
	issuer, err := validatedPublicURL(selectedIssuer)
	if err != nil || issuer.RawQuery != "" {
		http.Error(w, "invalid OAuth issuer", 400)
		return
	}
	authURL, tokenURL, requireIss, err := discoverRemoteOAuth(r.Context(), issuer)
	if err != nil {
		http.Error(w, "OAuth issuer discovery failed", 400)
		return
	}
	authorizationEndpoint, err := validatedPublicURL(authURL)
	if err != nil {
		http.Error(w, "invalid discovered authorization endpoint", 400)
		return
	}
	for _, reserved := range []string{"state", "client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method", "resource"} {
		if _, ok := authorizationEndpoint.Query()[reserved]; ok {
			http.Error(w, "authorization endpoint contains reserved parameters", 400)
			return
		}
	}
	tokenEndpoint, err := validatedPublicURL(tokenURL)
	if err != nil || tokenEndpoint.RawQuery != "" {
		http.Error(w, "invalid discovered token endpoint", 400)
		return
	}
	scopes := strings.Fields(input.Scopes)
	if len(scopes) == 0 || len(scopes) > 30 {
		http.Error(w, "enter the scopes required by this service", 400)
		return
	}
	id, err := randomURLSafeString(9)
	if err != nil {
		http.Error(w, "could not create connection", 500)
		return
	}
	c := remoteConnection{ID: id, Provider: input.Provider, Name: input.Name, Endpoint: endpoint.String(), Issuer: selectedIssuer, RequireIssuerResponse: requireIss, AuthURL: authURL, TokenURL: tokenURL, ClientID: input.ClientID, ClientSecret: input.ClientSecret, Scopes: scopes}
	err = withRemoteConnections(func(records map[string]remoteConnection) error {
		if len(records) >= 20 {
			return errors.New("connection limit reached")
		}
		records[id] = c
		return saveRemoteConnections(records)
	})
	if err != nil {
		http.Error(w, "could not save connection", 500)
		return
	}
	writeSDKJSON(w, 201, c.public())
}

func (s *Server) handleRemoteItem(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		http.Error(w, "unknown connection", 404)
		return
	}
	switch r.Method {
	case "DELETE":
		err := withRemoteConnections(func(records map[string]remoteConnection) error {
			if _, ok := records[id]; !ok {
				return os.ErrNotExist
			}
			delete(records, id)
			return saveRemoteConnections(records)
		})
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				http.Error(w, "connection not found", 404)
				return
			}
			http.Error(w, "could not remove connection", 500)
			return
		}
		writeSDKJSON(w, 200, map[string]string{"state": "removed"})
	case "POST":
		if strings.HasSuffix(r.URL.Path, "/start") {
			s.handleRemoteStart(w, r, id)
		} else if strings.HasSuffix(r.URL.Path, "/check") {
			s.handleRemoteCheck(w, r, id)
		} else {
			http.Error(w, "not found", 404)
		}
	case "PATCH":
		if strings.HasSuffix(r.URL.Path, "/tools") {
			s.handleRemoteTools(w, r, id)
		} else {
			http.Error(w, "not found", 404)
		}
	default:
		http.Error(w, "method not allowed", 405)
	}
}

func (s *Server) handleRemoteStart(w http.ResponseWriter, r *http.Request, id string) {
	var c remoteConnection
	err := withRemoteConnections(func(records map[string]remoteConnection) error {
		var ok bool
		c, ok = records[id]
		if !ok {
			return os.ErrNotExist
		}
		return nil
	})
	if err != nil {
		http.Error(w, "connection not found", 404)
		return
	}
	state, err := randomURLSafeString(32)
	if err != nil {
		http.Error(w, "could not start authorization", 500)
		return
	}
	verifier, err := randomURLSafeString(64)
	if err != nil {
		http.Error(w, "could not start authorization", 500)
		return
	}
	remotePending.Lock()
	for key, item := range remotePending.items {
		if time.Now().After(item.Expires) {
			delete(remotePending.items, key)
		}
	}
	remotePending.items[state] = remoteAuthAttempt{ID: id, Provider: c.Provider, Verifier: verifier, Issuer: c.Issuer, Endpoint: c.Endpoint, ClientID: c.ClientID, Expires: time.Now().Add(5 * time.Minute)}
	remotePending.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "muxterm_remote_oauth", Value: state, Path: "/api/connections/remote/callback", HttpOnly: true, Secure: strings.HasPrefix(s.remoteCallbackURL(), "https://"), SameSite: http.SameSiteLaxMode, MaxAge: 300})
	cfg := oauth2.Config{ClientID: c.ClientID, ClientSecret: c.ClientSecret, RedirectURL: s.remoteCallbackURL(), Scopes: c.Scopes, Endpoint: oauth2.Endpoint{AuthURL: c.AuthURL, TokenURL: c.TokenURL}}
	options := []oauth2.AuthCodeOption{oauth2.S256ChallengeOption(verifier)}
	if usesResourceIndicator(c) {
		options = append(options, oauth2.SetAuthURLParam("resource", c.Endpoint))
	}
	if c.Issuer == "https://accounts.google.com" {
		options = append(options, oauth2.SetAuthURLParam("access_type", "offline"), oauth2.SetAuthURLParam("prompt", "consent"))
	}
	authURL := cfg.AuthCodeURL(state, options...)
	writeSDKJSON(w, 200, map[string]string{"url": authURL})
}

func (s *Server) handleRemoteCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	state := q.Get("state")
	cookie, err := r.Cookie("muxterm_remote_oauth")
	if err != nil || state == "" || len(q["state"]) != 1 || subtle.ConstantTimeCompare([]byte(cookie.Value), []byte(state)) != 1 {
		http.Error(w, "invalid authorization state", 400)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "muxterm_remote_oauth", Path: "/api/connections/remote/callback", MaxAge: -1, HttpOnly: true, Secure: strings.HasPrefix(s.remoteCallbackURL(), "https://"), SameSite: http.SameSiteLaxMode})
	remotePending.Lock()
	attempt, ok := remotePending.items[state]
	delete(remotePending.items, state)
	remotePending.Unlock()
	if !ok || time.Now().After(attempt.Expires) {
		http.Error(w, "authorization attempt expired", 400)
		return
	}
	selection := attempt.Provider
	if selection == "" {
		selection = "remote"
	}
	returnToConnections := func(reason string) {
		http.Redirect(w, r, "/?connections="+selection+"&connection_error="+reason, http.StatusSeeOther)
	}
	iss := q.Get("iss")
	if len(q["iss"]) > 1 || (iss != "" && canonicalRootIssuer(iss) != attempt.Issuer) {
		returnToConnections("failed")
		return
	}
	if q.Get("error") == "" && len(q["code"]) != 1 {
		returnToConnections("failed")
		return
	}
	if reason := q.Get("error"); reason != "" {
		if reason == "access_denied" {
			returnToConnections("denied")
		} else {
			returnToConnections("failed")
		}
		return
	}
	code := q.Get("code")
	if code == "" {
		returnToConnections("failed")
		return
	}
	var c remoteConnection
	err = withRemoteConnections(func(records map[string]remoteConnection) error {
		var ok bool
		c, ok = records[attempt.ID]
		if !ok {
			return os.ErrNotExist
		}
		return nil
	})
	if err != nil {
		returnToConnections("failed")
		return
	}
	if c.Provider != attempt.Provider || c.Issuer != attempt.Issuer || c.Endpoint != attempt.Endpoint || c.ClientID != attempt.ClientID {
		returnToConnections("failed")
		return
	}
	if c.RequireIssuerResponse && iss == "" {
		returnToConnections("failed")
		return
	}
	cfg := oauth2.Config{ClientID: c.ClientID, ClientSecret: c.ClientSecret, RedirectURL: s.remoteCallbackURL(), Scopes: c.Scopes, Endpoint: oauth2.Endpoint{AuthURL: c.AuthURL, TokenURL: c.TokenURL}}
	ctx := context.WithValue(r.Context(), oauth2.HTTPClient, safeRemoteHTTPClient(12*time.Second))
	options := []oauth2.AuthCodeOption{oauth2.VerifierOption(attempt.Verifier)}
	if usesResourceIndicator(c) {
		options = append(options, oauth2.SetAuthURLParam("resource", c.Endpoint))
	}
	token, err := cfg.Exchange(ctx, code, options...)
	if err != nil || token.AccessToken == "" {
		returnToConnections("failed")
		return
	}
	if c.Provider != "" && token.RefreshToken == "" {
		returnToConnections("failed")
		return
	}
	revision, err := randomURLSafeString(12)
	if err != nil {
		returnToConnections("failed")
		return
	}
	err = withRemoteConnections(func(records map[string]remoteConnection) error {
		current, ok := records[attempt.ID]
		if !ok || current.Provider != attempt.Provider || current.ClientID != c.ClientID || current.TokenURL != c.TokenURL || current.Issuer != attempt.Issuer || current.Endpoint != attempt.Endpoint {
			return errors.New("connection changed")
		}
		current.Token = token
		current.AuthRevision = revision
		current.ToolCount = 0
		current.CheckedAt = time.Time{}
		current.CheckError = ""
		current.DiscoveredTools = nil
		current.AllowedTools = nil
		records[attempt.ID] = current
		return saveRemoteConnections(records)
	})
	if err != nil {
		returnToConnections("failed")
		return
	}
	http.Redirect(w, r, "/?connections="+selection, http.StatusSeeOther)
}

func remoteTokenSnapshot(id string) (remoteConnection, string, error) {
	var c remoteConnection
	var access string
	err := withRemoteConnections(func(records map[string]remoteConnection) error {
		var ok bool
		c, ok = records[id]
		if !ok {
			return os.ErrNotExist
		}
		if c.Token == nil || c.Token.AccessToken == "" {
			return errors.New("connection is not authorized")
		}
		if (c.Token.Valid() && time.Until(c.Token.Expiry) > 2*time.Minute) || c.Token.Expiry.IsZero() {
			access = c.Token.AccessToken
		}
		return nil
	})
	return c, access, err
}

func remoteRefreshLockPath(id string) string {
	hash := sha256.Sum256([]byte(id))
	return filepath.Join(filepath.Dir(remoteConnectionsPath()), "remote-refresh-"+hex.EncodeToString(hash[:]))
}

func remoteAccessToken(ctx context.Context, id string) (remoteConnection, string, error) {
	c, access, err := remoteTokenSnapshot(id)
	if err != nil || access != "" {
		return c, access, err
	}
	// Only refreshes for this connection serialize with one another. Browser
	// reads and writes to remote.json continue while the network request runs.
	err = withRemoteConnectionFileLock(remoteRefreshLockPath(id), func() error {
		c, access, err = remoteTokenSnapshot(id)
		if err != nil || access != "" {
			return err
		}
		if c.Token.RefreshToken == "" {
			return errors.New("connection needs authorization")
		}
		snapshot := c
		cfg := oauth2.Config{ClientID: c.ClientID, ClientSecret: c.ClientSecret, Endpoint: oauth2.Endpoint{TokenURL: c.TokenURL}}
		refreshClient := safeRemoteHTTPClient(12 * time.Second)
		if usesResourceIndicator(c) {
			refreshClient.Transport = resourceRefreshTransport{base: refreshClient.Transport, resource: c.Endpoint}
		}
		refreshCtx := context.WithValue(ctx, oauth2.HTTPClient, refreshClient)
		// oauth2.TokenSource uses a shorter expiry margin than our two-minute
		// refresh window. Expire only its copy so this branch actually redeems
		// the refresh token instead of saving the old access token again.
		refreshInput := *c.Token
		refreshInput.Expiry = time.Now().Add(-time.Second)
		fresh, refreshErr := cfg.TokenSource(refreshCtx, &refreshInput).Token()
		if refreshErr != nil {
			return errors.New("connection token refresh failed")
		}
		if fresh.RefreshToken == "" {
			fresh.RefreshToken = snapshot.Token.RefreshToken
		}
		return withRemoteConnections(func(records map[string]remoteConnection) error {
			current, ok := records[id]
			if !ok || current.Token == nil || current.AuthRevision != snapshot.AuthRevision || current.Token.RefreshToken != snapshot.Token.RefreshToken || current.Token.AccessToken != snapshot.Token.AccessToken {
				return errors.New("connection changed during refresh")
			}
			current.Token = fresh
			records[id] = current
			if err := saveRemoteConnections(records); err != nil {
				return err
			}
			c = current
			access = fresh.AccessToken
			return nil
		})
	})
	return c, access, err
}

// oauth2.Config.TokenSource omits resource on refresh. MCP authorization uses
// RFC 8707 resource binding, so add the same resource to refresh grants.
type resourceRefreshTransport struct {
	base     http.RoundTripper
	resource string
}

func (t resourceRefreshTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method != "POST" {
		return t.base.RoundTrip(r)
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	form, err := url.ParseQuery(string(body))
	if err != nil {
		return nil, err
	}
	if form.Get("grant_type") != "refresh_token" {
		return nil, errors.New("unexpected token grant")
	}
	form.Set("resource", t.resource)
	copy := r.Clone(r.Context())
	encoded := form.Encode()
	copy.Body = io.NopCloser(strings.NewReader(encoded))
	copy.ContentLength = int64(len(encoded))
	return t.base.RoundTrip(copy)
}

type remoteBearerTransport struct {
	ID, Endpoint, AuthRevision string
	Base                       http.RoundTripper
}

func (t remoteBearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	target, _ := url.Parse(t.Endpoint)
	port := func(u *url.URL) string {
		if u.Port() == "" {
			return "443"
		}
		return u.Port()
	}
	if r.URL.Scheme != "https" || !strings.EqualFold(r.URL.Hostname(), target.Hostname()) || port(r.URL) != port(target) {
		return nil, errors.New("remote tool request left the authorized host")
	}
	c, token, err := remoteAccessToken(r.Context(), t.ID)
	if err != nil {
		return nil, err
	}
	if c.Endpoint != t.Endpoint || c.AuthRevision != t.AuthRevision {
		return nil, errors.New("remote connection changed")
	}
	copy := r.Clone(r.Context())
	copy.Header.Set("Authorization", "Bearer "+token)
	return t.Base.RoundTrip(copy)
}

func connectRemote(ctx context.Context, c remoteConnection) (*mcp.ClientSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: "muxterm-remote-bridge", Version: "1"}, nil)
	safe := safeRemoteHTTPClient(0)
	safe.Transport = remoteBearerTransport{ID: c.ID, Endpoint: c.Endpoint, AuthRevision: c.AuthRevision, Base: safe.Transport}
	transport := &mcp.StreamableClientTransport{Endpoint: c.Endpoint, HTTPClient: safe}
	return client.Connect(ctx, transport, nil)
}

// The pinned SDK panics when Server.AddTool receives nil or a non-object
// input/output schema. Remote providers control these values, so skip only
// the malformed tool and keep the other connections available.
func validRemoteToolSchema(schema any) bool {
	if schema == nil {
		return false
	}
	b, err := json.Marshal(schema)
	if err != nil {
		return false
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(b, &object); err != nil {
		return false
	}
	var kind string
	return json.Unmarshal(object["type"], &kind) == nil && kind == "object"
}

func listRemoteTools(ctx context.Context, session *mcp.ClientSession) ([]*mcp.Tool, error) {
	var tools []*mcp.Tool
	cursor := ""
	seen := map[string]bool{}
	for {
		var p *mcp.ListToolsParams
		if cursor != "" {
			p = &mcp.ListToolsParams{Cursor: cursor}
		}
		result, err := session.ListTools(ctx, p)
		if err != nil {
			return nil, err
		}
		tools = append(tools, result.Tools...)
		if result.NextCursor == "" {
			return tools, nil
		}
		if seen[result.NextCursor] || len(tools) > 1000 {
			return nil, errors.New("remote tool catalog too large")
		}
		seen[result.NextCursor] = true
		cursor = result.NextCursor
	}
}

func (s *Server) handleRemoteCheck(w http.ResponseWriter, r *http.Request, id string) {
	errAuthChanged := errors.New("authorization changed during tool check")
	var c remoteConnection
	err := withRemoteConnections(func(records map[string]remoteConnection) error {
		var ok bool
		c, ok = records[id]
		if !ok {
			return os.ErrNotExist
		}
		return nil
	})
	if err != nil {
		http.Error(w, "connection not found", 404)
		return
	}
	if c.Token == nil {
		http.Error(w, "authorize this connection first", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	session, err := connectRemote(ctx, c)
	count := 0
	var discovered []remoteToolSummary
	errNoTools := errors.New("This service returned no tools for this account; check its access requirements")
	statusMessage := ""
	if err == nil {
		defer session.Close()
		var tools []*mcp.Tool
		tools, err = listRemoteTools(ctx, session)
		if err == nil {
			seen := map[string]bool{}
			for _, tool := range tools {
				if tool == nil || tool.Name == "" || seen[tool.Name] ||
					!validRemoteToolSchema(tool.InputSchema) ||
					(tool.OutputSchema != nil && !validRemoteToolSchema(tool.OutputSchema)) ||
					!presetAllowsRemoteTool(c, tool.Name) {
					continue
				}
				seen[tool.Name] = true
				description := tool.Description
				if len(description) > 240 {
					description = description[:240]
				}
				discovered = append(discovered, remoteToolSummary{Name: tool.Name, Description: description})
			}
			count = len(discovered)
			if count == 0 {
				if c.Provider != "" && len(tools) > 0 {
					statusMessage = "This Google service returned tools, but none match muxterm's approved read tools. Check product access or supported tools."
				} else if c.Provider != "" {
					statusMessage = "Google returned no tools for this account. Check Developer Preview and product API access."
				} else {
					err = errNoTools
				}
			}
		}
	}
	saveErr := withRemoteConnections(func(records map[string]remoteConnection) error {
		current, ok := records[id]
		if !ok {
			return os.ErrNotExist
		}
		if current.AuthRevision != c.AuthRevision {
			return errAuthChanged
		}
		if err != nil {
			if errors.Is(err, errNoTools) {
				current.CheckError = errNoTools.Error()
			} else {
				current.CheckError = "Remote tools could not be reached; check account and service access"
			}
		} else {
			current.CheckedAt = time.Now()
			current.ToolCount = count
			current.DiscoveredTools = discovered
			present := map[string]bool{}
			for _, tool := range discovered {
				present[tool.Name] = true
			}
			kept := make([]string, 0, len(current.AllowedTools))
			for _, name := range current.AllowedTools {
				if present[name] {
					kept = append(kept, name)
				}
			}
			current.AllowedTools = kept
			current.CheckError = statusMessage
		}
		records[id] = current
		return saveRemoteConnections(records)
	})
	if saveErr != nil {
		if errors.Is(saveErr, errAuthChanged) {
			http.Error(w, errAuthChanged.Error(), http.StatusConflict)
			return
		}
		http.Error(w, "could not save connection status", 500)
		return
	}
	if err != nil {
		if errors.Is(err, errNoTools) {
			http.Error(w, errNoTools.Error(), http.StatusUnprocessableEntity)
			return
		}
		http.Error(w, "Remote tools could not be reached; check account and service access", 502)
		return
	}
	if statusMessage != "" {
		writeSDKJSON(w, 200, map[string]any{"state": "needs-attention", "toolCount": 0})
		return
	}
	writeSDKJSON(w, 200, map[string]any{"state": "ready", "toolCount": count})
}

func (s *Server) handleRemoteTools(w http.ResponseWriter, r *http.Request, id string) {
	var input struct {
		AllowedTools []string `json:"allowedTools"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&input); err != nil {
		http.Error(w, "invalid tool selection", 400)
		return
	}
	errUnchecked := errors.New("check tools before allowing them")
	errUnknown := errors.New("unknown or repeated tool")
	err := withRemoteConnections(func(records map[string]remoteConnection) error {
		c, ok := records[id]
		if !ok {
			return os.ErrNotExist
		}
		if c.CheckedAt.IsZero() || c.CheckError != "" {
			return errUnchecked
		}
		known := map[string]bool{}
		for _, tool := range c.DiscoveredTools {
			known[tool.Name] = true
		}
		seen := map[string]bool{}
		for _, name := range input.AllowedTools {
			if !known[name] || seen[name] || !presetAllowsRemoteTool(c, name) {
				return errUnknown
			}
			seen[name] = true
		}
		c.AllowedTools = input.AllowedTools
		records[id] = c
		return saveRemoteConnections(records)
	})
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			http.Error(w, "connection not found", 404)
			return
		}
		if errors.Is(err, errUnchecked) || errors.Is(err, errUnknown) {
			http.Error(w, "invalid tool selection", 400)
			return
		}
		http.Error(w, "tool selection could not be saved", 500)
		return
	}
	writeSDKJSON(w, 200, map[string]any{"allowedTools": input.AllowedTools})
}

func remoteToolAllowed(id, name, revision string) bool {
	allowed := false
	_ = withRemoteConnections(func(records map[string]remoteConnection) error {
		c, ok := records[id]
		if !ok || c.Token == nil || c.CheckError != "" || c.AuthRevision != revision {
			return nil
		}
		allowed = slices.Contains(c.AllowedTools, name) && presetAllowsRemoteTool(c, name)
		return nil
	})
	return allowed
}

// RunRemoteConnectionsMCP exposes authorized remote tools through one stdio
// server. Prefixes keep unrelated remote tool names distinct across harnesses.
func RunRemoteConnectionsMCP(ctx context.Context) error {
	records, err := loadRemoteConnections()
	if err != nil {
		return err
	}
	local := mcp.NewServer(&mcp.Implementation{Name: "muxterm-remote-connections", Version: "1"}, nil)
	var sessions []*mcp.ClientSession
	defer func() {
		for _, s := range sessions {
			_ = s.Close()
		}
	}()
	for _, c := range records {
		if c.Token == nil || c.AuthRevision == "" || c.CheckedAt.IsZero() || c.CheckError != "" || len(c.AllowedTools) == 0 {
			continue
		}
		// The SDK detaches the stream lifetime from Connect's context. Bound
		// each provider's setup so one stalled endpoint cannot block all chats.
		setupCtx, setupCancel := context.WithTimeout(ctx, 20*time.Second)
		session, err := connectRemote(setupCtx, c)
		setupCancel()
		if err != nil {
			continue
		}
		listCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		tools, err := listRemoteTools(listCtx, session)
		cancel()
		if err != nil {
			_ = session.Close()
			continue
		}
		sessions = append(sessions, session)
		for _, tool := range tools {
			if tool == nil || tool.Name == "" || !slices.Contains(c.AllowedTools, tool.Name) ||
				!validRemoteToolSchema(tool.InputSchema) ||
				(tool.OutputSchema != nil && !validRemoteToolSchema(tool.OutputSchema)) ||
				!presetAllowsRemoteTool(c, tool.Name) {
				continue
			}
			t := *tool
			original := t.Name
			t.Name = "remote_" + c.ID + "_" + t.Name
			remote := session
			local.AddTool(&t, func(callCtx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				if !remoteToolAllowed(c.ID, original, c.AuthRevision) {
					return nil, errors.New("remote tool is no longer enabled")
				}
				bounded, cancel := context.WithTimeout(callCtx, 2*time.Minute)
				defer cancel()
				return remote.CallTool(bounded, &mcp.CallToolParams{Name: original, Arguments: json.RawMessage(request.Params.Arguments)})
			})
		}
	}
	return local.Run(ctx, &mcp.StdioTransport{})
}
