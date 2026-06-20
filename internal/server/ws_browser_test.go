package server

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// TestBroadcastBrowserFrameCachesLastFrame verifies that BroadcastBrowserFrame
// stores the most-recently-broadcast encoded frame in hub.lastBrowserFrames
// so that a reconnecting client can receive it immediately on connect.
func TestBroadcastBrowserFrameCachesLastFrame(t *testing.T) {
	hub := NewHub(nil)
	jpeg := []byte{0xFF, 0xD8, 0xFF, 0xE0} // minimal JPEG header stub

	hub.BroadcastBrowserFrame(42, jpeg)

	hub.browserMu.RLock()
	cached, ok := hub.lastBrowserFrames[42]
	hub.browserMu.RUnlock()

	if !ok {
		t.Fatal("expected lastBrowserFrames[42] to be set after BroadcastBrowserFrame, but was not")
	}
	want := EncodeBinaryFrame(42, jpeg)
	if !bytes.Equal(cached, want) {
		t.Errorf("lastBrowserFrames[42] = %v, want %v", cached, want)
	}
}

// TestBroadcastBrowserFrameUpdatesCache verifies that a second broadcast for
// the same pane overwrites the previous cached frame with the newer data.
func TestBroadcastBrowserFrameUpdatesCache(t *testing.T) {
	hub := NewHub(nil)

	hub.BroadcastBrowserFrame(7, []byte{0x01})
	hub.BroadcastBrowserFrame(7, []byte{0x02, 0x03})

	hub.browserMu.RLock()
	cached := hub.lastBrowserFrames[7]
	hub.browserMu.RUnlock()

	want := EncodeBinaryFrame(7, []byte{0x02, 0x03})
	if !bytes.Equal(cached, want) {
		t.Errorf("lastBrowserFrames[7] after second broadcast = %v, want %v", cached, want)
	}
}

// TestBroadcastBrowserFrameTracksMultiplePanes verifies that frames for
// different panes are stored independently.
func TestBroadcastBrowserFrameTracksMultiplePanes(t *testing.T) {
	hub := NewHub(nil)

	hub.BroadcastBrowserFrame(1, []byte{0xAA})
	hub.BroadcastBrowserFrame(2, []byte{0xBB})

	hub.browserMu.RLock()
	c1 := hub.lastBrowserFrames[1]
	c2 := hub.lastBrowserFrames[2]
	hub.browserMu.RUnlock()

	if !bytes.Equal(c1, EncodeBinaryFrame(1, []byte{0xAA})) {
		t.Errorf("pane 1 frame = %v, want encoded {0xAA}", c1)
	}
	if !bytes.Equal(c2, EncodeBinaryFrame(2, []byte{0xBB})) {
		t.Errorf("pane 2 frame = %v, want encoded {0xBB}", c2)
	}
}

// TestCloseBrowserPaneClearsFrameCache verifies that handling a
// TypeCloseBrowserPane message removes the pane's entry from lastBrowserFrames,
// so stale frames are never replayed to clients connecting after the pane is gone.
func TestCloseBrowserPaneClearsFrameCache(t *testing.T) {
	fake := &fakeDaemonConn{}
	hub := newTestHub(fake)
	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)
	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	// Pre-populate the cache as if frames had been received for pane 5.
	hub.BroadcastBrowserFrame(5, []byte{0xAB, 0xCD})

	hub.browserMu.RLock()
	_, before := hub.lastBrowserFrames[5]
	hub.browserMu.RUnlock()
	if !before {
		t.Fatal("precondition failed: expected frame cache to be populated before pane close")
	}

	// Send TypeCloseBrowserPane — should clear the cache entry for pane 5.
	msg, _ := json.Marshal(map[string]any{
		"type":   sessiond.TypeCloseBrowserPane,
		"paneId": 5,
		"cid":    1,
	})
	c.handleTextInput(msg)

	hub.browserMu.RLock()
	_, after := hub.lastBrowserFrames[5]
	hub.browserMu.RUnlock()
	if after {
		t.Fatal("expected lastBrowserFrames[5] to be cleared after TypeCloseBrowserPane, but entry still present")
	}
}
