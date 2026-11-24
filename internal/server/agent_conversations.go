package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

// AgentConversationLink joins a source-owned conversation to a Go-owned chat.
// The source platform retains its original messages and audience.
type AgentConversationLink struct {
	AgentID            string    `json:"agentId"`
	ConnectionID       string    `json:"connectionId"`
	SourceConversation string    `json:"sourceConversation"`
	ChatID             string    `json:"chatId"`
	CreatedAt          time.Time `json:"createdAt"`
}

func agentConversationKey(agentID, connectionID, sourceConversation string) string {
	sum := sha256.Sum256([]byte(agentID + "\x00" + connectionID + "\x00" + sourceConversation))
	return hex.EncodeToString(sum[:])
}

func (h *sdkChatHost) loadAgentConversations() error {
	data, err := os.ReadFile(filepath.Join(h.dir, "agent-conversations.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read agent conversation links: %w", err)
	}
	var links map[string]*AgentConversationLink
	if err := json.Unmarshal(data, &links); err != nil {
		return fmt.Errorf("invalid agent conversation links: %w", err)
	}
	if links == nil {
		return fmt.Errorf("invalid agent conversation links: expected an object")
	}
	for key, link := range links {
		if link == nil || key != agentConversationKey(link.AgentID, link.ConnectionID, link.SourceConversation) ||
			h.agents[link.AgentID] == nil || h.chats[link.ChatID] == nil || h.chats[link.ChatID].AgentID != link.AgentID {
			return fmt.Errorf("invalid agent conversation link %q", key)
		}
	}
	h.agentConversations = links
	return nil
}

func (h *sdkChatHost) saveAgentConversationsLocked() error {
	data, err := json.MarshalIndent(h.agentConversations, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(h.dir, 0700); err != nil {
		return err
	}
	return atomicfile.Write(filepath.Join(h.dir, "agent-conversations.json"), append(data, '\n'), 0600)
}

// linkAgentConversationLocked is idempotent. It never silently moves a
// source conversation to another chat after a reconnect or lost receipt.
func (h *sdkChatHost) linkAgentConversationLocked(link AgentConversationLink) (AgentConversationLink, bool, error) {
	if h.agents[link.AgentID] == nil {
		return AgentConversationLink{}, false, errors.New("unknown agent")
	}
	chat := h.chats[link.ChatID]
	if chat == nil || chat.Archived || chat.AgentID != link.AgentID {
		return AgentConversationLink{}, false, errors.New("chat is unavailable or belongs to another agent")
	}
	key := agentConversationKey(link.AgentID, link.ConnectionID, link.SourceConversation)
	if prior := h.agentConversations[key]; prior != nil {
		if prior.ChatID != link.ChatID {
			return AgentConversationLink{}, false, errors.New("source conversation is already linked to another chat")
		}
		return *prior, false, nil
	}
	link.CreatedAt = time.Now().UTC()
	h.agentConversations[key] = &link
	if err := h.saveAgentConversationsLocked(); err != nil {
		delete(h.agentConversations, key)
		return AgentConversationLink{}, false, err
	}
	return link, true, nil
}

// LinkAgentConnectionConversation is the in-process connector seam for
// associating an authorized source conversation with an existing agent chat.
// Connector implementations validate source identity before calling it.
func (s *Server) LinkAgentConnectionConversation(agentID, connectionID, sourceConversation, chatID string) (AgentConversationLink, bool, error) {
	if agentID == "" || len(agentID) > 128 || connectionID == "" || len(connectionID) > 128 ||
		sourceConversation == "" || len(sourceConversation) > 2048 || chatID == "" || len(chatID) > 128 {
		return AgentConversationLink{}, false, errors.New("invalid agent conversation link")
	}
	h := s.sdkChats
	if h.agentDataErr != nil {
		return AgentConversationLink{}, false, fmt.Errorf("agent registry unavailable: %w", h.agentDataErr)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.linkAgentConversationLocked(AgentConversationLink{AgentID: agentID, ConnectionID: connectionID, SourceConversation: sourceConversation, ChatID: chatID})
}

func (s *Server) handleAgentInstanceConversations(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h := s.sdkChats
	if h.agentDataErr != nil {
		http.Error(w, "agent registry unavailable: "+h.agentDataErr.Error(), http.StatusServiceUnavailable)
		return
	}
	if r.Method == http.MethodGet {
		h.mu.Lock()
		if h.agents[id] == nil {
			h.mu.Unlock()
			http.NotFound(w, r)
			return
		}
		links := make([]AgentConversationLink, 0)
		for _, link := range h.agentConversations {
			if link.AgentID == id {
				links = append(links, *link)
			}
		}
		h.mu.Unlock()
		sort.Slice(links, func(i, j int) bool { return links[i].CreatedAt.Before(links[j].CreatedAt) })
		writeSDKJSON(w, http.StatusOK, map[string]any{"conversations": links})
		return
	}
	if !humanBrowserRequest(r) {
		http.Error(w, "linking a conversation requires a human browser", http.StatusForbidden)
		return
	}
	var req struct {
		ConnectionID       string `json:"connectionId"`
		SourceConversation string `json:"sourceConversation"`
		ChatID             string `json:"chatId"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 8192)).Decode(&req) != nil ||
		strings.TrimSpace(req.ConnectionID) == "" || len(req.ConnectionID) > 128 ||
		strings.TrimSpace(req.SourceConversation) == "" || len(req.SourceConversation) > 2048 ||
		strings.TrimSpace(req.ChatID) == "" || len(req.ChatID) > 128 {
		http.Error(w, "connectionId, sourceConversation, and chatId are required", http.StatusBadRequest)
		return
	}
	h.mu.Lock()
	link, created, err := h.linkAgentConversationLocked(AgentConversationLink{
		AgentID: id, ConnectionID: req.ConnectionID,
		SourceConversation: req.SourceConversation, ChatID: req.ChatID,
	})
	h.mu.Unlock()
	if err != nil {
		status := http.StatusConflict
		if err.Error() == "unknown agent" {
			status = http.StatusNotFound
		}
		http.Error(w, err.Error(), status)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeSDKJSON(w, status, link)
}
