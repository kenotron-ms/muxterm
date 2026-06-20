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

	muxcfg "github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
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
	NoAuth        bool                     // skip token/localhost auth check (dev only)
	ConfigPath    string                   // path to write config.toml on PATCH /api/config (empty = skip writes)
	InitialConfig muxcfg.Config            // initial resolved configuration (zero value = package defaults)
	BrowserManager *sessiond.BrowserManager // optional; nil disables /ws/browser CDP features
}

// Server is the HTTP server for muxterm.
type Server struct {
	addr    string
	secret  string
	noAuth  bool
	mux     *http.ServeMux
	hub     *Hub
	tunnels *TunnelRegistry

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
		addr:    cfg.Addr,
		secret:  cfg.Secret,
		noAuth:  cfg.NoAuth,
		mux:     http.NewServeMux(),
		hub:     hub,
		tunnels: tunnels,
	}

	s.configPath = cfg.ConfigPath
	// Use the supplied initial config if it looks populated (palette is never
	// empty in a real config), otherwise fall back to hardcoded defaults.
	s.cfg = cfg.InitialConfig
	if s.cfg.Theme.Palette == "" {
		s.cfg = muxcfg.Defaults()
	}

	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/token", s.handleToken)
	s.mux.HandleFunc("GET /api/config", s.handleGetConfig)
	s.mux.HandleFunc("PATCH /api/config", s.handlePatchConfig)
	s.mux.HandleFunc("GET /api/tunnels", s.handleTunnelList)
	s.mux.HandleFunc("POST /api/tunnels", s.handleTunnelCreate)
	s.mux.HandleFunc("DELETE /api/tunnels/{id}", s.handleTunnelClose)
	s.mux.HandleFunc("/t/", s.handleTunnelProxy)
	s.mux.HandleFunc("GET /ws", s.handleWS)
	s.mux.HandleFunc("GET /ws/browser", s.handleWSBrowser)

	if cfg.StaticFS != nil {
		s.mux.Handle("/", http.FileServer(http.FS(cfg.StaticFS)))
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

// Secret returns the server's secret.
func (s *Server) Secret() string {
	return s.secret
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	token, err := GenerateToken(s.secret)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	s.handleWSImpl(w, r)
}

func (s *Server) handleWSBrowser(w http.ResponseWriter, r *http.Request) {
	s.handleWSBrowserImpl(w, r)
}

// handleTunnelList returns a JSON array of all active tunnels (id, port).
// Restricted to localhost callers; the primary consumer is the MCP server.
func (s *Server) handleTunnelList(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
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
// assigned id. Body must be JSON {"port": <int>}. Restricted to localhost.
func (s *Server) handleTunnelCreate(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
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
// segment. Returns 404 when the id is unknown. Restricted to localhost.
func (s *Server) handleTunnelClose(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
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
	// before forwarding to the upstream.
	cloned := r.Clone(r.Context())
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
