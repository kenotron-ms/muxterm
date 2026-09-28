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
	"sort"
	"strings"
	"sync"
	"time"
)

// sdkChatManager is the Go owner of SDK chat IDs, receipts and the event journal.
// The Node process may disappear; accepted work is marked uncertain, never replayed.
type sdkChatManager struct {
	mu          sync.Mutex
	launchMu    sync.Mutex
	dir         string
	sessions    map[string]*sdkChatSession
	conn        net.Conn
	waiting     map[string]chan sdkChatReply
	pending     map[string]string
	subscribers map[string]map[chan struct{}]struct{}
}
type sdkChatSession struct {
	ID           string          `json:"id"`
	WorkspaceID  string          `json:"workspaceId"`
	ProjectPath  string          `json:"projectPath"`
	Harness      string          `json:"harness"`
	HarnessID    string          `json:"harnessId,omitempty"`
	Title        string          `json:"title"`
	State        string          `json:"state"`
	Capabilities map[string]bool `json:"capabilities,omitempty"`
	CreatedAt    time.Time       `json:"createdAt"`
	Events       []sdkChatEvent  `json:"-"`
	Active       map[string]bool `json:"-"`
}
type sdkChatEvent struct {
	Seq       int             `json:"seq"`
	SessionID string          `json:"session_id"`
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	InputID   string          `json:"input_id,omitempty"`
	InputIDs  []string        `json:"input_ids,omitempty"`
	Kind      string          `json:"kind,omitempty"`
	Source    string          `json:"source,omitempty"`
	Tool      string          `json:"tool,omitempty"`
	ToolID    string          `json:"tool_id,omitempty"`
	Detail    json.RawMessage `json:"detail,omitempty"`
	Message   string          `json:"message,omitempty"`
	HarnessID string          `json:"harness_id,omitempty"`
	Time      time.Time       `json:"time"`
}
type sdkChatReply struct {
	ID           string          `json:"id"`
	Error        string          `json:"error"`
	Accepted     bool            `json:"accepted"`
	Capabilities map[string]bool `json:"capabilities"`
}
type sdkChatFrame struct {
	Version      int             `json:"version"`
	ID           string          `json:"id,omitempty"`
	Event        *sdkChatEvent   `json:"event,omitempty"`
	Error        string          `json:"error,omitempty"`
	Accepted     bool            `json:"accepted,omitempty"`
	Capabilities map[string]bool `json:"capabilities,omitempty"`
}

