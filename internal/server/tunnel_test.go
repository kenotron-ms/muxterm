package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// ---- TunnelRegistry unit tests ----

func TestTunnelRegistry_CreateReturnsUniqueID(t *testing.T) {
	reg := NewTunnelRegistry()
	id, err := reg.Create(3000)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if len(id) != 5 {
		t.Errorf("ID length = %d, want 5", len(id))
	}
	// ID should only contain lowercase alphanumeric chars.
	for _, ch := range id {
		if !((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
			t.Errorf("ID contains invalid char %q", ch)
		}
	}
}

func TestTunnelRegistry_Port(t *testing.T) {
	reg := NewTunnelRegistry()
	id, err := reg.Create(9000)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	port, ok := reg.Port(id)
	if !ok {
		t.Fatalf("Port(%q): not found", id)
	}
	if port != 9000 {
		t.Errorf("Port = %d, want 9000", port)
	}

	_, ok = reg.Port("nope0")
	if ok {
		t.Error("Port for unknown ID should return false")
	}
}

func TestTunnelRegistry_Close(t *testing.T) {
	reg := NewTunnelRegistry()
	id, _ := reg.Create(4000)

	// First close should succeed.
	if ok := reg.Close(id); !ok {
		t.Errorf("Close(%q) = false, want true", id)
	}
	// Second close (already removed) should return false.
	if ok := reg.Close(id); ok {
		t.Errorf("Close(%q) second call = true, want false", id)
	}
	// Port should no longer be found.
	if _, ok := reg.Port(id); ok {
		t.Errorf("Port(%q) found after Close", id)
	}
}

func TestTunnelRegistry_List(t *testing.T) {
	reg := NewTunnelRegistry()
	id1, _ := reg.Create(1111)
	id2, _ := reg.Create(2222)

	list := reg.List()
	if len(list) != 2 {
		t.Fatalf("List len = %d, want 2", len(list))
	}

	// Collect ids and ports from the list.
	found := make(map[string]int)
	for _, entry := range list {
		found[entry.id] = entry.port
	}
	if found[id1] != 1111 {
		t.Errorf("List entry for %q port = %d, want 1111", id1, found[id1])
	}
	if found[id2] != 2222 {
		t.Errorf("List entry for %q port = %d, want 2222", id2, found[id2])
	}
}

// ---- /t/{id}/ proxy route tests ----

func TestTunnelProxy_NotFound(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	req := httptest.NewRequest(http.MethodGet, "/t/notfound/", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for unknown tunnel ID", resp.StatusCode)
	}
}

func TestTunnelProxy_NoID(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	// Path without an ID segment should return 400.
	req := httptest.NewRequest(http.MethodGet, "/t/", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for missing tunnel ID", resp.StatusCode)
	}
}

func TestTunnelProxy_Found(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	// Register a tunnel with an unused port.
	id, err := srv.tunnels.Create(19998)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// No server is listening on 19998 so we expect a 502 Bad Gateway
	// (proxy handled, upstream refused) — not a 404 from the mux.
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/t/" + id + "/")
	if err != nil {
		t.Fatalf("GET /t/%s/: %v", id, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusBadRequest {
		t.Errorf("status = %d; expected proxy to handle it (502) not route to 404/400", resp.StatusCode)
	}
}

// ---- WebSocket handler tests for tunnel messages ----

func TestHandleTextInput_TypeCreateTunnel(t *testing.T) {
	hub := NewHub(nil)
	hub.tunnels = NewTunnelRegistry()

	var sentMessages [][]byte
	c := newTestClient(hub, func(data []byte) error {
		cp := make([]byte, len(data))
		copy(cp, data)
		sentMessages = append(sentMessages, cp)
		return nil
	}, func([]byte) error { return nil })
	// Wire a fake daemon so the daemon-nil guard doesn't fire.
	c.daemon = &fakeDaemonConn{}

	msg := sessiond.Message{
		Type:       sessiond.TypeCreateTunnel,
		CID:        42,
		TunnelPort: 7070,
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if len(sentMessages) == 0 {
		t.Fatal("no message sent after TypeCreateTunnel")
	}
	var reply sessiond.Message
	if err := json.Unmarshal(sentMessages[0], &reply); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	if reply.Type != sessiond.TypeTunnelCreated {
		t.Errorf("reply Type = %q, want %q", reply.Type, sessiond.TypeTunnelCreated)
	}
	if reply.CID != 42 {
		t.Errorf("reply CID = %d, want 42", reply.CID)
	}
	if reply.TunnelID == "" {
		t.Error("reply TunnelID is empty")
	}
	if reply.TunnelPort != 7070 {
		t.Errorf("reply TunnelPort = %d, want 7070", reply.TunnelPort)
	}
}

func TestHandleTextInput_TypeCloseTunnel(t *testing.T) {
	hub := NewHub(nil)
	hub.tunnels = NewTunnelRegistry()

	// Pre-create a tunnel so we have a known ID to close.
	id, err := hub.tunnels.Create(8080)
	if err != nil {
		t.Fatalf("pre-create tunnel: %v", err)
	}

	var sentMessages [][]byte
	c := newTestClient(hub, func(data []byte) error {
		cp := make([]byte, len(data))
		copy(cp, data)
		sentMessages = append(sentMessages, cp)
		return nil
	}, func([]byte) error { return nil })
	c.daemon = &fakeDaemonConn{}

	msg := sessiond.Message{
		Type:     sessiond.TypeCloseTunnel,
		CID:      55,
		TunnelID: id,
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if len(sentMessages) == 0 {
		t.Fatal("no message sent after TypeCloseTunnel")
	}
	var reply sessiond.Message
	if err := json.Unmarshal(sentMessages[0], &reply); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	if reply.Type != sessiond.TypeTunnelClosed {
		t.Errorf("reply Type = %q, want %q", reply.Type, sessiond.TypeTunnelClosed)
	}
	if reply.CID != 55 {
		t.Errorf("reply CID = %d, want 55", reply.CID)
	}
}

func TestHandleTextInput_TypeListTunnels(t *testing.T) {
	hub := NewHub(nil)
	hub.tunnels = NewTunnelRegistry()

	// Pre-create a couple of tunnels.
	_, _ = hub.tunnels.Create(1234)
	_, _ = hub.tunnels.Create(5678)

	var sentMessages [][]byte
	c := newTestClient(hub, func(data []byte) error {
		cp := make([]byte, len(data))
		copy(cp, data)
		sentMessages = append(sentMessages, cp)
		return nil
	}, func([]byte) error { return nil })
	c.daemon = &fakeDaemonConn{}

	msg := sessiond.Message{
		Type: sessiond.TypeListTunnels,
		CID:  77,
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if len(sentMessages) == 0 {
		t.Fatal("no message sent after TypeListTunnels")
	}
	var reply sessiond.Message
	if err := json.Unmarshal(sentMessages[0], &reply); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	if reply.Type != sessiond.TypeTunnelList {
		t.Errorf("reply Type = %q, want %q", reply.Type, sessiond.TypeTunnelList)
	}
	if reply.CID != 77 {
		t.Errorf("reply CID = %d, want 77", reply.CID)
	}
	if len(reply.Tunnels) != 2 {
		t.Errorf("reply Tunnels len = %d, want 2", len(reply.Tunnels))
	}
}
