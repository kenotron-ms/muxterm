// Command realtimefixture is a loopback-only TLS provider-edge fixture for the
// Mission Control backend protocol driver. It is not an audio, WebRTC, or
// browser-negotiation fixture: its SDP answer is explicitly protocol-only.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	prefix       = "/openai/v1"
	controlPath  = "/__fixture/control"
	maxEventSize = 32 << 10
)

type call struct {
	id       string
	secret   string
	conn     *websocket.Conn
	commands []command
}

type command struct {
	Type         string            `json:"type"`
	MetadataKeys []string          `json:"metadata_keys,omitempty"`
	Metadata     map[string]string `json:"metadata,omitempty"`
}

type fixture struct {
	mu       sync.Mutex
	next     uint64
	sessions map[string]string // ephemeral secret -> provider session ID
	calls    map[string]*call
	evidence string
}

func (f *fixture) id(kind string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	return fmt.Sprintf("%s_fixture_%d", kind, f.next)
}

func (f *fixture) writeEvidence() {
	if f.evidence == "" {
		return
	}
	f.mu.Lock()
	out := struct {
		Format string `json:"format"`
		Calls  []struct {
			ID        string    `json:"id"`
			Connected bool      `json:"connected"`
			Commands  []command `json:"commands"`
			CommandN  int       `json:"command_count"`
		} `json:"calls"`
	}{Format: "missioncontrol-realtime-fixture-v1"}
	for _, c := range f.calls {
		row := struct {
			ID        string    `json:"id"`
			Connected bool      `json:"connected"`
			Commands  []command `json:"commands"`
			CommandN  int       `json:"command_count"`
		}{ID: c.id, Connected: c.conn != nil, Commands: append([]command(nil), c.commands...), CommandN: len(c.commands)}
		out.Calls = append(out.Calls, row)
	}
	f.mu.Unlock()
	data, _ := json.MarshalIndent(out, "", "  ")
	tmp := f.evidence + ".tmp"
	_ = os.WriteFile(tmp, append(data, '\n'), 0o600)
	_ = os.Rename(tmp, f.evidence)
}

func bearer(r *http.Request) string {
	const p = "Bearer "
	v := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(v, p) {
		return strings.TrimSpace(strings.TrimPrefix(v, p))
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func metadata(value any) (map[string]string, []string) {
	response, _ := value.(map[string]any)["response"].(map[string]any)
	meta, _ := response["metadata"].(map[string]any)
	out := make(map[string]string, len(meta))
	keys := make([]string, 0, len(meta))
	for k, v := range meta {
		keys = append(keys, k)
		if text, ok := v.(string); ok {
			out[k] = text
		}
	}
	return out, keys
}

func (f *fixture) mint(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
		return
	}
	// Deliberately consume but never retain the server-owned instructions/tools.
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, maxEventSize)).Decode(&map[string]any{})
	secretBytes := make([]byte, 18)
	_, _ = rand.Read(secretBytes)
	secret := "ephemeral_fixture_" + hex.EncodeToString(secretBytes)
	sessionID := f.id("session")
	f.mu.Lock()
	f.sessions[secret] = sessionID
	f.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{
		"value": secret, "expires_at": time.Now().Add(5 * time.Minute).Unix(),
		"session": map[string]any{"id": sessionID},
	})
}

func (f *fixture) sdp(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || bearer(r) == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "ephemeral bearer required"})
		return
	}
	f.mu.Lock()
	_, valid := f.sessions[bearer(r)]
	f.mu.Unlock()
	if !valid {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unknown ephemeral bearer"})
		return
	}
	callID := f.id("call")
	f.mu.Lock()
	f.calls[callID] = &call{id: callID, secret: bearer(r)}
	f.mu.Unlock()
	// This is intentionally not proof of a browser WebRTC negotiation.
	w.Header().Set("Location", "https://"+r.Host+prefix+"/realtime/calls/"+callID)
	w.Header().Set("Content-Type", "application/sdp")
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte("v=0\r\no=realtimefixture 0 0 IN IP4 127.0.0.1\r\ns=PROTOCOL_FIXTURE_NOT_WEBRTC_PROOF\r\nt=0 0\r\n"))
	f.writeEvidence()
}

