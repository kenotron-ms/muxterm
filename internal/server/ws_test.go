package server

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/user/muxterm/internal/tmux"
)

// sendKeysCall records a single SendKeys invocation.
type sendKeysCall struct {
	PaneID string
	Data   []byte
}

// commandCall records a single command invocation.
type commandCall struct {
	Method string
	Args   []interface{}
}

// mockEngine satisfies TmuxEngine with static TmuxState.
type mockEngine struct {
	state         *tmux.TmuxState
	sendKeysCalls []sendKeysCall
	commandCalls  []commandCall
	mu            sync.Mutex
}

func newMockEngine() *mockEngine {
	return &mockEngine{
		state: &tmux.TmuxState{
			ActiveSessionID: "dev",
			Sessions: []tmux.Session{
				{
					ID:   "dev",
					Name: "dev",
					Windows: []tmux.Window{
						{
							ID:     "@1",
							Name:   "shell",
							Active: true,
							Panes: []tmux.Pane{
								{ID: "%1", Width: 80, Height: 24, Active: true},
							},
						},
					},
				},
			},
		},
	}
}

func (m *mockEngine) State() *tmux.TmuxState { return m.state }
func (m *mockEngine) SendKeys(paneID, keys string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	dataCopy := make([]byte, len(keys))
	copy(dataCopy, []byte(keys))
	m.sendKeysCalls = append(m.sendKeysCalls, sendKeysCall{PaneID: paneID, Data: dataCopy})
	return nil
}
func (m *mockEngine) getSendKeysCalls() []sendKeysCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]sendKeysCall, len(m.sendKeysCalls))
	copy(out, m.sendKeysCalls)
	return out
}
func (m *mockEngine) SelectWindow(windowID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "SelectWindow", Args: []interface{}{windowID}})
	return nil
}
func (m *mockEngine) SelectPane(paneID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "SelectPane", Args: []interface{}{paneID}})
	return nil
}
func (m *mockEngine) SplitWindow(targetPaneID string, horizontal bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "SplitWindow", Args: []interface{}{targetPaneID, horizontal}})
	return nil
}
func (m *mockEngine) ResizePane(paneID string, cols, rows int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "ResizePane", Args: []interface{}{paneID, cols, rows}})
	return nil
}
func (m *mockEngine) NewWindow(sessionID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "NewWindow", Args: []interface{}{sessionID}})
	return nil
}
func (m *mockEngine) KillPane(paneID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "KillPane", Args: []interface{}{paneID}})
	return nil
}
func (m *mockEngine) CloseWindow(windowID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "CloseWindow", Args: []interface{}{windowID}})
	return nil
}
func (m *mockEngine) RenameWindow(windowID, name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "RenameWindow", Args: []interface{}{windowID, name}})
	return nil
}
func (m *mockEngine) NewSession(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "NewSession", Args: []interface{}{name}})
	return nil
}

func (m *mockEngine) CapturePaneContent(_ string) ([]byte, error) { return nil, nil }
func (m *mockEngine) LiveState() (*tmux.TmuxState, error)         { return m.state, nil }
func (m *mockEngine) AttachSession(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.commandCalls = append(m.commandCalls, commandCall{Method: "AttachSession", Args: []interface{}{name}})
	return nil
}
func (m *mockEngine) SessionList() []SessionInfo {
	return []SessionInfo{{Name: "dev", Windows: 1}}
}
func (m *mockEngine) getCommandCalls() []commandCall {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]commandCall, len(m.commandCalls))
	copy(out, m.commandCalls)
	return out
}

// testEnv bundles a mock engine, server, and httptest server for WS tests.
type testEnv struct {
	engine *mockEngine
	srv    *Server
	ts     *httptest.Server
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	engine := newMockEngine()
	srv := New(Config{Secret: "test-secret"}, engine)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &testEnv{engine: engine, srv: srv, ts: ts}
}

func TestWebSocketConnect(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// httptest.Server listens on 127.0.0.1 so IsLocalhost passes
	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Give the server a moment to register the client
	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 1 {
		t.Fatalf("ClientCount = %d, want 1", got)
	}
}

func TestWebSocketDisconnect(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}

	// Give the server a moment to register the client
	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 1 {
		t.Fatalf("ClientCount after connect = %d, want 1", got)
	}

	// Close with normal closure
	conn.Close(websocket.StatusNormalClosure, "bye")

	// Give the server a moment to process the disconnect
	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 0 {
		t.Fatalf("ClientCount after disconnect = %d, want 0", got)
	}
}

func TestEncodeBinaryFrame(t *testing.T) {
	frame := EncodeBinaryFrame(5, []byte("hello"))

	if len(frame) != 9 {
		t.Fatalf("frame length = %d, want 9", len(frame))
	}

	// Verify LE bytes for pane ID 5: [5, 0, 0, 0]
	expectedHeader := []byte{5, 0, 0, 0}
	if !bytes.Equal(frame[:4], expectedHeader) {
		t.Fatalf("frame header = %v, want %v", frame[:4], expectedHeader)
	}

	if !bytes.Equal(frame[4:], []byte("hello")) {
		t.Fatalf("frame data = %q, want %q", frame[4:], "hello")
	}
}

