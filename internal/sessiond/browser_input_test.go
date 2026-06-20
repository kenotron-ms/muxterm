package sessiond

import (
	"context"
	"strings"
	"testing"
)

// TestCDPMouseButton verifies cdpMouseButton maps button names to CDP button
// strings correctly.
func TestCDPMouseButton(t *testing.T) {
	cases := []struct {
		name string
		want string
	}{
		{"left", "left"},
		{"middle", "middle"},
		{"right", "right"},
		{"", "left"},     // default
		{"other", "left"}, // default
	}
	for _, tc := range cases {
		got := cdpMouseButton(tc.name)
		if got != tc.want {
			t.Errorf("cdpMouseButton(%q) = %q; want %q", tc.name, got, tc.want)
		}
	}
}

// TestCDPKeyParams verifies cdpKeyParams returns correct CDP key, code, and
// text parameters for known key names.
func TestCDPKeyParams(t *testing.T) {
	cases := []struct {
		name     string
		wantKey  string
		wantCode string
		wantText string
	}{
		// Single printable ASCII: key=char, code="Key"+upper(char), text=char
		{"a", "a", "KeyA", "a"},
		{"A", "A", "KeyA", "A"},
		{"z", "z", "KeyZ", "z"},
		// Named keys
		{"Enter", "Enter", "Enter", "\r"},
		{"Backspace", "Backspace", "Backspace", ""},
		{"Tab", "Tab", "Tab", "\t"},
		{"Escape", "Escape", "Escape", ""},
		{"Delete", "Delete", "Delete", ""},
		{"ArrowLeft", "ArrowLeft", "ArrowLeft", ""},
		{"ArrowRight", "ArrowRight", "ArrowRight", ""},
		{"ArrowUp", "ArrowUp", "ArrowUp", ""},
		{"ArrowDown", "ArrowDown", "ArrowDown", ""},
		{"Home", "Home", "Home", ""},
		{"End", "End", "End", ""},
		{"PageUp", "PageUp", "PageUp", ""},
		{"PageDown", "PageDown", "PageDown", ""},
		{"F1", "F1", "F1", ""},
		{"F12", "F12", "F12", ""},
		{"Control", "Control", "ControlLeft", ""},
		{"Shift", "Shift", "ShiftLeft", ""},
		{"Alt", "Alt", "AltLeft", ""},
		{"Meta", "Meta", "MetaLeft", ""},
		{"Space", " ", "Space", " "},
		// Unknown/unsupported — echoed as-is with empty text
		{"Unknown", "Unknown", "Unknown", ""},
	}
	for _, tc := range cases {
		gotKey, gotCode, gotText := cdpKeyParams(tc.name)
		if gotKey != tc.wantKey {
			t.Errorf("cdpKeyParams(%q).key = %q; want %q", tc.name, gotKey, tc.wantKey)
		}
		if gotCode != tc.wantCode {
			t.Errorf("cdpKeyParams(%q).code = %q; want %q", tc.name, gotCode, tc.wantCode)
		}
		if gotText != tc.wantText {
			t.Errorf("cdpKeyParams(%q).text = %q; want %q", tc.name, gotText, tc.wantText)
		}
	}
}

// TestHandleInput_DefaultCase verifies that HandleInput returns nil for an
// unknown event type without panicking (no cdp.Call access needed).
func TestHandleInput_DefaultCase(t *testing.T) {
	bp := &BrowserPage{} // cdp is nil; default case must not touch it
	err := bp.HandleInput(context.Background(), BrowserInputMsg{Type: "unknown-event-type"})
	if err != nil {
		t.Errorf("HandleInput unknown type: got error %v; want nil", err)
	}
}

// TestHandleNavigate_EmptyURL verifies handleNavigate returns an error for
// an empty URL without invoking the CDP connection (cdp is nil).
func TestHandleNavigate_EmptyURL(t *testing.T) {
	bp := &BrowserPage{} // cdp is nil; empty-URL check must happen before cdp use
	err := bp.handleNavigate(context.Background(), "")
	if err == nil {
		t.Fatal("handleNavigate(\"\") returned nil; want error")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Errorf("handleNavigate(\"\") error = %q; want it to mention 'empty'", err.Error())
	}
}