func (f *fixture) realtime(w http.ResponseWriter, r *http.Request) {
	callID := r.URL.Query().Get("call_id")
	f.mu.Lock()
	c := f.calls[callID]
	valid := c != nil && bearer(r) != "" && bearer(r) == c.secret
	f.mu.Unlock()
	if !valid {
		http.Error(w, "unknown call or bearer", http.StatusUnauthorized)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"localhost", "127.0.0.1", "[::1]"}})
	if err != nil {
		return
	}
	f.mu.Lock()
	c.conn = conn
	f.mu.Unlock()
	_ = f.send(c, map[string]any{"type": "session.created", "session": map[string]any{"id": "fixture-sideband-session"}})
	_ = f.send(c, map[string]any{"type": "session.updated", "session": map[string]any{"type": "realtime"}})
	f.writeEvidence()
	defer func() {
		f.mu.Lock()
		if c.conn == conn {
			c.conn = nil
		}
		f.mu.Unlock()
		_ = conn.Close(websocket.StatusNormalClosure, "")
		f.writeEvidence()
	}()
	for {
		typ, data, err := conn.Read(r.Context())
		if err != nil || typ != websocket.MessageText {
			return
		}
		var message map[string]any
		if json.Unmarshal(data, &message) != nil {
			continue
		}
		kind, _ := message["type"].(string)
		f.mu.Lock()
		meta, keys := metadata(message)
		c.commands = append(c.commands, command{Type: kind, MetadataKeys: keys, Metadata: meta})
		f.mu.Unlock()
		f.writeEvidence()
	}
}

func (f *fixture) send(c *call, event map[string]any) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if len(data) > maxEventSize {
		return errors.New("fixture event exceeds bound")
	}
	f.mu.Lock()
	conn := c.conn
	f.mu.Unlock()
	if conn == nil {
		return errors.New("sideband is not connected")
	}
	ctx, cancel := contextWithTimeout()
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}

func contextWithTimeout() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 5*time.Second)
}

func (f *fixture) control(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "POST required"})
		return
	}
	var request struct {
		Operation string         `json:"operation"`
		CallID    string         `json:"call_id"`
		Event     map[string]any `json:"event"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxEventSize)).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bounded JSON required"})
		return
	}
	f.mu.Lock()
	c := f.calls[request.CallID]
	f.mu.Unlock()
	if c == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown fixture call"})
		return
	}
	switch request.Operation {
	case "inspect":
		f.mu.Lock()
		reply := map[string]any{"call_id": c.id, "connected": c.conn != nil, "commands": append([]command(nil), c.commands...)}
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, reply)
	case "inject":
		if request.Event == nil || request.Event["type"] == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "event.type required"})
			return
		}
		if err := f.send(c, request.Event); err != nil {
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	case "close":
		f.mu.Lock()
		conn := c.conn
		f.mu.Unlock()
		if conn != nil {
			_ = conn.Close(websocket.StatusGoingAway, "fixture transport unavailable")
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "operation must be inspect, inject, or close"})
	}
	f.writeEvidence()
}

func loopback(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

func main() {
	listen := flag.String("listen", "", "required loopback host:port")
	cert := flag.String("cert", "", "required TLS certificate PEM")
	key := flag.String("key", "", "required TLS private-key PEM")
	evidence := flag.String("evidence", "", "required private absolute evidence JSON path outside this repository")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: realtimefixture --listen <loopback:port> --cert <pem> --key <pem> --evidence <absolute-private-json>")
		fmt.Fprintln(os.Stderr, "BACKEND_PROTOCOL_ONLY: TLS is required. Supply a CA trusted by the prepared muxterm server.")
		fmt.Fprintln(os.Stderr, "The SDP response is a provider protocol fixture, never browser/WebRTC/audio proof.")
		flag.PrintDefaults()
	}
	flag.Parse()
	wd, _ := os.Getwd()
	rel, relErr := filepath.Rel(wd, *evidence)
	inRepository := relErr == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
	if *listen == "" || !loopback(*listen) || *cert == "" || *key == "" || *evidence == "" || !filepath.IsAbs(*evidence) || inRepository {
		flag.Usage()
		os.Exit(2)
	}
	certificate, err := tls.LoadX509KeyPair(*cert, *key)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load TLS certificate:", err)
		os.Exit(2)
	}
	f := &fixture{sessions: map[string]string{}, calls: map[string]*call{}, evidence: *evidence}
	mux := http.NewServeMux()
	mux.HandleFunc(prefix+"/realtime/client_secrets", f.mint)
	mux.HandleFunc(prefix+"/realtime/calls", f.sdp)
	mux.HandleFunc(prefix+"/realtime", f.realtime)
	mux.HandleFunc(controlPath, f.control)
	server := &http.Server{Addr: *listen, Handler: mux, TLSConfig: &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}}
	fmt.Println(`{"event":"listening","mode":"BACKEND_PROTOCOL_ONLY","tls":true}`)
	if err := server.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
