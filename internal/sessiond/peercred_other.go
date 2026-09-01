//go:build !linux

package sessiond

import (
	"errors"
	"net"
)

// peerAllowed is a no-op on non-Linux platforms: SO_PEERCRED is Linux-specific,
// and the 0700 directory / 0600 socket permissions are the primary guard there.
func (s *Server) peerAllowed(nc net.Conn) bool {
	_ = nc
	return true
}

// peerPID always fails on non-Linux platforms. There is no portable substitute
// (macOS LOCAL_PEERPID needs golang.org/x/sys, which this package avoids), and
// a wrong answer here would mean signalling an unrelated process -- so the
// daemon-restart path is simply unavailable rather than approximate.
func peerPID(nc net.Conn) (int, error) {
	_ = nc
	return 0, errors.New("peer pid unavailable: SO_PEERCRED is linux-only")
}
