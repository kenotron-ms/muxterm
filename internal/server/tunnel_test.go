package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
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
	srv := New(Config{NoAuth: true})

	req := httptest.NewRequest(http.MethodGet, "/t/notfound/", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for unknown tunnel ID", resp.StatusCode)
	}
}

func TestTunnelProxy_NoID(t *testing.T) {
	srv := New(Config{NoAuth: true})

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
	srv := New(Config{NoAuth: true})

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
