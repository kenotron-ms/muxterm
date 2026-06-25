package sessiond

import (
	"encoding/json"
	"testing"
)

// TestBrowserProtocolConstants verifies the new browser-cdp wire protocol
// constants are defined with the correct frozen string values.
func TestBrowserProtocolConstants(t *testing.T) {
	cases := []struct {
		name  string
		got   string
		want  string
	}{
		{"TypeCreateBrowserPane", TypeCreateBrowserPane, "create-browser-pane"},
		{"TypeCloseBrowserPane", TypeCloseBrowserPane, "close-browser-pane"},
		{"TypeBrowserInput", TypeBrowserInput, "browser-input"},
		{"TypeBrowserURL", TypeBrowserURL, "browser-url"},
		{"TypeBrowserDownloadProgress", TypeBrowserDownloadProgress, "browser-download-progress"},
		{"TypeBrowserError", TypeBrowserError, "browser-error"},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s = %q; want %q", tc.name, tc.got, tc.want)
		}
	}
}

// TestBrowserInputMsgJSON verifies BrowserInputMsg marshals with correct JSON
// field names and respects omitempty for optional fields.
func TestBrowserInputMsgJSON(t *testing.T) {
	// Only required Type field set — all optional fields must be omitted.
	msg := BrowserInputMsg{Type: TypeBrowserInput}
	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal BrowserInputMsg: %v", err)
	}
	want := `{"type":"browser-input"}`
	if string(got) != want {
		t.Errorf("BrowserInputMsg omitempty\n got: %s\nwant: %s", got, want)
	}

	// All fields populated — verify JSON tags.
	full := BrowserInputMsg{
		Type:   "click",
		X:      100.5,
		Y:      200.5,
		Button: "left",
		DeltaX: 10.0,
		DeltaY: 20.0,
		Key:    "Enter",
		Text:   "hello",
		URL:    "https://example.com",
		Width:  1280,
		Height: 720,
	}
	got, err = json.Marshal(&full)
	if err != nil {
		t.Fatalf("json.Marshal BrowserInputMsg full: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	checkField := func(key string, want interface{}) {
		t.Helper()
		v, ok := decoded[key]
		if !ok {
			t.Errorf("BrowserInputMsg JSON missing field %q", key)
			return
		}
		// JSON numbers come back as float64
		switch w := want.(type) {
		case int:
			if v.(float64) != float64(w) {
				t.Errorf("BrowserInputMsg[%q] = %v; want %v", key, v, want)
			}
		default:
			if v != want {
				t.Errorf("BrowserInputMsg[%q] = %v; want %v", key, v, want)
			}
		}
	}
	checkField("type", "click")
	checkField("x", 100.5)
	checkField("y", 200.5)
	checkField("button", "left")
	checkField("deltaX", 10.0)
	checkField("deltaY", 20.0)
	checkField("key", "Enter")
	checkField("text", "hello")
	checkField("url", "https://example.com")
	checkField("width", 1280)
	checkField("height", 720)
}

// TestBrowserURLMsgJSON verifies BrowserURLMsg marshals with correct JSON field names.
func TestBrowserURLMsgJSON(t *testing.T) {
	msg := BrowserURLMsg{
		Type:   TypeBrowserURL,
		PaneID: 3,
		URL:    "https://example.com/path",
	}
	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal BrowserURLMsg: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if decoded["type"] != "browser-url" {
		t.Errorf("BrowserURLMsg type = %v; want browser-url", decoded["type"])
	}
	if decoded["paneId"].(float64) != 3 {
		t.Errorf("BrowserURLMsg paneId = %v; want 3", decoded["paneId"])
	}
	if decoded["url"] != "https://example.com/path" {
		t.Errorf("BrowserURLMsg url = %v; want https://example.com/path", decoded["url"])
	}
}

// TestBrowserProgressMsgJSON verifies BrowserProgressMsg marshals with correct JSON field names.
func TestBrowserProgressMsgJSON(t *testing.T) {
	msg := BrowserProgressMsg{
		Type:    TypeBrowserDownloadProgress,
		PaneID:  5,
		Percent: 42,
	}
	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal BrowserProgressMsg: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if decoded["type"] != "browser-download-progress" {
		t.Errorf("BrowserProgressMsg type = %v; want browser-download-progress", decoded["type"])
	}
	if decoded["paneId"].(float64) != 5 {
		t.Errorf("BrowserProgressMsg paneId = %v; want 5", decoded["paneId"])
	}
	if decoded["percent"].(float64) != 42 {
		t.Errorf("BrowserProgressMsg percent = %v; want 42", decoded["percent"])
	}
}

// TestBrowserErrorMsgJSON verifies BrowserErrorMsg marshals with correct JSON field names.
func TestBrowserErrorMsgJSON(t *testing.T) {
	msg := BrowserErrorMsg{
		Type:   TypeBrowserError,
		PaneID: 7,
		Error:  "navigation failed",
	}
	got, err := json.Marshal(&msg)
	if err != nil {
		t.Fatalf("json.Marshal BrowserErrorMsg: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if decoded["type"] != "browser-error" {
		t.Errorf("BrowserErrorMsg type = %v; want browser-error", decoded["type"])
	}
	if decoded["paneId"].(float64) != 7 {
		t.Errorf("BrowserErrorMsg paneId = %v; want 7", decoded["paneId"])
	}
	if decoded["error"] != "navigation failed" {
		t.Errorf("BrowserErrorMsg error = %v; want navigation failed", decoded["error"])
	}
}
