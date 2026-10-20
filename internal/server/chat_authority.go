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

func (s *Server) chatAuthorityBoundary(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if humanBrowserRequest(r) {
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
