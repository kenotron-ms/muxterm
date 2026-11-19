package server

import (
	"crypto/subtle"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
)

func (server *Server) connectionRequestOwner(request *http.Request) string {
	if server.noAuth {
		return "user:local"
	}
	var token string
	if value, ok := bearerToken(request); ok {
		token = value
	}
	if token == "" {
		if cookie, err := request.Cookie(SessionCookieName); err == nil {
			token = cookie.Value
		}
	}
	if token != "" && server.authSrv != nil {
		if info, err := server.authSrv.Manager().LoadAccessToken(request.Context(), token); err == nil && info.GetUserID() != "" {
			return "user:" + info.GetUserID()
		}
	}
	if token != "" && server.localToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(server.localToken)) == 1 {
		return "user:local"
	}
	if token != "" {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(request.URL.Hostname()), ".")
	if host == "" {
		parsed, err := url.Parse("http://" + request.Host)
		if err == nil {
			host = strings.TrimSuffix(strings.ToLower(parsed.Hostname()), ".")
		}
	}
	address := net.ParseIP(host)
	if !server.behindReverseProxy && IsLocalhost(request) && (host == "localhost" || (address != nil && address.IsLoopback())) {
		return "user:local"
	}
	return ""
}

func (server *Server) connectionRequestMutation(writer http.ResponseWriter, request *http.Request) bool {
	if request.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(writer, "Cross-site request denied", http.StatusForbidden)
		return false
	}
	if request.Header.Get("X-Muxterm-Connection-Request") != "1" {
		http.Error(writer, "Missing connection request header", http.StatusForbidden)
		return false
	}
	if origin := request.Header.Get("Origin"); origin != "" {
		parsed, err := url.Parse(origin)
		expected := request.Host
		expectedScheme := "http"
		if request.TLS != nil {
			expectedScheme = "https"
		}
		if base := server.publicBaseURL(); base != "" {
			if configured, err := url.Parse(base); err == nil {
				expected = configured.Host
				expectedScheme = configured.Scheme
			}
		}
		if err != nil || parsed.Host != expected || parsed.Scheme != expectedScheme {
			http.Error(writer, "Cross-origin request denied", http.StatusForbidden)
			return false
		}
	}
	return true
}

func connectionRequestJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Cache-Control", "no-store")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func connectionRequestDecode(writer http.ResponseWriter, request *http.Request, value any) bool {
	request.Body = http.MaxBytesReader(writer, request.Body, 48<<10)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		http.Error(writer, "Invalid connection request", http.StatusBadRequest)
		return false
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		http.Error(writer, "Only one connection request is allowed", http.StatusBadRequest)
		return false
	}
	return true
}
