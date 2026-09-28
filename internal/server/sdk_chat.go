package server

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// SDK chats are Go-owned records. Native harness IDs are resume pointers only.
type sdkChat struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId,omitempty"`
	ProjectPath string    `json:"projectPath"`
	Title       string    `json:"title"`
	Harness     string    `json:"harness"`
	NativeID    string    `json:"nativeId,omitempty"`
	State       string    `json:"state"`
	CreatedAt   time.Time `json:"createdAt"`
}
type sdkEvent struct {
	SessionID    string          `json:"sessionId"`
	Type         string          `json:"type"`
	NativeID     string          `json:"nativeId,omitempty"`
	InputID      string          `json:"inputId,omitempty"`
	InputIDs     []string        `json:"inputIds,omitempty"`
	GenerationID string          `json:"generationId,omitempty"`
	Delivery     string          `json:"delivery,omitempty"`
	Persisted    *bool           `json:"persisted,omitempty"`
	Kind         string          `json:"kind,omitempty"`
	Source       string          `json:"source,omitempty"`
	Text         string          `json:"text,omitempty"`
	Name         string          `json:"name,omitempty"`
	ToolID       string          `json:"toolId,omitempty"`
	Message      string          `json:"message,omitempty"`
	Raw          json.RawMessage `json:"raw,omitempty"`
}
type sdkChatHost struct {
	mu         sync.Mutex
	dir        string
	socket     string
	process    *exec.Cmd
	done       chan struct{}
	running    bool
	ampSocket  string
	ampProcess *exec.Cmd
	ampDone    chan struct{}
	ampRunning bool
	chats      map[string]*sdkChat
	streams    map[string]map[chan sdkEvent]struct{}
}