func sdkChatID() string { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func sdkChatDataDir() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(base, "muxterm", "sdk-chat")
}
func newSDKChatManager() *sdkChatManager {
	m := &sdkChatManager{dir: sdkChatDataDir(), sessions: map[string]*sdkChatSession{}, waiting: map[string]chan sdkChatReply{}, pending: map[string]string{}, subscribers: map[string]map[chan struct{}]struct{}{}}
	entries, _ := os.ReadDir(m.dir)
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(m.dir, e.Name()))
		if err != nil {
			continue
		}
		var s sdkChatSession
		if json.Unmarshal(data, &s) != nil || s.ID == "" {
			continue
		}
		s.Active = map[string]bool{}
		m.sessions[s.ID] = &s
		m.loadEvents(&s)
		if s.State == "working" || s.State == "starting" {
			m.markUncertain(&s, "Go restarted while SDK work was in flight; accepted work was not replayed")
		}
	}
	return m
}
func (m *sdkChatManager) loadEvents(s *sdkChatSession) {
	f, err := os.Open(filepath.Join(m.dir, s.ID+".ndjson"))
	if err != nil {
		return
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	for scanner.Scan() {
		var e sdkChatEvent
		if json.Unmarshal(scanner.Bytes(), &e) == nil {
			s.Events = append(s.Events, e)
		}
	}
}
func (m *sdkChatManager) persist(s *sdkChatSession) error {
	if err := os.MkdirAll(m.dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(m.dir, s.ID+".json")
	tmp := path + ".tmp"
	if err = os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
func (m *sdkChatManager) appendEvent(s *sdkChatSession, e sdkChatEvent) error {
	e.Seq = len(s.Events) + 1
	e.SessionID = s.ID
	e.Time = time.Now().UTC()
	if err := os.MkdirAll(m.dir, 0700); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(m.dir, s.ID+".ndjson"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	data, _ := json.Marshal(e)
	_, err = f.Write(append(data, '\n'))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	s.Events = append(s.Events, e)
	for c := range m.subscribers[s.ID] {
		select {
		case c <- struct{}{}:
		default:
		}
	}
	return nil
}
func (m *sdkChatManager) markUncertain(s *sdkChatSession, reason string) {
	if s.State == "uncertain" {
		return
	}
	s.State = "uncertain"
	s.Active = map[string]bool{}
	if err := m.appendEvent(s, sdkChatEvent{Type: "error", Message: reason}); err != nil {
		log.Printf("sdk chat %s: persist uncertainty event: %v", s.ID, err)
	}
	if err := m.persist(s); err != nil {
		log.Printf("sdk chat %s: persist uncertainty state: %v", s.ID, err)
	}
}
func (m *sdkChatManager) sidecarPath() (string, error) {
	if path := os.Getenv("MUXTERM_SDK_SIDECAR_DIR"); path != "" {
		return filepath.Join(path, "sidecar.mjs"), nil
	}
	cwd, _ := os.Getwd()
	path := filepath.Join(cwd, "internal", "sdkchat", "sidecar.mjs")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	exe, _ := os.Executable()
	path = filepath.Join(filepath.Dir(exe), "sdkchat", "sidecar.mjs")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	return "", errors.New("SDK sidecar files unavailable; set MUXTERM_SDK_SIDECAR_DIR")
}
func (m *sdkChatManager) ensure(ctx context.Context) error {
	m.launchMu.Lock()
	defer m.launchMu.Unlock()
	m.mu.Lock()
	if m.conn != nil {
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	path, err := m.sidecarPath()
	if err != nil {
		return err
	}
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDir == "" {
		runtimeDir = os.TempDir()
	}
	socketDir, err := os.MkdirTemp(runtimeDir, "muxterm-sdk-")
	if err != nil {
		return err
	}
	socketPath := filepath.Join(socketDir, "sidecar.sock")
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return err
	}
	_ = os.Chmod(socketPath, 0600)
	cmd := exec.Command("node", path)
	cmd.Dir = filepath.Dir(filepath.Dir(filepath.Dir(path)))
	cmd.Env = append(os.Environ(), "MUXTERM_SDK_SOCKET="+socketPath)
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		listener.Close()
		os.RemoveAll(socketDir)
		return err
	}
	deadline := time.After(8 * time.Second)
	type accepted struct {
		c   net.Conn
		err error
	}
	ch := make(chan accepted, 1)
	go func() { c, e := listener.Accept(); ch <- accepted{c, e} }()
	select {
	case got := <-ch:
		if got.err != nil {
			return got.err
		}
		m.mu.Lock()
		m.conn = got.c
		m.mu.Unlock()
		go m.readLoop(got.c, socketDir, listener, cmd)
		return nil
	case <-deadline:
		_ = cmd.Process.Kill()
		listener.Close()
		os.RemoveAll(socketDir)
		return errors.New("SDK sidecar connection timed out")
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		listener.Close()
		os.RemoveAll(socketDir)
		return ctx.Err()
	}
}
func (m *sdkChatManager) readLoop(conn net.Conn, socketDir string, listener net.Listener, cmd *exec.Cmd) {
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 4096), 4<<20)
	for scanner.Scan() {
		var frame sdkChatFrame
		if json.Unmarshal(scanner.Bytes(), &frame) != nil || frame.Version != 1 {
			continue
		}
		m.mu.Lock()
		if frame.Event != nil {
			e := *frame.Event
			if s := m.sessions[e.SessionID]; s != nil {
				if e.Type == "session.started" && e.HarnessID != "" {
					s.HarnessID = e.HarnessID
					_ = m.persist(s)
				}
				if e.Type == "turn.completed" {
					s.State = "ready"
					s.Active = map[string]bool{"opened": true}
					_ = m.persist(s)
				}
				if e.Type == "error" {
					s.State = "error"
					s.Active = map[string]bool{}
					_ = m.persist(s)
				}
				_ = m.appendEvent(s, e)
			}
		} else if ch := m.waiting[frame.ID]; ch != nil {
			delete(m.waiting, frame.ID)
			delete(m.pending, frame.ID)
			ch <- sdkChatReply{ID: frame.ID, Error: frame.Error, Accepted: frame.Accepted, Capabilities: frame.Capabilities}
		}
		m.mu.Unlock()
	}
	m.mu.Lock()
	if m.conn == conn {
		m.conn = nil
		for _, s := range m.sessions {
			s.Active = map[string]bool{}
			if s.State == "working" {
				m.markUncertain(s, "SDK sidecar stopped; accepted work is uncertain and was not replayed")
			}
		}
		for id, ch := range m.waiting {
			if s := m.sessions[m.pending[id]]; s != nil {
				m.markUncertain(s, "SDK sidecar stopped during an operation; receipt is uncertain and work was not replayed")
			}
			delete(m.waiting, id)
			delete(m.pending, id)
			ch <- sdkChatReply{ID: id, Error: "SDK sidecar disconnected; operation uncertain"}
		}
	}
	m.mu.Unlock()
	conn.Close()
	listener.Close()
	os.RemoveAll(socketDir)
	_ = cmd.Wait()
}
func (m *sdkChatManager) request(ctx context.Context, op string, fields map[string]any) (sdkChatReply, error) {
	if err := m.ensure(ctx); err != nil {
		return sdkChatReply{}, err
	}
	id := sdkChatID()
	fields["version"] = 1
	fields["id"] = id
	fields["op"] = op
	data, _ := json.Marshal(fields)
	data = append(data, '\n')
	ch := make(chan sdkChatReply, 1)
	m.mu.Lock()
	m.waiting[id] = ch
	if sessionID, ok := fields["session_id"].(string); ok {
		m.pending[id] = sessionID
	}
	_ = m.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err := m.conn.Write(data)
	if err != nil {
		delete(m.waiting, id)
		if s := m.sessions[m.pending[id]]; s != nil {
			m.markUncertain(s, "SDK sidecar write failed; operation receipt is uncertain")
		}
		delete(m.pending, id)
	}
	m.mu.Unlock()
	if err != nil {
		return sdkChatReply{}, err
	}
	select {
	case reply := <-ch:
		if reply.Error != "" {
			return reply, errors.New(reply.Error)
		}
		return reply, nil
	case <-ctx.Done():
		m.mu.Lock()
		delete(m.waiting, id)
		if s := m.sessions[m.pending[id]]; s != nil {
			m.markUncertain(s, "SDK operation timed out; receipt is uncertain and work was not replayed")
		}
		delete(m.pending, id)
		m.mu.Unlock()
		return sdkChatReply{}, ctx.Err()
	}
}
func sdkChatJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func sdkChatError(w http.ResponseWriter, status int, err error) {
	sdkChatJSON(w, status, map[string]string{"error": err.Error()})
}
func (s *Server) handleSDKChatList(w http.ResponseWriter, r *http.Request) {
	s.sdkChats.mu.Lock()
	rows := make([]*sdkChatSession, 0, len(s.sdkChats.sessions))
	for _, v := range s.sdkChats.sessions {
		rows = append(rows, v)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].CreatedAt.Before(rows[j].CreatedAt) })
	s.sdkChats.mu.Unlock()
	sdkChatJSON(w, 200, rows)
}
func (s *Server) handleSDKChatCreate(w http.ResponseWriter, r *http.Request) {
	var input struct {
		WorkspaceID string `json:"workspaceId"`
		ProjectPath string `json:"projectPath"`
		Harness     string `json:"harness"`
		Prompt      string `json:"prompt"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&input) != nil {
		sdkChatError(w, 400, errors.New("invalid request"))
		return
	}
	if input.Harness == "amplifier" {
		sdkChatError(w, 501, errors.New("Amplifier SDK chat unavailable in this build"))
		return
	}
	if input.Harness != "codex" && input.Harness != "claude" {
		sdkChatError(w, 400, errors.New("unsupported harness"))
		return
	}
	info, err := os.Stat(input.ProjectPath)
	if err != nil || !info.IsDir() {
		sdkChatError(w, 400, errors.New("project folder is unavailable"))
		return
	}
	if strings.TrimSpace(input.Prompt) == "" {
		sdkChatError(w, 400, errors.New("first message is required"))
		return
	}
	title := strings.TrimSpace(input.Prompt)
	if len(title) > 72 {
		title = title[:72] + "…"
	}
	row := &sdkChatSession{ID: sdkChatID(), WorkspaceID: input.WorkspaceID, ProjectPath: input.ProjectPath, Harness: input.Harness, Title: title, State: "starting", CreatedAt: time.Now().UTC(), Active: map[string]bool{}}
	s.sdkChats.mu.Lock()
	s.sdkChats.sessions[row.ID] = row
	err = s.sdkChats.persist(row)
	s.sdkChats.mu.Unlock()
	if err != nil {
		sdkChatError(w, 500, err)
		return
	}
	reply, err := s.sdkChats.request(r.Context(), "start", map[string]any{"session_id": row.ID, "harness": row.Harness, "cwd": row.ProjectPath})
	if err != nil {
		s.sdkChats.mu.Lock()
		if row.State != "uncertain" {
			row.State = "error"
			_ = s.sdkChats.appendEvent(row, sdkChatEvent{Type: "error", Message: err.Error()})
			_ = s.sdkChats.persist(row)
		}
		s.sdkChats.mu.Unlock()
		sdkChatError(w, 503, err)
		return
	}
	s.sdkChats.mu.Lock()
	row.Capabilities = reply.Capabilities
	_ = s.sdkChats.persist(row)
	s.sdkChats.mu.Unlock()
	sdkChatJSON(w, 201, row)
}
func (s *Server) handleSDKChatGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.sdkChats.mu.Lock()
	row := s.sdkChats.sessions[id]
	if row == nil {
		s.sdkChats.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	events := append([]sdkChatEvent(nil), row.Events...)
	s.sdkChats.mu.Unlock()
	sdkChatJSON(w, 200, map[string]any{"session": row, "events": events})
}

func (s *Server) handleSDKChatResume(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.sdkChats.mu.Lock()
	row := s.sdkChats.sessions[id]
	if row == nil {
		s.sdkChats.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	harness, harnessID, cwd := row.Harness, row.HarnessID, row.ProjectPath
	s.sdkChats.mu.Unlock()
	if harnessID == "" {
		sdkChatError(w, 409, errors.New("harness session ID is unavailable; no accepted work was replayed"))
		return
	}
	_, err := s.sdkChats.request(r.Context(), "resume", map[string]any{"session_id": id, "harness": harness, "harness_id": harnessID, "cwd": cwd})
	if err != nil && !strings.Contains(err.Error(), "already open") {
		sdkChatError(w, 503, err)
		return
	}
	s.sdkChats.mu.Lock()
	row.State = "ready"
	row.Active = map[string]bool{"opened": true}
	_ = s.sdkChats.persist(row)
	s.sdkChats.mu.Unlock()
	sdkChatJSON(w, 200, row)
}
func (s *Server) handleSDKChatInterrupt(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.sdkChats.mu.Lock()
	row := s.sdkChats.sessions[id]
	s.sdkChats.mu.Unlock()
	if row == nil {
		http.NotFound(w, r)
		return
	}
	_, err := s.sdkChats.request(r.Context(), "interrupt", map[string]any{"session_id": id})
	if err != nil {
		sdkChatError(w, 409, err)
		return
	}
	sdkChatJSON(w, 202, map[string]bool{"accepted": true})
}
func (s *Server) handleSDKChatClose(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.sdkChats.mu.Lock()
	row := s.sdkChats.sessions[id]
	s.sdkChats.mu.Unlock()
	if row == nil {
		http.NotFound(w, r)
		return
	}
	_, err := s.sdkChats.request(r.Context(), "close", map[string]any{"session_id": id})
	if err != nil && !strings.Contains(err.Error(), "session not open") {
		sdkChatError(w, 409, err)
		return
	}
	s.sdkChats.mu.Lock()
	row.State = "closed"
	row.Active = map[string]bool{}
	_ = s.sdkChats.persist(row)
	s.sdkChats.mu.Unlock()
	sdkChatJSON(w, 200, row)
}
func (s *Server) handleSDKChatSend(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var input struct {
		Kind    string `json:"kind"`
		Source  string `json:"source"`
		ID      string `json:"id"`
		Content string `json:"content"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&input) != nil {
		sdkChatError(w, 400, errors.New("invalid input"))
		return
	}
	if input.ID == "" {
		input.ID = sdkChatID()
	}
	if input.Kind != "user" && input.Kind != "service" {
		sdkChatError(w, 400, errors.New("unsupported input kind"))
		return
	}
	if input.Kind == "service" && input.Source == "" {
		sdkChatError(w, 400, errors.New("service source is required"))
		return
	}
	s.sdkChats.mu.Lock()
	row := s.sdkChats.sessions[id]
	if row == nil {
		s.sdkChats.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if row.State == "uncertain" || row.State == "closed" {
		s.sdkChats.mu.Unlock()
		sdkChatError(w, http.StatusConflict, errors.New("session is uncertain or closed; resume it explicitly before sending"))
		return
	}
	if row.Harness == "codex" && (input.Kind == "service" || row.State == "working") {
		s.sdkChats.mu.Unlock()
		sdkChatError(w, 409, errors.New("unsupported: Codex TypeScript SDK cannot accept attributed service or live input"))
		return
	}
	for _, e := range row.Events {
		if e.InputID == input.ID && e.Type == "input.accepted" {
			s.sdkChats.mu.Unlock()
			sdkChatJSON(w, 200, map[string]any{"accepted": true, "id": input.ID})
			return
		}
	}
	harnessID := row.HarnessID
	harness := row.Harness
	cwd := row.ProjectPath
	s.sdkChats.mu.Unlock()
	if err := s.sdkChats.ensure(r.Context()); err != nil {
		sdkChatError(w, 503, err)
		return
	}
	s.sdkChats.mu.Lock()
	_, opened := s.sdkChats.sessions[id].Active["opened"]
	s.sdkChats.mu.Unlock()
	if !opened {
		_, err := s.sdkChats.request(r.Context(), "resume", map[string]any{"session_id": id, "harness": harness, "harness_id": harnessID, "cwd": cwd})
		if err != nil && !strings.Contains(err.Error(), "already open") {
			sdkChatError(w, 503, err)
			return
		}
		s.sdkChats.mu.Lock()
		row.Active["opened"] = true
		s.sdkChats.mu.Unlock()
	}
	reply, err := s.sdkChats.request(r.Context(), "send", map[string]any{"session_id": id, "input": input})
	if err != nil {
		sdkChatError(w, 409, err)
		return
	}
	s.sdkChats.mu.Lock()
	if row.State == "uncertain" {
		_ = s.sdkChats.appendEvent(row, sdkChatEvent{Type: "input.accepted", InputID: input.ID, Kind: input.Kind, Source: input.Source, Text: input.Content})
		s.sdkChats.mu.Unlock()
		sdkChatError(w, 503, errors.New("SDK sidecar stopped after accepting input; operation is uncertain and was not replayed"))
		return
	}
	row.State = "working"
	row.Active[input.ID] = true
	_ = s.sdkChats.appendEvent(row, sdkChatEvent{Type: "input.accepted", InputID: input.ID, Kind: input.Kind, Source: input.Source, Text: input.Content})
	_ = s.sdkChats.persist(row)
	s.sdkChats.mu.Unlock()
	sdkChatJSON(w, 202, map[string]any{"accepted": reply.Accepted, "id": input.ID})
}
func (s *Server) handleSDKChatEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	ch := make(chan struct{}, 1)
	var after int
	_, _ = fmt.Sscan(r.URL.Query().Get("after"), &after)
	s.sdkChats.mu.Lock()
	if s.sdkChats.sessions[id] == nil {
		s.sdkChats.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if s.sdkChats.subscribers[id] == nil {
		s.sdkChats.subscribers[id] = map[chan struct{}]struct{}{}
	}
	s.sdkChats.subscribers[id][ch] = struct{}{}
	s.sdkChats.mu.Unlock()
	defer func() { s.sdkChats.mu.Lock(); delete(s.sdkChats.subscribers[id], ch); s.sdkChats.mu.Unlock() }()
	for {
		s.sdkChats.mu.Lock()
		row := s.sdkChats.sessions[id]
		var events []sdkChatEvent
		for _, e := range row.Events {
			if e.Seq > after {
				events = append(events, e)
			}
		}
		s.sdkChats.mu.Unlock()
		for _, e := range events {
			data, _ := json.Marshal(e)
			_, _ = fmt.Fprintf(w, "id: %d\ndata: %s\n\n", e.Seq, data)
			after = e.Seq
		}
		flusher.Flush()
		select {
		case <-ch:
		case <-r.Context().Done():
			return
		}
	}
}
