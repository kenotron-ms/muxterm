//go:build darwin

package sessiond

import (
	"fmt"
	"net"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// recoveryPeerCredentials are kernel-authenticated facts about a Unix-domain
// socket peer. Callers must never derive recovery authority from socket mode
// bits or a caller-supplied PID.
type recoveryPeerCredentials struct {
	UID uint32
	PID int
}

// privilegedRecoverySupported reports whether this platform has the kernel
// facts required to safely enable the privileged recovery socket.
func privilegedRecoverySupported() bool {
	return recoveryProcessIdentitySupported
}

// peerCredentials obtains Darwin's UID and PID facts in one descriptor-control
// section. LOCAL_PEERCRED alone is insufficient for recovery: a peer PID is
// required to bind a lease to a process lifetime.
func peerCredentials(nc net.Conn) (recoveryPeerCredentials, error) {
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return recoveryPeerCredentials{}, fmt.Errorf("recovery: peer is not a Unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return recoveryPeerCredentials{}, fmt.Errorf("recovery: access peer socket descriptor: %w", err)
	}

	var (
		credentials   *unix.Xucred
		pid           int
		credentialErr error
	)
	if err := raw.Control(func(fd uintptr) {
		credentials, credentialErr = unix.GetsockoptXucred(
			int(fd),
			unix.SOL_LOCAL,
			unix.LOCAL_PEERCRED,
		)
		if credentialErr != nil {
			return
		}
		pid, credentialErr = syscall.GetsockoptInt(
			int(fd),
			unix.SOL_LOCAL,
			unix.LOCAL_PEERPID,
		)
	}); err != nil {
		return recoveryPeerCredentials{}, fmt.Errorf("recovery: inspect peer credentials: %w", err)
	}
	if credentialErr != nil || credentials == nil {
		if credentialErr != nil {
			return recoveryPeerCredentials{}, fmt.Errorf("recovery: read peer credentials: %w", credentialErr)
		}
		return recoveryPeerCredentials{}, fmt.Errorf("recovery: peer credentials unavailable")
	}
	if pid <= 0 {
		return recoveryPeerCredentials{}, fmt.Errorf("recovery: peer has no valid PID")
	}
	if credentials.Uid != uint32(os.Geteuid()) {
		return recoveryPeerCredentials{}, fmt.Errorf("recovery: peer UID does not match daemon owner")
	}
	return recoveryPeerCredentials{UID: credentials.Uid, PID: pid}, nil
}

// peerAllowed is the compatibility wrapper used by the existing main control
// socket. New recovery authority consumes peerCredentials directly.
func (s *Server) peerAllowed(nc net.Conn) bool {
	_, err := peerCredentials(nc)
	return err == nil
}
