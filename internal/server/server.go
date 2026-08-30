package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/ai"
	"github.com/kenotron-ms/muxterm/internal/authserver"
	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
)

func init() {
	// Go's mime package has no built-in mapping for the PWA manifest
	// extension. Without this, http.FileServer serves manifest.webmanifest as
	// application/octet-stream and some browsers reject it.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// Config holds the configuration for creating a new Server.
type Config struct {
	Addr          string
	Secret        string
	StaticFS      fs.FS
	NoAuth        bool          // skip all auth checks, including loopback bypass (dev only)
	ConfigPath    string        // path to write config.toml on PATCH /api/config (empty = skip writes)
	InitialConfig muxcfg.Config // initial resolved configuration (zero value = package defaults)

	// AIKeyPath is the file path of the owner-only Anthropic API key. Empty
	// means ai.DefaultKeyPath(). The key is deliberately NOT part of
	// InitialConfig: anything in config.Config is published by GET /api/config,
	// Hub.BroadcastConfig, and MCP get_config by construction.
	AIKeyPath string

	// AuthServer is nil when the platform login backend is unavailable at
	// startup (see cmd/muxterm's newAuthServer) — in that case every
	// non-loopback request is denied (fail closed), and /authorize,
	// /token, /auth/login, /auth/callback are not mounted at all.
	AuthServer *authserver.AuthServer
	// WebRedirectURI is the exact-match redirect URI for the muxterm-web
	// OAuth client (e.g. "http://127.0.0.1:8311/auth/callback").
	WebRedirectURI string
	// BehindReverseProxy mirrors config.ServerConfig.BehindReverseProxy.
	// When true the IsLocalhost() auth bypass is disabled entirely — see
	// internal/server/authmiddleware.go.
	BehindReverseProxy bool
}

// Server is the HTTP server for muxterm.
type Server struct {
	addr               string
	noAuth             bool
	behindReverseProxy bool
	mux                *http.ServeMux
	hub                *Hub
	tunnels            *TunnelRegistry

	authSrv        *authserver.AuthServer
	webRedirectURI string

	// configPath is the file path for persisting PATCH /api/config writes.
	// Empty string means writes are skipped (dev/test mode).
	configPath string
	cfgMu      sync.RWMutex
	cfg        muxcfg.Config

	// ai owns the opt-in AI capability: key storage, the enabled flag, and the
	// lazily-constructed Anthropic client. Never reachable from cfg.
	ai *ai.Manager
}

// New creates a Server, registers routes, and optionally serves static files.
// The Hub is created with a nil dialer; the per-browser daemon dialer is
// injected later via s.hub.SetDialer.
func New(cfg Config) *Server {
	tunnels := NewTunnelRegistry()
	hub := NewHub(nil)
	hub.tunnels = tunnels

	s := &Server{
		addr:               cfg.Addr,
		noAuth:             cfg.NoAuth,
		behindReverseProxy: cfg.BehindReverseProxy,
		mux:                http.NewServeMux(),
		hub:                hub,
		tunnels:            tunnels,
		authSrv:            cfg.AuthServer,
		webRedirectURI:     cfg.WebRedirectURI,
	}

	s.configPath = cfg.ConfigPath
	// Use the supplied initial config if it looks populated (palette is never
	// empty in a real config), otherwise fall back to hardcoded defaults.
	s.cfg = cfg.InitialConfig
	if s.cfg.Theme.Palette == "" {
		s.cfg = muxcfg.Defaults()
	}

	aiKeyPath := cfg.AIKeyPath
	if aiKeyPath == "" {
		aiKeyPath = ai.DefaultKeyPath()
	}
	s.ai = ai.NewManager(aiKeyPath)

	authMW := NewAuthMiddleware(cfg.AuthServer, cfg.NoAuth, cfg.BehindReverseProxy)
	protect := func(h http.Handler) http.Handler {
		return authMW.Wrap(h)
	}

	// NOTE for the Phase 2 (MCP-over-HTTP) surface: muxterm does not yet
	// serve an RFC 8414 .well-known/oauth-authorization-server document, an
	// RFC 9728 .well-known/oauth-protected-resource document, or a POST
	// /mcp route — none of them exist anywhere in this codebase today.
	// When they are added, every absolute URL inside them (issuer,
	// authorization_endpoint, token_endpoint, resource, and the canonical
	// /mcp resource URI) MUST be built from the same origin that produced
	// cfg.WebRedirectURI — cmd/muxterm's publicBaseURL, which resolves to
	// the operator-configured public_origin behind a reverse proxy and to
	// the loopback derivation otherwise. They MUST NOT be derived from
	// r.Host, X-Forwarded-Host, X-Forwarded-Proto, or any other request
	// header: headers are spoofable, and the design rejects trusting them
	// for any trust-relevant value. Deriving them anywhere else is how
	// these documents silently drift from the registered redirect URI.

	// Public, unauthenticated routes.
	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	if s.authSrv != nil {
		s.mux.HandleFunc("GET /authorize", s.authSrv.ServeAuthorize)
		s.mux.HandleFunc("POST /authorize", s.authSrv.ServeAuthorize)
		s.mux.HandleFunc("POST /token", s.authSrv.ServeToken)
		s.mux.HandleFunc("GET /auth/login", s.handleAuthLogin)
		s.mux.HandleFunc("GET /auth/callback", s.handleAuthCallback)
		s.mux.HandleFunc("POST /auth/logout", s.handleAuthLogout)
	}

	// Protected routes: loopback bypass, else a valid session (cookie or
	// bearer token) is required — see internal/server/authmiddleware.go.
	s.mux.Handle("GET /api/config", protect(http.HandlerFunc(s.handleGetConfig)))
	s.mux.Handle("PATCH /api/config", protect(http.HandlerFunc(s.handlePatchConfig)))

	// Opt-in AI capability. Deliberately a separate route family from
	// /api/config: the key goes in via PUT and only a derived Status comes out.
	s.mux.Handle("GET /api/ai/status", protect(http.HandlerFunc(s.handleAIStatus)))
	s.mux.Handle("PUT /api/ai/key", protect(http.HandlerFunc(s.handleAIPutKey)))
	s.mux.Handle("DELETE /api/ai/key", protect(http.HandlerFunc(s.handleAIDeleteKey)))
	s.mux.Handle("POST /api/ai/ping", protect(http.HandlerFunc(s.handleAIPing)))

	s.mux.Handle("GET /api/tunnels", protect(http.HandlerFunc(s.handleTunnelList)))
	s.mux.Handle("POST /api/tunnels", protect(http.HandlerFunc(s.handleTunnelCreate)))
	s.mux.Handle("DELETE /api/tunnels/{id}", protect(http.HandlerFunc(s.handleTunnelClose)))
	s.mux.Handle("/t/", protect(http.HandlerFunc(s.handleTunnelProxy)))
	s.mux.Handle("GET /ws", protect(http.HandlerFunc(s.handleWS)))

	if cfg.StaticFS != nil {
		s.mux.Handle("/", protect(http.FileServer(http.FS(cfg.StaticFS))))
	}

	return s
}

// Handler returns the http.Handler for use with httptest or custom servers.
func (s *Server) Handler() http.Handler {
	return s.mux
}

// ListenAndServe starts the HTTP server and blocks until ctx is cancelled.
// It performs a graceful shutdown with a 5-second timeout and returns nil
// when the server closes normally.
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &http.Server{
		Addr:    s.addr,
		Handler: s.mux,
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		// Drain the ListenAndServe error (ErrServerClosed)
		<-errCh
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// Hub returns the server's WebSocket hub.
func (s *Server) Hub() *Hub {
	return s.hub
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	s.handleWSImpl(w, r)
}

// handleTunnelList returns a JSON array of all active tunnels (id, port).
// AuthMiddleware protects this route at mux registration.
func (s *Server) handleTunnelList(w http.ResponseWriter, r *http.Request) {
	entries := s.tunnels.List()
	items := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		items = append(items, map[string]any{
			"id":   e.id,
			"port": e.port,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items) //nolint:errcheck
}

// handleTunnelCreate registers a new port-forward tunnel and returns the
// assigned id. Body must be JSON {"port": <int>}. AuthMiddleware protects
// this route at mux registration.
func (s *Server) handleTunnelCreate(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Port int `json:"port"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Port == 0 {
		http.Error(w, "port required", http.StatusBadRequest)
		return
	}
	id, err := s.tunnels.Create(body.Port)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{ //nolint:errcheck
		"id":   id,
		"port": body.Port,
	})
}

// handleTunnelClose deregisters the tunnel identified by the {id} path
// segment. Returns 404 when the id is unknown. AuthMiddleware protects this
// route at mux registration.
func (s *Server) handleTunnelClose(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.tunnels.Close(id) {
		http.Error(w, "tunnel not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true}) //nolint:errcheck
}

// handleTunnelProxy reverse-proxies requests arriving at /t/{id}/... to the
// local port registered under id. It returns 400 when no id segment is
// present and 404 when the id is unknown.
func (s *Server) handleTunnelProxy(w http.ResponseWriter, r *http.Request) {
	// Strip the leading "/t/" prefix, then extract the id (up to the next '/').
	rest := strings.TrimPrefix(r.URL.Path, "/t/")
	if rest == "" {
		http.Error(w, "tunnel id required", http.StatusBadRequest)
		return
	}

	// Extract the ID segment (everything before the first '/').
	id := rest
	suffix := ""
	if idx := strings.Index(rest, "/"); idx >= 0 {
		id = rest[:idx]
		suffix = rest[idx:]
	}

	if id == "" {
		http.Error(w, "tunnel id required", http.StatusBadRequest)
		return
	}

	port, ok := s.tunnels.Port(id)
	if !ok {
		http.Error(w, "tunnel not found", http.StatusNotFound)
		return
	}

	target, err := url.Parse(fmt.Sprintf("http://localhost:%d", port))
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// Clone the request and rewrite the URL path to strip the /t/{id} prefix
	// before forwarding to the upstream. Browser credentials are stripped
	// so the tunneled (potentially untrusted, arbitrary local dev server)
	// target never receives muxterm's own session credentials. The response
	// policy below also forces every tunneled document into an opaque sandboxed
	// origin so it cannot inherit muxterm's browser authority.
	cloned := r.Clone(r.Context())
	cloned.Header.Del("Cookie")
	cloned.Header.Del("Authorization")
	cloned.Header.Del("Proxy-Authorization")
	cloned.URL = &url.URL{
		Scheme:   target.Scheme,
		Host:     target.Host,
		Path:     suffix,
		RawQuery: r.URL.RawQuery,
	}
	cloned.Host = target.Host

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ModifyResponse = func(resp *http.Response) error {
		for _, name := range []string{
			"Set-Cookie",
			"Set-Cookie2",
			"Clear-Site-Data",
			"WWW-Authenticate",
			"Proxy-Authenticate",
			"Authentication-Info",
			"Proxy-Authentication-Info",
			"Content-Security-Policy-Report-Only",
			"Report-To",
			"Reporting-Endpoints",
			"NEL",
			"Origin-Agent-Cluster",
			"Cross-Origin-Opener-Policy",
			"Cross-Origin-Embedder-Policy",
			"Strict-Transport-Security",
			"Alt-Svc",
			"Accept-CH",
			"Accept-CH-Lifetime",
			"Critical-CH",
			"Delegate-CH",
			"Expect-CT",
			"Public-Key-Pins",
			"Public-Key-Pins-Report-Only",
			"Refresh",
		} {
			resp.Header.Del(name)
		}

		resp.Header.Set("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads")
		resp.Header.Set("Referrer-Policy", "no-referrer")
		resp.Header.Set("X-Content-Type-Options", "nosniff")
		resp.Header.Set("Permissions-Policy", "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), publickey-credentials-get=(), serial=(), usb=()")

		if resp.StatusCode >= http.StatusMultipleChoices && resp.StatusCode < http.StatusBadRequest {
			location := resp.Header.Get("Location")
			if location != "" {
				rewritten, err := rewriteTunnelLocation(location, id, target, resp.Request.URL)
				if err != nil {
					return errors.New("unsafe tunnel redirect")
				}
				resp.Header.Set("Location", rewritten)
			}
		}
		return nil
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, http.StatusText(http.StatusBadGateway), http.StatusBadGateway)
	}
	proxy.ServeHTTP(w, cloned)
}

func rewriteTunnelLocation(location, id string, target, requestURL *url.URL) (string, error) {
	redirect, err := url.Parse(location)
	if err != nil || redirect.Opaque != "" || redirect.User != nil {
		return "", errors.New("invalid redirect")
	}
	if err := validateTunnelRedirectPath(redirect); err != nil {
		return "", err
	}
	if redirect.Host != "" {
		if redirect.Scheme != "http" || redirect.Host != target.Host {
			return "", errors.New("off-upstream redirect")
		}
	} else if redirect.Scheme != "" {
		return "", errors.New("invalid redirect scheme")
	}

	resolved := requestURL.ResolveReference(redirect)
	if resolved.Scheme != "http" || resolved.Host != target.Host || resolved.User != nil {
		return "", errors.New("off-upstream redirect")
	}
	if err := validateTunnelRedirectPath(resolved); err != nil {
		return "", err
	}

	path := resolved.Path
	if path == "" {
		path = "/"
	}
	rewritten := &url.URL{
		Path:        "/t/" + id + path,
		RawQuery:    resolved.RawQuery,
		ForceQuery:  resolved.ForceQuery,
		Fragment:    resolved.Fragment,
		RawFragment: resolved.RawFragment,
	}
	return rewritten.String(), nil
}

func validateTunnelRedirectPath(target *url.URL) error {
	for _, escapedSegment := range strings.Split(target.EscapedPath(), "/") {
		segment, err := url.PathUnescape(escapedSegment)
		if err != nil || segment == "." || segment == ".." || strings.ContainsAny(segment, `/\`) {
			return errors.New("unsafe redirect path")
		}
	}
	return nil
}
