//go:build !linux && !darwin

package sessiond

import (
	"fmt"
	"net"
)

// recoveryPeerCredentials intentionally remains available on unsupported
// platforms so callers can compile while privileged recovery fails closed.
type recoveryPeerCredentials struct {
	UID uint32
	PID int
}

// privilegedRecoverySupported is false where there is no supported
// kernel-authenticated UID-and-PID peer credential API.
func privilegedRecoverySupported() bool {
	return false
}

// peerCredentials never substitutes filesystem permissions for kernel peer
// credentials. Unsupported platforms cannot enable privileged recovery.
func peerCredentials(nc net.Conn) (recoveryPeerCredentials, error) {
	_ = nc
	return recoveryPeerCredentials{}, fmt.Errorf("recovery: privileged peer credentials unsupported on this platform")
}

// peerAllowed preserves the existing ordinary control-socket behavior on
// unsupported platforms. The socket directory and socket permissions remain
// the compatibility guard for that legacy surface; privileged recovery uses
// peerCredentials directly and is unavailable here.
func (s *Server) peerAllowed(nc net.Conn) bool {
	_ = nc
	return true
}
