# Phase 2: WebSocket Server & Pane I/O Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Build the HTTP/WebSocket server that bridges tmux control mode events to browser clients via binary pane I/O and JSON control messages.

**Architecture:** A single HTTP server serves static files (embedded frontend), exposes a health endpoint and token endpoint, and upgrades `/ws` connections to WebSocket. The WebSocket layer uses a Hub/Client pattern — one Hub manages all connected clients. Binary frames carry pane I/O (4-byte LE pane ID + raw data). Text frames carry JSON control messages (state sync, incremental updates, user actions). The server translates between tmux control mode events and the WebSocket wire protocol.

**Tech Stack:** Go (net/http, `github.com/coder/websocket`), crypto/hmac for auth tokens

---

## Prerequisites

Phase 1 must be complete. The following files and types are expected to exist:

**Files from Phase 1:**
- `go.mod` — Go module (check actual module name, this plan uses `muxterm`)
- `internal/tmux/model.go` — `TmuxState`, `Session`, `Window`, `Pane` structs (with JSON tags)
- `internal/tmux/control.go` — `Controller` type managing `tmux -CC` connection
- `internal/tmux/command.go` — functions for `send-keys`, `select-window`, `split-window`, etc.
- `internal/tmux/layout.go` — layout string parser
- `cmd/muxterm/main.go` — CLI entry point

**Expected Phase 1 API surface (adapt if names differ):**
```go
// internal/tmux/model.go
type TmuxState struct {
    Sessions      []Session `json:"sessions"`
    ActiveSession string    `json:"activeSession"`
}
type Session struct {
    Name    string   `json:"name"`
    Windows []Window `json:"windows"`
}
type Window struct {
    ID     string `json:"id"`     // @N
    Name   string `json:"name"`
    Panes  []Pane `json:"panes"`
    Layout string `json:"layout"`
}
type Pane struct {
    ID     string `json:"id"`     // %N
    Width  int    `json:"width"`
    Height int    `json:"height"`
    Active bool   `json:"active"`
}
```

**Before starting:** Run `cat go.mod` to verify the module name. If it's not `muxterm`, adjust all import paths in this plan accordingly. Run `go test ./internal/tmux/...` to confirm Phase 1 tests pass.

---

## New dependency

Before Task 1, install the WebSocket library:

```bash
cd ~/workspace/muxterm
go get github.com/coder/websocket@latest
```

---

### Task 1: Auth Module

**Files:**
- Create: `internal/server/auth.go`
- Create: `internal/server/auth_test.go`

**Step 1: Write the failing tests**

Create `internal/server/auth_test.go`:

```go
package server

import (
	"net/http"
	"testing"
	"time"
)

func TestGenerateSecret(t *testing.T) {
	s1, err := GenerateSecret()
	if err != nil {
		t.Fatalf("GenerateSecret: %v", err)
	}
	if len(s1) != 64 { // 32 bytes = 64 hex chars
		t.Fatalf("expected 64 hex chars, got %d", len(s1))
	}

	s2, err := GenerateSecret()
	if err != nil {
		t.Fatalf("GenerateSecret: %v", err)
	}
	if s1 == s2 {
		t.Fatal("two secrets should not be equal")
	}
}

func TestGenerateAndValidateToken(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatalf("GenerateSecret: %v", err)
	}

	token, err := GenerateToken(secret)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}

	if !ValidateToken(token, secret, 30*time.Second) {
		t.Fatal("valid token should pass validation")
	}
}

func TestValidateToken_WrongSecret(t *testing.T) {
	secret1, _ := GenerateSecret()
	secret2, _ := GenerateSecret()

	token, _ := GenerateToken(secret1)
	if ValidateToken(token, secret2, 30*time.Second) {
		t.Fatal("token signed with different secret should fail")
	}
}

func TestValidateToken_Expired(t *testing.T) {
	secret, _ := GenerateSecret()
	token, _ := GenerateToken(secret)

	// TTL of 0 means already expired
	if ValidateToken(token, secret, 0) {
		t.Fatal("expired token should fail")
	}
}

func TestValidateToken_Malformed(t *testing.T) {
	secret, _ := GenerateSecret()

	cases := []string{
		"",
		"noperiod",
		"abc.def",
		".nosig",
		"notanumber.abcdef",
	}
	for _, tc := range cases {
		if ValidateToken(tc, secret, 30*time.Second) {
			t.Fatalf("malformed token %q should fail", tc)
		}
	}
}

func TestIsLocalhost(t *testing.T) {
	tests := []struct {
		remoteAddr string
		want       bool
	}{
		{"127.0.0.1:8080", true},
		{"[::1]:8080", true},
		{"192.168.1.1:8080", false},
		{"10.0.0.1:8080", false},
	}
	for _, tt := range tests {
		r := &http.Request{RemoteAddr: tt.remoteAddr}
		got := IsLocalhost(r)
		if got != tt.want {
			t.Errorf("IsLocalhost(%q) = %v, want %v", tt.remoteAddr, got, tt.want)
		}
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestGenerate|TestValidate|TestIsLocalhost"`

Expected: Compilation error — `auth.go` doesn't exist yet.

**Step 3: Write the implementation**

Create `internal/server/auth.go`:

```go
package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// GenerateSecret creates a random 32-byte hex-encoded secret.
func GenerateSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// GenerateToken creates an HMAC-SHA256 token with embedded timestamp.
// Format: "<unix_timestamp>.<hex_hmac>"
func GenerateToken(secret string) (string, error) {
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts))
	sig := hex.EncodeToString(mac.Sum(nil))
	return ts + "." + sig, nil
}

// ValidateToken checks that a token's HMAC is valid and within TTL.
func ValidateToken(token, secret string, ttl time.Duration) bool {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return false
	}
	ts, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return false
	}
	if time.Since(time.Unix(ts, 0)) > ttl {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0]))
	expected := hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(expected), []byte(parts[1]))
}

// IsLocalhost returns true if the request originates from a loopback address.
func IsLocalhost(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestGenerate|TestValidate|TestIsLocalhost"`

Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add internal/server/auth.go internal/server/auth_test.go && git commit -m "feat(server): auth module — HMAC tokens, secret generation, localhost bypass"
```

---

### Task 2: HTTP Server Scaffolding

**Files:**
- Create: `internal/server/server.go`
- Create: `internal/server/server_test.go`

**Step 1: Write the failing tests**

Create `internal/server/server_test.go`:

```go
package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"
)

