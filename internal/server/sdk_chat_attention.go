package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// Attention is a session choice, separate from subscriptions. The Amplifier
// hook reads this only when a turn is already running; it never wakes a chat.
type sdkInboxAttention struct {
	Mode   string `json:"mode"`
	Cursor int64  `json:"cursor"`
}

func (h *sdkChatHost) inboxAttentionPath(id string) string {
	return filepath.Join(h.dir, "inbox-attention", id+".json")
}

func (h *sdkChatHost) readInboxAttentionLocked(id string) (sdkInboxAttention, error) {
	data, err := os.ReadFile(h.inboxAttentionPath(id))
	if errors.Is(err, os.ErrNotExist) {
		return sdkInboxAttention{Mode: "manual"}, nil
	}
	if err != nil {
		return sdkInboxAttention{}, err
	}
	var attention sdkInboxAttention
	if err := json.Unmarshal(data, &attention); err != nil {
		return sdkInboxAttention{}, err
	}
	if attention.Mode != "manual" && attention.Mode != "reminder" {
		return sdkInboxAttention{}, errors.New("invalid stored inbox attention mode")
	}
	return attention, nil
}

func (h *sdkChatHost) saveInboxAttentionLocked(id string, attention sdkInboxAttention) error {
	data, err := json.Marshal(attention)
	if err != nil {
		return err
	}
	path := h.inboxAttentionPath(id)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0600)
}

func (s *Server) handleSDKInboxAttention(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.chats[id] == nil {
		http.NotFound(w, r)
		return
	}
	attention, err := h.readInboxAttentionLocked(id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if r.Method == http.MethodPost {
		var req struct {
			Mode string `json:"mode"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || (req.Mode != "manual" && req.Mode != "reminder") {
			http.Error(w, "mode must be manual or reminder", 400)
			return
		}
		attention.Mode = req.Mode
		if err := h.saveInboxAttentionLocked(id, attention); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}
	writeSDKJSON(w, 200, attention)
}

func (s *Server) handleSDKInboxAttentionAck(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Cursor int64 `json:"cursor"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || req.Cursor < 0 {
		http.Error(w, "nonnegative cursor required", 400)
		return
	}
	h := s.sdkChats
	id := r.PathValue("id")
	var inboxSize int64
	var statErr error
	if req.Cursor > 0 {
		var info os.FileInfo
		info, statErr = os.Stat(h.inboxPath(id))
		if statErr == nil {
			inboxSize = info.Size()
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.chats[id] == nil {
		http.NotFound(w, r)
		return
	}
	attention, err := h.readInboxAttentionLocked(id)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if req.Cursor > attention.Cursor {
		if statErr != nil || req.Cursor > inboxSize {
			http.Error(w, "cursor beyond inbox", 400)
			return
		}
		attention.Cursor = req.Cursor
		if err := h.saveInboxAttentionLocked(id, attention); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
	}
	writeSDKJSON(w, 200, attention)
}
