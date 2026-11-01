package server

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

func (s *Server) agentBrowserControlRequest(r *http.Request) bool {
	if r.Header.Get("X-Muxterm-Agent") != "1" || s.browserAssistant.localToken == "" {
		return false
	}
	token, ok := bearerToken(r)
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.browserAssistant.localToken)) != 1 {
		return false
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 5 || parts[0] != "api" || parts[1] != "browser-assistant" || parts[2] != "connections" || parts[3] == "" {
		return false
	}
	return (r.Method == http.MethodPost && (parts[4] == "commands" || parts[4] == "requests")) ||
		(r.Method == http.MethodDelete && parts[4] == "control")
}

// Agent Chat requests are limited to discovery, creation, transcript/status
// reads, and idempotent message admission. A same-user local token authenticates
// the MCP process; goal controls retain their separate origin and ledger rules.
func (s *Server) agentChatRequest(r *http.Request) bool {
	if r.Header.Get("X-Muxterm-Agent") != "1" || s.browserAssistant.localToken == "" {
		return false
	}
	token, ok := bearerToken(r)
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.browserAssistant.localToken)) != 1 || !agentChatPathAllowed(r.Method, r.URL.Path) {
		return false
	}
	// A session capability may change only that session's subscriptions,
	// attention, or published topics. The same-user MCP client without a
	// session capability acts as an external tool, as for control-send.
	if r.Method != http.MethodGet && r.Method != http.MethodHead && r.Header.Get("X-Muxterm-Origin") != "" {
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/sdk-chats/"), "/")
		if strings.HasPrefix(r.URL.Path, "/api/sdk-chats/") && len(parts) > 1 &&
			(parts[1] == "subscriptions" || parts[1] == "inbox-attention" || parts[1] == "topics") {
			s.sdkChats.mu.Lock()
			origin, valid := s.sdkChats.controlOriginLocked(r.Header.Get("X-Muxterm-Origin"), parts[0])
			s.sdkChats.mu.Unlock()
			return valid && (origin.ChatID == parts[0] || origin.Relation == "operator-to-lane" || origin.Relation == "lane-to-operator")
		}
	}
	return true
}

func (s *Server) agentRemoteChatRequest(r *http.Request) bool {
	if r.Header.Get("X-Muxterm-Agent") != "1" || s.browserAssistant.localToken == "" {
		return false
	}
	token, ok := bearerToken(r)
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.browserAssistant.localToken)) != 1 {
		return false
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/remote-chat/"+r.PathValue("id"))
	return r.PathValue("id") != "" && path != r.URL.Path && agentChatPathAllowed(r.Method, path)
}

func agentChatPathAllowed(method, path string) bool {
	if path == "/api/sdk-work" {
		return method == http.MethodGet || method == http.MethodPost
	}
	if strings.HasPrefix(path, "/api/sdk-work/") {
		parts := strings.Split(strings.TrimPrefix(path, "/api/sdk-work/"), "/")
		return (len(parts) == 1 && parts[0] != "" && method == http.MethodGet) ||
			(len(parts) == 2 && parts[0] != "" && parts[1] == "updates" && method == http.MethodPost)
	}
	if path == "/api/sdk-chats" {
		return method == http.MethodGet || method == http.MethodPost
	}
	if path == "/api/sdk-projects" || path == "/api/sdk-chats/search-content" {
		return method == http.MethodGet
	}
	if !strings.HasPrefix(path, "/api/sdk-chats/") {
		return false
	}
	parts := strings.Split(strings.TrimPrefix(path, "/api/sdk-chats/"), "/")
	if len(parts) == 0 || parts[0] == "" {
		return false
	}
	if len(parts) == 1 {
		return method == http.MethodGet
	}
	if len(parts) == 2 {
		switch parts[1] {
		case "subscriptions", "inbox-attention":
			return method == http.MethodGet || method == http.MethodPost
		case "inbox":
			return method == http.MethodGet
		case "topics":
			return method == http.MethodPost
		}
	}
	if len(parts) == 3 {
		if parts[1] == "subscriptions" && parts[2] != "" && method == http.MethodDelete {
			return true
		}
		if parts[1] == "inbox-attention" && parts[2] == "ack" && method == http.MethodPost {
			return true
		}
	}
	if len(parts) == 3 && parts[1] == "control-notes" && parts[2] != "" {
		return method == http.MethodPut
	}
	if len(parts) == 4 && parts[1] == "control-notes" && parts[2] != "" && parts[3] == "append" {
		return method == http.MethodPost
	}
	if len(parts) != 2 {
		return false
	}
	switch parts[1] {
	case "history", "control-history":
		return method == http.MethodGet
	case "control-send":
		return method == http.MethodPost
	case "control-notes":
		return method == http.MethodPost
	default:
		return false
	}
}

