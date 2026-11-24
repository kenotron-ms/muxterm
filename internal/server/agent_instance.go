package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// agentInstance is a stable participant. Its chats are execution and
// conversation records, and the selected harness is only a default for new
// chats. A process restart or a different harness does not change this ID.
type agentInstance struct {
	ID                 string    `json:"id"`
	Name               string    `json:"name"`
	DefaultHarness     string    `json:"defaultHarness,omitempty"`
	DefaultProjectPath string    `json:"defaultProjectPath,omitempty"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

// Internal connectors set this unexported context key only after validating
// their source identity and selected agent. It cannot be supplied over HTTP.
type agentLinkContextKey struct{}

func (h *sdkChatHost) loadAgents() error {
	data, err := os.ReadFile(filepath.Join(h.dir, "agent-instances.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read agent registry: %w", err)
	}
	var agents map[string]*agentInstance
	if err := json.Unmarshal(data, &agents); err != nil {
		return fmt.Errorf("invalid agent registry: %w", err)
	}
	if agents == nil {
		return fmt.Errorf("invalid agent registry: expected an object")
	}
	for id, agent := range agents {
		if agent == nil || id == "" || agent.ID != id || agent.Name == "" || !validWorkHarness(agent.DefaultHarness) || (agent.DefaultProjectPath != "" && !filepath.IsAbs(agent.DefaultProjectPath)) {
			return fmt.Errorf("invalid agent registry entry %q", id)
		}
	}
	h.agents = agents
	return nil
}

func (h *sdkChatHost) saveAgentsLocked() error {
	data, err := json.MarshalIndent(h.agents, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(h.dir, "agent-instances.json"), append(data, '\n'), 0600)
}

func (s *Server) handleAgentInstances(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	if h.agentDataErr != nil {
		http.Error(w, "agent registry unavailable: "+h.agentDataErr.Error(), http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodGet {
		h.mu.Lock()
		agents := make([]agentInstance, 0, len(h.agents))
		for _, agent := range h.agents {
			agents = append(agents, *agent)
		}
		h.mu.Unlock()
		sort.Slice(agents, func(i, j int) bool { return agents[i].CreatedAt.Before(agents[j].CreatedAt) })
		writeSDKJSON(w, http.StatusOK, map[string]any{"agents": agents})
		return
	}
	if !humanBrowserRequest(r) {
		http.Error(w, "creating an agent instance requires a human browser", http.StatusForbidden)
		return
	}
	var req struct {
		Name               string `json:"name"`
		DefaultHarness     string `json:"defaultHarness"`
		DefaultProjectPath string `json:"defaultProjectPath"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req) != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" || len([]rune(req.Name)) > 80 {
		http.Error(w, "name must contain 1-80 characters", http.StatusBadRequest)
		return
	}
	if !validWorkHarness(req.DefaultHarness) {
		http.Error(w, "unknown default harness", http.StatusBadRequest)
		return
	}
	if req.DefaultProjectPath != "" && !filepath.IsAbs(req.DefaultProjectPath) {
		http.Error(w, "default project path must be absolute", http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	agent := &agentInstance{ID: sdkID(), Name: req.Name, DefaultHarness: req.DefaultHarness, DefaultProjectPath: req.DefaultProjectPath, CreatedAt: now, UpdatedAt: now}
	if agent.DefaultProjectPath != "" {
		agent.DefaultProjectPath = filepath.Clean(agent.DefaultProjectPath)
	}
	h.mu.Lock()
	h.agents[agent.ID] = agent
	if err := h.saveAgentsLocked(); err != nil {
		delete(h.agents, agent.ID)
		h.mu.Unlock()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	h.mu.Unlock()
	writeSDKJSON(w, http.StatusCreated, agent)
}

func (s *Server) handleAgentInstanceChats(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h := s.sdkChats
	if h.agentDataErr != nil {
		http.Error(w, "agent registry unavailable: "+h.agentDataErr.Error(), http.StatusServiceUnavailable)
		return
	}
	h.mu.Lock()
	if h.agents[id] == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	chats := make([]sdkChat, 0)
	for _, chat := range h.chats {
		if chat.AgentID == id {
			chats = append(chats, *chat)
		}
	}
	h.mu.Unlock()
	sort.Slice(chats, func(i, j int) bool { return chats[i].CreatedAt.Before(chats[j].CreatedAt) })
	writeSDKJSON(w, http.StatusOK, map[string]any{"chats": chats})
}