func TestDecodeBinaryFrame(t *testing.T) {
	original := []byte("world")
	var paneID uint32 = 42

	frame := EncodeBinaryFrame(paneID, original)
	gotID, gotData, err := DecodeBinaryFrame(frame)
	if err != nil {
		t.Fatalf("DecodeBinaryFrame: %v", err)
	}
	if gotID != paneID {
		t.Fatalf("pane ID = %d, want %d", gotID, paneID)
	}
	if !bytes.Equal(gotData, original) {
		t.Fatalf("data = %q, want %q", gotData, original)
	}
}

func TestDecodeBinaryFrame_TooShort(t *testing.T) {
	_, _, err := DecodeBinaryFrame([]byte{0x01, 0x02})
	if err == nil {
		t.Fatal("expected error for 2-byte frame, got nil")
	}
}

func TestPaneIDConversion(t *testing.T) {
	// String to uint32
	id, err := PaneIDToUint32("%7")
	if err != nil {
		t.Fatalf("PaneIDToUint32(%%7): %v", err)
	}
	if id != 7 {
		t.Fatalf("PaneIDToUint32(%%7) = %d, want 7", id)
	}

	// uint32 to string
	s := Uint32ToPaneID(7)
	if s != "%7" {
		t.Fatalf("Uint32ToPaneID(7) = %q, want %%7", s)
	}
}

// keysOf returns sorted keys of a map for error messages.
func keysOf(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func TestBroadcastPaneOutput(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Consume connect messages: full-sync + session-list
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (full-sync): %v", err)
	}
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (session-list): %v", err)
	}

	// Broadcast pane output for pane %5
	env.srv.Hub().BroadcastPaneOutput("%5", []byte("ls\n"))

	// Read binary frame from client
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read: %v", err)
	}
	if msgType != websocket.MessageBinary {
		t.Fatalf("message type = %v, want Binary", msgType)
	}

	// Decode and verify
	gotID := binary.LittleEndian.Uint32(data[:4])
	if gotID != 5 {
		t.Fatalf("pane ID = %d, want 5", gotID)
	}
	if !bytes.Equal(data[4:], []byte("ls\n")) {
		t.Fatalf("data = %q, want %q", data[4:], "ls\n")
	}
}

func TestStateSyncOnConnect(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Read first message — should be the state sync
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read: %v", err)
	}
	if msgType != websocket.MessageText {
		t.Fatalf("message type = %v, want Text", msgType)
	}

	// Unmarshal to map[string]json.RawMessage
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	// Assert 'full-sync' key exists (on-connect sync uses "full-sync";
	// the "state" key is reserved for periodic syncs).
	stateRaw, ok := msg["full-sync"]
	if !ok {
		t.Fatalf("message has no 'full-sync' key, got keys: %v", keysOf(msg))
	}

	// Unmarshal state to tmux.TmuxState
	var state tmux.TmuxState
	if err := json.Unmarshal(stateRaw, &state); err != nil {
		t.Fatalf("json.Unmarshal state: %v", err)
	}

	if state.ActiveSessionID != "dev" {
		t.Fatalf("ActiveSessionID = %q, want %q", state.ActiveSessionID, "dev")
	}
	if len(state.Sessions) != 1 {
		t.Fatalf("Sessions count = %d, want 1", len(state.Sessions))
	}
}

func TestBroadcastEvent(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Consume connect messages: full-sync + session-list
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (full-sync): %v", err)
	}
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (session-list): %v", err)
	}

	// Broadcast an event
	env.srv.Hub().BroadcastEvent("window-add", map[string]string{"id": "@3", "name": "vim"})

	// Read text frame
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read: %v", err)
	}
	if msgType != websocket.MessageText {
		t.Fatalf("message type = %v, want Text", msgType)
	}

	// Unmarshal and assert 'window-add' key
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	if _, ok := msg["window-add"]; !ok {
		t.Fatalf("message has no 'window-add' key, got keys: %v", keysOf(msg))
	}
}

func TestMultipleClients(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"

	conn1, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial #1: %v", err)
	}
	defer conn1.CloseNow()

	conn2, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial #2: %v", err)
	}
	defer conn2.CloseNow()

	// Give the server a moment to register both clients
	time.Sleep(100 * time.Millisecond)

	if got := env.srv.Hub().ClientCount(); got != 2 {
		t.Fatalf("ClientCount = %d, want 2", got)
	}
}

