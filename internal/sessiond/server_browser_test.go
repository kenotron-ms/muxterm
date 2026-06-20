package sessiond

import (
	"bytes"
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// TestServerHasBrowserFields verifies that Server has the new browserManager
// and browserPanes fields with the correct types. This is a compile-time test:
// it fails to compile before the fields are added to the struct.
func TestServerHasBrowserFields(t *testing.T) {
	var s Server
	// browserManager field: *BrowserManager
	var _ *BrowserManager = s.browserManager
	// browserPanes field: map[int]string
	var _ map[int]string = s.browserPanes
}

// TestNewServerInitializesBrowserManager verifies that NewServer creates a
// non-nil browserManager and a non-nil browserPanes map.
func TestNewServerInitializesBrowserManager(t *testing.T) {
	s, err := NewServer(filepath.Join(t.TempDir(), "sessiond.sock"))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	if s.browserManager == nil {
		t.Fatal("browserManager is nil after NewServer")
	}
	if s.browserPanes == nil {
		t.Fatal("browserPanes is nil after NewServer")
	}
}

// TestBroadcastBrowserDataFansOut verifies that broadcastBrowserData enqueues
// a FrameBrowserData frame to every live connection.
func TestBroadcastBrowserDataFansOut(t *testing.T) {
	s, err := NewServer(filepath.Join(t.TempDir(), "sessiond.sock"))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	// Create an in-memory net.Pipe to act as a connection.
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	c := newConn(s, server)
	s.mu.Lock()
	s.conns[c] = true
	s.mu.Unlock()

	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xE0} // minimal JPEG header bytes
	s.broadcastBrowserData(42, jpeg)

	// Read from the client side: should receive a FrameBrowserData frame.
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	kind, payload, err := ReadFrame(client)
	if err != nil {
		t.Fatalf("ReadFrame: %v", err)
	}
	if kind != FrameBrowserData {
		t.Fatalf("frame kind = %d, want FrameBrowserData (%d)", kind, FrameBrowserData)
	}
	// FrameBrowserData has the same payload layout as FramePaneData.
	paneID, data := DecodePaneData(payload)
	if int(paneID) != 42 {
		t.Fatalf("paneID = %d, want 42", paneID)
	}
	if !bytes.Equal(data, jpeg) {
		t.Fatalf("data = %x, want %x", data, jpeg)
	}
}

// TestBroadcastBrowserControlAnyFansOut verifies that broadcastBrowserControlAny
// marshals msg to JSON, builds a Message with Type/PaneID/RawPayload, and
// enqueues it as a FrameControl frame to every live connection.
func TestBroadcastBrowserControlAnyFansOut(t *testing.T) {
	s, err := NewServer(filepath.Join(t.TempDir(), "sessiond.sock"))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	// Create an in-memory net.Pipe to act as a connection.
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()

	c := newConn(s, server)
	s.mu.Lock()
	s.conns[c] = true
	s.mu.Unlock()

	msg := BrowserURLMsg{
		Type:   TypeBrowserURL,
		PaneID: 7,
		URL:    "https://example.com",
	}
	s.broadcastBrowserControlAny(msg)

	// Read from the client side: should receive a FrameControl frame.
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	kind, payload, readErr := ReadFrame(client)
	if readErr != nil {
		t.Fatalf("ReadFrame: %v", readErr)
	}
	if kind != FrameControl {
		t.Fatalf("frame kind = %d, want FrameControl (%d)", kind, FrameControl)
	}

	var got Message
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("unmarshal Message: %v", err)
	}
	if got.Type != TypeBrowserURL {
		t.Fatalf("Message.Type = %q, want %q", got.Type, TypeBrowserURL)
	}
	if got.PaneID != 7 {
		t.Fatalf("Message.PaneID = %d, want 7", got.PaneID)
	}
	if got.RawPayload == nil {
		t.Fatal("Message.RawPayload is nil")
	}
	// Confirm RawPayload round-trips back to the original URL.
	var raw struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal(got.RawPayload, &raw); err != nil {
		t.Fatalf("unmarshal RawPayload: %v", err)
	}
	if raw.URL != "https://example.com" {
		t.Fatalf("RawPayload url = %q, want %q", raw.URL, "https://example.com")
	}
}
