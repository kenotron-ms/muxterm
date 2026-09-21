package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/transport"
)

// RelaySettings deliberately excludes credentials from all read responses.
type RelaySettings struct {
	URL         string `json:"url"`
	Host        string `json:"host"`
	DisplayName string `json:"displayName"`
	Configured  bool   `json:"configured"`
	Available   bool   `json:"available"`
	Detail      string `json:"detail,omitempty"`
}
type RelayUpdate struct {
	URL         string `json:"url"`
	Host        string `json:"host"`
	DisplayName string `json:"displayName"`
	Token       string `json:"token"`
}
type RelayConfigurer interface {
	RelaySettings() RelaySettings
	ConfigureRelay(context.Context, RelayUpdate) error
	ClearRelay() error
}

func (s *Server) handleRelaySettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	host, _, err := net.SplitHostPort(s.addr)
	ip := net.ParseIP(host)
	available := err == nil && ip != nil && ip.IsLoopback() && !s.behindReverseProxy
	manager, ok := s.hub.Remotes().Transport().(RelayConfigurer)
	available = available && ok
	requestHost := r.Host
	if h, _, e := net.SplitHostPort(requestHost); e == nil {
		requestHost = h
	}
	requestIP := net.ParseIP(requestHost)
	if !IsLocalhost(r) || !(requestHost == "localhost" || requestIP != nil && requestIP.IsLoopback()) {
		http.Error(w, "relay settings require local access", http.StatusForbidden)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, e := url.Parse(origin)
		if e != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
			http.Error(w, "invalid origin", http.StatusForbidden)
			return
		}
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "invalid origin", http.StatusForbidden)
		return
	}
	// Keep disk updates and registry membership changes in one order.
	s.relaySettingsMu.Lock()
	defer s.relaySettingsMu.Unlock()
	status := RelaySettings{Available: available}
	if ok {
		status = manager.RelaySettings()
		status.Available = available
	}
	if !available {
		status.Detail = "Relay settings require a loopback server without a reverse proxy."
	}
	if r.Method == http.MethodGet {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(status)
		return
	}
	if !available {
		http.Error(w, status.Detail, http.StatusForbidden)
		return
	}
	old := status.Host
	switch r.Method {
	case http.MethodPut:
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "JSON required", http.StatusUnsupportedMediaType)
			return
		}
		var input RelayUpdate
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
			http.Error(w, "invalid relay settings", http.StatusBadRequest)
			return
		}
		if err := manager.ConfigureRelay(r.Context(), input); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	case http.MethodDelete:
		if err := manager.ClearRelay(); err != nil {
			http.Error(w, "could not remove relay settings", http.StatusInternalServerError)
			return
		}
	}
	if old != "" {
		s.hub.Remotes().Remove(old)
	}
	status = manager.RelaySettings()
	status.Available = true
	if status.Configured {
		_ = s.hub.Remotes().Add(relayHost(status))
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(status)
}

func relayHost(s RelaySettings) transport.HostRef {
	return transport.HostRef{ID: s.Host, DisplayName: s.DisplayName}
}
