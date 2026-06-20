package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// trackingDaemonConn wraps fakeDaemonConn and records which create method was called.
type trackingDaemonConn struct {
	fakeDaemonConn
	createPaneCalled        bool
	createBrowserCDPPaneCalled bool
}

func (f *trackingDaemonConn) CreatePane(cmd []string, placement string, referencePaneID int) (int, error) {
	f.createPaneCalled = true
	return f.createdID, nil
}

func (f *trackingDaemonConn) CreateBrowserCDPPane(placement string, referencePaneID int) (int, error) {
	f.createBrowserCDPPaneCalled = true
	return f.createdID, nil
}

// TestAttachClient_OnPaneAdded_RelaysBrowserCDPSurfaceKind verifies that when the daemon fires a
// TypePaneAdded event for a browser-cdp pane, the relay handler in attachClient sends a
// TypePaneAdded message to the WS client that includes SurfaceKind "browser-cdp".
func TestAttachClient_OnPaneAdded_RelaysBrowserCDPSurfaceKind(t *testing.T) {
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

	// Trigger the OnPaneAdded handler with browser-cdp surface kind.
	fake.handlers.OnPaneAdded(sessiond.PaneInfo{
		PaneID:      5,
		Cols:        120,
		Rows:        30,
		Title:       "Browser",
		SurfaceKind: "browser-cdp",
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
	if msg.SurfaceKind != "browser-cdp" {
		t.Errorf("SurfaceKind = %q, want \"browser-cdp\"", msg.SurfaceKind)
	}
}

// TestHandleTextInput_TypeCreateBrowserPane_CallsCreateBrowserCDPPane verifies that a
// TypeCreateBrowserPane message routes to CreateBrowserCDPPane (not CreatePane).
func TestHandleTextInput_TypeCreateBrowserPane_CallsCreateBrowserCDPPane(t *testing.T) {
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

	// Send TypeCreateBrowserPane.
	msg := sessiond.Message{
		Type: sessiond.TypeCreateBrowserPane,
		CID:  99,
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if !fake.createBrowserCDPPaneCalled {
		t.Fatal("expected CreateBrowserCDPPane to be called for TypeCreateBrowserPane, but it was not")
	}
	if fake.createPaneCalled {
		t.Fatal("CreatePane should not be called for TypeCreateBrowserPane")
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
	if fake.createBrowserCDPPaneCalled {
		t.Fatal("CreateBrowserCDPPane should not be called when SurfaceKind is empty")
	}
}
