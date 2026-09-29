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
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/cos"
	sdkchat "github.com/kenotron-ms/muxterm/sdk-chat"
)

// SDK chats are Go-owned records. Native harness IDs are resume pointers only.
type sdkChat struct {
	ID           string    `json:"id"`
	WorkspaceID  string    `json:"workspaceId,omitempty"`
	ProjectPath  string    `json:"projectPath"`
	Title        string    `json:"title"`
	Harness      string    `json:"harness"`
	Bundle       string    `json:"bundle,omitempty"`
	Provider     string    `json:"provider,omitempty"`
	NativeID     string    `json:"nativeId,omitempty"`
	State        string    `json:"state"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt,omitempty"`
	LastActivity string    `json:"lastActivity,omitempty"`
	LastOutput   string    `json:"lastOutput,omitempty"`
}
type sdkProject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
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
	Failed       bool            `json:"failed,omitempty"`
}
type sdkInputAttachment struct {
	Path string `json:"path"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

func (s *Server) resolveSDKAttachments(ids []string) ([]sdkInputAttachment, error) {
	if len(ids) > 10 {
		return nil, errors.New("at most 10 attachments are allowed per message")
	}
	seen := make(map[string]bool, len(ids))
	items := make([]sdkInputAttachment, 0, len(ids))
	for _, id := range ids {
		if seen[id] {
			return nil, errors.New("duplicate attachment id")
		}
		seen[id] = true
		path, meta, err := s.sdkChatAttachments.ResolvePath(id)
		if err != nil {
			return nil, fmt.Errorf("attachment %q cannot be read: %w", id, err)
		}
		items = append(items, sdkInputAttachment{Path: path, Name: meta.Filename, Kind: meta.Kind})
	}
	return items, nil
}

type sdkChatHost struct {
	mu       sync.Mutex
	dir      string
	socket   string
	process  *exec.Cmd
	done     chan struct{}
	running  bool
	cosRelay *cosRelay
	ampSup   *cos.Supervisor
	ampOnce  sync.Once
	ampErr   error
	chats    map[string]*sdkChat
	projects map[string]*sdkProject
	streams  map[string]map[chan sdkEvent]struct{}
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
	h := &sdkChatHost{dir: sdkDataDir(), chats: map[string]*sdkChat{}, projects: map[string]*sdkProject{}, streams: map[string]map[chan sdkEvent]struct{}{}}
	h.socket = filepath.Join(h.dir, "sidecar.sock")
	entries, _ := os.ReadDir(h.dir)
	// A catalog is authoritative once written. A removed project must stay
	// removed even when an older chat record still names its former ID.
	hasProjectCatalog := false
	for _, e := range entries {
		if e.Name() == "projects.json" {
			hasProjectCatalog = true
			data, err := os.ReadFile(filepath.Join(h.dir, e.Name()))
			if err == nil {
				_ = json.Unmarshal(data, &h.projects)
			}
			if h.projects == nil {
				h.projects = map[string]*sdkProject{}
			}
			continue
		}
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
	// Old chat records already carried a workspace ID. Preserve that identity
	// while moving project metadata into its own durable catalog.
	if !hasProjectCatalog {
		for _, c := range h.chats {
			if c.WorkspaceID != "" && h.projects[c.WorkspaceID] == nil {
				h.projects[c.WorkspaceID] = &sdkProject{ID: c.WorkspaceID, Name: filepath.Base(c.ProjectPath), Path: c.ProjectPath}
			}
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
func (h *sdkChatHost) saveProjectsLocked() error {
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(h.projects, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(h.dir, "projects.json.tmp")
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(h.dir, "projects.json"))
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
	c.UpdatedAt = time.Now().UTC()
	switch event.Type {
	case "input.accepted":
		c.State = "working"
		c.LastActivity = "Working on: " + sdkPreview(event.Text, 160)
		c.LastOutput = ""
	case "tool.started":
		c.LastActivity = "Running tool: " + event.Name
	case "assistant.delta":
		c.LastOutput = sdkTail(c.LastOutput+event.Text, 300)
	case "turn.completed":
		c.State = "ready"
		c.LastActivity = "Turn completed"
	case "error":
		c.State = "failed"
		c.LastActivity = "Error: " + sdkPreview(event.Message, 160)
	case "session.uncertain":
		c.LastActivity = "Delivery uncertain"
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
func sdkPreview(text string, limit int) string {
	return strings.TrimSpace(sdkTail(text, limit))
}
func sdkTail(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[len(runes)-limit:])
}
func (h *sdkChatHost) sidecarPath() (string, error) {
	if p := os.Getenv("MUXTERM_SDK_CHAT_SIDECAR"); p != "" {
		return p, nil
	}
	return sdkchat.Prepare()
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
	path, err := h.sidecarPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("SDK sidecar unavailable at %s: %w", path, err)
	}
	cmd := exec.Command("node", path, h.socket)
	cmd.Dir = filepath.Dir(path)
	cmd.Stderr = os.Stderr
	// Give SDK chats the MCP server belonging to this serve process. Looking up
	// `muxterm` on PATH can connect a dev chat to the installed production server.
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd.Env = append(os.Environ(), "MUXTERM_CHAT_MCP_BIN="+self)
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
	h.ampOnce.Do(func() {
		sup := cos.New(cos.Config{SDKOnly: true, SessionID: "muxterm-sdk-host-" + sdkID(),
			StatePath: "-", Logf: log.Printf})
		if err := sup.Start(context.Background()); err != nil {
			h.ampErr = err
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), cos.DefaultReadyTimeout)
		defer cancel()
		if _, err := sup.WaitReady(ctx); err != nil {
			h.ampErr = err
			_ = sup.Close()
			return
		}
		h.mu.Lock()
		h.ampSup = sup
		h.mu.Unlock()
		// Subscribe before returning: start/send may emit the first frame at once.
		go h.observeAmplifier(sup.Subscribe(1024))
	})
	return h.ampErr
}
func (h *sdkChatHost) observeAmplifier(sub *cos.Subscription) {
	defer sub.Close()
	for ev := range sub.C() {
		if ev.Ev == cos.EvSidecarUncertain || (ev.Ev == cos.EvError && ev.Code == cos.CodeSidecarExit) {
			h.mu.Lock()
			var ids []string
			for _, c := range h.chats {
				if c.Harness == "amplifier" && (c.State == "working" || c.State == "starting") {
					c.State = "uncertain"
					_ = h.saveLocked(c)
					ids = append(ids, c.ID)
				}
			}
			h.mu.Unlock()
			for _, id := range ids {
				h.appendEvent(sdkEvent{SessionID: id, Type: "session.uncertain", Message: "The supervised Amplifier sidecar stopped before the turn completed. The accepted input was not replayed."})
			}
			continue
		}
		if ev.Ev != "sdk_event" {
			continue
		}
		var frame struct {
			Event sdkEvent `json:"event"`
		}
		if json.Unmarshal(ev.Raw, &frame) == nil {
			h.appendEvent(frame.Event)
		}
	}
}
func (h *sdkChatHost) watch(cmd *exec.Cmd, done chan struct{}, harness string) {
	defer close(done)
	err := cmd.Wait()
	var uncertain []string
	h.mu.Lock()
	if harness == "node" && h.process == cmd {
		h.running = false
		h.process = nil
		for _, c := range h.chats {
			if c.Harness != "amplifier" && (c.State == "working" || c.State == "starting") {
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
	amp := h.ampSup
	h.mu.Unlock()
	if amp != nil {
		_ = amp.Close()
	}
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
	if harness == "amplifier" {
		args["op"] = op
		args["requestId"] = sdkID()
		args["v"] = 1
		command, err := json.Marshal(args)
		if err != nil {
			return nil, err
		}
		return h.ampSup.SDKCommand(ctx, command)
	}
	socket := h.socket
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
	_, err := h.call(ctx, "resume", map[string]any{"sessionId": c.ID, "harness": c.Harness, "cwd": c.ProjectPath, "nativeId": c.NativeID, "bundle": c.Bundle, "provider": amplifierProviderModule(c.Harness, c.Provider)})
	return err
}

func (s *Server) handleSDKChatSettings(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	c := h.chats[id]
	h.mu.Unlock()
	if c == nil || c.Harness != "amplifier" {
		http.NotFound(w, r)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if err := h.resume(ctx, c); err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	if r.Method == "GET" {
		result, err := h.call(ctx, "settings", map[string]any{"sessionId": id})
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		writeSDKJSON(w, 200, json.RawMessage(result))
		return
	}
	if r.Method != "PATCH" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var req struct{ Bundle, Provider string }
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil ||
		len(req.Bundle) > 256 || len(req.Provider) > 128 {
		http.Error(w, "invalid Amplifier settings", 400)
		return
	}
	result, err := h.call(ctx, "select", map[string]any{"sessionId": id, "bundle": req.Bundle, "provider": req.Provider})
	if err != nil {
		http.Error(w, err.Error(), 422)
		return
	}
	var selected struct{ Bundle, Provider string }
	if err := json.Unmarshal(result, &selected); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Lock()
	c.Bundle, c.Provider = selected.Bundle, selected.Provider
	err = h.saveLocked(c)
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeSDKJSON(w, 200, json.RawMessage(result))
}
func writeSDKJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func (s *Server) handleSDKProjects(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	if r.Method == http.MethodGet {
		h.mu.Lock()
		rows := make([]sdkProject, 0, len(h.projects))
		for _, p := range h.projects {
			rows = append(rows, *p)
		}
		h.mu.Unlock()
		writeSDKJSON(w, 200, rows)
		return
	}
	var req struct{ Name, Path string }
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil || !filepath.IsAbs(req.Path) {
		http.Error(w, "absolute project path required", 400)
		return
	}
	req.Path = filepath.Clean(req.Path)
	if req.Name == "" {
		req.Name = filepath.Base(req.Path)
	}
	p := &sdkProject{ID: sdkID(), Name: req.Name, Path: req.Path}
	h.mu.Lock()
	h.projects[p.ID] = p
	err := h.saveProjectsLocked()
	if err != nil {
		delete(h.projects, p.ID)
	}
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeSDKJSON(w, 201, p)
}
func (s *Server) handleSDKProject(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	p := h.projects[id]
	if p == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	delete(h.projects, id)
	err := h.saveProjectsLocked()
	if err != nil {
		h.projects[id] = p
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	// Only muxterm's metadata changes. The folder and native session remain intact.
	// The catalog is committed first so a stale chat record cannot recreate a
	// removed project after a crash or an individual chat write failure.
	for _, c := range h.chats {
		if c.WorkspaceID == id {
			c.WorkspaceID = ""
			if saveErr := h.saveLocked(c); saveErr != nil && err == nil {
				err = saveErr
			}
		}
	}
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (s *Server) handleSDKFolders(w http.ResponseWriter, r *http.Request) {
	s.cfgMu.RLock()
	base := s.cfg.Chat.DefaultBaseHomeFolder
	s.cfgMu.RUnlock()
	if base == "" {
		base, _ = os.UserHomeDir()
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		path = base
	}
	if !filepath.IsAbs(path) {
		http.Error(w, "absolute folder path required", 400)
		return
	}
	path = filepath.Clean(path)
	entries, err := os.ReadDir(path)
	// A requested folder may be a new project directory. Let the picker browse
	// its nearest existing parent; the browser keeps the requested chat target.
	if os.IsNotExist(err) {
		for parent := filepath.Dir(path); parent != path; parent = filepath.Dir(path) {
			path = parent
			entries, err = os.ReadDir(path)
			if !os.IsNotExist(err) {
				break
			}
		}
	}
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	folders := make([]string, 0)
	for _, entry := range entries {
		if entry.IsDir() {
			folders = append(folders, entry.Name())
		}
	}
	writeSDKJSON(w, 200, map[string]any{"path": path, "base": base, "parent": filepath.Dir(path), "folders": folders})
}
// Amplifier selects provider modules by module ID. New chats store short
// provider names; composer changes persist the module ID returned by Amplifier.
func amplifierProviderModule(harness, provider string) string {
	if harness != "amplifier" {
		return provider
	}
	switch provider {
	case "openai":
		return "provider-openai"
	case "anthropic":
		return "provider-anthropic"
	case "configured", "":
		return ""
	default:
		// Preserve an explicit module ID on resume. Amplifier rejects an
		// unavailable module instead of silently using its default provider.
		return provider
	}
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
	var req struct{ WorkspaceID, ProjectPath, Harness, Provider, Prompt string }
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.Harness != "codex" && req.Harness != "claude" && req.Harness != "amplifier" {
		http.Error(w, "unsupported harness", 400)
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		http.Error(w, "prompt required", 400)
		return
	}
	if req.Provider != "" && req.Provider != "openai" && req.Provider != "anthropic" && req.Provider != "configured" {
		http.Error(w, "unsupported provider", 400)
		return
	}
	if req.Provider == "openai" && req.Harness == "claude" || req.Provider == "anthropic" && req.Harness == "codex" || req.Provider == "configured" && req.Harness != "amplifier" {
		http.Error(w, "provider does not match harness", 400)
		return
	}
	if req.WorkspaceID != "" {
		h.mu.Lock()
		p := h.projects[req.WorkspaceID]
		h.mu.Unlock()
		if p == nil {
			http.Error(w, "project not found", 404)
			return
		}
		req.ProjectPath = p.Path
	}
	if req.ProjectPath == "" {
		s.cfgMu.RLock()
		req.ProjectPath = s.cfg.Chat.DefaultBaseHomeFolder
		s.cfgMu.RUnlock()
		if req.ProjectPath == "" {
			req.ProjectPath, _ = os.UserHomeDir()
		}
	}
	if !filepath.IsAbs(req.ProjectPath) {
		http.Error(w, "absolute project path required", 400)
		return
	}
	req.ProjectPath = filepath.Clean(req.ProjectPath)
	if err := os.MkdirAll(req.ProjectPath, 0755); err != nil {
		http.Error(w, "cannot create project folder: "+err.Error(), 400)
		return
	}
	title := strings.TrimSpace(req.Prompt)
	if len(title) > 70 {
		title = title[:70] + "…"
	}
	c := &sdkChat{ID: sdkID(), WorkspaceID: req.WorkspaceID, ProjectPath: req.ProjectPath, Title: title, Harness: req.Harness, Provider: req.Provider, State: "starting", CreatedAt: time.Now().UTC()}
	h.mu.Lock()
	h.chats[c.ID] = c
	err := h.saveLocked(c)
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if _, err = h.call(ctx, "start", map[string]any{"sessionId": c.ID, "harness": c.Harness, "cwd": c.ProjectPath, "provider": amplifierProviderModule(c.Harness, c.Provider)}); err == nil {
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
		var req struct {
			Kind, Source, ID, Content string
			Attachments               []string `json:"attachments"`
		}
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
		if len(req.Attachments) > 0 && req.Kind != "user" {
			http.Error(w, "attachments require a user message", 422)
			return
		}
		attachments, err := s.resolveSDKAttachments(req.Attachments)
		if err != nil {
			http.Error(w, err.Error(), 422)
			return
		}
		if strings.TrimSpace(req.Content) == "" && len(attachments) == 0 {
			http.Error(w, "message or attachment required", 422)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if err := h.resume(ctx, c); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		result, err := h.call(ctx, "send", map[string]any{"sessionId": id, "input": map[string]any{"kind": req.Kind, "source": req.Source, "id": req.ID, "content": req.Content, "attachments": attachments}})
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
