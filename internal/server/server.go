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
	"github.com/kenotron-ms/muxterm/internal/missioncontrol"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/voice"
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
	StaticFS fs.FS

	// PublicDocFS holds the single asset the UNAUTHENTICATED /p/{id} page
	// loads: the markdown renderer, built separately so it is one
	// self-contained file with a fixed name (web/vite.public-doc.config.ts).
	// Deliberately NOT a subdirectory of StaticFS -- the anonymous route must
	// not be able to reach the application bundle. nil disables the markdown
	// page's script, which degrades to "Loading…" rather than to a 500.
	PublicDocFS fs.FS

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

	// publications holds live public file publications. A SIBLING of
	// tunnels, never a widening of it: a tunnel forwards to a port and stays
	// behind the auth middleware, a publication serves one file to anyone
	// holding its link. See internal/server/publish.go.
	publications *PublicationRegistry

	// publicDocFS is the one asset family reachable without authentication:
	// the markdown renderer loaded by the /p/{id} page. See Config.
	publicDocFS fs.FS

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

	// voice owns the opt-in realtime speech-to-speech capability. nil
	// unless [voice] is enabled and valid; the routes are registered only
	// alongside it, so a nil here means the paths do not exist.
	voice *voice.Manager

	// missionControlVoice owns the one bounded safety-only bridge lease for
	// this Server. It never owns a provider or microphone session.
	missionControlVoice *voice.LeaseManager
	// missionControlVoiceProvider is constructed only behind the independent
	// Mission Control candidate gate. It is never the legacy global bridge.
	missionControlVoiceProvider     *voice.Manager
	missionControlVoiceAttachmentMu sync.Mutex
	missionControlVoiceAttachment   *missionControlVoiceAttachment

	// ai owns the opt-in AI capability: key storage, the enabled flag, and the
	// lazily-constructed Anthropic client. Never reachable from cfg.
	ai *ai.Manager

	// prs is the durable collector behind the Pull Requests applet: the
	// pull requests muxterm's own sessions opened, kept after those
	// sessions are gone. Server-owned rather than per-browser, because a
	// collected pull request belongs to the machine's history and not to
	// whoever happens to have a tab open. See prs_store.go.
	prs *prCollector

	// prsRefreshing is the single-flight guard for the background pull-request
	// status refresh. See refreshPRStatusesAsync.
	prsRefreshing atomic.Bool

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
		publications:   NewPublicationRegistry(),
		publicDocFS:    cfg.PublicDocFS,
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
	if s.cfg.MissionControl.ThreadsV2 {
		catalog, err := missioncontrol.Open(missioncontrol.DefaultPath())
		if err != nil {
			// Keep the configured v2/text-preview state visible even when an
			// existing catalog cannot be opened.  Falling back to legacy COS
			// here silently starts the unrelated global sidecar after a
			// protocol-aware client explicitly requested the constrained path.
			hub.setMissionControl(nil, nil, s.cfg.MissionControl.TextPreview, err)
		} else {
			var router *missioncontrol.Router
			if s.cfg.MissionControl.TextPreview {
				if err := s.cfg.MissionControl.ValidateTextContextMaxTokens(); err != nil {
					hub.setMissionControl(nil, nil, true, err)
				} else {
					router = missioncontrol.NewRouter(catalog, s.cfg.MissionControl.TextWorkerCap, s.cfg.MissionControl.TextContextMaxTokens)
				}
			}
			if router != nil || !s.cfg.MissionControl.TextPreview {
				hub.setMissionControl(catalog, router, s.cfg.MissionControl.TextPreview, nil)
			}
		}
	}

	// The collected pull requests, loaded from disk at construction so the
	// first GET after a restart answers from the store rather than from an
	// empty list it would then have to rebuild. Both paths are XDG-derived
	// through sessiond's own resolver, so a dev server never reads the real
	// machine's log or writes the real machine's store.
	s.prs = newPRCollector(DefaultCollectedPRsPath(), sessiond.CompletionsPath())

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

	// ⛔ THE ONLY ROUTES IN THIS SERVER THAT SERVE USER DATA WITHOUT AUTH.
	//
	// A published file is readable by anyone holding its link -- that is the
	// entire point, since a link that needs a muxterm account is not a link
	// you can send to anyone. The bypass is scoped HERE, by registering
	// exactly these two patterns without protect(), and it changes nothing
	// about any other route: no flag, no header, and no request-derived
	// condition can promote a protected pattern into an unprotected one.
	//
	// "/p/{id}" is two segments and the id must be 22 base64url characters
	// before the registry is even consulted; "/p/_asset/doc.js" is a literal
	// (and wins over the wildcard below, because Go's ServeMux prefers the
	// more specific pattern). For those two, nothing a caller writes reaches
	// the filesystem: traversal is not filtered, it is unrepresentable.
	//
	// ⛔ "/p/{id}/{rest...}" IS DIFFERENT AND THE DIFFERENCE MATTERS. It is
	// the one public pattern with a caller-controlled path component, which a
	// BROWSABLE published folder cannot exist without: a reader has to be
	// able to say which page they want. {rest...} is used as a key into a
	// manifest fixed at publish time and never as a path -- read the header
	// of internal/server/publish_folder.go before touching it.
	s.mux.HandleFunc("GET /p/_asset/doc.js", s.handlePublicAsset)
	s.mux.HandleFunc("GET /p/{id}", s.handlePublicDocument)
	s.mux.HandleFunc("GET /p/{id}/{rest...}", s.handlePublicTree)
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

	// Opt-in realtime voice. Registered only when [voice] is enabled and
	// valid -- see internal/server/voice.go.
	s.registerVoiceRoutes(s.cfg.Voice, protect)

	// Voice CREDENTIALS, registered unconditionally -- unlike the routes
	// above, whose whole job is to be absent when voice is off. Configuring
	// voice while it is off is the normal path: save, check, then enable.
	// The key goes in via PUT and only a boolean comes out; see
	// internal/server/voice_settings.go.
	s.mux.Handle("GET /api/voice/settings", protect(http.HandlerFunc(s.handleVoiceSettingsGet)))
	s.mux.Handle("PUT /api/voice/settings", protect(http.HandlerFunc(s.handleVoiceSettingsPut)))
	s.mux.Handle("DELETE /api/voice/key", protect(http.HandlerFunc(s.handleVoiceSettingsDeleteKey)))
	s.mux.Handle("POST /api/voice/check", protect(http.HandlerFunc(s.handleVoiceSettingsCheck)))

	// Self-update. Protected like every other owner surface: applying an
	// update rewrites the binary this process is running from.
	s.mux.Handle("GET /api/update/status", protect(http.HandlerFunc(s.handleUpdateStatus)))
	s.mux.Handle("POST /api/update/apply", protect(http.HandlerFunc(s.handleUpdateApply)))

	s.mux.Handle("GET /api/tunnels", protect(http.HandlerFunc(s.handleTunnelList)))
	s.mux.Handle("POST /api/tunnels", protect(http.HandlerFunc(s.handleTunnelCreate)))
	s.mux.Handle("DELETE /api/tunnels/{id}", protect(http.HandlerFunc(s.handleTunnelClose)))
	s.mux.Handle("/t/", protect(http.HandlerFunc(s.handleTunnelProxy)))

	// Owner side of publishing. Protected like every other owner surface --
	// only the /p/ reader routes above are anonymous. See publish_api.go.
	s.mux.Handle("GET /api/publications", protect(http.HandlerFunc(s.handlePublicationsList)))
	s.mux.Handle("POST /api/publications", protect(http.HandlerFunc(s.handlePublicationCreate)))
	// A folder gets its OWN create route rather than a flag on the one above:
	// publishing a whole tree is a materially bigger act than publishing a
	// file, and a caller should have to name it. List and revoke are shared --
	// a folder is a row in the same registry, and revoking its id kills the
	// whole tree at once. See internal/server/publish_folder_api.go.
	s.mux.Handle("POST /api/publications/folder", protect(http.HandlerFunc(s.handlePublicationCreateFolder)))
	s.mux.Handle("DELETE /api/publications", protect(http.HandlerFunc(s.handlePublicationRevoke)))
	s.mux.Handle("DELETE /api/publications/{id}", protect(http.HandlerFunc(s.handlePublicationRevoke)))

	// Remote machines. {id} is a HostRef.ID such as "ssh:boxb"; a colon is a
	// legal pchar in a path segment and rule P3 (no "/" in a host id) is what
	// keeps it to one segment. See internal/server/remotes_api.go.
	s.mux.Handle("GET /api/remotes", protect(http.HandlerFunc(s.handleRemotesList)))
	s.mux.Handle("POST /api/remotes", protect(http.HandlerFunc(s.handleRemotesAdd)))
	s.mux.Handle("DELETE /api/remotes/{id}", protect(http.HandlerFunc(s.handleRemotesRemove)))
	s.mux.Handle("POST /api/remotes/{id}/connect", protect(http.HandlerFunc(s.handleRemotesConnect)))
	s.mux.Handle("POST /api/remotes/{id}/disconnect", protect(http.HandlerFunc(s.handleRemotesDisconnect)))
	s.mux.Handle("POST /api/remotes/{id}/provision", protect(http.HandlerFunc(s.handleRemotesProvision)))

	// Mission Control's read-only applets: one git-annotated directory listing
	// for Files, and every open pull request across the named worktrees for
	// Pull Requests. Both add no authority over /ws -- the same auth boundary
	// already hands out a shell. See internal/server/files_api.go and
	// internal/server/prs_api.go.
	s.mux.Handle("GET /api/files", protect(http.HandlerFunc(s.handleFilesList)))
	s.mux.Handle("GET /api/prs", protect(http.HandlerFunc(s.handlePRsList)))
	s.mux.Handle("POST /api/prs/dismiss", protect(http.HandlerFunc(s.handlePRDismiss)))

	// The artifact viewer: ONE file, shown the way a recipient of a published
	// link would see it. Its kind, its content type and its size bound all
	// come from the publishing code rather than from a second table, which is
	// what makes the local preview and the public page agree by construction.
	// /open is the one push: it lets the chief of staff put a document on the
	// user's screen when they ask to be shown one. See artifact_api.go.
	s.mux.Handle("GET /api/artifact", protect(http.HandlerFunc(s.handleArtifact)))
	s.mux.Handle("GET /api/artifact/raw", protect(http.HandlerFunc(s.handleArtifactRaw)))
	s.mux.Handle("GET /api/artifact/doc.css", protect(http.HandlerFunc(s.handleArtifactDocCSS)))
	s.mux.Handle("POST /api/artifact/open", protect(http.HandlerFunc(s.handleArtifactOpen)))

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
	defer s.hub.CloseMissionControl()

	// A voice sideband is a live outbound WebSocket to the realtime
	// vendor. Left open it keeps billing a session nobody is listening to,
	// so it goes down on every return path, exactly as the sidecar does.
	if s.voice != nil {
		defer s.voice.Close()
	}
	if s.missionControlVoice != nil {
		defer s.missionControlVoice.Close()
	}
	if s.missionControlVoiceProvider != nil {
		defer s.missionControlVoiceProvider.Close()
	}

	// Expired publications linger briefly as tombstones so a reader who is
	// seconds late is told "this expired" rather than "this is not valid".
	// This drops them once that window closes. Stops with the server.
	sweepDone := make(chan struct{})
	defer close(sweepDone)
	go s.sweepPublications(sweepDone)

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
