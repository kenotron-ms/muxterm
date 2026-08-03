package server

import (
	"net"
	"net/http"
)

// IsLocalhost returns true if the request originates from a loopback address
// (127.0.0.1 or [::1]).
func IsLocalhost(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}

	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}

	return ip.IsLoopback()
}
