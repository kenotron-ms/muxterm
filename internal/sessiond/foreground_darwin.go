//go:build darwin

package sessiond

import (
	"bytes"
	"encoding/binary"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// darwinProcArgs2 is a thin wrapper kept for compatibility; use darwinProcInfo.
func darwinProcArgs2(pid int) []string {
	argv, _ := darwinProcInfo(pid)
	return argv
}

// Darwin sysctl MIB constants (stable across macOS versions).
const (
	darwinCtlKern       int32 = 1  // CTL_KERN
	darwinKernProcArgs2 int32 = 49 // KERN_PROCARGS2
)

// paneForegrounded returns the argv, working directory, and environment of the
// foreground process running inside a pane's PTY on macOS. It uses TIOCGPGRP
// (POSIX, same as Linux) to get the foreground process group, then
// KERN_PROCARGS2 sysctl to read its argv and environment.
//
// Falls back to spawn argv / empty dir / nil env when the shell is at idle or
// when any step fails.
func paneForegrounded(p *Pane) (argv []string, dir string, env map[string]string) {
	argv = p.argv
	dir = ""
	env = nil

	if p.ptmx == nil || p.cmd == nil || p.cmd.Process == nil {
		return
	}
	shellPID := p.cmd.Process.Pid

	// TIOCGPGRP: ask the PTY master for the foreground process group ID.
	sc, err := p.ptmx.SyscallConn()
	if err != nil {
		return
	}
	var pgid int32
	var ioctlErr error
	_ = sc.Control(func(fd uintptr) {
		_, _, errno := syscall.Syscall(
			syscall.SYS_IOCTL,
			fd,
			syscall.TIOCGPGRP,
			uintptr(unsafe.Pointer(&pgid)),
		)
		if errno != 0 {
			ioctlErr = errno
		}
	})
	if ioctlErr != nil || pgid <= 0 {
		return
	}

	// Shell at idle prompt: its own process group is foreground.
	if int(pgid) == shellPID {
		return
	}

	fgArgv, fgEnv := darwinProcInfo(int(pgid))
	if len(fgArgv) == 0 {
		return
	}

	// Get the working directory via lsof — no cgo required.
	fgDir := darwinCwdViaLsof(int(pgid))

	return fgArgv, fgDir, fgEnv
}

// darwinCwdViaLsof returns the working directory of pid by running
// lsof -p <pid> -d cwd -Fn and parsing the output line starting with "n".
// Returns "" on any error; lsof is always present on macOS.
func darwinCwdViaLsof(pid int) string {
	out, err := exec.Command(
		"lsof",
		"-p", strconv.Itoa(pid),
		"-d", "cwd",
		"-Fn",
	).Output()
	if err != nil || len(out) == 0 {
		return ""
	}
	// Output is newline-separated fields; the line starting with 'n' is the path.
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "n") {
			return strings.TrimSpace(line[1:])
		}
	}
	return ""
}

// darwinProcInfo retrieves the argv and environment of pid via the
// KERN_PROCARGS2 sysctl in a single call. The kernel returns both in one
// buffer, so we parse both in one pass.
//
// Buffer layout:
//
//	[4 bytes: argc (int32 LE)]
//	[null-terminated exe path — may differ from argv[0]]
//	[zero padding to word boundary]
//	[argv[0]\0][argv[1]\0]...[argv[argc-1]\0]
//	[KEY=VALUE\0][KEY=VALUE\0]...  ← environment
func darwinProcInfo(pid int) (argv []string, env map[string]string) {
	mib := [3]int32{darwinCtlKern, darwinKernProcArgs2, int32(pid)}

	// First call: query required buffer size.
	size := uintptr(0)
	_, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])), 3,
		0, uintptr(unsafe.Pointer(&size)),
		0, 0,
	)
	if errno != 0 || size == 0 {
		return nil, nil
	}

	buf := make([]byte, size)
	_, _, errno = syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])), 3,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)),
		0, 0,
	)
	if errno != 0 {
		return nil, nil
	}
	buf = buf[:size]

	if len(buf) < 4 {
		return nil, nil
	}
	argc := int(binary.LittleEndian.Uint32(buf[:4]))
	rest := buf[4:]

	// Skip the exe path (first null-terminated string).
	if i := bytes.IndexByte(rest, 0); i >= 0 {
		rest = rest[i+1:]
	} else {
		return nil, nil
	}

	// Skip null padding between exe path and argv[0].
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}

	// Parse argc null-terminated argv strings.
	args := make([]string, 0, argc)
	for i := 0; i < argc && len(rest) > 0; i++ {
		j := bytes.IndexByte(rest, 0)
		if j < 0 {
			args = append(args, string(rest))
			rest = rest[len(rest):]
			break
		}
		args = append(args, string(rest[:j]))
		rest = rest[j+1:]
	}

	// Parse environment: KEY=VALUE\0 entries until an empty entry or end.
	envMap := make(map[string]string)
	for len(rest) > 0 {
		j := bytes.IndexByte(rest, 0)
		if j <= 0 {
			break // empty entry signals end of env block
		}
		entry := string(rest[:j])
		rest = rest[j+1:]
		if eq := strings.IndexByte(entry, '='); eq > 0 {
			envMap[entry[:eq]] = entry[eq+1:]
		}
	}

	return args, envMap
}
