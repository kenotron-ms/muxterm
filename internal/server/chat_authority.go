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
		if s.agentBrowserControlRequest(r) {
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
