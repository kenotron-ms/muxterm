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