func sdkDataDir() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "muxterm", "sdk-chat")
}
func newSDKChatHost() *sdkChatHost {
	h := &sdkChatHost{dir: sdkDataDir(), chats: map[string]*sdkChat{}, streams: map[string]map[chan sdkEvent]struct{}{}}
	h.socket = filepath.Join(h.dir, "sidecar.sock")
	h.ampSocket = filepath.Join(h.dir, "amplifier.sock")
	entries, _ := os.ReadDir(h.dir)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(h.dir, e.Name()))
		if err != nil {
			continue
		}
		var chat sdkChat
		if json.Unmarshal(data, &chat) == nil && chat.ID != "" {
			if chat.State == "working" || chat.State == "starting" {
				chat.State = "uncertain"
			}
			h.chats[chat.ID] = &chat
		}
	}
	return h
}
func sdkID() string { var b [16]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }
func (h *sdkChatHost) saveLocked(c *sdkChat) error {
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(c, "", "  ")
	tmp := filepath.Join(h.dir, c.ID+".json.tmp")
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(h.dir, c.ID+".json"))
}
func (h *sdkChatHost) appendEvent(event sdkEvent) {
	h.mu.Lock()
	c := h.chats[event.SessionID]
	if c == nil {
		h.mu.Unlock()
		return
	}
	if event.NativeID != "" {
		c.NativeID = event.NativeID
	}
	switch event.Type {
	case "input.accepted":
		c.State = "working"
	case "turn.completed":
		c.State = "ready"
	case "error":
		c.State = "failed"
	}
	_ = h.saveLocked(c)
	line, _ := json.Marshal(event)
	f, err := os.OpenFile(filepath.Join(h.dir, c.ID+".ndjson"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err == nil {
		_, _ = f.Write(append(line, '\n'))
		_ = f.Sync()
		_ = f.Close()
	}
	for ch := range h.streams[event.SessionID] {
		select {
		case ch <- event:
		default:
			close(ch)
			delete(h.streams[event.SessionID], ch)
		}
	}
	h.mu.Unlock()
}
func (h *sdkChatHost) sidecarPath() string {
	if p := os.Getenv("MUXTERM_SDK_CHAT_SIDECAR"); p != "" {
		return p
	}
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "sdk-chat", "sidecar.mjs"))
}
func (h *sdkChatHost) ensure(harness string) error {
	if harness == "amplifier" {
		return h.ensureAmplifier()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.running {
		return nil
	}
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	_ = os.Remove(h.socket)
	path := h.sidecarPath()
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("SDK sidecar unavailable at %s: %w", path, err)
	}
	cmd := exec.Command("node", path, h.socket)
	cmd.Dir = filepath.Dir(path)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	h.process = cmd
	h.running = true
	h.done = make(chan struct{})
	ready := make(chan error, 1)
	go h.observe(cmd, h.socket, ready)
	go h.watch(cmd, h.done, "node")
	select {
	case err := <-ready:
		return err
	case <-time.After(3 * time.Second):
		return errors.New("SDK sidecar did not open its Unix socket")
	}
}
func (h *sdkChatHost) ensureAmplifier() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ampRunning {
		return nil
	}
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	_ = os.Remove(h.ampSocket)
	path := os.Getenv("MUXTERM_SDK_CHAT_AMPLIFIER_SIDECAR")
	if path == "" {
		_, file, _, _ := runtime.Caller(0)
		path = filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "sdk-chat", "amplifier_sidecar.py"))
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("Amplifier sidecar unavailable at %s: %w", path, err)
	}
	python := os.Getenv("MUXTERM_COS_PYTHON")
	if python == "" {
		home, _ := os.UserHomeDir()
		python = filepath.Join(home, ".local", "share", "uv", "tools", "amplifier", "bin", "python")
	}
	cmd := exec.Command(python, path, h.ampSocket)
	cmd.Dir = filepath.Dir(path)
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("Amplifier SDK failed to start: %w", err)
	}
	h.ampProcess = cmd
	h.ampRunning = true
	h.ampDone = make(chan struct{})
	ready := make(chan error, 1)
	go h.observe(cmd, h.ampSocket, ready)
	go h.watch(cmd, h.ampDone, "amplifier")
	select {
	case err := <-ready:
		return err
	case <-time.After(3 * time.Second):
		return errors.New("Amplifier sidecar did not open its Unix socket")
	}
}
func (h *sdkChatHost) watch(cmd *exec.Cmd, done chan struct{}, harness string) {
	defer close(done)
	err := cmd.Wait()
	var uncertain []string
	h.mu.Lock()
	if (harness == "amplifier" && h.ampProcess == cmd) || (harness == "node" && h.process == cmd) {
		if harness == "amplifier" {
			h.ampRunning = false
			h.ampProcess = nil
		} else {
			h.running = false
			h.process = nil
		}
		for _, c := range h.chats {
			if (c.Harness == "amplifier") == (harness == "amplifier") && (c.State == "working" || c.State == "starting") {
				c.State = "uncertain"
				_ = h.saveLocked(c)
				uncertain = append(uncertain, c.ID)
			}
		}
	}
	h.mu.Unlock()
	for _, id := range uncertain {
		h.appendEvent(sdkEvent{SessionID: id, Type: "session.uncertain", Message: "The SDK sidecar stopped before the turn reached a terminal event. The accepted input was not replayed."})
	}
	log.Printf("sdk chat sidecar exited: %v", err)
}
func (h *sdkChatHost) close() {
	h.mu.Lock()
	cmd := h.process
	amp := h.ampProcess
	h.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Signal(os.Interrupt)
		h.mu.Lock()
		done := h.done
		h.mu.Unlock()
		if done != nil {
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				_ = cmd.Process.Kill()
				<-done
			}
		}
	}
	if amp != nil && amp.Process != nil {
		_ = amp.Process.Signal(os.Interrupt)
		select {
		case <-h.ampDone:
		case <-time.After(3 * time.Second):
			_ = amp.Process.Kill()
			<-h.ampDone
		}
	}
}
func (h *sdkChatHost) observe(cmd *exec.Cmd, socket string, ready chan error) {
	var conn net.Conn
	for i := 0; i < 40; i++ {
		c, err := net.Dial("unix", socket)
		if err == nil {
			conn = c
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if conn == nil {
		ready <- errors.New("SDK sidecar Unix socket unavailable")
		return
	}
	ready <- nil
	defer conn.Close()
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var frame struct {
			V     int       `json:"v"`
			Event *sdkEvent `json:"event"`
		}
		if json.Unmarshal(scanner.Bytes(), &frame) == nil && frame.V == 1 && frame.Event != nil {
			h.appendEvent(*frame.Event)
		}
	}
}
func (h *sdkChatHost) call(ctx context.Context, op string, args map[string]any) (json.RawMessage, error) {
	harness, _ := args["harness"].(string)
	if harness == "" {
		if id, ok := args["sessionId"].(string); ok {
			h.mu.Lock()
			if c := h.chats[id]; c != nil {
				harness = c.Harness
			}
			h.mu.Unlock()
		}
	}
	if err := h.ensure(harness); err != nil {
		return nil, err
	}
	socket := h.socket
	if harness == "amplifier" {
		socket = h.ampSocket
	}
	var conn net.Conn
	var err error
	for attempt := 0; attempt < 40; attempt++ {
		conn, err = (&net.Dialer{}).DialContext(ctx, "unix", socket)
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	id := sdkID()
	args["v"] = 1
	args["requestId"] = id
	args["op"] = op
	data, _ := json.Marshal(args)
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, err
	}
	reader := bufio.NewReader(conn)
	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		var reply struct {
			RequestID string          `json:"requestId"`
			Result    json.RawMessage `json:"result"`
			Error     string          `json:"error"`
		}
		if json.Unmarshal(line, &reply) != nil || reply.RequestID != id {
			continue
		}
		if reply.Error != "" {
			return nil, errors.New(reply.Error)
		}
		return reply.Result, nil
	}
}
func (h *sdkChatHost) resume(ctx context.Context, c *sdkChat) error {
	_, err := h.call(ctx, "resume", map[string]any{"sessionId": c.ID, "harness": c.Harness, "cwd": c.ProjectPath, "nativeId": c.NativeID})
	return err
}
func writeSDKJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) handleSDKChats(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	if r.Method == "GET" {
		h.mu.Lock()
		rows := make([]sdkChat, 0, len(h.chats))
		for _, c := range h.chats {
			rows = append(rows, *c)
		}
		h.mu.Unlock()
		writeSDKJSON(w, 200, rows)
		return
	}
	var req struct{ WorkspaceID, ProjectPath, Harness, Prompt string }
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.Harness != "codex" && req.Harness != "claude" && req.Harness != "amplifier" {
		http.Error(w, "unsupported harness", 400)
		return
	}
	if !filepath.IsAbs(req.ProjectPath) || strings.TrimSpace(req.Prompt) == "" {
		http.Error(w, "projectPath and prompt required", 400)
		return
	}
	if info, err := os.Stat(req.ProjectPath); err != nil || !info.IsDir() {
		http.Error(w, "project folder unavailable", 400)
		return
	}
	title := strings.TrimSpace(req.Prompt)
	if len(title) > 70 {
		title = title[:70] + "…"
	}
	c := &sdkChat{ID: sdkID(), WorkspaceID: req.WorkspaceID, ProjectPath: req.ProjectPath, Title: title, Harness: req.Harness, State: "starting", CreatedAt: time.Now().UTC()}
	h.mu.Lock()
	h.chats[c.ID] = c
	err := h.saveLocked(c)
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if _, err = h.call(ctx, "start", map[string]any{"sessionId": c.ID, "harness": c.Harness, "cwd": c.ProjectPath}); err == nil {
		_, err = h.call(ctx, "send", map[string]any{"sessionId": c.ID, "input": map[string]any{"kind": "user", "source": "browser", "id": sdkID(), "content": req.Prompt}})
	}
	if err != nil {
		h.appendEvent(sdkEvent{SessionID: c.ID, Type: "error", Message: err.Error()})
		http.Error(w, err.Error(), 502)
		return
	}
	writeSDKJSON(w, 201, c)
}
func (s *Server) handleSDKChat(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	c := h.chats[id]
	h.mu.Unlock()
	if c == nil {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case "GET":
		writeSDKJSON(w, 200, c)
	case "POST":
		var req struct{ Kind, Source, ID, Content string }
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		if req.ID == "" {
			req.ID = sdkID()
		}
		if req.Kind == "" {
			req.Kind = "user"
		}
		if req.Kind == "service" && c.Harness == "codex" {
			http.Error(w, "unsupported: attributed service input", 422)
			return
		}
		if req.Kind != "user" && req.Kind != "service" && !(c.Harness == "amplifier" && (req.Kind == "steer" || req.Kind == "cancel_job" || req.Kind == "stop")) {
			http.Error(w, "unsupported input kind", 422)
			return
		}
		if req.Kind == "service" && c.Harness == "amplifier" && (req.Source == "" || req.Source == "browser" || req.Source == "user" || req.Source == "system" || req.Source == "developer") {
			http.Error(w, "service input requires a distinct source", 422)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if err := h.resume(ctx, c); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		result, err := h.call(ctx, "send", map[string]any{"sessionId": id, "input": map[string]any{"kind": req.Kind, "source": req.Source, "id": req.ID, "content": req.Content}})
		if err != nil {
			http.Error(w, err.Error(), 422)
			return
		}
		writeSDKJSON(w, 202, result)
	default:
		http.Error(w, "method not allowed", 405)
	}
}
func (s *Server) handleSDKChatEvents(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	c := h.chats[id]
	if c == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	ch := make(chan sdkEvent, 256)
	if h.streams[id] == nil {
		h.streams[id] = map[chan sdkEvent]struct{}{}
	}
	h.streams[id][ch] = struct{}{}
	data, _ := os.ReadFile(filepath.Join(h.dir, id+".ndjson"))
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if _, ok := h.streams[id][ch]; ok {
			delete(h.streams[id], ch)
			close(ch)
		}
		h.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", jsonString(c))
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line != "" {
			fmt.Fprintf(w, "event: sdk\ndata: %s\n\n", line)
		}
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	for {
		select {
		case event, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "event: sdk\ndata: %s\n\n", jsonString(event))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		case <-r.Context().Done():
			return
		}
	}
}
func jsonString(v any) string { b, _ := json.Marshal(v); return string(b) }
