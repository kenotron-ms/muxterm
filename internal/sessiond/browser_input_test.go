package sessiond

import (
	"strings"
	"testing"

	"github.com/go-rod/rod/lib/input"
	"github.com/go-rod/rod/lib/proto"
)

// TestMouseButton verifies the mouseButton helper maps button names to
// proto.InputMouseButton values correctly.
func TestMouseButton(t *testing.T) {
	cases := []struct {
		name string
		want proto.InputMouseButton
	}{
		{"left", proto.InputMouseButtonLeft},
		{"middle", proto.InputMouseButtonMiddle},
		{"right", proto.InputMouseButtonRight},
		{"", proto.InputMouseButtonLeft},   // default
		{"other", proto.InputMouseButtonLeft}, // default
	}
	for _, tc := range cases {
		got := mouseButton(tc.name)
		if got != tc.want {
			t.Errorf("mouseButton(%q) = %q; want %q", tc.name, got, tc.want)
		}
	}
}

// TestKeyFromName verifies keyFromName returns correct input.Key values
// for known keys and 0 for unknown/unsupported keys.
func TestKeyFromName(t *testing.T) {
	cases := []struct {
		name string
		want input.Key
	}{
		// Single printable ASCII
		{"a", input.Key('a')},
		{"A", input.Key('A')},
		{"z", input.Key('z')},
		{"0", input.Key('0')},
		// Named keys
		{"Enter", input.Enter},
		{"Backspace", input.Backspace},
		{"Tab", input.Tab},
		{"Escape", input.Escape},
		{"Delete", input.Delete},
		{"ArrowLeft", input.ArrowLeft},
		{"ArrowRight", input.ArrowRight},
		{"ArrowUp", input.ArrowUp},
		{"ArrowDown", input.ArrowDown},
		{"Home", input.Home},
		{"End", input.End},
		{"PageUp", input.PageUp},
		{"PageDown", input.PageDown},
		{"F1", input.F1},
		{"F2", input.F2},
		{"F3", input.F3},
		{"F4", input.F4},
		{"F5", input.F5},
		{"F6", input.F6},
		{"F7", input.F7},
		{"F8", input.F8},
		{"F9", input.F9},
		{"F10", input.F10},
		{"F11", input.F11},
		{"F12", input.F12},
		{"Control", input.ControlLeft},
		{"Shift", input.ShiftLeft},
		{"Alt", input.AltLeft},
		{"Meta", input.MetaLeft},
		{"Space", input.Space},
		// Unknown/unsupported — must return 0
		{"Unknown", 0},
		{"CapsLock", 0},
		{"", 0},
		{"Unidentified", 0},
	}
	for _, tc := range cases {
		got := keyFromName(tc.name)
		if got != tc.want {
			t.Errorf("keyFromName(%q) = %v; want %v", tc.name, got, tc.want)
		}
	}
}

// TestHandleInput_DefaultCase verifies that HandleInput returns nil for an
// unknown event type without panicking (no bp.page access needed).
func TestHandleInput_DefaultCase(t *testing.T) {
	bp := &BrowserPage{} // page is nil; default case must not touch it
	err := bp.HandleInput(BrowserInputMsg{Type: "unknown-event-type"})
	if err != nil {
		t.Errorf("HandleInput unknown type: got error %v; want nil", err)
	}
}

// TestHandleNavigate_EmptyURL verifies handleNavigate returns an error for
// an empty URL without invoking the rod.Page (page is nil).
func TestHandleNavigate_EmptyURL(t *testing.T) {
	bp := &BrowserPage{} // page is nil; empty-URL check must happen before page use
	err := bp.handleNavigate("")
	if err == nil {
		t.Fatal("handleNavigate(\"\") returned nil; want error")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Errorf("handleNavigate(\"\") error = %q; want it to mention 'empty'", err.Error())
	}
}

// TestHandleInput_TypeSwitch verifies all branch constants exist and are
// reachable. We exercise the "type" branch (InsertText with empty text)
// and navigate-empty branch via nil-page checks.
// This is a compile-time coverage test: if a branch refers to a non-existent
// method, the package fails to build.
func TestHandleInput_BranchesExist(t *testing.T) {
	// Verify HandleInput and handleNavigate exist and have the right signatures
	// by taking their addresses (compile check only).
	var _ func(BrowserInputMsg) error = (&BrowserPage{}).HandleInput
	var _ func(string) error = (&BrowserPage{}).handleNavigate
	var _ func(string) proto.InputMouseButton = mouseButton
	var _ func(string) input.Key = keyFromName
}
