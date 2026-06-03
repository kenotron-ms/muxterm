//go:build linux

package sessiond

import (
	"net"
	"os"
	"syscall"
)

// peerAllowed enforces an SO_PEERCRED uid check using only the standard library
// syscall package (no golang.org/x/sys). It accepts a connection only when the
// peer's uid matches this process's uid, rejecting on any error.
func (s *Server) peerAllowed(nc net.Conn) bool {
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return false
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return false
	}
	var cred *syscall.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return false
	}
	if credErr != nil || cred == nil {
		return false
	}
	return int(cred.Uid) == os.Getuid()
}
