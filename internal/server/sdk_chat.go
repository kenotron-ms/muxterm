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
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/cos"
	sdkchat "github.com/kenotron-ms/muxterm/sdk-chat"
)

// SDK chats are Go-owned records. Native harness IDs are resume pointers only.
type sdkChat struct {
	ID               string    `json:"id"`
	WorkspaceID      string    `json:"workspaceId,omitempty"`
	ProjectPath      string    `json:"projectPath"`
	SourceFolders    []string  `json:"sourceFolders,omitempty"`
	Title            string    `json:"title"`
	TitleSource      string    `json:"titleSource,omitempty"`
	TitleCheckedTurn int       `json:"titleCheckedTurn,omitempty"`
	UserTurns        int       `json:"userTurns,omitempty"`
	Harness          string    `json:"harness"`
	Approval         string    `json:"approval,omitempty"`
	Goal             string    `json:"goal,omitempty"`
	GoalState        string    `json:"goalState,omitempty"`
	GoalReason       string    `json:"goalReason,omitempty"`
	GoalSummary      string    `json:"goalSummary,omitempty"`
	Bundle           string    `json:"bundle,omitempty"`
	Provider         string    `json:"provider,omitempty"`
	Model            string    `json:"model,omitempty"`
	Effort           string    `json:"effort,omitempty"`
	Permission       string    `json:"permission,omitempty"`
	Mode             string    `json:"mode,omitempty"`
	NativeID         string    `json:"nativeId,omitempty"`
	State            string    `json:"state"`
	Archived         bool      `json:"archived,omitempty"`
	Pinned           bool      `json:"pinned,omitempty"`
	WorkMode         string    `json:"workMode,omitempty"`
	CreatedAt        time.Time `json:"createdAt"`
	UpdatedAt        time.Time `json:"updatedAt,omitempty"`
	LastActivity     string    `json:"lastActivity,omitempty"`
	LastOutput       string    `json:"lastOutput,omitempty"`
}
type sdkProject struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Path          string   `json:"path"`
	SourceFolders []string `json:"sourceFolders,omitempty"`
	Pinned        bool     `json:"pinned,omitempty"`
}
type sdkEvent struct {
	SessionID       string                 `json:"sessionId"`
	At              time.Time              `json:"at,omitempty"`
	Type            string                 `json:"type"`
	NativeID        string                 `json:"nativeId,omitempty"`
	InputID         string                 `json:"inputId,omitempty"`
	InputIDs        []string               `json:"inputIds,omitempty"`
	GenerationID    string                 `json:"generationId,omitempty"`
	Delivery        string                 `json:"delivery,omitempty"`
	Persisted       *bool                  `json:"persisted,omitempty"`
	Kind            string                 `json:"kind,omitempty"`
	Source          string                 `json:"source,omitempty"`
	Text            string                 `json:"text,omitempty"`
	Name            string                 `json:"name,omitempty"`
	ToolID          string                 `json:"toolId,omitempty"`
	ChildSessionID  string                 `json:"childSessionId,omitempty"`
	ParentSessionID string                 `json:"parentSessionId,omitempty"`
	Agent           string                 `json:"agent,omitempty"`
	Message         string                 `json:"message,omitempty"`
	Model           string                 `json:"model,omitempty"`
	Provider        string                 `json:"provider,omitempty"`
	Bundle          string                 `json:"bundle,omitempty"`
	Raw             json.RawMessage        `json:"raw,omitempty"`
	GoalState       string                 `json:"goalState,omitempty"`
	GoalReason      string                 `json:"goalReason,omitempty"`
	GoalSummary     string                 `json:"goalSummary,omitempty"`
	Failed          bool                   `json:"failed,omitempty"`
	Complete        bool                   `json:"complete,omitempty"`
	Attachments     []sdkDisplayAttachment `json:"attachments,omitempty"`
}
type sdkDisplayAttachment struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}
type sdkInputAttachment struct {
	ID   string `json:"id"`
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
		items = append(items, sdkInputAttachment{ID: id, Path: path, Name: meta.Filename, Kind: meta.Kind})
	}
	return items, nil
}

