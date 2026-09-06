package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

	// LocalToken authenticates same-user helper processes on this machine
	// (today: the MCP server) to the HTTP API. It is published only via the
	// 0600 handoff file in the 0700 runtime dir that sessiond.WriteServerURL
	// writes. Empty disables the check, which is correct for callers that
	// publish no token. See internal/server/authmiddleware.go.
	LocalToken string

	// Version is the running binary's version string (main.version). Empty or
	// "dev" marks a development build, for which self-update is not offered.
	Version string

	// Remotes is how this process reaches machines that are not this one.
	// nil means the whole remote feature is inert: nothing is discoverable,
	// nothing can be connected, and /api/remotes reports empty lists -- which
	// is what a build wired without a transport should do.
	//
	// The concrete transport is adapted to this interface in cmd/muxterm, so
	// internal/server never imports internal/transport/ssh or internal/deploy.
	Remotes RemoteTransport
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

	// behindReverseProxy is the EFFECTIVE reverse-proxy mode for this
	// server, taken from Config.BehindReverseProxy -- deliberately NOT
	// read from cfg.Server, which carries the config FILE's value.
	//
	// Local mode (bare `muxterm`) ignores the [server] section by design
	// and leaves this false even when config.toml sets
	// behind_reverse_proxy = true, so that a machine configured for
	// production keeps working for direct local use. Reading the file's
	// value here instead would set Secure on cookies served over plain
	// http -- browsers drop those, so local login would fail outright --
	// and would hand out absolute tunnel URLs pointing at the public
	// origin.
	behindReverseProxy bool

	// configPath is the file path for persisting PATCH /api/config writes.
	// Empty string means writes are skipped (dev/test mode).
	configPath string
	cfgMu      sync.RWMutex
	cfg        muxcfg.Config

	// ai owns the opt-in AI capability: key storage, the enabled flag, and the
	// lazily-constructed Anthropic client. Never reachable from cfg.
	ai *ai.Manager

	// version is the running binary's version string, used by the
	// /api/update/* routes. updating serializes apply requests so two
	// concurrent clients cannot both rewrite the binary.
	version  string
	updating atomic.Bool
}

