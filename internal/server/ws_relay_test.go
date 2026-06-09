package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/user/muxterm/internal/sessiond"
)

// trackingDaemonConn wraps fakeDaemonConn and records which create method was called.
type trackingDaemonConn struct {
	fakeDaemonConn
	createPaneCalled        bool
	createBrowserPaneCalled bool
	browserPort             int
	browserPath             string
	browserHeaders          map[string]string
}

func (f *trackingDaemonConn) CreatePane(cmd []string) (int, error) {
	f.createPaneCalled = true
	return f.createdID, nil
}

func (f *trackingDaemonConn) CreateBrowserPane(port int, path string, headers map[string]string) (int, error) {
	f.createBrowserPaneCalled = true
	f.browserPort = port
	f.browserPath = path
	f.browserHeaders = headers
	return f.createdID, nil
}

// TestAttachClient_OnPaneAdded_RelaysBrowserFields verifies that when the daemon fires a
// TypePaneAdded event for a browser pane, the relay handler in attachClient sends a
// TypePaneAdded message to the WS client that includes SurfaceKind, BrowserPort,
// BrowserPath, and ProxyHeaders.
func TestAttachClient_OnPaneAdded_RelaysBrowserFields(t *testing.T) {
	fake := &fakeDaemonConn{createdID: 1}
	h := NewHub(func() (DaemonConn, error) {
		return fake, nil
	})

	var captured []byte
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := &Client{
		hub:    h,
		ctx:    ctx,
		cancel: cancel,
	}
	c.writeTextFn = func(data []byte) error {
		captured = data
		return nil
	}
	c.writeBinaryFn = func(data []byte) error { return nil }

	if err := h.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	if fake.handlers.OnPaneAdded == nil {
		t.Fatal("OnPaneAdded handler not set by attachClient")
	}

	// Trigger the OnPaneAdded handler with browser-specific fields.
	fake.handlers.OnPaneAdded(sessiond.PaneInfo{
		PaneID:       5,
		Cols:         120,
		Rows:         30,
		Title:        "DevTools",
		SurfaceKind:  "browser",
		BrowserPort:  4000,
		BrowserPath:  "/debug",
		ProxyHeaders: map[string]string{"X-Token": "abc"},
	})

	if captured == nil {
		t.Fatal("no message sent to WS client after OnPaneAdded")
	}
	var msg sessiond.Message
	if err := json.Unmarshal(captured, &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if msg.Type != sessiond.TypePaneAdded {
		t.Errorf("Type = %q, want %q", msg.Type, sessiond.TypePaneAdded)
	}
	if msg.SurfaceKind != "browser" {
		t.Errorf("SurfaceKind = %q, want %q", msg.SurfaceKind, "browser")
	}
	if msg.BrowserPort != 4000 {
		t.Errorf("BrowserPort = %d, want 4000", msg.BrowserPort)
	}
	if msg.BrowserPath != "/debug" {
		t.Errorf("BrowserPath = %q, want %q", msg.BrowserPath, "/debug")
	}
	if msg.ProxyHeaders["X-Token"] != "abc" {
		t.Errorf("ProxyHeaders[X-Token] = %q, want %q", msg.ProxyHeaders["X-Token"], "abc")
	}
}

// TestHandleTextInput_TypeCreatePane_BrowserSurfaceKind verifies that a TypeCreatePane
// message with SurfaceKind="browser" routes to CreateBrowserPane (not CreatePane) so that
// a browser-backed pane is created instead of a PTY-backed terminal pane.
func TestHandleTextInput_TypeCreatePane_BrowserSurfaceKind(t *testing.T) {
	fake := &trackingDaemonConn{fakeDaemonConn: fakeDaemonConn{createdID: 10}}

	var sentMessages [][]byte
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := &Client{
		hub:    NewHub(nil),
		ctx:    ctx,
		cancel: cancel,
		daemon: fake,
	}
	c.writeTextFn = func(data []byte) error {
		sentMessages = append(sentMessages, data)
		return nil
	}
	c.writeBinaryFn = func(data []byte) error { return nil }

	// Send TypeCreatePane with SurfaceKind="browser".
	msg := sessiond.Message{
		Type:        sessiond.TypeCreatePane,
		CID:         99,
		SurfaceKind: "browser",
		BrowserPort: 5000,
		BrowserPath: "/api",
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if !fake.createBrowserPaneCalled {
		t.Fatal("expected CreateBrowserPane to be called for SurfaceKind=browser, but it was not")
	}
	if fake.createPaneCalled {
		t.Fatal("CreatePane should not be called when SurfaceKind=browser")
	}
	if fake.browserPort != 5000 {
		t.Errorf("CreateBrowserPane port = %d, want 5000", fake.browserPort)
	}
	if fake.browserPath != "/api" {
		t.Errorf("CreateBrowserPane path = %q, want %q", fake.browserPath, "/api")
	}
}

// TestHandleTextInput_TypeCreatePane_TerminalSurfaceKind verifies that a TypeCreatePane
// message with SurfaceKind="" (terminal, the default) routes to CreatePane as before.
func TestHandleTextInput_TypeCreatePane_TerminalSurfaceKind(t *testing.T) {
	fake := &trackingDaemonConn{fakeDaemonConn: fakeDaemonConn{createdID: 11}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := &Client{
		hub:    NewHub(nil),
		ctx:    ctx,
		cancel: cancel,
		daemon: fake,
	}
	c.writeTextFn = func(data []byte) error { return nil }
	c.writeBinaryFn = func(data []byte) error { return nil }

	// Send TypeCreatePane with no SurfaceKind (terminal path).
	msg := sessiond.Message{
		Type: sessiond.TypeCreatePane,
		CID:  77,
		Cmd:  []string{"bash"},
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if !fake.createPaneCalled {
		t.Fatal("expected CreatePane to be called when SurfaceKind is empty")
	}
	if fake.createBrowserPaneCalled {
		t.Fatal("CreateBrowserPane should not be called when SurfaceKind is empty")
	}
}
