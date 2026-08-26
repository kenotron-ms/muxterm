//go:build darwin || linux

package sessiond

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

func foregroundPGRPSupported() bool {
	return true
}

func inspectProcessGroup(pid int) (int, error) {
	return unix.Getpgid(pid)
}

func inspectForegroundPGRP(ptmx *os.File) (int, error) {
	if ptmx == nil {
		return 0, errors.New("sessiond: pane has no PTY")
	}
	raw, err := ptmx.SyscallConn()
	if err != nil {
		return 0, err
	}
	var (
		pgrp     int
		ioctlErr error
	)
	if err := raw.Control(func(fd uintptr) {
		pgrp, ioctlErr = unix.IoctlGetInt(int(fd), unix.TIOCGPGRP)
	}); err != nil {
		return 0, err
	}
	return pgrp, ioctlErr
}
