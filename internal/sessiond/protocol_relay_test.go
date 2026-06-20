package sessiond

import (
	"bytes"
	"encoding/json"
	"testing"
)

// TestFrameBrowserDataConstant verifies the FrameBrowserData frame kind constant
// is defined with value 0x03, one above FramePaneData (0x02).
func TestFrameBrowserDataConstant(t *testing.T) {
	if FrameBrowserData != 0x03 {
		t.Errorf("FrameBrowserData = %#x, want 0x03", FrameBrowserData)
	}
}

// TestBrowserRelayTypeConstants verifies the new browser focus/blur/granted
// type string constants are defined with the correct frozen wire values.
func TestBrowserRelayTypeConstants(t *testing.T) {
	cases := []struct {
		name string
		got  string
		want string
	}{
		{"TypeBrowserFocus", TypeBrowserFocus, "browser-focus"},
		{"TypeBrowserBlur", TypeBrowserBlur, "browser-blur"},
		{"TypeBrowserGranted", TypeBrowserGranted, "browser-granted"},
	}
	for _, tc := range cases {
		if tc.got != tc.want {
			t.Errorf("%s = %q; want %q", tc.name, tc.got, tc.want)
		}
	}
}

// TestMessageRelayFieldsJSON verifies the new relay Message fields survive a
// JSON round-trip with the correct frozen wire field names.
func TestMessageRelayFieldsJSON(t *testing.T) {
	raw := json.RawMessage(`{"type":"keydown","key":"Enter"}`)
	rawPayload := json.RawMessage(`{"type":"browser-input","key":"Enter"}`)

	original := Message{
		Type:         TypeBrowserFocus,
		ClientID:     "client-abc",
		DeviceID:     "device-xyz",
		RenderWidth:  1280,
		RenderHeight: 720,
		InputEvent:   raw,
		RawPayload:   rawPayload,
	}

	data, err := json.Marshal(&original)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}

	var decoded map[string]interface{}
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	checkString := func(key, want string) {
		t.Helper()
		v, ok := decoded[key]
		if !ok {
			t.Errorf("Message JSON missing field %q", key)
			return
		}
		if v.(string) != want {
			t.Errorf("Message[%q] = %q; want %q", key, v, want)
		}
	}
	checkInt := func(key string, want int) {
		t.Helper()
		v, ok := decoded[key]
		if !ok {
			t.Errorf("Message JSON missing field %q", key)
			return
		}
		if int(v.(float64)) != want {
			t.Errorf("Message[%q] = %v; want %d", key, v, want)
		}
	}

	checkString("clientId", "client-abc")
	checkString("deviceId", "device-xyz")
	checkInt("renderWidth", 1280)
	checkInt("renderHeight", 720)

	// inputEvent and rawPayload should be present as JSON objects
	if _, ok := decoded["inputEvent"]; !ok {
		t.Error("Message JSON missing field \"inputEvent\"")
	}
	if _, ok := decoded["rawPayload"]; !ok {
		t.Error("Message JSON missing field \"rawPayload\"")
	}
}

// TestMessageRelayFieldsOmitempty verifies that zero-valued relay fields do not
// appear in the marshaled JSON envelope.
func TestMessageRelayFieldsOmitempty(t *testing.T) {
	got, err := json.Marshal(&Message{Type: TypeBrowserBlur})
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	for _, field := range []string{"clientId", "deviceId", "renderWidth", "renderHeight", "inputEvent", "rawPayload"} {
		if _, ok := decoded[field]; ok {
			t.Errorf("Message JSON contains field %q with zero value, want omitted", field)
		}
	}
}

// TestWriteBrowserDataRoundTrip writes a FrameBrowserData frame and reads it
// back, asserting the frame kind, decoded paneID, and exact JPEG byte payload.
func TestWriteBrowserDataRoundTrip(t *testing.T) {
	jpeg := []byte{0xff, 0xd8, 0xff, 0xe0, 0x42, 0x43} // fake JPEG header bytes

	var buf bytes.Buffer
	if err := WriteBrowserData(&buf, 99, jpeg); err != nil {
		t.Fatalf("WriteBrowserData returned error: %v", err)
	}

	kind, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame returned error: %v", err)
	}
	if kind != FrameBrowserData {
		t.Fatalf("kind = %#x, want FrameBrowserData (%#x)", kind, FrameBrowserData)
	}

	// payload is [4-byte LE paneID][data]
	if len(payload) < 4 {
		t.Fatalf("payload too short: %d bytes", len(payload))
	}
	paneID, gotData := DecodePaneData(payload)
	if paneID != 99 {
		t.Errorf("paneID = %d, want 99", paneID)
	}
	if !bytes.Equal(gotData, jpeg) {
		t.Errorf("data = %#v, want %#v", gotData, jpeg)
	}
}

// TestWriteBrowserDataLittleEndian asserts the on-wire paneId inside
// FrameBrowserData is little-endian, consistent with FramePaneData framing.
func TestWriteBrowserDataLittleEndian(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteBrowserData(&buf, 1, nil); err != nil {
		t.Fatalf("WriteBrowserData returned error: %v", err)
	}

	_, payload, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame returned error: %v", err)
	}

	want := []byte{0x01, 0x00, 0x00, 0x00}
	if !bytes.Equal(payload, want) {
		t.Errorf("payload = %#v, want %#v (paneId=1 little-endian, no body)", payload, want)
	}
}
