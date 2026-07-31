package server

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// newTestHub builds a Hub whose dialer always returns the supplied DaemonConn,
// so a per-browser attach binds to the test double instead of a real socket.
func newTestHub(dc DaemonConn) *Hub {
	return NewHub(func() (DaemonConn, error) { return dc, nil })
}

// decodeMsg unmarshals a frozen sessiond.Message from a relayed text frame.
func decodeMsg(data []byte) sessiond.Message {
	var m sessiond.Message
	_ = json.Unmarshal(data, &m)
	return m
}

// firstOfType returns the first relayed message whose Type matches typ.
func firstOfType(msgs [][]byte, typ string) (sessiond.Message, bool) {
	for _, raw := range msgs {
		m := decodeMsg(raw)
		if m.Type == typ {
			return m, true
		}
	}
	return sessiond.Message{}, false
}

// newTestClient builds a Client whose writers are captured by wt/wb instead of
// a real WebSocket connection.
func newTestClient(hub *Hub, wt, wb func([]byte) error) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	return &Client{
		hub:           hub,
		ctx:           ctx,
		cancel:        cancel,
		writeTextFn:   wt,
		writeBinaryFn: wb,
	}
}

// capture collects the text and binary frames a Client writes.
type capture struct {
	mu      sync.Mutex
	textMsg [][]byte
	binMsg  [][]byte
}

func (c *capture) text(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	c.textMsg = append(c.textMsg, cp)
	return nil
}

func (c *capture) binary(data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make([]byte, len(data))
	copy(cp, data)
	c.binMsg = append(c.binMsg, cp)
	return nil
}

func (c *capture) texts() [][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([][]byte, len(c.textMsg))
	copy(out, c.textMsg)
	return out
}

func (c *capture) lastBinary() ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.binMsg) == 0 {
		return nil, false
	}
	return c.binMsg[len(c.binMsg)-1], true
}

func TestAttachRelaysCompositionAndOutput(t *testing.T) {
	fake := &fakeDaemonConn{createdID: 9}
	hub := newTestHub(fake)
	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)

	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	c.handleTextInput([]byte(`{"type":"attach","cid":11,"workspaceId":"w1"}`))

	if fake.attached != "w1" {
		t.Fatalf("fake.attached = %q, want %q", fake.attached, "w1")
	}

	comp, ok := firstOfType(cap.texts(), sessiond.TypeComposition)
	if !ok {
		t.Fatalf("no composition message relayed")
	}
	if comp.CID != 11 {
		t.Errorf("composition CID = %d, want 11 (echoed)", comp.CID)
	}
	if comp.WorkspaceID != "w1" {
		t.Errorf("composition WorkspaceID = %q, want w1", comp.WorkspaceID)
	}
	if len(comp.Panes) != 1 {
		t.Fatalf("composition Panes = %d, want 1", len(comp.Panes))
	}

	// Pane output relays as a binary frame.
	fake.handlers.OnPaneOutput(1, []byte("hi"))
	raw, ok := cap.lastBinary()
	if !ok {
		t.Fatalf("no binary frame relayed for pane output")
	}
	paneID, payload, err := DecodeBinaryFrame(raw)
	if err != nil {
		t.Fatalf("DecodeBinaryFrame: %v", err)
	}
	if paneID != 1 || string(payload) != "hi" {
		t.Errorf("decoded frame = (%d, %q), want (1, \"hi\")", paneID, payload)
	}

	// Lifecycle events relay as frozen messages.
	fake.handlers.OnPaneAdded(sessiond.PaneInfo{PaneID: 2, Cols: 80, Rows: 24})
	added, ok := firstOfType(cap.texts(), sessiond.TypePaneAdded)
	if !ok {
		t.Fatalf("no pane-added message relayed")
	}
	if added.PaneID != 2 {
		t.Errorf("pane-added PaneID = %d, want 2", added.PaneID)
	}
}

func TestBrowserInputAndResizeReachDaemon(t *testing.T) {
	fake := &fakeDaemonConn{}
	hub := newTestHub(fake)
	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)

	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	c.handleBinaryInput(EncodeBinaryFrame(3, []byte("ls\r")))
	if len(fake.inputs) != 1 || fake.inputs[0] != "ls\r" {
		t.Fatalf("fake.inputs = %v, want [\"ls\\r\"]", fake.inputs)
	}

	c.handleTextInput([]byte(`{"type":"resize","paneId":3,"cols":120,"rows":30}`))
	if len(fake.resizes) != 1 || fake.resizes[0] != [3]int{3, 120, 30} {
		t.Fatalf("fake.resizes = %v, want [[3 120 30]]", fake.resizes)
	}
}

// errDaemonConn returns an unknown-workspace DaemonError on Attach.
type errDaemonConn struct {
	*fakeDaemonConn
}

func (e *errDaemonConn) Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error) {
	return sessiond.Composition{}, &sessiond.DaemonError{
		Code:        sessiond.CodeUnknownWorkspace,
		Err:         "no such workspace",
		WorkspaceID: "gone",
	}
}

func TestUnknownWorkspaceErrorPreservesCode(t *testing.T) {
	fake := &errDaemonConn{fakeDaemonConn: &fakeDaemonConn{}}
	hub := newTestHub(fake)
	cap := &capture{}
	c := newTestClient(hub, cap.text, cap.binary)

	if err := hub.attachClient(c); err != nil {
		t.Fatalf("attachClient: %v", err)
	}

	c.handleTextInput([]byte(`{"type":"attach","cid":7,"workspaceId":"gone"}`))

	errMsg, ok := firstOfType(cap.texts(), sessiond.TypeError)
	if !ok {
		t.Fatalf("no error message relayed")
	}
	if errMsg.Code != sessiond.CodeUnknownWorkspace {
		t.Errorf("error Code = %q, want %q", errMsg.Code, sessiond.CodeUnknownWorkspace)
	}
	if errMsg.CID != 7 {
		t.Errorf("error CID = %d, want 7 (echoed)", errMsg.CID)
	}
}
