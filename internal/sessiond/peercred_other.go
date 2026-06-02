//go:build !linux

package sessiond

import "net"

// peerAllowed is a no-op on non-Linux platforms: SO_PEERCRED is Linux-specific,
// and the 0700 directory / 0600 socket permissions are the primary guard there.
func (s *Server) peerAllowed(nc net.Conn) bool {
	_ = nc
	return true
}