// TestHandleInput_BranchesExist verifies HandleInput and helper functions
// exist and have the correct signatures (compile-time check).
func TestHandleInput_BranchesExist(t *testing.T) {
	var _ func(context.Context, BrowserInputMsg) error = (&BrowserPage{}).HandleInput
	var _ func(context.Context, string) error = (&BrowserPage{}).handleNavigate
	var _ func(string) string = cdpMouseButton
	var _ func(string) (string, string, string) = cdpKeyParams
}

// TestHandleInput_AuthorityGuard_DropsNonAuthority verifies that HandleInput
// silently drops mouse/keyboard events from a client that does not hold
// authority. The guard must return nil without touching the CDP connection
// (which is nil here — reaching it would panic).
func TestHandleInput_AuthorityGuard_DropsNonAuthority(t *testing.T) {
	bm := NewBrowserManager(
		func(paneID int, data []byte) {},
		func(msg any) {},
	)
	bm.SetAuthority(1, "client-A") // client-A holds authority

	bp := &BrowserPage{
		paneID:  1,
		manager: bm,
		// cdp is nil: reaching it would panic, proving the guard returned early
	}

	// client-B (not the authority) sends mousemove — must be silently dropped.
	err := bp.HandleInput(context.Background(), BrowserInputMsg{
		Type:     "mousemove",
		ClientID: "client-B",
		X:        50,
		Y:        50,
	})
	if err != nil {
		t.Errorf("HandleInput non-authority drop: want nil error, got %v", err)
	}
}

// TestHandleInput_BrowserBlur_ClearsAuthority verifies that a browser-blur
// message from the current authority client clears that client's authority.
// browser-blur must not touch CDP, so cdp can remain nil.
func TestHandleInput_BrowserBlur_ClearsAuthority(t *testing.T) {
	bm := NewBrowserManager(nil, nil)
	bm.SetAuthority(1, "client-A")

	bp := &BrowserPage{paneID: 1, manager: bm}

	err := bp.HandleInput(context.Background(), BrowserInputMsg{
		Type:     TypeBrowserBlur,
		ClientID: "client-A",
	})
	if err != nil {
		t.Errorf("browser-blur: got error %v; want nil", err)
	}
	if bm.IsAuthority(1, "client-A") {
		t.Error("browser-blur: authority not cleared after blur")
	}
}

// TestHandleInput_BrowserFocus_SetsAuthorityAndBroadcasts verifies that a
// browser-focus message (a) records the sender as the input authority and
// (b) broadcasts a BrowserGrantedMsg to all clients.
//
// Because the final step of browser-focus calls startScreencast (which
// requires a live CDP connection), we run HandleInput in a goroutine and
// recover from the nil-cdp panic, then inspect the side-effects that
// occurred before the panic.
func TestHandleInput_BrowserFocus_SetsAuthorityAndBroadcasts(t *testing.T) {
	var grantedMsg BrowserGrantedMsg
	var broadcastCount int

	bm := NewBrowserManager(
		func(paneID int, data []byte) {},
		func(msg any) {
			if g, ok := msg.(BrowserGrantedMsg); ok {
				grantedMsg = g
				broadcastCount++
			}
		},
	)

	bp := &BrowserPage{paneID: 1, manager: bm}
	// cdp is nil; SetViewport is skipped (RenderWidth/Height == 0),
	// but captureScreenshot/startScreencast will panic — recovered below.

	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { recover() }() // catch nil-cdp panic in captureScreenshot/startScreencast
		bp.HandleInput(context.Background(), BrowserInputMsg{ //nolint:errcheck
			Type:     TypeBrowserFocus,
			ClientID: "client-X",
			// RenderWidth/Height = 0 → SetViewport skipped
		})
	}()
	<-done // happens-before: goroutine side-effects are visible here

	if !bm.IsAuthority(1, "client-X") {
		t.Error("browser-focus: authority not set after focus")
	}
	if broadcastCount == 0 {
		t.Error("browser-focus: BrowserGrantedMsg not broadcast via broadcastJSON")
	}
	if broadcastCount > 0 {
		if grantedMsg.ClientID != "client-X" {
			t.Errorf("BrowserGrantedMsg.ClientID = %q; want %q", grantedMsg.ClientID, "client-X")
		}
		if grantedMsg.PaneID != 1 {
			t.Errorf("BrowserGrantedMsg.PaneID = %d; want 1", grantedMsg.PaneID)
		}
		if grantedMsg.Type != TypeBrowserGranted {
			t.Errorf("BrowserGrantedMsg.Type = %q; want %q", grantedMsg.Type, TypeBrowserGranted)
		}
	}
}