func TestHealthEndpoint(t *testing.T) {
	srv := New(Config{Addr: ":0", Secret: "test-secret"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var result map[string]string
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if result["status"] != "ok" {
		t.Fatalf("expected status ok, got %q", result["status"])
	}
}

func TestTokenEndpoint_Localhost(t *testing.T) {
	srv := New(Config{Addr: ":0", Secret: "test-secret"})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// httptest.NewServer connections come from 127.0.0.1
	resp, err := http.Get(ts.URL + "/api/token")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	var result map[string]string
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if result["token"] == "" {
		t.Fatal("expected non-empty token")
	}
}

func TestStaticFileServing(t *testing.T) {
	staticFS := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>muxterm</html>")},
	}

	srv := New(Config{Addr: ":0", Secret: "test-secret", StaticFS: staticFS})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/index.html")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	body, _ := io.ReadAll(resp.Body)
	if string(body) != "<html>muxterm</html>" {
		t.Fatalf("unexpected body: %s", body)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestHealth|TestToken|TestStatic"`

Expected: Compilation error — `server.go` doesn't exist yet.

**Step 3: Write the implementation**

Create `internal/server/server.go`:

```go
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"time"
)

// Config holds server configuration.
type Config struct {
	Addr     string // listen address, e.g. ":8080"
	Secret   string // HMAC secret for token auth
	StaticFS fs.FS  // embedded frontend files (nil = no static serving)
}

// Server is the muxterm HTTP + WebSocket server.
type Server struct {
	addr   string
	secret string
	mux    *http.ServeMux
	hub    *Hub
}

// New creates a Server with the given config.
// Pass a TmuxEngine to enable WebSocket pane I/O; nil is allowed for
// HTTP-only testing.
func New(cfg Config, engine ...TmuxEngine) *Server {
	var eng TmuxEngine
	if len(engine) > 0 {
		eng = engine[0]
	}

	s := &Server{
		addr:   cfg.Addr,
		secret: cfg.Secret,
		hub:    NewHub(eng),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/token", s.handleToken)
	mux.HandleFunc("GET /ws", s.handleWS)

	if cfg.StaticFS != nil {
		mux.Handle("/", http.FileServer(http.FS(cfg.StaticFS)))
	}

	s.mux = mux
	return s
}

// Handler returns the http.Handler for use with httptest or http.Server.
func (s *Server) Handler() http.Handler {
	return s.mux
}

// ListenAndServe starts the HTTP server. Blocks until ctx is cancelled.
func (s *Server) ListenAndServe(ctx context.Context) error {
	srv := &http.Server{
		Addr:    s.addr,
		Handler: s.mux,
		BaseContext: func(_ net.Listener) context.Context {
			return ctx
		},
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("muxterm listening on %s", s.addr)
	err := srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte(`{"status":"ok"}`))
}

func (s *Server) handleToken(w http.ResponseWriter, r *http.Request) {
	if !IsLocalhost(r) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	token, err := GenerateToken(s.secret)
	if err != nil {
		http.Error(w, `{"error":"token generation failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": token})
}

// handleWS is a placeholder — implemented in Task 3.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}

// Hub returns the server's WebSocket hub.
func (s *Server) Hub() *Hub {
	return s.hub
}

// Secret returns the server's auth secret.
func (s *Server) Secret() string {
	return s.secret
}
```

Also create the minimal `ws.go` stub so the package compiles (Hub and TmuxEngine types):

Create `internal/server/ws.go`:

```go
package server

import (
	"muxterm/internal/tmux"
	"sync"
)

// TmuxEngine defines what the server needs from the tmux control mode engine.
// Phase 1's Controller should satisfy this interface (or be wrapped to do so).
type TmuxEngine interface {
	// State returns a snapshot of the current tmux state.
	State() tmux.TmuxState
	// SendKeys sends raw input to a pane.
	SendKeys(paneID string, data []byte) error
	// SelectWindow switches the active window.
	SelectWindow(windowID string) error
	// SelectPane focuses a pane.
	SelectPane(paneID string) error
	// SplitWindow splits a pane. horizontal=true means left/right split.
	SplitWindow(paneID string, horizontal bool) error
	// ResizePane resizes a pane to the given dimensions.
	ResizePane(paneID string, cols, rows int) error
	// NewWindow creates a new window in the current session.
	NewWindow() error
	// KillPane closes a pane.
	KillPane(paneID string) error
	// RenameWindow renames a window.
	RenameWindow(windowID string, name string) error
	// NewSession creates a new tmux session.
	NewSession(name string) error
}

// Hub manages all connected WebSocket clients.
type Hub struct {
	clients map[*Client]struct{}
	mu      sync.RWMutex
	engine  TmuxEngine
}

// NewHub creates a Hub. engine may be nil for HTTP-only testing.
func NewHub(engine TmuxEngine) *Hub {
	return &Hub{
		clients: make(map[*Client]struct{}),
		engine:  engine,
	}
}

// ClientCount returns the number of connected clients. Used in tests.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Client represents a single WebSocket connection. Placeholder for Task 3.
type Client struct{}
```

> **Note:** Check the import path `muxterm/internal/tmux`. If `go.mod` says the module is something else (e.g. `github.com/user/muxterm`), adjust this import.

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestHealth|TestToken|TestStatic"`

Expected: All 3 tests PASS.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add internal/server/ && git commit -m "feat(server): HTTP server scaffolding — health, token, static file serving"
```

---

### Task 3: WebSocket Handler — Hub, Client, Upgrade

**Files:**
- Modify: `internal/server/ws.go` (replace placeholder with full Hub/Client/upgrade)
- Create: `internal/server/ws_test.go`

**Step 1: Write the failing tests**

Create `internal/server/ws_test.go`:

```go
package server

import (
	"context"
	"muxterm/internal/tmux"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// --- Mock TmuxEngine for all WS tests ---

type mockEngine struct {
	state tmux.TmuxState
}

func newMockEngine() *mockEngine {
	return &mockEngine{
		state: tmux.TmuxState{
			Sessions: []tmux.Session{
				{
					Name: "dev",
					Windows: []tmux.Window{
						{
							ID:   "@1",
							Name: "shell",
							Panes: []tmux.Pane{
								{ID: "%1", Width: 80, Height: 24, Active: true},
							},
							Layout: "simple",
						},
					},
				},
			},
			ActiveSession: "dev",
		},
	}
}

func (m *mockEngine) State() tmux.TmuxState          { return m.state }
func (m *mockEngine) SendKeys(string, []byte) error   { return nil }
func (m *mockEngine) SelectWindow(string) error        { return nil }
func (m *mockEngine) SelectPane(string) error           { return nil }
func (m *mockEngine) SplitWindow(string, bool) error    { return nil }
func (m *mockEngine) ResizePane(string, int, int) error { return nil }
func (m *mockEngine) NewWindow() error                  { return nil }
func (m *mockEngine) KillPane(string) error             { return nil }
func (m *mockEngine) RenameWindow(string, string) error { return nil }
func (m *mockEngine) NewSession(string) error           { return nil }

// --- Test helpers ---

type testEnv struct {
	engine *mockEngine
	srv    *Server
	ts     *httptest.Server
	t      *testing.T
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	engine := newMockEngine()
	srv := New(Config{Addr: ":0", Secret: "test-secret"}, engine)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &testEnv{engine: engine, srv: srv, ts: ts, t: t}
}

func (e *testEnv) wsURL() string {
	return "ws" + strings.TrimPrefix(e.ts.URL, "http") + "/ws"
}

func (e *testEnv) dial(ctx context.Context) *websocket.Conn {
	e.t.Helper()
	conn, _, err := websocket.Dial(ctx, e.wsURL(), nil)
	if err != nil {
		e.t.Fatalf("WebSocket dial failed: %v", err)
	}
	return conn
}

// --- Tests ---

func TestWebSocketConnect(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()

	// Give the server goroutine time to register the client
	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 1 {
		t.Fatalf("expected 1 client, got %d", got)
	}
}

func TestWebSocketDisconnect(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 1 {
		t.Fatalf("expected 1 client, got %d", got)
	}

	conn.Close(websocket.StatusNormalClosure, "bye")
	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 0 {
		t.Fatalf("expected 0 clients after disconnect, got %d", got)
	}
}

func TestMultipleClients(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn1 := env.dial(ctx)
	defer conn1.CloseNow()
	conn2 := env.dial(ctx)
	defer conn2.CloseNow()

	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 2 {
		t.Fatalf("expected 2 clients, got %d", got)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestWebSocket|TestMultiple"`

Expected: Compilation error or test failure — handleWS returns 501.

**Step 3: Write the implementation**

Replace the entire contents of `internal/server/ws.go` with:

```go
package server

import (
	"context"
	"log"
	"muxterm/internal/tmux"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// TmuxEngine defines what the server needs from the tmux control mode engine.
type TmuxEngine interface {
	State() tmux.TmuxState
	SendKeys(paneID string, data []byte) error
	SelectWindow(windowID string) error
	SelectPane(paneID string) error
	SplitWindow(paneID string, horizontal bool) error
	ResizePane(paneID string, cols, rows int) error
	NewWindow() error
	KillPane(paneID string) error
	RenameWindow(windowID string, name string) error
	NewSession(name string) error
}

// Hub manages all connected WebSocket clients.
type Hub struct {
	clients map[*Client]struct{}
	mu      sync.RWMutex
	engine  TmuxEngine
}

// NewHub creates a Hub. engine may be nil for HTTP-only testing.
func NewHub(engine TmuxEngine) *Hub {
	return &Hub{
		clients: make(map[*Client]struct{}),
		engine:  engine,
	}
}

// Add registers a client with the hub.
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

// Remove unregisters a client and closes its connection.
func (h *Hub) Remove(c *Client) {
	h.mu.Lock()
	_, exists := h.clients[c]
	if exists {
		delete(h.clients, c)
	}
	h.mu.Unlock()
	if exists {
		c.close()
	}
}

// ClientCount returns the number of connected clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Client represents a single WebSocket connection.
type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex
}

// newClient creates a Client bound to a hub and connection.
func newClient(hub *Hub, conn *websocket.Conn) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		hub:    hub,
		conn:   conn,
		ctx:    ctx,
		cancel: cancel,
	}
}

// writeBinary sends a binary WebSocket frame with a 5-second timeout.
func (c *Client) writeBinary(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageBinary, data)
}

// writeText sends a text WebSocket frame with a 5-second timeout.
func (c *Client) writeText(data []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()
	return c.conn.Write(ctx, websocket.MessageText, data)
}

// readPump reads messages from the client until the connection closes.
// Messages are discarded for now — Tasks 4-7 add actual handling.
func (c *Client) readPump() {
	defer c.hub.Remove(c)
	for {
		_, _, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
	}
}

// close cancels the client context and closes the WebSocket.
func (c *Client) close() {
	c.cancel()
	c.conn.CloseNow()
}

// handleWS upgrades an HTTP request to a WebSocket connection.
// Replaces the placeholder from Task 2.
func (s *Server) handleWSImpl(w http.ResponseWriter, r *http.Request) {
	// Auth: localhost bypass OR valid token
	if !IsLocalhost(r) {
		token := r.URL.Query().Get("token")
		if !ValidateToken(token, s.secret, 30*time.Second) {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // origin check not needed — auth is token-based
	})
	if err != nil {
		log.Printf("websocket accept: %v", err)
		return
	}

	// Increase read limit for large pane output / input
	conn.SetReadLimit(1 << 20) // 1MB

	client := newClient(s.hub, conn)
	s.hub.Add(client)

	go client.readPump()
}
```

Now update `server.go` to use `handleWSImpl` instead of the placeholder. Replace the `handleWS` method:

In `internal/server/server.go`, replace:
```go
// handleWS is a placeholder — implemented in Task 3.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "not implemented", http.StatusNotImplemented)
}
```

With:
```go
// handleWS upgrades to WebSocket — see ws.go handleWSImpl.
func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	s.handleWSImpl(w, r)
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestWebSocket|TestMultiple"`

Expected: All 3 tests PASS.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add internal/server/ && git commit -m "feat(server): WebSocket handler — Hub, Client, upgrade with auth"
```

---

### Task 4: Pane I/O — Server to Client (Binary Frames)

**Files:**
- Modify: `internal/server/ws.go` (add binary frame encoding + BroadcastPaneOutput)
- Modify: `internal/server/ws_test.go` (add encoding tests + broadcast integration test)

**Step 1: Write the failing tests**

Add to `internal/server/ws_test.go`:

```go
func TestEncodeBinaryFrame(t *testing.T) {
	frame := EncodeBinaryFrame(5, []byte("hello"))
	if len(frame) != 4+5 {
		t.Fatalf("expected 9 bytes, got %d", len(frame))
	}
	// pane ID 5 in LE: [5, 0, 0, 0]
	if frame[0] != 5 || frame[1] != 0 || frame[2] != 0 || frame[3] != 0 {
		t.Fatalf("wrong pane ID bytes: %v", frame[:4])
	}
	if string(frame[4:]) != "hello" {
		t.Fatalf("wrong data: %q", frame[4:])
	}
}

func TestDecodeBinaryFrame(t *testing.T) {
	original := EncodeBinaryFrame(42, []byte("world"))
	paneID, data, err := DecodeBinaryFrame(original)
	if err != nil {
		t.Fatal(err)
	}
	if paneID != 42 {
		t.Fatalf("expected pane 42, got %d", paneID)
	}
	if string(data) != "world" {
		t.Fatalf("expected 'world', got %q", data)
	}
}

func TestDecodeBinaryFrame_TooShort(t *testing.T) {
	_, _, err := DecodeBinaryFrame([]byte{1, 2})
	if err == nil {
		t.Fatal("expected error for short frame")
	}
}

func TestPaneIDConversion(t *testing.T) {
	id, err := PaneIDToUint32("%7")
	if err != nil {
		t.Fatal(err)
	}
	if id != 7 {
		t.Fatalf("expected 7, got %d", id)
	}
	if Uint32ToPaneID(7) != "%7" {
		t.Fatalf("expected %%7, got %s", Uint32ToPaneID(7))
	}
}

func TestBroadcastPaneOutput(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()
	time.Sleep(100 * time.Millisecond)

	// Broadcast pane output from "server side"
	env.srv.Hub().BroadcastPaneOutput("%5", []byte("ls\n"))

	// Read the binary frame on the client
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if msgType != websocket.MessageBinary {
		t.Fatalf("expected binary frame, got %v", msgType)
	}
	paneID, payload, err := DecodeBinaryFrame(data)
	if err != nil {
		t.Fatal(err)
	}
	if paneID != 5 {
		t.Fatalf("expected pane 5, got %d", paneID)
	}
	if string(payload) != "ls\n" {
		t.Fatalf("expected 'ls\\n', got %q", payload)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestEncode|TestDecode|TestPaneID|TestBroadcastPane"`

Expected: Compilation error — `EncodeBinaryFrame`, `DecodeBinaryFrame`, etc. undefined.

**Step 3: Write the implementation**

Add the following to `internal/server/ws.go` (append after the existing code):

```go
// --- Binary frame encoding/decoding ---

// EncodeBinaryFrame creates a binary WS frame: [4-byte LE uint32 pane_id][data].
func EncodeBinaryFrame(paneID uint32, data []byte) []byte {
	frame := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(frame[:4], paneID)
	copy(frame[4:], data)
	return frame
}

// DecodeBinaryFrame extracts pane ID and data from a binary frame.
func DecodeBinaryFrame(frame []byte) (uint32, []byte, error) {
	if len(frame) < 4 {
		return 0, nil, fmt.Errorf("binary frame too short: %d bytes", len(frame))
	}
	paneID := binary.LittleEndian.Uint32(frame[:4])
	return paneID, frame[4:], nil
}

// PaneIDToUint32 converts a tmux pane ID string "%N" to uint32 N.
func PaneIDToUint32(id string) (uint32, error) {
	if !strings.HasPrefix(id, "%") {
		return 0, fmt.Errorf("invalid pane ID (missing %%): %s", id)
	}
	n, err := strconv.ParseUint(id[1:], 10, 32)
	if err != nil {
		return 0, fmt.Errorf("invalid pane ID number: %s", id)
	}
	return uint32(n), nil
}

// Uint32ToPaneID converts uint32 N to tmux pane ID string "%N".
func Uint32ToPaneID(id uint32) string {
	return "%" + strconv.FormatUint(uint64(id), 10)
}

// BroadcastPaneOutput sends pane output as a binary frame to all clients.
// Called by the tmux event handler when %output is received.
func (h *Hub) BroadcastPaneOutput(paneID string, data []byte) {
	id, err := PaneIDToUint32(paneID)
	if err != nil {
		log.Printf("BroadcastPaneOutput: %v", err)
		return
	}
	frame := EncodeBinaryFrame(id, data)

	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		if err := c.writeBinary(frame); err != nil {
			h.Remove(c)
		}
	}
}
```

Also add the required imports to `ws.go`. The import block should include:

```go
import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"muxterm/internal/tmux"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestEncode|TestDecode|TestPaneID|TestBroadcastPane"`

Expected: All 5 tests PASS.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add internal/server/ && git commit -m "feat(server): binary frame encoding + pane output broadcast (server→client)"
```

---

### Task 5: Pane I/O — Client to Server (Binary Frames)

**Files:**
- Modify: `internal/server/ws.go` (add binary input handling to readPump)
- Modify: `internal/server/ws_test.go` (add input routing test)

**Step 1: Write the failing test**

First, upgrade `mockEngine` to record `SendKeys` calls. Add to `ws_test.go`:

```go
// Replace the mockEngine with a recording version:

type sendKeysCall struct {
	PaneID string
	Data   []byte
}

// Add this field to mockEngine struct:
//     sendKeysCalls []sendKeysCall
//     mu            sync.Mutex

// Replace the SendKeys method:
// func (m *mockEngine) SendKeys(paneID string, data []byte) error {
//     m.mu.Lock()
//     defer m.mu.Unlock()
//     m.sendKeysCalls = append(m.sendKeysCalls, sendKeysCall{paneID, append([]byte{}, data...)})
//     return nil
// }
```

To avoid confusion, here is the **complete updated mockEngine** — replace the existing one in `ws_test.go`:

```go
type sendKeysCall struct {
	PaneID string
	Data   []byte
}

type mockEngine struct {
	state         tmux.TmuxState
	mu            sync.Mutex
	sendKeysCalls []sendKeysCall
}

func newMockEngine() *mockEngine {
	return &mockEngine{
		state: tmux.TmuxState{
			Sessions: []tmux.Session{
				{
					Name: "dev",
					Windows: []tmux.Window{
						{
							ID:   "@1",
							Name: "shell",
							Panes: []tmux.Pane{
								{ID: "%1", Width: 80, Height: 24, Active: true},
							},
							Layout: "simple",
						},
					},
				},
			},
			ActiveSession: "dev",
		},
	}
}

func (m *mockEngine) State() tmux.TmuxState { return m.state }
func (m *mockEngine) SendKeys(paneID string, data []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sendKeysCalls = append(m.sendKeysCalls, sendKeysCall{paneID, append([]byte{}, data...)})
	return nil
}
func (m *mockEngine) SelectWindow(string) error        { return nil }
func (m *mockEngine) SelectPane(string) error           { return nil }
func (m *mockEngine) SplitWindow(string, bool) error    { return nil }
func (m *mockEngine) ResizePane(string, int, int) error { return nil }
func (m *mockEngine) NewWindow() error                  { return nil }
func (m *mockEngine) KillPane(string) error             { return nil }
func (m *mockEngine) RenameWindow(string, string) error { return nil }
func (m *mockEngine) NewSession(string) error           { return nil }

func (m *mockEngine) getSendKeysCalls() []sendKeysCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]sendKeysCall{}, m.sendKeysCalls...)
}
```

Then add the test:

```go
func TestBinaryInputRouting(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()
	time.Sleep(100 * time.Millisecond)

	// Client sends binary frame: pane 3, "ls\n"
	frame := EncodeBinaryFrame(3, []byte("ls\n"))
	err := conn.Write(ctx, websocket.MessageBinary, frame)
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// Wait for server to process
	time.Sleep(100 * time.Millisecond)

	calls := env.engine.getSendKeysCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 SendKeys call, got %d", len(calls))
	}
	if calls[0].PaneID != "%3" {
		t.Fatalf("expected pane %%3, got %s", calls[0].PaneID)
	}
	if string(calls[0].Data) != "ls\n" {
		t.Fatalf("expected 'ls\\n', got %q", calls[0].Data)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run TestBinaryInput`

Expected: FAIL — readPump discards all messages, SendKeys never called.

**Step 3: Write the implementation**

In `internal/server/ws.go`, replace the `readPump` method:

```go
// readPump reads messages from the client until the connection closes.
func (c *Client) readPump() {
	defer c.hub.Remove(c)
	for {
		msgType, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}
		switch msgType {
		case websocket.MessageBinary:
			c.handleBinaryInput(data)
		case websocket.MessageText:
			// JSON control messages — handled in Task 7
		}
	}
}

// handleBinaryInput decodes a binary frame and sends keys to the target pane.
func (c *Client) handleBinaryInput(data []byte) {
	paneID, payload, err := DecodeBinaryFrame(data)
	if err != nil {
		log.Printf("handleBinaryInput: %v", err)
		return
	}
	if c.hub.engine == nil {
		return
	}
	if err := c.hub.engine.SendKeys(Uint32ToPaneID(paneID), payload); err != nil {
		log.Printf("SendKeys to %s: %v", Uint32ToPaneID(paneID), err)
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run TestBinaryInput`

Expected: PASS.

Also run all server tests to verify nothing broke:

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v`

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add internal/server/ && git commit -m "feat(server): binary pane input routing (client→server via SendKeys)"
```

---

### Task 6: JSON Control Messages — Server to Client

**Files:**
- Modify: `internal/server/ws.go` (add JSON message helpers, state sync, event broadcast)
- Modify: `internal/server/ws_test.go` (add state sync + event broadcast tests)

**Step 1: Write the failing tests**

Add to `internal/server/ws_test.go`:

```go
func TestStateSyncOnConnect(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()

	// First message should be a state sync
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if msgType != websocket.MessageText {
		t.Fatalf("expected text frame, got %v", msgType)
	}

	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	stateRaw, ok := msg["state"]
	if !ok {
		t.Fatalf("expected 'state' key in message, got keys: %v", keysOf(msg))
	}

	var state tmux.TmuxState
	if err := json.Unmarshal(stateRaw, &state); err != nil {
		t.Fatalf("unmarshal state: %v", err)
	}
	if state.ActiveSession != "dev" {
		t.Fatalf("expected activeSession 'dev', got %q", state.ActiveSession)
	}
	if len(state.Sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(state.Sessions))
	}
}

func TestBroadcastEvent(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()

	// Consume the state sync message first
	_, _, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read state sync: %v", err)
	}

	// Broadcast a window-add event
	env.srv.Hub().BroadcastEvent("window-add", map[string]string{
		"id":   "@3",
		"name": "vim",
	})

	// Read the event
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read event: %v", err)
	}
	if msgType != websocket.MessageText {
		t.Fatalf("expected text frame, got %v", msgType)
	}

	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := msg["window-add"]; !ok {
		t.Fatalf("expected 'window-add' key, got: %s", string(data))
	}
}

// keysOf returns the keys of a map for error messages.
func keysOf(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	return keys
}
```

Add `"encoding/json"` to the imports of `ws_test.go` if not already there.

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestStateSync|TestBroadcastEvent"`

Expected: Compilation error — `BroadcastEvent` undefined, and no state sync on connect.

**Step 3: Write the implementation**

Add to `internal/server/ws.go`:

```go
// --- JSON control messages (server → client) ---

// NewServerMsg creates a JSON message with a single key.
// e.g. NewServerMsg("window-add", payload) → {"window-add": <payload>}
func NewServerMsg(msgType string, payload interface{}) ([]byte, error) {
	return json.Marshal(map[string]interface{}{msgType: payload})
}

// NewErrorMsg creates a JSON error message.
func NewErrorMsg(msg string) []byte {
	data, _ := json.Marshal(map[string]interface{}{"error": msg})
	return data
}

// BroadcastEvent sends a JSON control message to all connected clients.
func (h *Hub) BroadcastEvent(eventType string, payload interface{}) {
	data, err := NewServerMsg(eventType, payload)
	if err != nil {
		log.Printf("BroadcastEvent marshal: %v", err)
		return
	}
	h.broadcastText(data)
}

// broadcastText sends raw text data to all connected clients.
func (h *Hub) broadcastText(data []byte) {
	h.mu.RLock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()

	for _, c := range clients {
		if err := c.writeText(data); err != nil {
			h.Remove(c)
		}
	}
}

// sendStateSync sends the full TmuxState to a single client.
func (h *Hub) sendStateSync(c *Client) {
	if h.engine == nil {
		return
	}
	state := h.engine.State()
	data, err := NewServerMsg("state", state)
	if err != nil {
		log.Printf("sendStateSync marshal: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendStateSync write: %v", err)
	}
}
```

Add `"encoding/json"` to the imports of `ws.go`.

Then update `Hub.Add` to send state sync after registration:

```go
// Add registers a client with the hub and sends initial state sync.
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()

	// Send initial state to the new client
	h.sendStateSync(c)
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestStateSync|TestBroadcastEvent"`

Expected: Both tests PASS.

Run all server tests: `cd ~/workspace/muxterm && go test ./internal/server/ -v`

Expected: All tests PASS. (Note: `TestBroadcastPaneOutput` now needs to read past the initial state sync message. If it fails, add a line before the broadcast to consume the state sync: `conn.Read(ctx)`)

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add internal/server/ && git commit -m "feat(server): JSON control messages — state sync on connect + event broadcast"
```

---

### Task 7: JSON Control Messages — Client to Server

**Files:**
- Modify: `internal/server/ws.go` (add action parsing + dispatch)
- Modify: `internal/server/ws_test.go` (add action dispatch tests)

**Step 1: Write the failing tests**

First, upgrade the mock engine to record all command calls. Add these fields and methods to `mockEngine` in `ws_test.go`:

```go
// Add these fields to mockEngine:
type commandCall struct {
	Method string
	Args   []interface{}
}

// Add to mockEngine struct:
//     commandCalls []commandCall

// Replace all command methods to record calls:
func (m *mockEngine) SelectWindow(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"SelectWindow", []interface{}{id}})
	return nil
}
func (m *mockEngine) SelectPane(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"SelectPane", []interface{}{id}})
	return nil
}
func (m *mockEngine) SplitWindow(paneID string, horizontal bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"SplitWindow", []interface{}{paneID, horizontal}})
	return nil
}
func (m *mockEngine) ResizePane(paneID string, cols, rows int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"ResizePane", []interface{}{paneID, cols, rows}})
	return nil
}
func (m *mockEngine) NewWindow() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"NewWindow", nil})
	return nil
}
func (m *mockEngine) KillPane(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"KillPane", []interface{}{id}})
	return nil
}
func (m *mockEngine) RenameWindow(id, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"RenameWindow", []interface{}{id, name}})
	return nil
}
func (m *mockEngine) NewSession(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{"NewSession", []interface{}{name}})
	return nil
}

