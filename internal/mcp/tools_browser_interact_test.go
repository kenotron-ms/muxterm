package mcp

import (
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

// TestBrowserInteractActionStrings table-tests each browser interaction tool:
// verify action string, field mapping, and {ok:true} result.
func TestBrowserInteractActionStrings(t *testing.T) {
	socketPath, cancel := startMCPTestServer(t)
	defer cancel()
	mc, wsID := attachedMCPClient(t, socketPath)
	actions, closeB := browserResponder(t, socketPath, wsID, sessiond.Message{OK: true})
	defer closeB()

	bt := newBrowserTools(mc)

	cases := []struct {
		name string
		call func(map[string]any) (string, error)
		args map[string]any
		// expected fields on the received action message
		wantAction string
		wantRef    string
		wantValue  string
		wantKey    string
	}{
		{
			name:       "click",
			call:       bt.browserClick,
			args:       map[string]any{"pane_id": 1, "ref": "e5"},
			wantAction: "click",
			wantRef:    "e5",
		},
		{
			name:       "fill",
			call:       bt.browserFill,
			args:       map[string]any{"pane_id": 1, "ref": "e2", "value": "hi"},
			wantAction: "fill",
			wantRef:    "e2",
			wantValue:  "hi",
		},
		{
			// CRITICAL: tool argument is named "text" but must map to Value field,
			// not Text. The shim's type_ action reads msg.value.
			name:       "type",
			call:       bt.browserType,
			args:       map[string]any{"pane_id": 1, "text": "abc"},
			wantAction: "type_",
			wantValue:  "abc",
		},
		{
			name:       "press",
			call:       bt.browserPress,
			args:       map[string]any{"pane_id": 1, "key": "Enter"},
			wantAction: "press",
			wantKey:    "Enter",
		},
		{
			name:       "hover",
			call:       bt.browserHover,
			args:       map[string]any{"pane_id": 1, "ref": "e4"},
			wantAction: "hover",
			wantRef:    "e4",
		},
		{
			name:       "select",
			call:       bt.browserSelect,
			args:       map[string]any{"pane_id": 1, "ref": "e9", "value": "opt1"},
			wantAction: "select_",
			wantRef:    "e9",
			wantValue:  "opt1",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			out, err := tc.call(tc.args)
			if err != nil {
				t.Fatalf("%s: unexpected error: %v", tc.name, err)
			}
			if out != `{"ok":true}` {
				t.Errorf("%s: result = %s, want {\"ok\":true}", tc.name, out)
			}

			select {
			case a := <-actions:
				if a.Action != tc.wantAction {
					t.Errorf("%s: action = %q, want %q", tc.name, a.Action, tc.wantAction)
				}
				if tc.wantRef != "" && a.Ref != tc.wantRef {
					t.Errorf("%s: Ref = %q, want %q", tc.name, a.Ref, tc.wantRef)
				}
				if tc.wantValue != "" && a.Value != tc.wantValue {
					t.Errorf("%s: Value = %q, want %q", tc.name, a.Value, tc.wantValue)
				}
				if tc.wantKey != "" && a.Key != tc.wantKey {
					t.Errorf("%s: Key = %q, want %q", tc.name, a.Key, tc.wantKey)
				}
			case <-time.After(2 * time.Second):
				t.Fatalf("%s: no browser-action received", tc.name)
			}
		})
	}
}
