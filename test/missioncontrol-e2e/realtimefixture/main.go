// Command realtimefixture is a loopback-only TLS provider-edge fixture for the
// Mission Control backend protocol driver. The default SDP response is
// explicitly protocol-only. --rtc-relay additionally lets a private test
// process supply a real browser peer answer without exposing SDP in evidence.
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
	"io"
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
	offer    string
	answer   chan string
	answered bool
}

type command struct {
	Type           string            `json:"type"`
	MetadataKeys   []string          `json:"metadata_keys,omitempty"`
	Metadata       map[string]string `json:"metadata,omitempty"`
	Output         map[string]any    `json:"output,omitempty"`
	FunctionCallID string            `json:"function_call_id,omitempty"`
}

type fixture struct {
	mu       sync.Mutex
	next     uint64
	sessions map[string]string // ephemeral secret -> provider session ID
	calls    map[string]*call
	evidence string
	rtcRelay bool
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

// fixtureOutput retains only the small, known receipt fields needed by the
// private harness. It never records a provider prompt, SDP, bearer, token, or
// arbitrary function output.
func fixtureOutput(value map[string]any) map[string]any {
	item, _ := value["item"].(map[string]any)
	raw, _ := item["output"].(string)
	if raw == "" || len(raw) > 16<<10 {
		return nil
	}
	var decoded any
	if json.Unmarshal([]byte(raw), &decoded) != nil {
		if strings.HasPrefix(raw, "Refused:") {
			return map[string]any{"status": "refused"}
		}
		return nil
	}
	safe := map[string]any{}
	ids := make([]string, 0, 16)
	machines := make([]string, 0, 8)
	statuses := make([]string, 0, 8)
	add := func(dst *[]string, value string, max int) {
		if value == "" || len(*dst) == max {
			return
		}
		for _, prior := range *dst {
			if prior == value {
				return
			}
		}
		*dst = append(*dst, value)
	}
	var visit func(any)
	visit = func(node any) {
		if list, ok := node.([]any); ok {
			for _, child := range list {
				visit(child)
			}
			return
		}
		obj, ok := node.(map[string]any)
		if !ok {
			return
		}
		for key, child := range obj {
			switch key {
			case "id", "thread_id", "turn_id", "workspace_id", "session_id", "machine_id":
				if text, ok := child.(string); ok {
					add(&ids, text, 128)
				}
			case "machine":
				if text, ok := child.(string); ok {
					add(&machines, text, 32)
				}
			case "status", "code":
				if text, ok := child.(string); ok {
					add(&statuses, text, 32)
				}
			case "revision", "runtime_generation", "channel_id":
				switch child.(type) {
				case string, float64, bool:
					safe[key] = child
				}
			case "machines", "workspaces", "threads", "fleet":
				if rows, ok := child.([]any); ok {
					safe[key+"_count"] = len(rows)
				}
			case "truncated":
				if encoded, err := json.Marshal(child); err == nil && len(encoded) <= 16<<10 {
					safe[key] = json.RawMessage(encoded)
				}
			case "selected_target", "active":
				if encoded, err := json.Marshal(child); err == nil && len(encoded) <= 16<<10 {
					safe[key] = json.RawMessage(encoded)
				}
			}
			visit(child)
		}
	}
	visit(decoded)
	if len(ids) > 0 {
		safe["ids"] = ids
	}
	if len(machines) > 0 {
		safe["machines"] = machines
	}
	if len(statuses) > 0 {
		statusText := strings.Join(statuses, ";")
		if len(statusText) > 16<<10 {
			statusText = statusText[:16<<10]
		}
		safe["status_text"] = statusText
	}
	if len(safe) == 0 {
		return nil
	}
	return safe
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
	offer, err := io.ReadAll(io.LimitReader(r.Body, maxEventSize+1))
	if err != nil || len(offer) == 0 || len(offer) > maxEventSize {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bounded SDP offer required"})
		return
	}
	callID := f.id("call")
	f.mu.Lock()
	c := &call{id: callID, secret: bearer(r)}
	if f.rtcRelay {
		c.offer = string(offer)
		c.answer = make(chan string, 1)
	}
	f.calls[callID] = c
	f.mu.Unlock()
	f.writeEvidence()
	w.Header().Set("Location", "https://"+r.Host+prefix+"/realtime/calls/"+callID)
	w.Header().Set("Content-Type", "application/sdp")
	if !f.rtcRelay {
		// This is intentionally not proof of a browser WebRTC negotiation.
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("v=0\r\no=realtimefixture 0 0 IN IP4 127.0.0.1\r\ns=PROTOCOL_FIXTURE_NOT_WEBRTC_PROOF\r\nt=0 0\r\n"))
		return
	}
	select {
	case answer := <-c.answer:
		w.WriteHeader(http.StatusCreated)
		_, _ = io.WriteString(w, answer)
	case <-r.Context().Done():
		return
	case <-time.After(30 * time.Second):
		writeJSON(w, http.StatusGatewayTimeout, map[string]any{"error": "RTC relay answer timed out"})
	}
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
		item, _ := message["item"].(map[string]any)
		functionCallID, _ := item["call_id"].(string)
		f.mu.Lock()
		meta, keys := metadata(message)
		c.commands = append(c.commands, command{Type: kind, MetadataKeys: keys, Metadata: meta, Output: fixtureOutput(message), FunctionCallID: functionCallID})
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
		AnswerSDP string         `json:"answer_sdp"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxEventSize)).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "bounded JSON required"})
		return
	}
	switch request.Operation {
	case "pending_offer":
		if !f.rtcRelay {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "RTC relay is disabled"})
			return
		}
		f.mu.Lock()
		var pending *call
		for _, candidate := range f.calls {
			if candidate.offer != "" && !candidate.answered {
				if pending != nil {
					f.mu.Unlock()
					writeJSON(w, http.StatusConflict, map[string]any{"error": "multiple RTC offers are pending"})
					return
				}
				pending = candidate
			}
		}
		if pending == nil {
			f.mu.Unlock()
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "no RTC offer is pending"})
			return
		}
		reply := map[string]any{"call_id": pending.id, "offer_sdp": pending.offer}
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, reply)
	case "answer_sdp":
		f.mu.Lock()
		c := f.calls[request.CallID]
		f.mu.Unlock()
		if c == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown fixture call"})
			return
		}
		if !f.rtcRelay || request.CallID == "" || !strings.HasPrefix(request.AnswerSDP, "v=0") || len(request.AnswerSDP) > maxEventSize {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "valid bounded RTC answer and call_id required"})
			return
		}
		f.mu.Lock()
		if c.offer == "" || c.answered {
			f.mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{"error": "RTC call is not awaiting one answer"})
			return
		}
		c.answered = true
		answer := c.answer
		f.mu.Unlock()
		select {
		case answer <- request.AnswerSDP:
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		default:
			writeJSON(w, http.StatusConflict, map[string]any{"error": "RTC answer was no longer awaited"})
		}
	case "inspect":
		f.mu.Lock()
		c := f.calls[request.CallID]
		f.mu.Unlock()
		if c == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown fixture call"})
			return
		}
		f.mu.Lock()
		reply := map[string]any{"call_id": c.id, "connected": c.conn != nil, "commands": append([]command(nil), c.commands...)}
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, reply)
	case "inject":
		f.mu.Lock()
		c := f.calls[request.CallID]
		f.mu.Unlock()
		if c == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown fixture call"})
			return
		}
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
		c := f.calls[request.CallID]
		f.mu.Unlock()
		if c == nil {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "unknown fixture call"})
			return
		}
		f.mu.Lock()
		conn := c.conn
		f.mu.Unlock()
		if conn != nil {
			_ = conn.Close(websocket.StatusGoingAway, "fixture transport unavailable")
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "operation must be pending_offer, answer_sdp, inspect, inject, or close"})
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
	rtcRelay := flag.Bool("rtc-relay", false, "relay a browser SDP answer through private fixture control")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: realtimefixture --listen <loopback:port> --cert <pem> --key <pem> --evidence <absolute-private-json> [--rtc-relay]")
		fmt.Fprintln(os.Stderr, "BACKEND_PROTOCOL_ONLY: TLS is required. Supply a CA trusted by the prepared muxterm server.")
		fmt.Fprintln(os.Stderr, "--rtc-relay enables private real-browser WebRTC signalling; media remains synthetic, not acoustic.")
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
	f := &fixture{sessions: map[string]string{}, calls: map[string]*call{}, evidence: *evidence, rtcRelay: *rtcRelay}
	mux := http.NewServeMux()
	mux.HandleFunc(prefix+"/realtime/client_secrets", f.mint)
	mux.HandleFunc(prefix+"/realtime/calls", f.sdp)
	mux.HandleFunc(prefix+"/realtime", f.realtime)
	mux.HandleFunc(controlPath, f.control)
	server := &http.Server{Addr: *listen, Handler: mux, TLSConfig: &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}}
	mode := "BACKEND_PROTOCOL_ONLY"
	if *rtcRelay {
		mode = "REALRTC_SYNTHETIC_MEDIA"
	}
	fmt.Printf("{\"event\":\"listening\",\"mode\":%q,\"tls\":true}\n", mode)
	if err := server.ListenAndServeTLS("", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
