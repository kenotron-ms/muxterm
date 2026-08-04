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
	addr    string
	noAuth  bool
	mux     *http.ServeMux
	hub     *Hub
	tunnels *TunnelRegistry

	authSrv        *authserver.AuthServer
	webRedirectURI string

	// configPath is the file path for persisting PATCH /api/config writes.
	// Empty string means writes are skipped (dev/test mode).
	configPath string
	cfgMu      sync.RWMutex
	cfg        muxcfg.Config
}

// New creates a Server, registers routes, and optionally serves static files.
// The Hub is created with a nil dialer; the per-browser daemon dialer is
// injected later via s.hub.SetDialer.
func New(cfg Config) *Server {
	tunnels := NewTunnelRegistry()
	hub := NewHub(nil)
	hub.tunnels = tunnels

	s := &Server{
		addr:           cfg.Addr,
		noAuth:         cfg.NoAuth,
		mux:            http.NewServeMux(),
		hub:            hub,
		tunnels:        tunnels,
		authSrv:        cfg.AuthServer,
		webRedirectURI: cfg.WebRedirectURI,
	}

	s.configPath = cfg.ConfigPath
	// Use the supplied initial config if it looks populated (palette is never
	// empty in a real config), otherwise fall back to hardcoded defaults.
	s.cfg = cfg.InitialConfig
	if s.cfg.Theme.Palette == "" {
		s.cfg = muxcfg.Defaults()
	}

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
	// before forwarding to the upstream. Cookie/Authorization are stripped
	// so the tunneled (potentially untrusted, arbitrary local dev server)
	// target never receives muxterm's own session credentials — see
	// design doc "Tunnel credential stripping." This closes the
	// credential-forwarding vector only; same-origin JS access from the
	// tunneled page is a separate, unresolved limitation (design doc "Out
	// of Scope").
	cloned := r.Clone(r.Context())
	cloned.Header.Del("Cookie")
	cloned.Header.Del("Authorization")
	cloned.URL = &url.URL{
		Scheme:   target.Scheme,
		Host:     target.Host,
		Path:     suffix,
		RawQuery: r.URL.RawQuery,
	}
	cloned.Host = target.Host

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ServeHTTP(w, cloned)
}
