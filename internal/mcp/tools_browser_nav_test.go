package mcp

import (
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

// browserResponder attaches a second sessiond client to wsID acting as the
// "browser side". It records every browser-action it receives into actions and
// immediately replies with reply (PaneID is copied from the incoming action).
// Returns the captured-action channel and a close func.
func browserResponder(t *testing.T, socketPath, wsID string, reply sessiond.Message) (<-chan *sessiond.Message, func()) {
	t.Helper()
	actions := make(chan *sessiond.Message, 8)
	b, err := sessiond.Dial(socketPath)
	if err != nil {
		t.Fatalf("browserResponder Dial: %v", err)
	}
	b.SetHandlers(sessiond.Handlers{
		OnBrowserAction: func(paneID int, action, ref, value, key, expr string) {
			actions <- &sessiond.Message{PaneID: paneID, Action: action, Ref: ref, Value: value, Key: key, Expression: expr}
			r := reply
			r.PaneID = paneID
			_ = b.BrowserActionResult(r)
		},
	})
	go b.Run()
	if _, err := b.Attach(wsID, "wide"); err != nil {
		t.Fatalf("browserResponder Attach: %v", err)
	}
	return actions, func() { b.Close() }
}

// attachedMCPClient dials a fresh MCP client and attaches it to the cold-start
// default workspace. Returns the client and the workspace id.
func attachedMCPClient(t *testing.T, socketPath string) (*Client, string) {
	t.Helper()
	mc, err := DialSocket(socketPath)
	if err != nil {
		t.Fatalf("DialSocket: %v", err)
	}
	t.Cleanup(func() { mc.Close() })
	wss, err := mc.conn.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	wsID := wss[0].WorkspaceID
	if err := mc.AttachWorkspace(wsID); err != nil {
		t.Fatalf("AttachWorkspace: %v", err)
	}
	return mc, wsID
}

// TestBrowserGotoSendsAction verifies that browserGoto sends action="goto"
// with value=url and returns {"ok":true}.
func TestBrowserGotoSendsAction(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{OK: true})
	defer closeB()

	out, err := newBrowserTools(mc).browserGoto(map[string]any{"pane_id": 3, "url": "http://example.com"})
	if err != nil {
		t.Fatalf("browserGoto: %v", err)
	}
	if out != `{"ok":true}` {
		t.Errorf("browserGoto result = %s, want {\"ok\":true}", out)
	}
	select {
	case a := <-actions:
		if a.Action != "goto" || a.Value != "http://example.com" || a.PaneID != 3 {
			t.Errorf("browser saw action=%q value=%q pane=%d, want goto/http://example.com/3", a.Action, a.Value, a.PaneID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no browser-action received")
	}
}

// TestBrowserNavActionStrings table-tests that each nav handler sends the
// correct action string to the shim.
func TestBrowserNavActionStrings(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{OK: true})
	defer closeB()

	bt := newBrowserTools(mc)
	cases := []struct {
		call func(map[string]any) (string, error)
		want string
	}{
		{bt.browserGoBack, "go-back"},
		{bt.browserGoForward, "go-forward"},
		{bt.browserReload, "reload"},
	}
	for _, tc := range cases {
		if _, err := tc.call(map[string]any{"pane_id": 1}); err != nil {
			t.Fatalf("%s: %v", tc.want, err)
		}
		select {
		case a := <-actions:
			if a.Action != tc.want {
				t.Errorf("action = %q, want %q", a.Action, tc.want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("no browser-action received for %q", tc.want)
		}
	}
}
