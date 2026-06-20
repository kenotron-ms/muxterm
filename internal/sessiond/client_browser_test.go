package sessiond

import (
	"encoding/json"
	"net"
	"testing"
	"time"
)

// TestHandlersBrowserFrameField verifies the Handlers struct has OnBrowserFrame
// and OnBrowserMsg callback fields (compile-time + zero-value safety).
func TestHandlersBrowserFrameField(t *testing.T) {
	var h Handlers
	if h.OnBrowserFrame != nil {
		t.Fatal("OnBrowserFrame should be nil by default")
	}
	if h.OnBrowserMsg != nil {
		t.Fatal("OnBrowserMsg should be nil by default")
	}
	// Assign a non-nil handler and verify the fields exist and are assignable.
	h.OnBrowserFrame = func(paneID uint32, data []byte) {}
	h.OnBrowserMsg = func(msg *Message) {}
	if h.OnBrowserFrame == nil {
		t.Fatal("OnBrowserFrame should be non-nil after assignment")
	}
	if h.OnBrowserMsg == nil {
		t.Fatal("OnBrowserMsg should be non-nil after assignment")
	}
}

// TestRunDispatchesBrowserDataFrame verifies that Run() routes FrameBrowserData
// frames to the OnBrowserFrame handler.
func TestRunDispatchesBrowserDataFrame(t *testing.T) {
	type frame struct {
		paneID uint32
		data   []byte
	}
	ch := make(chan frame, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		// Send a FrameBrowserData frame: [4-byte LE paneID][JPEG body]
		_ = WriteBrowserData(conn, 7, []byte{0xFF, 0xD8, 0xDE, 0xAD})
		time.Sleep(100 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	c.SetHandlers(Handlers{
		OnBrowserFrame: func(paneID uint32, data []byte) {
			ch <- frame{paneID: paneID, data: data}
		},
	})

	go c.Run()

	select {
	case f := <-ch:
		if f.paneID != 7 {
			t.Errorf("paneID = %d, want 7", f.paneID)
		}
		want := []byte{0xFF, 0xD8, 0xDE, 0xAD}
		if len(f.data) != len(want) {
			t.Fatalf("data length = %d, want %d", len(f.data), len(want))
		}
		for i, b := range want {
			if f.data[i] != b {
				t.Errorf("data[%d] = %#x, want %#x", i, f.data[i], b)
			}
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for FrameBrowserData dispatch")
	}
}

// TestDispatchEvent_BrowserURL verifies that TypeBrowserURL events are routed
// to OnBrowserMsg.
func TestDispatchEvent_BrowserURL(t *testing.T) {
	ch := make(chan *Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		_ = WriteControl(conn, &Message{
			Type:   TypeBrowserURL,
			PaneID: 3,
		})
		time.Sleep(100 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	c.SetHandlers(Handlers{
		OnBrowserMsg: func(msg *Message) {
			ch <- msg
		},
	})

	go c.Run()

	select {
	case msg := <-ch:
		if msg.Type != TypeBrowserURL {
			t.Errorf("msg.Type = %q, want %q", msg.Type, TypeBrowserURL)
		}
		if msg.PaneID != 3 {
			t.Errorf("msg.PaneID = %d, want 3", msg.PaneID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for TypeBrowserURL event")
	}
}

// TestDispatchEvent_BrowserDownloadProgress verifies that
// TypeBrowserDownloadProgress events are routed to OnBrowserMsg.
func TestDispatchEvent_BrowserDownloadProgress(t *testing.T) {
	ch := make(chan *Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		_ = WriteControl(conn, &Message{
			Type:   TypeBrowserDownloadProgress,
			PaneID: 4,
		})
		time.Sleep(100 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	c.SetHandlers(Handlers{
		OnBrowserMsg: func(msg *Message) {
			ch <- msg
		},
	})

	go c.Run()

	select {
	case msg := <-ch:
		if msg.Type != TypeBrowserDownloadProgress {
			t.Errorf("msg.Type = %q, want %q", msg.Type, TypeBrowserDownloadProgress)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for TypeBrowserDownloadProgress event")
	}
}

// TestDispatchEvent_BrowserError verifies that TypeBrowserError events are
// routed to OnBrowserMsg.
func TestDispatchEvent_BrowserError(t *testing.T) {
	ch := make(chan *Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		_ = WriteControl(conn, &Message{
			Type:   TypeBrowserError,
			PaneID: 2,
		})
		time.Sleep(100 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	c.SetHandlers(Handlers{
		OnBrowserMsg: func(msg *Message) {
			ch <- msg
		},
	})

	go c.Run()

	select {
	case msg := <-ch:
		if msg.Type != TypeBrowserError {
			t.Errorf("msg.Type = %q, want %q", msg.Type, TypeBrowserError)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for TypeBrowserError event")
	}
}

// TestDispatchEvent_BrowserGranted verifies that TypeBrowserGranted events are
// routed to OnBrowserMsg.
func TestDispatchEvent_BrowserGranted(t *testing.T) {
	ch := make(chan *Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		_ = WriteControl(conn, &Message{
			Type:   TypeBrowserGranted,
			PaneID: 1,
		})
		time.Sleep(100 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	c.SetHandlers(Handlers{
		OnBrowserMsg: func(msg *Message) {
			ch <- msg
		},
	})

	go c.Run()

	select {
	case msg := <-ch:
		if msg.Type != TypeBrowserGranted {
			t.Errorf("msg.Type = %q, want %q", msg.Type, TypeBrowserGranted)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for TypeBrowserGranted event")
	}
}

// TestBrowserFocusSendsCorrectFrame verifies that BrowserFocus sends a
// TypeBrowserFocus control frame with the correct fields.
func TestBrowserFocusSendsCorrectFrame(t *testing.T) {
	ch := make(chan Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			if kind != FrameControl {
				continue
			}
			var req Message
			mustUnmarshal(t, payload, &req)
			if req.Type == TypeBrowserFocus {
				ch <- req
				return
			}
		}
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	if err := c.BrowserFocus(5, "client-abc", "device-xyz", 1280, 720); err != nil {
		t.Fatalf("BrowserFocus: %v", err)
	}

	select {
	case req := <-ch:
		if req.Type != TypeBrowserFocus {
			t.Errorf("Type = %q, want %q", req.Type, TypeBrowserFocus)
		}
		if req.PaneID != 5 {
			t.Errorf("PaneID = %d, want 5", req.PaneID)
		}
		if req.ClientID != "client-abc" {
			t.Errorf("ClientID = %q, want %q", req.ClientID, "client-abc")
		}
		if req.DeviceID != "device-xyz" {
			t.Errorf("DeviceID = %q, want %q", req.DeviceID, "device-xyz")
		}
		if req.RenderWidth != 1280 {
			t.Errorf("RenderWidth = %d, want 1280", req.RenderWidth)
		}
		if req.RenderHeight != 720 {
			t.Errorf("RenderHeight = %d, want 720", req.RenderHeight)
		}
		if req.CID != 0 {
			t.Errorf("CID = %d, want 0 (fire-and-forget)", req.CID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for BrowserFocus frame")
	}
}

// TestBrowserBlurSendsCorrectFrame verifies that BrowserBlur sends a
// TypeBrowserBlur control frame with the correct fields.
func TestBrowserBlurSendsCorrectFrame(t *testing.T) {
	ch := make(chan Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			if kind != FrameControl {
				continue
			}
			var req Message
			mustUnmarshal(t, payload, &req)
			if req.Type == TypeBrowserBlur {
				ch <- req
				return
			}
		}
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	if err := c.BrowserBlur(5, "client-abc", "device-xyz"); err != nil {
		t.Fatalf("BrowserBlur: %v", err)
	}

	select {
	case req := <-ch:
		if req.Type != TypeBrowserBlur {
			t.Errorf("Type = %q, want %q", req.Type, TypeBrowserBlur)
		}
		if req.PaneID != 5 {
			t.Errorf("PaneID = %d, want 5", req.PaneID)
		}
		if req.ClientID != "client-abc" {
			t.Errorf("ClientID = %q, want %q", req.ClientID, "client-abc")
		}
		if req.DeviceID != "device-xyz" {
			t.Errorf("DeviceID = %q, want %q", req.DeviceID, "device-xyz")
		}
		if req.CID != 0 {
			t.Errorf("CID = %d, want 0 (fire-and-forget)", req.CID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for BrowserBlur frame")
	}
}

// TestBrowserInputSendsCorrectFrame verifies that BrowserInput sends a
// TypeBrowserInput control frame with the raw event payload.
func TestBrowserInputSendsCorrectFrame(t *testing.T) {
	ch := make(chan Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			if kind != FrameControl {
				continue
			}
			var req Message
			mustUnmarshal(t, payload, &req)
			if req.Type == TypeBrowserInput {
				ch <- req
				return
			}
		}
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	event := json.RawMessage(`{"type":"click","x":100,"y":200}`)
	if err := c.BrowserInput(5, "client-abc", event); err != nil {
		t.Fatalf("BrowserInput: %v", err)
	}

	select {
	case req := <-ch:
		if req.Type != TypeBrowserInput {
			t.Errorf("Type = %q, want %q", req.Type, TypeBrowserInput)
		}
		if req.PaneID != 5 {
			t.Errorf("PaneID = %d, want 5", req.PaneID)
		}
		if req.ClientID != "client-abc" {
			t.Errorf("ClientID = %q, want %q", req.ClientID, "client-abc")
		}
		if string(req.InputEvent) != string(event) {
			t.Errorf("InputEvent = %s, want %s", req.InputEvent, event)
		}
		if req.CID != 0 {
			t.Errorf("CID = %d, want 0 (fire-and-forget)", req.CID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for BrowserInput frame")
	}
}
