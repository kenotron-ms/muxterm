package server

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"time"

	"github.com/user/muxterm/internal/proxy"
	"github.com/user/muxterm/internal/sessiond"
)

func init() {
	// Go's mime package has no built-in mapping for the PWA manifest
	// extension. Without this, http.FileServer serves manifest.webmanifest as
	// application/octet-stream and some browsers reject it.
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// Config holds the configuration for creating a new Server.
type Config struct {
	Addr     string
	Secret   string
	StaticFS fs.FS
}

// Server is the HTTP server for muxterm.
type Server struct {
	addr   string
	secret string
	mux    *http.ServeMux
	hub    *Hub
}

// New creates a Server, registers routes, and optionally serves static files.
// The Hub is created with a nil dialer; the per-browser daemon dialer is
// injected later via s.hub.SetDialer.
func New(cfg Config) *Server {
	s := &Server{
		addr:   cfg.Addr,
		secret: cfg.Secret,
		mux:    http.NewServeMux(),
		hub:    NewHub(nil),
	}

	s.mux.HandleFunc("GET /api/health", s.handleHealth)
	s.mux.HandleFunc("GET /api/token", s.handleToken)
	s.mux.HandleFunc("GET /ws", s.handleWS)

	// Proxy routes: /sw.js and /p/{port}/ for browser pane content serving.
	s.mux.HandleFunc("GET /sw.js", func(w http.ResponseWriter, r *http.Request) {
		proxy.ServeServiceWorker(w, r)
	})
	s.mux.Handle("/p/", proxy.NewHandler("localhost", nil)) // ProxyHeaders injection deferred to v2

	// REST endpoint for CLI and agent automation: create a browser pane without a WebSocket.
	s.mux.HandleFunc("POST /api/pane", s.handleCreatePane)

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

type createPaneRequest struct {
	SurfaceKind  string            `json:"surfaceKind"`
	BrowserPort  int               `json:"browserPort"`
	BrowserPath  string            `json:"browserPath"`
	ProxyHeaders map[string]string `json:"proxyHeaders"`
}

// handleCreatePane handles POST /api/pane for the CLI open-browser command.
// Only accepts requests from localhost. Creates a browser pane in the default
// workspace by dialing sessiond directly.
func (s *Server) handleCreatePane(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	var req createPaneRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.SurfaceKind != "browser" {
		http.Error(w, "only surfaceKind=browser is supported", http.StatusBadRequest)
		return
	}
	if req.BrowserPort <= 0 || req.BrowserPort > 65535 {
		http.Error(w, "browserPort must be 1–65535", http.StatusBadRequest)
		return
	}
	if req.BrowserPath == "" {
		req.BrowserPath = "/"
	}
	conn, err := s.hub.Dial()
	if err != nil {
		http.Error(w, "sessiond unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	defer conn.Close()
	errCh := make(chan error, 1)
	go func() { errCh <- conn.Run() }()
	workspaces, err := conn.ListWorkspaces()
	if err != nil || len(workspaces) == 0 {
		http.Error(w, "no workspace available", http.StatusInternalServerError)
		return
	}
	wsID := workspaces[0].WorkspaceID
	if _, err := conn.Attach(wsID, ""); err != nil {
		http.Error(w, "attach failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	paneID, err := conn.CreateBrowserPane(req.BrowserPort, req.BrowserPath, req.ProxyHeaders)
	if err != nil {
		http.Error(w, "create pane failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(struct {
		Type   string `json:"type"`
		PaneID int    `json:"paneId"`
	}{sessiond.TypePaneCreated, paneID})
}
