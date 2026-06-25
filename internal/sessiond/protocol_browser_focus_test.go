package sessiond

import (
	"encoding/json"
	"testing"
)

// TestTypeBrowserGrantedConstant verifies the TypeBrowserGranted constant
// has the correct frozen wire-protocol value.
func TestTypeBrowserGrantedConstant(t *testing.T) {
	if TypeBrowserGranted != "browser-granted" {
		t.Errorf("TypeBrowserGranted = %q; want %q", TypeBrowserGranted, "browser-granted")
	}
}

// TestBrowserInputMsgFocusFields verifies that BrowserInputMsg carries the
// four new fields required for browser-focus and browser-blur events:
// ClientID, DeviceID, RenderWidth, RenderHeight.
func TestBrowserInputMsgFocusFields(t *testing.T) {
	msg := BrowserInputMsg{
		Type:         TypeBrowserFocus,
		ClientID:     "client-abc-123",
		DeviceID:     "device-xyz-456",
		RenderWidth:  1280,
		RenderHeight: 800,
	}

	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal BrowserInputMsg with focus fields: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	checkStr := func(key, want string) {
		t.Helper()
		v, ok := decoded[key]
		if !ok {
			t.Errorf("BrowserInputMsg JSON missing field %q", key)
			return
		}
		if v != want {
			t.Errorf("BrowserInputMsg[%q] = %v; want %q", key, v, want)
		}
	}
	checkInt := func(key string, want int) {
		t.Helper()
		v, ok := decoded[key]
		if !ok {
			t.Errorf("BrowserInputMsg JSON missing field %q", key)
			return
		}
		if v.(float64) != float64(want) {
			t.Errorf("BrowserInputMsg[%q] = %v; want %d", key, v, want)
		}
	}

	checkStr("type", "browser-focus")
	checkStr("clientId", "client-abc-123")
	checkStr("deviceId", "device-xyz-456")
	checkInt("renderWidth", 1280)
	checkInt("renderHeight", 800)
}

// TestBrowserInputMsgFocusFieldsOmitempty verifies that new focus fields are
// omitted when zero-valued (omitempty must be set on all four fields).
func TestBrowserInputMsgFocusFieldsOmitempty(t *testing.T) {
	msg := BrowserInputMsg{Type: TypeBrowserInput}
	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	want := `{"type":"browser-input"}`
	if string(got) != want {
		t.Errorf("BrowserInputMsg omitempty with focus fields\n got: %s\nwant: %s", got, want)
	}
}

// TestBrowserGrantedMsgJSON verifies BrowserGrantedMsg marshals to the
// correct JSON shape: {type, paneId, clientId}.
func TestBrowserGrantedMsgJSON(t *testing.T) {
	msg := BrowserGrantedMsg{
		Type:     TypeBrowserGranted,
		PaneID:   3,
		ClientID: "client-abc-123",
	}

	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal BrowserGrantedMsg: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	if decoded["type"] != "browser-granted" {
		t.Errorf("BrowserGrantedMsg type = %v; want browser-granted", decoded["type"])
	}
	if decoded["paneId"].(float64) != 3 {
		t.Errorf("BrowserGrantedMsg paneId = %v; want 3", decoded["paneId"])
	}
	if decoded["clientId"] != "client-abc-123" {
		t.Errorf("BrowserGrantedMsg clientId = %v; want client-abc-123", decoded["clientId"])
	}
}