func (m *mockEngine) getCommandCalls() []commandCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]commandCall{}, m.commandCalls...)
}
```

Then add the tests:

```go
func TestSelectWindowAction(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()

	// Consume state sync
	conn.Read(ctx)
	time.Sleep(50 * time.Millisecond)

	// Send select-window action
	msg := []byte(`{"select-window":"@3"}`)
	err := conn.Write(ctx, websocket.MessageText, msg)
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	calls := env.engine.getCommandCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 command call, got %d", len(calls))
	}
	if calls[0].Method != "SelectWindow" {
		t.Fatalf("expected SelectWindow, got %s", calls[0].Method)
	}
	if calls[0].Args[0] != "@3" {
		t.Fatalf("expected @3, got %v", calls[0].Args[0])
	}
}

func TestNewWindowAction(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()
	conn.Read(ctx)
	time.Sleep(50 * time.Millisecond)

	err := conn.Write(ctx, websocket.MessageText, []byte(`{"new-window":{}}`))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	calls := env.engine.getCommandCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 command call, got %d", len(calls))
	}
	if calls[0].Method != "NewWindow" {
		t.Fatalf("expected NewWindow, got %s", calls[0].Method)
	}
}

func TestResizePaneAction(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()
	conn.Read(ctx)
	time.Sleep(50 * time.Millisecond)

	msg := []byte(`{"resize-pane":{"id":"%5","cols":100,"rows":40}}`)
	err := conn.Write(ctx, websocket.MessageText, msg)
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	calls := env.engine.getCommandCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 call, got %d", len(calls))
	}
	if calls[0].Method != "ResizePane" {
		t.Fatalf("expected ResizePane, got %s", calls[0].Method)
	}
	if calls[0].Args[0] != "%5" {
		t.Fatalf("expected %%5, got %v", calls[0].Args[0])
	}
}

