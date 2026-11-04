package server

import (
	"net/http"
	"strings"
)

// SDK-owned MCP processes attach the chat capability to every local request.
// Keep a chat's history, pages, settings, and controls within that chat or an
// already established direct operator/lane relationship. Browser and external
// local clients keep their existing authentication path.
func (s *Server) sdkChatOriginBoundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("X-Muxterm-Origin")
		if token == "" && r.Header.Get("X-Muxterm-Agent") != "1" {
			next.ServeHTTP(w, r)
			return
		}
		if token == "" {
			http.Error(w, "chat capability required", http.StatusForbidden)
			return
		}

		h := s.sdkChats
		h.mu.Lock()
		senderID := h.originTokenChats[token]
		sender := h.chats[senderID]
		allowed := sender != nil && !sender.Archived && h.originTokens[senderID] == token
		path := strings.TrimPrefix(r.URL.Path, "/api/sdk-chats/")
		if allowed && path != r.URL.Path && path != "search-content" {
			targetID := strings.SplitN(path, "/", 2)[0]
			if targetID == "self" {
				targetID = senderID
			}
			_, allowed = h.authorizedControlSenderLocked(token, targetID)
			if allowed && path == targetID+"/operator" {
				// Only a human may enable operator mode or replace its lane set.
				// An enabled operator may still link a lane through its dedicated
				// POST route, as the operator tool contract requires.
				if r.Method == http.MethodPatch ||
					(r.Method == http.MethodPost && (senderID != targetID || !sender.Operator)) {
					allowed = false
				}
			}
		}
		h.mu.Unlock()
		if !allowed {
			http.Error(w, "chat capability does not authorize this request", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