func TestBinaryInputRouting(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Give the server a moment to register the client
	time.Sleep(100 * time.Millisecond)

	// Build a binary frame for pane 3 with payload "ls\n"
	frame := EncodeBinaryFrame(3, []byte("ls\n"))

	// Write binary message to server
	err = conn.Write(ctx, websocket.MessageBinary, frame)
	if err != nil {
		t.Fatalf("conn.Write: %v", err)
	}

	// Give the server a moment to process the message
	time.Sleep(100 * time.Millisecond)

	// Assert engine.getSendKeysCalls() has exactly 1 call
	calls := env.engine.getSendKeysCalls()
	if len(calls) != 1 {
		t.Fatalf("SendKeys call count = %d, want 1", len(calls))
	}
	if calls[0].PaneID != "%3" {
		t.Fatalf("SendKeys PaneID = %q, want %%3", calls[0].PaneID)
	}
	if !bytes.Equal(calls[0].Data, []byte("ls\n")) {
		t.Fatalf("SendKeys Data = %q, want %q", calls[0].Data, "ls\n")
	}
}

func TestSelectWindowAction(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Consume state sync
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (state sync): %v", err)
	}

	// Send select-window action
	err = conn.Write(ctx, websocket.MessageText, []byte(`{"select-window":"@3"}`))
	if err != nil {
		t.Fatalf("conn.Write: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	calls := env.engine.getCommandCalls()
	if len(calls) != 1 {
		t.Fatalf("command call count = %d, want 1", len(calls))
	}
	if calls[0].Method != "SelectWindow" {
		t.Fatalf("method = %q, want SelectWindow", calls[0].Method)
	}
	if calls[0].Args[0] != "@3" {
		t.Fatalf("arg = %v, want @3", calls[0].Args[0])
	}
}

func TestNewWindowAction(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Consume state sync
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (state sync): %v", err)
	}

	// Send new-window action
	err = conn.Write(ctx, websocket.MessageText, []byte(`{"new-window":{}}`))
	if err != nil {
		t.Fatalf("conn.Write: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	calls := env.engine.getCommandCalls()
	if len(calls) != 1 {
		t.Fatalf("command call count = %d, want 1", len(calls))
	}
	if calls[0].Method != "NewWindow" {
		t.Fatalf("method = %q, want NewWindow", calls[0].Method)
	}
}

func TestResizePaneAction(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Consume state sync
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (state sync): %v", err)
	}

	// Send resize-pane action
	err = conn.Write(ctx, websocket.MessageText, []byte(`{"resize-pane":{"id":"%5","cols":100,"rows":40}}`))
	if err != nil {
		t.Fatalf("conn.Write: %v", err)
	}

	time.Sleep(100 * time.Millisecond)

	calls := env.engine.getCommandCalls()
	found := false
	for _, c := range calls {
		if c.Method == "ResizePane" && len(c.Args) > 0 && c.Args[0] == "%5" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("ResizePane not called with '%%5', got calls: %v", calls)
	}
}

func TestEngineInterface_AttachAndList(t *testing.T) {
	m := newMockEngine()
	var eng TmuxEngine = m // compile-time interface satisfaction check
	err := eng.AttachSession("ops")
	if err != nil {
		t.Fatalf("AttachSession: unexpected error: %v", err)
	}
	sessions := eng.SessionList()
	if len(sessions) == 0 {
		t.Fatal("SessionList returned empty slice")
	}
}

func TestBuildSessionListMessage(t *testing.T) {
	m := newMockEngine()
	hub := NewHub(m)

	data, err := hub.sessionListJSON()
	if err != nil {
		t.Fatalf("sessionListJSON() error: %v", err)
	}
	if data == nil {
		t.Fatal("sessionListJSON() returned nil data")
	}

	var msg map[string]SessionListMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}

	list, ok := msg["session-list"]
	if !ok {
		t.Fatal("response has no 'session-list' key")
	}
	if len(list.Sessions) == 0 {
		t.Fatal("Sessions is empty")
	}
	if list.Sessions[0].Name != "dev" {
		t.Errorf("Sessions[0].Name = %q, want %q", list.Sessions[0].Name, "dev")
	}
}

func TestDispatchAction_AttachSession(t *testing.T) {
	m := newMockEngine()
	hub := NewHub(m)

	err := hub.dispatchAction("attach-session", json.RawMessage(`"ops"`))
	if err != nil {
		t.Fatalf("dispatchAction returned error: %v", err)
	}

	calls := m.getCommandCalls()
	for _, c := range calls {
		if c.Method == "AttachSession" && len(c.Args) > 0 && c.Args[0] == "ops" {
			return // found expected call
		}
	}
	t.Fatalf("AttachSession(\"ops\") not found in command calls: %v", calls)
}

func TestInvalidAction(t *testing.T) {
	env := newTestEnv(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + env.ts.URL[len("http"):] + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.CloseNow()

	// Consume connect messages: full-sync + session-list
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (full-sync): %v", err)
	}
	_, _, err = conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read (session-list): %v", err)
	}

	// Send invalid text
	err = conn.Write(ctx, websocket.MessageText, []byte("not json"))
	if err != nil {
		t.Fatalf("conn.Write: %v", err)
	}

	// Read error response
	msgType, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("conn.Read: %v", err)
	}
	if msgType != websocket.MessageText {
		t.Fatalf("message type = %v, want Text", msgType)
	}

	var msg map[string]json.RawMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if _, ok := msg["error"]; !ok {
		t.Fatalf("message has no 'error' key, got keys: %v", keysOf(msg))
	}
}