// A remote chat bridge is reached only after the home server has accepted a
// human browser request. Its same-user helper token is scoped here to chat and
// project operations; goal controls and operator authority stay on their
// existing, narrower paths.
func (s *Server) remoteChatBridgeRequest(r *http.Request) bool {
	if r.Header.Get("X-Muxterm-Remote-Chat") != "1" || r.Header.Get("Sec-Fetch-Site") != "same-origin" || r.Header.Get("X-Muxterm-Agent") != "" || s.browserAssistant.localToken == "" {
		return false
	}
	token, ok := bearerToken(r)
	if !ok || subtle.ConstantTimeCompare([]byte(token), []byte(s.browserAssistant.localToken)) != 1 {
		return false
	}
	path := r.URL.Path
	if strings.HasPrefix(path, "/api/sdk-chats/") {
		if strings.HasSuffix(path, "/goal") {
			return r.Method == http.MethodGet
		}
		if strings.HasSuffix(path, "/control-send") || strings.HasSuffix(path, "/operator") {
			return false
		}
	}
	return path == "/api/sdk-chats" || strings.HasPrefix(path, "/api/sdk-chats/") ||
		path == "/api/sdk-work" || strings.HasPrefix(path, "/api/sdk-work/") ||
		path == "/api/sdk-projects" || strings.HasPrefix(path, "/api/sdk-projects/") ||
		path == "/api/sdk-folders" || path == "/api/sdk-chat-start-options" ||
		path == "/api/sdk-chat-catalog" || strings.HasPrefix(path, "/api/sdk-chat-attachments")
}

func (s *Server) chatAuthorityBoundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if humanBrowserRequest(r) || s.remoteChatBridgeRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		if s.agentBrowserControlRequest(r) || s.agentChatRequest(r) || s.agentRemoteChatRequest(r) {
			next.ServeHTTP(w, r)
			return
		}
		path := r.URL.Path
		goalRoute := strings.HasPrefix(path, "/api/sdk-chats/") && strings.HasSuffix(path, "/goal")
		sendRoute := strings.HasPrefix(path, "/api/sdk-chats/") && strings.HasSuffix(path, "/control-send")
		if goalRoute || sendRoute {
			token := r.Header.Get("X-Muxterm-Origin")
			s.sdkChats.mu.Lock()
			origin, valid := s.sdkChats.controlOriginLocked(token, r.PathValue("id"))
			if goalRoute && r.PathValue("id") == "self" && valid && token != "" {
				r.SetPathValue("id", origin.ChatID)
				origin, valid = s.sdkChats.controlOriginLocked(token, origin.ChatID)
			}
			s.sdkChats.mu.Unlock()
			if token == "" || !valid || (origin.ChatID != r.PathValue("id") && origin.Relation != "operator-to-lane" && origin.Relation != "lane-to-operator") {
				http.Error(w, "owner or direct operator/lane capability required", 403)
				return
			}
		} else if ((strings.HasPrefix(path, "/api/sdk-") || strings.HasPrefix(path, "/api/browser-assistant")) && r.Method != http.MethodGet && r.Method != http.MethodHead) || r.Header.Get("Upgrade") != "" {
			http.Error(w, "agent mutation requires a scoped control endpoint; browser controls remain human-only", 403)
			return
		}
		next.ServeHTTP(w, r)
	})
}
