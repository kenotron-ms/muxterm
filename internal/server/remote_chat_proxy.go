package server

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/transport"
)

type remoteChatDialer interface {
	DialChat(context.Context, transport.HostRef) (net.Conn, error)
}

// handleRemoteChatProxy forwards only chat API calls over the selected SSH
// machine. Terminal WebSockets and all other app routes stay on this server.
func (s *Server) handleRemoteChatProxy(w http.ResponseWriter, r *http.Request) {
	agentRequest := s.agentRemoteChatRequest(r)
	if !humanBrowserRequest(r) && !agentRequest {
		http.Error(w, "remote chat requires a browser or scoped agent request", http.StatusForbidden)
		return
	}
	hostID := r.PathValue("id")
	rest := strings.TrimPrefix(r.URL.Path, "/api/remote-chat/"+hostID)
	if !strings.HasPrefix(rest, "/api/sdk-") && rest != "/api/chat-ui/navigate" {
		http.NotFound(w, r)
		return
	}
	registry := s.hub.Remotes()
	host, ok := registry.Get(hostID)
	if !ok {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if registry.Transport() != nil {
			found, err := registry.Transport().Discover(ctx)
			if err == nil {
				for _, candidate := range found {
					if candidate.ID == hostID {
						host = candidate
						ok = true
						break
					}
				}
			}
		}
	}
	if !ok {
		http.Error(w, "SSH machine not found in remote settings", http.StatusNotFound)
		return
	}
	dialer, ok := registry.Transport().(remoteChatDialer)
	if !ok {
		http.Error(w, "remote chat transport unavailable", http.StatusServiceUnavailable)
		return
	}
	headerTimeout := 30 * time.Second
	if r.Method == http.MethodPost && (rest == "/api/sdk-chats" || strings.HasSuffix(rest, "/control-send")) {
		headerTimeout = 4 * time.Minute
	}
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, DisableCompression: true,
		ResponseHeaderTimeout: headerTimeout,
		DialContext:           func(ctx context.Context, _, _ string) (net.Conn, error) { return dialer.DialChat(ctx, host) },
	}
	defer transport.CloseIdleConnections()
	out := r.Clone(r.Context())
	out.URL.Scheme = "http"
	out.URL.Host = "localhost"
	out.URL.Path = rest
	out.URL.RawPath = ""
	out.Host = "localhost"
	out.RequestURI = ""
	out.Header = r.Header.Clone()
	out.Header.Del("Cookie")
	out.Header.Del("Authorization")
	if agentRequest {
		// An origin token identifies a Chat on this server and cannot identify
		// one on the remote. The remote records this as an external tool input.
		out.Header.Del("X-Muxterm-Origin")
	}
	response, err := transport.RoundTrip(out)
	if err != nil {
		http.Error(w, "remote chat backend: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	for key, values := range response.Header {
		if strings.EqualFold(key, "Set-Cookie") || strings.EqualFold(key, "Connection") || strings.EqualFold(key, "Transfer-Encoding") {
			continue
		}
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	flusher, canFlush := w.(http.Flusher)
	if strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") && canFlush {
		buf := make([]byte, 4096)
		for {
			n, readErr := response.Body.Read(buf)
			if n > 0 {
				if _, err = w.Write(buf[:n]); err != nil {
					return
				}
				flusher.Flush()
			}
			if readErr != nil {
				return
			}
		}
	}
	_, _ = io.Copy(w, response.Body)
}
