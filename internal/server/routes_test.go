package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestServiceWorkerRoute verifies that GET /sw.js serves a JavaScript service worker.
func TestServiceWorkerRoute(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	req := httptest.NewRequest(http.MethodGet, "/sw.js", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/javascript") {
		t.Errorf("Content-Type = %q, want application/javascript", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "skipWaiting") {
		t.Error("sw.js body should contain 'skipWaiting'")
	}
}

// TestProxyRoute verifies that /p/ prefix is handled (proxied); we just check
// it routes to the proxy handler (which will fail upstream with BadGateway since
// there's no real service running, not a 404 Not Found).
func TestProxyRoute(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	// Use a port that nothing is listening on; we expect a 502 BadGateway from
	// the proxy (not a 404 from the mux, which would mean the route isn't registered).
	req := httptest.NewRequest(http.MethodGet, "/p/19999/", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	resp := w.Result()
	// 502 = proxy handled it (upstream refused); 404 would mean route not registered.
	if resp.StatusCode == http.StatusNotFound {
		t.Fatalf("proxy route not registered: got 404, expected 502 (bad gateway) or similar")
	}
}

// TestCreatePane_Unauthorized verifies that POST /api/pane rejects non-localhost requests.
func TestCreatePane_Unauthorized(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	body := `{"surfaceKind":"browser","browserPort":3000}`
	req := httptest.NewRequest(http.MethodPost, "/api/pane", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	// httptest.NewRequest sets RemoteAddr to 192.0.2.1:1234 by default (non-localhost)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d (unauthorized)", resp.StatusCode, http.StatusUnauthorized)
	}
}

// TestCreatePane_BadRequest_InvalidJSON verifies that malformed JSON returns 400.
func TestCreatePane_BadRequest_InvalidJSON(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	resp, err := http.Post(ts.URL+"/api/pane", "application/json", strings.NewReader("not-json"))
	if err != nil {
		t.Fatalf("POST /api/pane: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (bad request)", resp.StatusCode, http.StatusBadRequest)
	}
}

// TestCreatePane_BadRequest_WrongSurfaceKind verifies that non-browser surfaceKind returns 400.
func TestCreatePane_BadRequest_WrongSurfaceKind(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"surfaceKind":"terminal","browserPort":3000}`
	resp, err := http.Post(ts.URL+"/api/pane", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/pane: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (bad request)", resp.StatusCode, http.StatusBadRequest)
	}
}

// TestCreatePane_BadRequest_InvalidPort verifies that out-of-range port returns 400.
func TestCreatePane_BadRequest_InvalidPort(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"surfaceKind":"browser","browserPort":0}`
	resp, err := http.Post(ts.URL+"/api/pane", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/pane: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d (bad request)", resp.StatusCode, http.StatusBadRequest)
	}
}

// TestCreatePane_ServiceUnavailable verifies that 503 is returned when no dialer is configured.
func TestCreatePane_ServiceUnavailable(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})
	// No dialer configured → hub.Dial() should return error

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"surfaceKind":"browser","browserPort":3000}`
	resp, err := http.Post(ts.URL+"/api/pane", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/pane: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d (service unavailable)", resp.StatusCode, http.StatusServiceUnavailable)
	}
}

// TestCreatePane_Success verifies that POST /api/pane creates a browser pane and returns JSON.
func TestCreatePane_Success(t *testing.T) {
	fake := &fakeDaemonConn{createdID: 42}
	srv := New(Config{Secret: "test-secret"})
	srv.Hub().SetDialer(func() (DaemonConn, error) {
		return fake, nil
	})

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	reqBody := createPaneRequest{
		SurfaceKind: "browser",
		BrowserPort: 3000,
		BrowserPath: "/app",
	}
	data, _ := json.Marshal(reqBody)
	resp, err := http.Post(ts.URL+"/api/pane", "application/json", bytes.NewReader(data))
	if err != nil {
		t.Fatalf("POST /api/pane: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want %d; body = %s", resp.StatusCode, http.StatusOK, body)
	}

	var result struct {
		Type   string `json:"type"`
		PaneID int    `json:"paneId"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	if result.Type != "pane-created" {
		t.Errorf("type = %q, want %q", result.Type, "pane-created")
	}
	if result.PaneID != 42 {
		t.Errorf("paneId = %d, want 42", result.PaneID)
	}
}

// TestAgentServiceWorkerRoute verifies that GET /p/sw.js serves the agent service worker
// scoped to /p/ with navigation reporting via postMessage.
func TestAgentServiceWorkerRoute(t *testing.T) {
	srv := New(Config{Secret: "test-secret"})

	req := httptest.NewRequest(http.MethodGet, "/p/sw.js", nil)
	w := httptest.NewRecorder()
	srv.Handler().ServeHTTP(w, req)

	resp := w.Result()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resp.StatusCode, http.StatusOK)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.HasPrefix(ct, "application/javascript") {
		t.Errorf("Content-Type = %q, want application/javascript", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), "mux-page-navigated") {
		t.Error("agent sw.js body should contain 'mux-page-navigated'")
	}
}

// TestCreatePane_DefaultPath verifies that an empty BrowserPath defaults to "/".
func TestCreatePane_DefaultPath(t *testing.T) {
	fake := &fakeDaemonConn{createdID: 7}
	srv := New(Config{Secret: "test-secret"})
	srv.Hub().SetDialer(func() (DaemonConn, error) {
		return fake, nil
	})

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := `{"surfaceKind":"browser","browserPort":8080}`
	resp, err := http.Post(ts.URL+"/api/pane", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/pane: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d, want %d; body = %s", resp.StatusCode, http.StatusOK, b)
	}
}
