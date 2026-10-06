package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

type chatUINavigation struct {
	Action    string `json:"action"`
	SessionID string `json:"session_id"`
	Mode      string `json:"mode,omitempty"`
	Tab       string `json:"tab,omitempty"`
	Path      string `json:"path,omitempty"`
}

// handleChatUINavigation validates a requested view before relaying it to
// browsers. File paths use the same os.Root boundary as the chat's Files API.
func (s *Server) handleChatUINavigation(w http.ResponseWriter, r *http.Request) {
	var nav chatUINavigation
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&nav); err != nil {
		writeSDKJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid navigation request"})
		return
	}
	s.sdkChats.mu.Lock()
	chat := s.sdkChats.chats[nav.SessionID]
	projectPath := ""
	if chat != nil {
		projectPath = chat.ProjectPath
	}
	s.sdkChats.mu.Unlock()
	if chat == nil {
		writeSDKJSON(w, http.StatusNotFound, map[string]string{"error": "chat not found"})
		return
	}
	switch nav.Action {
	case "chat":
	case "panel":
		if nav.Mode != "chat" && nav.Mode != "split" {
			writeSDKJSON(w, http.StatusBadRequest, map[string]string{"error": "agent navigation mode must be chat or split"})
			return
		}
	case "tab":
		if nav.Tab != "plan" && nav.Tab != "files" && nav.Tab != "pr" && nav.Tab != "trajectory" {
			writeSDKJSON(w, http.StatusBadRequest, map[string]string{"error": "unknown chat tab"})
			return
		}
	case "file":
		if !filepath.IsAbs(nav.Path) {
			writeSDKJSON(w, http.StatusBadRequest, map[string]string{"error": "absolute file path required"})
			return
		}
		rel, err := filepath.Rel(projectPath, filepath.Clean(nav.Path))
		if err != nil || !filepath.IsLocal(rel) {
			writeSDKJSON(w, http.StatusBadRequest, map[string]string{"error": "file is outside this chat's folder"})
			return
		}
		root, err := os.OpenRoot(projectPath)
		if err != nil {
			writeSDKJSON(w, http.StatusNotFound, map[string]string{"error": "chat folder unavailable"})
			return
		}
		file, err := root.Open(rel)
		root.Close()
		if err != nil {
			writeSDKJSON(w, http.StatusNotFound, map[string]string{"error": "file unavailable"})
			return
		}
		info, err := file.Stat()
		file.Close()
		if err != nil || !info.Mode().IsRegular() {
			writeSDKJSON(w, http.StatusBadRequest, map[string]string{"error": "path is not a regular file"})
			return
		}
		nav.Path = rel
	default:
		writeSDKJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("unknown navigation action %q", nav.Action)})
		return
	}
	count := s.hub.BroadcastChatUINavigation(nav)
	writeSDKJSON(w, http.StatusOK, map[string]any{"navigation": nav, "browsers": count})
}
