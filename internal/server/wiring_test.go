package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// TestNewHub_BrowserClientsInitialized verifies that NewHub creates a Hub with
// an initialized (non-nil) browserClients map so that /ws/browser registrations
// and BroadcastBrowserFrame/BroadcastBrowserJSON don't panic on first use.
func TestNewHub_BrowserClientsInitialized(t *testing.T) {
	h := NewHub(nil)
	h.browserMu.Lock()
	defer h.browserMu.Unlock()
	if h.browserClients == nil {
		t.Fatal("NewHub: browserClients is nil; want initialized map")
	}
}

// TestSetBrowserManager verifies that SetBrowserManager stores the manager in
// Hub.browserManager so that handleTextInput and handleWSBrowserImpl can
// retrieve it later.
func TestSetBrowserManager(t *testing.T) {
	h := NewHub(nil)
	bm := sessiond.NewBrowserManager(func(int, []byte) {}, func(any) {})
	h.SetBrowserManager(bm)

	h.mu.RLock()
	got := h.browserManager
	h.mu.RUnlock()

	if got != bm {
		t.Fatal("SetBrowserManager: hub.browserManager was not set to the supplied BrowserManager")
	}
}

// TestHandleTextInput_TypeCreateBrowserPane verifies that a TypeCreateBrowserPane
// message calls daemon.CreateBrowserCDPPane and sends TypePaneCreated back.
func TestHandleTextInput_TypeCreateBrowserPane(t *testing.T) {
	fake := &fakeDaemonConn{createdID: 42}

	var sentMessages [][]byte
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := NewHub(nil)
	c := &Client{
		hub:    hub,
		ctx:    ctx,
		cancel: cancel,
		daemon: fake,
	}
	c.writeTextFn = func(data []byte) error {
		sentMessages = append(sentMessages, data)
		return nil
	}
	c.writeBinaryFn = func(data []byte) error { return nil }

	msg := sessiond.Message{
		Type:      sessiond.TypeCreateBrowserPane,
		CID:       77,
		ClientRef: "ref-1",
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if len(sentMessages) == 0 {
		t.Fatal("TypeCreateBrowserPane: expected at least one message sent to client, got none")
	}
	var reply sessiond.Message
	if err := json.Unmarshal(sentMessages[len(sentMessages)-1], &reply); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	if reply.Type != sessiond.TypePaneCreated {
		t.Errorf("reply.Type = %q, want %q", reply.Type, sessiond.TypePaneCreated)
	}
	if reply.PaneID != 42 {
		t.Errorf("reply.PaneID = %d, want 42", reply.PaneID)
	}
	if reply.CID != 77 {
		t.Errorf("reply.CID = %d, want 77", reply.CID)
	}
}

// TestHandleTextInput_TypeCloseBrowserPane verifies that a TypeCloseBrowserPane
// message calls daemon.ClosePane and sends TypeOK back.
func TestHandleTextInput_TypeCloseBrowserPane(t *testing.T) {
	fake := &fakeDaemonConn{}

	var sentMessages [][]byte
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hub := NewHub(nil)
	c := &Client{
		hub:    hub,
		ctx:    ctx,
		cancel: cancel,
		daemon: fake,
	}
	c.writeTextFn = func(data []byte) error {
		sentMessages = append(sentMessages, data)
		return nil
	}
	c.writeBinaryFn = func(data []byte) error { return nil }

	msg := sessiond.Message{
		Type:   sessiond.TypeCloseBrowserPane,
		CID:    55,
		PaneID: 7,
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if len(sentMessages) == 0 {
		t.Fatal("TypeCloseBrowserPane: expected at least one message sent to client, got none")
	}
	var reply sessiond.Message
	if err := json.Unmarshal(sentMessages[len(sentMessages)-1], &reply); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	if reply.Type != sessiond.TypeOK {
		t.Errorf("reply.Type = %q, want %q", reply.Type, sessiond.TypeOK)
	}
	if reply.CID != 55 {
		t.Errorf("reply.CID = %d, want 55", reply.CID)
	}
}

// TestConfigBrowserManagerField is a compile-time assertion that the Config
// struct exposes BrowserManager as a *sessiond.BrowserManager field. If the
// field does not exist this file will not compile.
func TestConfigBrowserManagerField(t *testing.T) {
	var cfg Config
	var _ *sessiond.BrowserManager = cfg.BrowserManager // compile-time check
}

// TestWSBrowserRouteRegistered verifies that GET /ws/browser is registered in
// the server's mux. We send a plain HTTP GET (not a WebSocket upgrade) and
// expect the handler to be reached — the request will fail because it is not
// a real WebSocket upgrade, but the 400 / 426 or similar non-404 response
// confirms the route is present.
func TestWSBrowserRouteRegistered(t *testing.T) {
	srv := New(Config{NoAuth: true})
	req := httptest.NewRequest(http.MethodGet, "/ws/browser", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code == http.StatusNotFound {
		t.Fatalf("GET /ws/browser returned 404: route not registered")
	}
}
