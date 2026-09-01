//go:build linux

package sessiond

import (
	"errors"
	"fmt"
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

// peerPID returns the pid of the process on the other end of nc, from the same
// SO_PEERCRED struct peerAllowed reads its uid out of. The kernel fills it in
// at connect time, so it names the process that actually owns the listening
// socket -- unlike a pidfile, it cannot go stale or point at a recycled pid.
//
// Unlike peerAllowed this reports WHY it failed: its caller (DaemonPID, and
// through it RestartDaemon) must never signal a pid it did not positively
// identify, so every failure has to be distinguishable from a real answer.
func peerPID(nc net.Conn) (int, error) {
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return 0, errors.New("peer pid unavailable: not a unix connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, fmt.Errorf("peer pid: access raw connection: %w", err)
	}
	var cred *syscall.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, fmt.Errorf("peer pid: control raw connection: %w", err)
	}
	if credErr != nil {
		return 0, fmt.Errorf("peer pid: getsockopt SO_PEERCRED: %w", credErr)
	}
	if cred == nil {
		return 0, errors.New("peer pid: getsockopt SO_PEERCRED returned no credentials")
	}
	return int(cred.Pid), nil
}