func TestInvalidAction(t *testing.T) {
	env := newTestEnv(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn := env.dial(ctx)
	defer conn.CloseNow()
	conn.Read(ctx) // state sync
	time.Sleep(50 * time.Millisecond)

	// Send invalid JSON
	err := conn.Write(ctx, websocket.MessageText, []byte(`not json`))
	if err != nil {
		t.Fatalf("write: %v", err)
	}

	// Should receive an error message back
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if msgType != websocket.MessageText {
		t.Fatalf("expected text, got %v", msgType)
	}

	var msg map[string]interface{}
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := msg["error"]; !ok {
		t.Fatalf("expected error message, got: %s", string(data))
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestSelectWindow|TestNewWindow|TestResizePane|TestInvalidAction"`

Expected: FAIL — readPump ignores text messages, mock methods not recording.

**Step 3: Write the implementation**

Add to `internal/server/ws.go`:

```go
// --- JSON action parsing + dispatch (client → server) ---

// parseClientMessage extracts the action name and raw payload from a client JSON message.
func parseClientMessage(data []byte) (string, json.RawMessage, error) {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		return "", nil, fmt.Errorf("invalid JSON: %w", err)
	}
	for key, val := range msg {
		return key, val, nil
	}
	return "", nil, fmt.Errorf("empty message")
}

// dispatchAction translates a client action into a tmux command.
func (h *Hub) dispatchAction(action string, payload json.RawMessage) error {
	if h.engine == nil {
		return fmt.Errorf("no tmux engine connected")
	}

	switch action {
	case "select-window":
		var windowID string
		if err := json.Unmarshal(payload, &windowID); err != nil {
			return fmt.Errorf("select-window: %w", err)
		}
		return h.engine.SelectWindow(windowID)

	case "select-pane":
		var paneID string
		if err := json.Unmarshal(payload, &paneID); err != nil {
			return fmt.Errorf("select-pane: %w", err)
		}
		return h.engine.SelectPane(paneID)

	case "split":
		var p struct {
			Direction string `json:"direction"`
			Pane      string `json:"pane"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("split: %w", err)
		}
		return h.engine.SplitWindow(p.Pane, p.Direction == "horizontal")

	case "resize-pane":
		var p struct {
			ID   string `json:"id"`
			Cols int    `json:"cols"`
			Rows int    `json:"rows"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("resize-pane: %w", err)
		}
		return h.engine.ResizePane(p.ID, p.Cols, p.Rows)

	case "new-window":
		return h.engine.NewWindow()

	case "close-pane":
		var paneID string
		if err := json.Unmarshal(payload, &paneID); err != nil {
			return fmt.Errorf("close-pane: %w", err)
		}
		return h.engine.KillPane(paneID)

	case "rename-window":
		var p struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("rename-window: %w", err)
		}
		return h.engine.RenameWindow(p.ID, p.Name)

	case "create-session":
		var p struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return fmt.Errorf("create-session: %w", err)
		}
		return h.engine.NewSession(p.Name)

	default:
		return fmt.Errorf("unknown action: %s", action)
	}
}
```

Now update `readPump` to handle text messages. Replace the `websocket.MessageText` case:

```go
case websocket.MessageText:
    c.handleTextInput(data)
```

And add the handler:

```go
// handleTextInput parses a JSON action message and dispatches it.
func (c *Client) handleTextInput(data []byte) {
	action, payload, err := parseClientMessage(data)
	if err != nil {
		c.writeText(NewErrorMsg(err.Error()))
		return
	}
	if err := c.hub.dispatchAction(action, payload); err != nil {
		c.writeText(NewErrorMsg(err.Error()))
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestSelectWindow|TestNewWindow|TestResizePane|TestInvalidAction"`

Expected: All 4 tests PASS.

Run all server tests: `cd ~/workspace/muxterm && go test ./internal/server/ -v`

Expected: All tests PASS.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add internal/server/ && git commit -m "feat(server): JSON action dispatch — client actions to tmux commands"
```

---

### Task 8: CLI Wiring — `serve` Subcommand

**Files:**
- Modify: `cmd/muxterm/main.go` (add `serve` subcommand that starts HTTP server + tmux controller)

**Step 1: Read the existing `cmd/muxterm/main.go`**

Run: `cat ~/workspace/muxterm/cmd/muxterm/main.go`

Phase 1 should have created this file with basic CLI structure. Read it and understand its current state before modifying.

**Step 2: Write the `serve` subcommand**

The `serve` command must:
1. Parse `--addr` and `--secret` flags
2. Auto-generate a secret if not provided
3. Create the tmux Controller from Phase 1
4. Create the Server with the controller as the TmuxEngine
5. Wire tmux events to Hub broadcasts
6. Start both the controller and HTTP server
7. Shut down cleanly on SIGINT/SIGTERM

Add this to `cmd/muxterm/main.go` (adapt to whatever CLI structure Phase 1 used — `flag`, `cobra`, etc.):

```go
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"muxterm/internal/server"
	"muxterm/internal/tmux"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	if len(os.Args) < 2 {
		// Default: local mode (same as "serve" on localhost)
		os.Args = append(os.Args, "serve")
	}

	switch os.Args[1] {
	case "serve":
		cmdServe(os.Args[2:])
	case "version":
		fmt.Println("muxterm dev")
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

func cmdServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	addr := fs.String("addr", "127.0.0.1:8080", "listen address")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	session := fs.String("session", "", "tmux session to attach (default: first available)")
	fs.Parse(args)

	// Auto-generate secret if not provided
	if *secret == "" {
		s, err := server.GenerateSecret()
		if err != nil {
			log.Fatalf("failed to generate secret: %v", err)
		}
		*secret = s
	}

	// Context that cancels on SIGINT/SIGTERM
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Start tmux controller
	ctrl := tmux.NewController(*session)
	if err := ctrl.Start(ctx); err != nil {
		log.Fatalf("tmux controller: %v", err)
	}
	defer ctrl.Stop()

	// Create server with controller as engine
	srv := server.New(server.Config{
		Addr:   *addr,
		Secret: *secret,
	}, ctrl)

	// Wire tmux events → WebSocket broadcasts
	// Adapt these callback names to match Phase 1's actual event API.
	// If Phase 1 uses channels instead of callbacks, read from the channel
	// in a goroutine and call these Hub methods.
	ctrl.OnOutput(func(paneID string, data []byte) {
		srv.Hub().BroadcastPaneOutput(paneID, data)
	})

	ctrl.OnWindowAdd(func(windowID, name string) {
		srv.Hub().BroadcastEvent("window-add", map[string]string{"id": windowID, "name": name})
	})

	ctrl.OnWindowRenamed(func(windowID, name string) {
		srv.Hub().BroadcastEvent("window-renamed", map[string]string{"id": windowID, "name": name})
	})

	ctrl.OnLayoutChange(func(windowID, layout string) {
		srv.Hub().BroadcastEvent("layout-change", map[string]string{"window": windowID, "layout": layout})
	})

	ctrl.OnSessionChanged(func(name string) {
		srv.Hub().BroadcastEvent("session-changed", map[string]string{"name": name})
	})

	ctrl.OnSessionWindowChanged(func(sessionID, windowID string) {
		srv.Hub().BroadcastEvent("session-window-changed", map[string]string{
			"session": sessionID, "window": windowID,
		})
	})

	ctrl.OnPaneModeChanged(func(paneID string) {
		srv.Hub().BroadcastEvent("pane-mode", map[string]string{"id": paneID})
	})

	ctrl.OnExit(func(reason string) {
		srv.Hub().BroadcastEvent("detached", map[string]string{"reason": reason})
	})

	log.Printf("muxterm: http://%s (secret: %s...)", *addr, (*secret)[:8])

	if err := srv.ListenAndServe(ctx); err != nil {
		log.Fatalf("server: %v", err)
	}
}
```

> **IMPORTANT:** The event callback names above (`OnOutput`, `OnWindowAdd`, etc.) are guesses based on the design doc. **You must read Phase 1's actual Controller API** and adapt. If Phase 1 uses a single `OnEvent(func(Event))` callback with event types, rewrite the wiring to use a type switch:
>
> ```go
> ctrl.OnEvent(func(ev tmux.Event) {
>     switch e := ev.(type) {
>     case *tmux.OutputEvent:
>         srv.Hub().BroadcastPaneOutput(e.PaneID, e.Data)
>     case *tmux.WindowAddEvent:
>         srv.Hub().BroadcastEvent("window-add", map[string]string{"id": e.WindowID, "name": e.Name})
>     // ... etc
>     }
> })
> ```
>
> Similarly, if Phase 1's Controller doesn't directly satisfy the `TmuxEngine` interface, write a thin adapter struct.

**Step 3: Verify the binary builds**

Run: `cd ~/workspace/muxterm && go build ./cmd/muxterm/`

Expected: Build succeeds with no errors. A `muxterm` binary appears in the project root.

**Step 4: Verify the serve command starts**

Run the server briefly to confirm it starts and the health endpoint responds:

```bash
cd ~/workspace/muxterm
# Start server in background (will fail to connect to tmux if no session exists, that's ok)
timeout 3 ./muxterm serve --addr 127.0.0.1:9999 2>&1 &
sleep 1
curl -s http://127.0.0.1:9999/api/health
# Expected: {"status":"ok"}
```

If tmux isn't running, the server may exit early — that's expected. The key verification is that it compiles and the HTTP routes work.

**Step 5: Commit**

```bash
cd ~/workspace/muxterm && git add cmd/muxterm/main.go && git commit -m "feat(cli): serve subcommand — wires HTTP server + tmux controller"
```

---

## Final Verification

After all 8 tasks are complete, run the full test suite:

```bash
cd ~/workspace/muxterm && go test ./... -v
```

Expected: All tests pass across all packages.

Then verify the binary builds clean:

```bash
cd ~/workspace/muxterm && go build ./cmd/muxterm/ && ls -la muxterm
```

Expected: Single binary, ready for Phase 3 (frontend).

---

## Summary of files created/modified

| File | Action | Purpose |
|------|--------|---------|
| `internal/server/auth.go` | Create | HMAC token gen/validation, secret gen, localhost bypass |
| `internal/server/auth_test.go` | Create | Auth unit tests |
| `internal/server/server.go` | Create | HTTP server, health/token endpoints, static serving |
| `internal/server/server_test.go` | Create | HTTP endpoint tests |
| `internal/server/ws.go` | Create | Hub, Client, WebSocket upgrade, binary/JSON protocol |
| `internal/server/ws_test.go` | Create | WebSocket integration tests |
| `cmd/muxterm/main.go` | Modify | Add `serve` subcommand |