type sdkChatHost struct {
	mu          sync.Mutex
	nameLocks   map[string]*sync.Mutex
	dir         string
	socket      string
	process     *exec.Cmd
	done        chan struct{}
	running     bool
	cosRelay    *cosRelay
	ampSup      *cos.Supervisor
	ampOnce     sync.Once
	ampErr      error
	chats       map[string]*sdkChat
	projects    map[string]*sdkProject
	streams     map[string]map[chan sdkEvent]struct{}
	nameStreams map[chan string]struct{}
	naming      map[string]bool
	onEvent     func(sdkEvent)
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
	h := &sdkChatHost{dir: sdkDataDir(), chats: map[string]*sdkChat{}, projects: map[string]*sdkProject{}, streams: map[string]map[chan sdkEvent]struct{}{}, nameStreams: map[chan string]struct{}{}, nameLocks: map[string]*sync.Mutex{}, naming: map[string]bool{}}
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
			chat.Approval = "never"
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
func (h *sdkChatHost) nameLock(id string) *sync.Mutex {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.nameLocks[id] == nil {
		h.nameLocks[id] = &sync.Mutex{}
	}
	return h.nameLocks[id]
}
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

// notifyCatalogLocked invalidates every browser's chat list after a persisted
// catalog change. The existing name-events stream carries these invalidations;
// its payload is only a hint, and clients fetch the authoritative catalog.
func (h *sdkChatHost) notifyCatalogLocked(id string) {
	for ch := range h.nameStreams {
		select {
		case ch <- id:
		default:
			close(ch)
			delete(h.nameStreams, ch)
		}
	}
}
func (h *sdkChatHost) appendEvent(event sdkEvent) {
	if event.At.IsZero() {
		event.At = time.Now().UTC()
	}
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
		if event.Kind == "user" {
			c.UserTurns++
		}
	case "tool.started":
		c.LastActivity = "Running tool: " + event.Name
	case "assistant.delta":
		c.LastOutput = sdkTail(c.LastOutput+event.Text, 300)
	case "turn.completed":
		c.State = "ready"
		c.LastActivity = "Turn completed"
	case "goal.progress":
		c.GoalState, c.GoalReason, c.GoalSummary = event.GoalState, event.GoalReason, event.GoalSummary
		c.LastActivity = "Goal: " + event.GoalState
	case "turn.cancelled":
		c.State = "ready"
		c.LastActivity = "Turn stopped by user"
	case "error":
		c.State = "failed"
		c.LastActivity = "Error: " + sdkPreview(event.Message, 160)
	case "session.uncertain":
		c.State = "uncertain"
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
	switch event.Type {
	case "session.renamed", "input.accepted", "turn.completed", "turn.cancelled", "error", "session.uncertain", "goal.progress":
		h.notifyCatalogLocked(event.SessionID)
	}
	// Name the opening input as soon as it is accepted, while its turn keeps
	// running. Revisit the subject after completed human turns 2, 5, 8, ...
	// All title calls run outside the chat event path.
	if (event.Type == "input.accepted" && event.Kind == "user" && c.UserTurns == 1) ||
		(event.Type == "turn.completed" && c.UserTurns >= 2 && (c.UserTurns-2)%3 == 0) {
		h.scheduleNamingLocked(c)
	}
	h.mu.Unlock()
	if h.onEvent != nil {
		h.onEvent(event)
	}
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
		self, err := os.Executable()
		if err != nil {
			h.ampErr = err
			return
		}
		sup := cos.New(cos.Config{SDKOnly: true, SessionID: "muxterm-sdk-host-" + sdkID(),
			StatePath: "-", Logf: log.Printf, MCPBinary: self})
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
	_, err := h.call(ctx, "resume", map[string]any{"sessionId": c.ID, "harness": c.Harness, "cwd": c.ProjectPath, "sourceFolders": c.SourceFolders, "nativeId": c.NativeID, "bundle": c.Bundle, "provider": amplifierProviderModule(c.Harness, c.Provider), "model": c.Model, "effort": c.Effort, "approval": "never", "permission": c.Permission, "mode": c.Mode})
	return err
}

func (s *Server) handleSDKChatSettings(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	c := h.chats[id]
	h.mu.Unlock()
	if c == nil {
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
		operation := "options"
		if c.Harness == "amplifier" {
			operation = "settings"
		}
		result, err := h.call(ctx, operation, map[string]any{"sessionId": id})
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		var settings map[string]any
		if err := json.Unmarshal(result, &settings); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if c.Model != "" {
			settings["model"] = c.Model
		}
		if c.Effort != "" {
			settings["effort"] = c.Effort
		}
		settings["permission"] = sdkPermission(c)
		settings["mode"] = sdkMode(c)
		settings["permissions"] = sdkPermissions(c.Harness)
		settings["modes"] = sdkModes(c.Harness)
		writeSDKJSON(w, 200, settings)
		return
	}
	if r.Method != "PATCH" {
		http.Error(w, "method not allowed", 405)
		return
	}
	var fields map[string]string
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&fields) != nil {
		http.Error(w, "invalid chat settings", 400)
		return
	}
	permission, mode := sdkPermission(c), sdkMode(c)
	if value, ok := fields["permission"]; ok {
		permission = value
	}
	if value, ok := fields["mode"]; ok {
		mode = value
	}
	if !sdkContains(sdkPermissions(c.Harness), permission) || !sdkContains(sdkModes(c.Harness), mode) || (c.Harness == "claude" && ((permission == "read-only") != (mode == "plan"))) {
		http.Error(w, "unsupported permission or mode for this harness", 422)
		return
	}
	var req struct{ Bundle, Provider, Model, Effort string }
	req.Bundle, req.Provider, req.Model, req.Effort = fields["bundle"], fields["provider"], fields["model"], fields["effort"]
	if len(req.Bundle) > 256 || len(req.Provider) > 128 || len(req.Model) > 128 || len(req.Effort) > 32 {
		http.Error(w, "invalid chat settings", 400)
		return
	}
	operation := "options"
	if c.Harness == "amplifier" {
		operation = "settings"
	}
	available, err := h.call(ctx, operation, map[string]any{"sessionId": id})
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	var current struct {
		Bundle   string `json:"bundle"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Effort   string `json:"effort"`
		Models   []struct {
			ID      string   `json:"id"`
			Efforts []string `json:"efforts"`
		} `json:"models"`
		Bundles   []string `json:"bundles"`
		Providers []string `json:"providers"`
	}
	if json.Unmarshal(available, &current) != nil {
		http.Error(w, "invalid harness settings", 502)
		return
	}
	if req.Bundle == "" {
		req.Bundle = current.Bundle
	}
	if req.Provider == "" {
		req.Provider = current.Provider
	}
	if _, ok := fields["model"]; !ok {
		req.Model = c.Model
		if req.Model == "" {
			req.Model = current.Model
		}
	}
	if _, ok := fields["effort"]; !ok {
		req.Effort = c.Effort
		if req.Effort == "" {
			req.Effort = current.Effort
		}
	}
	if c.Harness == "amplifier" {
		valid := func(values []string, value string) bool {
			for _, item := range values {
				if item == value {
					return true
				}
			}
			return false
		}
		if !valid(current.Bundles, req.Bundle) || !valid(current.Providers, req.Provider) {
			http.Error(w, "unavailable Amplifier bundle or provider", 422)
			return
		}
	}
	if req.Model != "" && req.Model != current.Model {
		found := false
		for _, model := range current.Models {
			if model.ID == req.Model {
				found = true
				break
			}
		}
		if !found && c.Harness != "amplifier" {
			http.Error(w, "unavailable model", 422)
			return
		}
	}
	result, err := h.call(ctx, "select", map[string]any{"sessionId": id, "bundle": req.Bundle, "provider": req.Provider, "model": req.Model, "effort": req.Effort, "permission": permission, "mode": mode})
	if err != nil {
		http.Error(w, err.Error(), 422)
		return
	}
	var selected struct{ Bundle, Provider, Model, Effort string }
	if err := json.Unmarshal(result, &selected); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Lock()
	c.Bundle, c.Provider, c.Model, c.Effort = selected.Bundle, selected.Provider, selected.Model, selected.Effort
	c.Permission, c.Mode = permission, mode
	err = h.saveLocked(c)
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	var response map[string]any
	if json.Unmarshal(result, &response) != nil {
		response = map[string]any{}
	}
	response["permission"], response["mode"] = permission, mode
	response["permissions"], response["modes"] = sdkPermissions(c.Harness), sdkModes(c.Harness)
	writeSDKJSON(w, 200, response)
}
func sdkPermission(c *sdkChat) string {
	if c.Permission != "" {
		return c.Permission
	}
	return "full-permission"
}
func sdkMode(c *sdkChat) string {
	if c.Mode != "" {
		return c.Mode
	}
	return "agent"
}
func sdkPermissions(harness string) []string {
	if harness == "codex" {
		return []string{"read-only", "workspace-write", "full-permission"}
	}
	if harness == "claude" {
		return []string{"read-only", "full-permission"}
	}
	return []string{"full-permission"}
}
func sdkModes(harness string) []string {
	if harness == "amplifier" {
		return []string{"agent"}
	}
	return []string{"agent", "plan"}
}
func sdkContains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
func writeSDKJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func sdkProjectFolders(primary string, folders []string) ([]string, error) {
	seen := map[string]bool{primary: true}
	result := make([]string, 0, len(folders))
	if len(folders) > 20 {
		return nil, errors.New("at most 20 source folders are allowed")
	}
	for _, folder := range folders {
		if !filepath.IsAbs(folder) {
			return nil, errors.New("source folders must be absolute paths")
		}
		folder = filepath.Clean(folder)
		if seen[folder] {
			continue
		}
		info, err := os.Stat(folder)
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("source folder is not an existing directory: %s", folder)
		}
		seen[folder] = true
		result = append(result, folder)
	}
	return result, nil
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
	var req struct {
		Name, Path    string
		SourceFolders []string
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil || !filepath.IsAbs(req.Path) {
		http.Error(w, "absolute project path required", 400)
		return
	}
	req.Path = filepath.Clean(req.Path)
	folders, err := sdkProjectFolders(req.Path, req.SourceFolders)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if len([]rune(req.Name)) > 80 {
		http.Error(w, "project name must be at most 80 characters", 400)
		return
	}
	if req.Name == "" {
		req.Name = filepath.Base(req.Path)
	}
	p := &sdkProject{ID: sdkID(), Name: req.Name, Path: req.Path, SourceFolders: folders}
	h.mu.Lock()
	h.projects[p.ID] = p
	err = h.saveProjectsLocked()
	if err != nil {
		delete(h.projects, p.ID)
	}
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Lock()
	h.notifyCatalogLocked(p.ID)
	h.mu.Unlock()
	writeSDKJSON(w, 201, p)
}
func (s *Server) handleSDKProject(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	if r.Method == http.MethodPatch {
		var req struct {
			Name          *string   `json:"name"`
			Path          *string   `json:"path"`
			SourceFolders *[]string `json:"sourceFolders"`
			Pinned        *bool     `json:"pinned"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		if req.Name != nil {
			*req.Name = strings.TrimSpace(*req.Name)
			if *req.Name == "" || len([]rune(*req.Name)) > 80 {
				http.Error(w, "project name must be 1-80 characters", 400)
				return
			}
		}
		if req.Path != nil {
			if !filepath.IsAbs(*req.Path) {
				http.Error(w, "absolute primary folder required", 400)
				return
			}
			*req.Path = filepath.Clean(*req.Path)
			info, err := os.Stat(*req.Path)
			if err != nil || !info.IsDir() {
				http.Error(w, "primary folder must exist", 400)
				return
			}
		}
		h.mu.Lock()
		p := h.projects[id]
		if p == nil {
			h.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		previous := *p
		primary := p.Path
		if req.Path != nil {
			primary = *req.Path
		}
		folders := p.SourceFolders
		if req.SourceFolders != nil {
			folders = *req.SourceFolders
		}
		folders, err := sdkProjectFolders(primary, folders)
		if err != nil {
			h.mu.Unlock()
			http.Error(w, err.Error(), 400)
			return
		}
		p.Path, p.SourceFolders = primary, folders
		if req.Name != nil {
			p.Name = *req.Name
		}
		if req.Pinned != nil {
			p.Pinned = *req.Pinned
		}
		err = h.saveProjectsLocked()
		if err != nil {
			*p = previous
		}
		updated := *p
		h.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		h.mu.Lock()
		h.notifyCatalogLocked(id)
		h.mu.Unlock()
		writeSDKJSON(w, 200, updated)
		return
	}
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
	h.mu.Lock()
	h.notifyCatalogLocked(id)
	h.mu.Unlock()
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
			continue
		}
		// ReadDir reports symlinks separately. A link to a directory is still
		// a browsable server folder, including common linked work directories.
		if entry.Type()&os.ModeSymlink != 0 {
			info, statErr := os.Stat(filepath.Join(path, entry.Name()))
			if statErr == nil && info.IsDir() {
				folders = append(folders, entry.Name())
			}
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
	var req struct{ WorkspaceID, ProjectPath, Harness, Provider, Prompt, Goal, Approval, WorkMode string }
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	if req.Harness != "codex" && req.Harness != "claude" && req.Harness != "amplifier" {
		http.Error(w, "unsupported harness", 400)
		return
	}
	if strings.TrimSpace(req.Prompt) == "" && strings.TrimSpace(req.Goal) == "" {
		http.Error(w, "prompt or goal required", 400)
		return
	}
	if req.Goal != "" && req.Harness != "amplifier" {
		http.Error(w, "goal requires amplifier", 400)
		return
	}
	if req.Approval != "" && req.Approval != "never" {
		http.Error(w, "chat approval must be never", 400)
		return
	}
	req.Approval = "never"
	if req.Goal != "" {
		req.Prompt = req.Goal
	}
	// Older clients omit provider. Resolve that omission to the harness's
	// actual default before persisting the chat or starting its SDK session.
	if req.Provider == "" {
		switch req.Harness {
		case "codex":
			req.Provider = "openai"
		case "claude":
			req.Provider = "anthropic"
		case "amplifier":
			req.Provider = "configured"
		}
	}
	if req.Provider != "openai" && req.Provider != "anthropic" && req.Provider != "configured" {
		http.Error(w, "unsupported provider", 400)
		return
	}
	if (req.Provider == "openai" && req.Harness == "claude") ||
		(req.Provider == "anthropic" && req.Harness == "codex") ||
		(req.Provider == "configured" && req.Harness != "amplifier") {
		http.Error(w, "provider does not match harness", 400)
		return
	}
	sourceFolders := []string{}
	if req.WorkspaceID != "" {
		h.mu.Lock()
		p := h.projects[req.WorkspaceID]
		if p != nil {
			sourceFolders = append(sourceFolders, p.SourceFolders...)
		}
		h.mu.Unlock()
		if p == nil {
			http.Error(w, "project not found", 404)
			return
		}
		req.ProjectPath = p.Path
	}
	if req.WorkMode != "" && req.WorkMode != "local" && req.WorkMode != "worktree" {
		http.Error(w, "work mode must be local or worktree", 400)
		return
	}
	if req.WorkMode == "worktree" && req.WorkspaceID == "" {
		http.Error(w, "choose a project to create a worktree", 400)
		return
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
	chatID := sdkID()
	if req.WorkMode == "worktree" {
		root, err := exec.CommandContext(r.Context(), "git", "-C", req.ProjectPath, "rev-parse", "--show-toplevel").Output()
		if err != nil || strings.TrimSpace(string(root)) != req.ProjectPath {
			http.Error(w, "the project's primary folder must be a Git repository root to create a worktree", 400)
			return
		}
		worktree := filepath.Join(filepath.Dir(req.ProjectPath), filepath.Base(req.ProjectPath)+"-worktrees", "muxterm-"+chatID[:8])
		if err := os.MkdirAll(filepath.Dir(worktree), 0755); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if output, err := exec.CommandContext(r.Context(), "git", "-C", req.ProjectPath, "worktree", "add", "--detach", worktree, "HEAD").CombinedOutput(); err != nil {
			http.Error(w, "cannot create worktree: "+strings.TrimSpace(string(output)), 400)
			return
		}
		req.ProjectPath = worktree
	} else if err := os.MkdirAll(req.ProjectPath, 0755); err != nil {
		http.Error(w, "cannot create project folder: "+err.Error(), 400)
		return
	}
	title := strings.TrimSpace(req.Prompt)
	if len(title) > 70 {
		title = title[:70] + "…"
	}
	c := &sdkChat{ID: chatID, WorkspaceID: req.WorkspaceID, ProjectPath: req.ProjectPath, SourceFolders: sourceFolders, WorkMode: req.WorkMode, Title: title, TitleSource: "opening", Harness: req.Harness, Provider: req.Provider, Approval: req.Approval, Goal: req.Goal, State: "starting", CreatedAt: time.Now().UTC()}
	h.mu.Lock()
	h.chats[c.ID] = c
	err := h.saveLocked(c)
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Lock()
	h.notifyCatalogLocked(c.ID)
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if _, err = h.call(ctx, "start", map[string]any{"sessionId": c.ID, "harness": c.Harness, "cwd": c.ProjectPath, "sourceFolders": c.SourceFolders, "provider": amplifierProviderModule(c.Harness, c.Provider), "approval": c.Approval}); err != nil {
		h.appendEvent(sdkEvent{SessionID: c.ID, Type: "error", Message: err.Error()})
		http.Error(w, fmt.Sprintf("chat %s could not start: %v", c.ID, err), 502)
		return
	}
	openingID := sdkID()
	result, err := h.call(ctx, "send", map[string]any{"sessionId": c.ID, "input": map[string]any{"kind": "user", "source": "browser", "id": openingID, "content": req.Prompt, "goal": req.Goal}})
	if err == nil {
		var ack struct{ Status, InputID string }
		err = json.Unmarshal(result, &ack)
		if err == nil && (ack.Status != "accepted" || ack.InputID != openingID) {
			err = fmt.Errorf("sidecar did not confirm opening input %s", openingID)
		}
	}
	if err != nil {
		message := fmt.Sprintf("chat %s opening turn acceptance uncertain: %v", c.ID, err)
		h.appendEvent(sdkEvent{SessionID: c.ID, Type: "session.uncertain", Message: message})
		http.Error(w, message, 502)
		return
	}
	writeSDKJSON(w, 201, c)
}

// Search the existing per-chat event journals without changing their format.
// Only accepted input and assistant text are searchable; tool payloads and
// thinking events are excluded. A small overlap catches phrases split across
// assistant.delta frames within one turn.
func (s *Server) handleSDKChatContentSearch(w http.ResponseWriter, r *http.Request) {
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if query == "" || len(query) > 512 {
		http.Error(w, "query must be 1-512 bytes", http.StatusBadRequest)
		return
	}
	h := s.sdkChats
	h.mu.Lock()
	ids := make([]string, 0, len(h.chats))
	for id := range h.chats {
		ids = append(ids, id)
	}
	h.mu.Unlock()
	sort.Strings(ids)
	matches := []string{}
	for _, id := range ids {
		file, err := os.Open(filepath.Join(h.dir, id+".ndjson"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 64<<10), 16<<20)
		assistantTail := ""
		matched := false
		for scanner.Scan() {
			var event sdkEvent
			if json.Unmarshal(scanner.Bytes(), &event) != nil {
				continue
			}
			switch event.Type {
			case "input.accepted":
				assistantTail = ""
				matched = strings.Contains(strings.ToLower(event.Text), query)
			case "assistant.delta":
				text := assistantTail + strings.ToLower(event.Text)
				matched = strings.Contains(text, query)
				if len(text) >= len(query) {
					assistantTail = text[len(text)-len(query)+1:]
				} else {
					assistantTail = text
				}
			case "turn.completed", "error":
				assistantTail = ""
			}
			if matched {
				break
			}
		}
		scanErr := scanner.Err()
		_ = file.Close()
		if scanErr != nil {
			http.Error(w, scanErr.Error(), http.StatusInternalServerError)
			return
		}
		if matched {
			matches = append(matches, id)
		}
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"ids": matches})
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
	case "PATCH":
		var req struct {
			Title    string `json:"title"`
			Archived *bool  `json:"archived"`
			Pinned   *bool  `json:"pinned"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		if (req.Archived != nil || req.Pinned != nil) && req.Title == "" {
			h.mu.Lock()
			previousArchived, previousPinned := c.Archived, c.Pinned
			if req.Archived != nil {
				c.Archived = *req.Archived
			}
			if req.Pinned != nil {
				c.Pinned = *req.Pinned
			}
			err := h.saveLocked(c)
			if err != nil {
				c.Archived, c.Pinned = previousArchived, previousPinned
			}
			updated := *c
			if err == nil {
				h.notifyCatalogLocked(id)
			}
			h.mu.Unlock()
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			writeSDKJSON(w, 200, updated)
			return
		}
		if strings.TrimSpace(req.Title) == "" || len([]rune(req.Title)) > 80 {
			http.Error(w, "title must be 1-80 characters", 400)
			return
		}
		name := strings.TrimSpace(req.Title)
		nameLock := h.nameLock(id)
		nameLock.Lock()
		defer nameLock.Unlock()
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		if err := h.resume(ctx, c); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		if _, err := h.call(ctx, "title", map[string]any{"sessionId": id, "mode": "manual", "name": name}); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		h.mu.Lock()
		c.Title, c.TitleSource = name, "manual"
		err := h.saveLocked(c)
		updated := *c
		h.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		h.appendEvent(sdkEvent{SessionID: id, Type: "session.renamed", Name: name})
		writeSDKJSON(w, 200, updated)
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
		if req.Kind != "user" && req.Kind != "service" && req.Kind != "steer" && !(c.Harness == "amplifier" && (req.Kind == "cancel_job" || req.Kind == "stop")) {
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
		if req.Kind == "steer" && c.State != "working" {
			http.Error(w, "No active turn to steer", 409)
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
		// A cold Amplifier resume can take longer than ten seconds before it can
		// accept the input. Keep the HTTP request open until the harness returns
		// its receipt so the browser does not invite a duplicate retry.
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		if err := h.resume(ctx, c); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		content := req.Content
		if req.Kind == "user" || req.Kind == "steer" {
			content = sdkTaskInputWithVoiceContext(content, h.recentVoiceContext(id))
		}
		result, err := h.call(ctx, "send", map[string]any{"sessionId": id, "input": map[string]any{"kind": req.Kind, "source": req.Source, "id": req.ID, "content": content, "displayContent": req.Content, "attachments": attachments, "model": c.Model, "effort": c.Effort}})
		if err != nil {
			http.Error(w, err.Error(), 422)
			return
		}
		writeSDKJSON(w, 202, result)
	default:
		http.Error(w, "method not allowed", 405)
	}
}
func (s *Server) handleSDKChatInterrupt(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	c := h.chats[id]
	if c == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	chat := *c
	h.mu.Unlock()
	if chat.State != "working" {
		http.Error(w, "No active turn to stop", 409)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := h.resume(ctx, &chat); err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	result, err := h.call(ctx, "interrupt", map[string]any{"sessionId": id})
	if err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	writeSDKJSON(w, 202, json.RawMessage(result))
}

func (s *Server) handleSDKChatNameEvents(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	ch := make(chan string, 32)
	h.mu.Lock()
	h.nameStreams[ch] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if _, ok := h.nameStreams[ch]; ok {
			delete(h.nameStreams, ch)
			close(ch)
		}
		h.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	fmt.Fprint(w, ": connected\n\n")
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	for {
		select {
		case id, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", jsonString(map[string]string{"id": id}))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) handleSDKChatEvents(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	afterValue := r.URL.Query().Get("after")
	var after int64
	if afterValue != "" {
		var err error
		after, err = strconv.ParseInt(afterValue, 10, 64)
		if err != nil || after < 0 {
			http.Error(w, "invalid event cursor", 400)
			return
		}
		if last, err := strconv.ParseInt(r.Header.Get("Last-Event-ID"), 10, 64); err == nil && last > after {
			after = last
		}
	}
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
	path := filepath.Join(h.dir, id+".ndjson")
	var end int64
	if info, err := os.Stat(path); err == nil {
		end = info.Size()
	}
	if afterValue != "" && after > end {
		delete(h.streams[id], ch)
		close(ch)
		h.mu.Unlock()
		http.Error(w, "event cursor beyond log", 400)
		return
	}
	chat := *c
	var data []byte
	if afterValue == "" {
		data, _ = os.ReadFile(path)
	}
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
	fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", jsonString(chat))
	if afterValue != "" {
		if _, err := sdkStreamLog(w, path, after, end); err != nil {
			return
		}
	} else {
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			if line != "" {
				fmt.Fprintf(w, "event: sdk\ndata: %s\n\n", line)
			}
		}
	}
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	cursor := end
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
			h.mu.Lock()
			info, statErr := os.Stat(path)
			h.mu.Unlock()
			if statErr == nil {
				next, err := sdkStreamLog(w, path, cursor, info.Size())
				cursor = next
				if err != nil {
					return
				}
			}
		case <-r.Context().Done():
			return
		}
	}
}
func jsonString(v any) string { b, _ := json.Marshal(v); return string(b) }