// New creates a Server, registers routes, and optionally serves static files.
// The Hub is created with a nil dialer; the per-browser daemon dialer is
// injected later via s.hub.SetDialer.
func New(cfg Config) *Server {
	tunnels := NewTunnelRegistry()
	hub := NewHub(nil)
	hub.tunnels = tunnels
	hub.remotes = NewRemoteRegistry(cfg.Remotes)

	s := &Server{
		addr:           cfg.Addr,
		noAuth:         cfg.NoAuth,
		mux:            http.NewServeMux(),
		hub:            hub,
		tunnels:        tunnels,
		authSrv:        cfg.AuthServer,
		webRedirectURI: cfg.WebRedirectURI,
		version:        cfg.Version,
	}

	s.configPath = cfg.ConfigPath
	// Use the supplied initial config if it looks populated (palette is never
	// empty in a real config), otherwise fall back to hardcoded defaults.
	s.behindReverseProxy = cfg.BehindReverseProxy
	s.cfg = cfg.InitialConfig
	if s.cfg.Theme.Palette == "" {
		s.cfg = muxcfg.Defaults()
	}

	aiKeyPath := cfg.AIKeyPath
	if aiKeyPath == "" {
		aiKeyPath = ai.DefaultKeyPath()
	}
	s.ai = ai.NewManager(aiKeyPath)

	authMW := NewAuthMiddleware(cfg.AuthServer, cfg.NoAuth, cfg.BehindReverseProxy, cfg.LocalToken)
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

	// Self-update. Protected like every other owner surface: applying an
	// update rewrites the binary this process is running from.
	s.mux.Handle("GET /api/update/status", protect(http.HandlerFunc(s.handleUpdateStatus)))
	s.mux.Handle("POST /api/update/apply", protect(http.HandlerFunc(s.handleUpdateApply)))

	s.mux.Handle("GET /api/tunnels", protect(http.HandlerFunc(s.handleTunnelList)))
	s.mux.Handle("POST /api/tunnels", protect(http.HandlerFunc(s.handleTunnelCreate)))
	s.mux.Handle("DELETE /api/tunnels/{id}", protect(http.HandlerFunc(s.handleTunnelClose)))
	s.mux.Handle("/t/", protect(http.HandlerFunc(s.handleTunnelProxy)))

	// Remote machines. {id} is a HostRef.ID such as "ssh:boxb"; a colon is a
	// legal pchar in a path segment and rule P3 (no "/" in a host id) is what
	// keeps it to one segment. See internal/server/remotes_api.go.
	s.mux.Handle("GET /api/remotes", protect(http.HandlerFunc(s.handleRemotesList)))
	s.mux.Handle("POST /api/remotes", protect(http.HandlerFunc(s.handleRemotesAdd)))
	s.mux.Handle("DELETE /api/remotes/{id}", protect(http.HandlerFunc(s.handleRemotesRemove)))
	s.mux.Handle("POST /api/remotes/{id}/connect", protect(http.HandlerFunc(s.handleRemotesConnect)))
	s.mux.Handle("POST /api/remotes/{id}/disconnect", protect(http.HandlerFunc(s.handleRemotesDisconnect)))
	s.mux.Handle("POST /api/remotes/{id}/provision", protect(http.HandlerFunc(s.handleRemotesProvision)))

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

	// The chief-of-staff sidecar is a child process of THIS process, so it has
	// to be stopped or it outlives the server that spawned it -- and an orphan
	// still holds the amplifier session, so the next muxterm's sidecar becomes
	// a SECOND writer on one transcript.
	//
	// Deferred, not placed in the ctx.Done() arm: this function also returns
	// when ListenAndServe itself fails (a port already in use, a listener
	// error), and that exit orphaned the sidecar. A defer covers every return
	// path, including ones added later. No-op when nobody ever opened the chat.
	//
	// It does NOT cover a panic-free-fall past this frame or a SIGKILL; that is
	// what the child's Pdeathsig is for (internal/cos/pdeathsig_linux.go).
	defer s.hub.CloseCos()

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
			"url":  s.tunnelURL(e.id),
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
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "port required", http.StatusBadRequest)
		return
	}
	// A port outside the valid range is accepted by the registry but
	// produces a target URL that url.Parse rejects, so the tunnel 500s on
	// first use instead of failing here where the caller can see why.
	if body.Port < 1 || body.Port > 65535 {
		http.Error(w, "port must be between 1 and 65535", http.StatusBadRequest)
		return
	}
	// Tunneling muxterm's own listen port to itself is always a mistake and
	// makes a proxy loop that is tedious to diagnose from the other end.
	if _, listenPort, err := net.SplitHostPort(s.addr); err == nil && listenPort == strconv.Itoa(body.Port) {
		http.Error(w, "cannot tunnel muxterm's own listen port", http.StatusBadRequest)
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
		"url":  s.tunnelURL(id),
	})
}

// tunnelURL returns the address a caller should use to reach tunnel id.
//
// It returns an ABSOLUTE url only when an operator has configured a public
// origin; otherwise it returns the relative path "/t/{id}/". This asymmetry
// is deliberate. The only origin muxterm can derive without configuration is
// its own listen address, which in every deployment that has a remote caller
// is a loopback address that is wrong for that caller by construction --
// handing back "http://127.0.0.1:9090/t/ab12c/" would be a confidently
// incorrect answer, which is worse than an honest relative one the caller
// resolves itself. Never derived from a request header: see the note on
// ServerConfig for why headers are not trusted for self-origin.
func (s *Server) tunnelURL(id string) string {
	path := "/t/" + id + "/"
	base := s.publicBaseURL()
	if base == "" {
		return path
	}
	return base + path
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
// present, 404 when the id is unknown, and 302 to the trailing-slash form
// when the path is exactly /t/{id}.
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

	// A tunnel serves a whole site rooted at /t/{id}/, so "/t/{id}" without
	// the trailing slash must redirect to the directory form. The upstream
	// answers both with its index page, but the browser resolves that page's
	// relative URLs against the document URL: from "/t/{id}" a "./assets/x.js"
	// resolves to "/t/assets/x.js" — one level too high, 404, and no app.
	//
	// The Location is deliberately a relative reference (RFC 7231 §7.1.2)
	// rather than a rooted path: if muxterm is itself mounted under a prefix
	// by a fronting proxy that strips it, r.URL.Path is missing that prefix
	// and a rooted Location would send the browser outside it. Written
	// directly instead of via http.Redirect, which rewrites a relative
	// location into a rooted one using r.URL.Path.
	if suffix == "" {
		loc := id + "/"
		if r.URL.RawQuery != "" {
			loc += "?" + r.URL.RawQuery
		}
		w.Header().Set("Location", loc)
		w.WriteHeader(http.StatusFound)
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
