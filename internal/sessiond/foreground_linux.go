//go:build linux

package sessiond

import (
	"bytes"
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"
)

// paneForegrounded returns the argv, working directory, and environment of the
// foreground process running inside a pane's PTY. It uses TIOCGPGRP to ask the
// kernel which process group is currently in the foreground on the PTY master,
// then reads /proc/<pgid>/cmdline, /proc/<pgid>/cwd, and /proc/<pgid>/environ.
//
// When the shell is at an idle prompt (no foreground program) the foreground
// PGID equals the shell's own PID, and paneForegrounded returns the pane's
// spawn argv, an empty dir, and a nil env (caller uses $HOME). When detection
// fails for any reason it also falls back to spawn argv / empty dir / nil env.
func paneForegrounded(p *Pane) (argv []string, dir string, env map[string]string) {
	argv = p.argv // safe fallback
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

	// Read the foreground process's argv from /proc/<pgid>/cmdline.
	// cmdline is null-terminated, fields separated by null bytes.
	cmdlineData, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pgid))
	if err != nil || len(cmdlineData) == 0 {
		return
	}
	parts := bytes.Split(bytes.TrimRight(cmdlineData, "\x00"), []byte{0})
	fgArgv := make([]string, 0, len(parts))
	for _, part := range parts {
		if len(part) > 0 {
			fgArgv = append(fgArgv, string(part))
		}
	}
	if len(fgArgv) == 0 {
		return
	}

	// setproctitle rewrites argv[0] in-place with the full title string
	// (e.g. "amplifier resume abc123"), producing a single cmdline entry
	// containing spaces. Split by fields so the restore command is
	// correctly structured as an argv slice for exec.Command.
	if len(fgArgv) == 1 && strings.Contains(fgArgv[0], " ") {
		fgArgv = strings.Fields(fgArgv[0])
	}

	// Read the foreground process's working directory from /proc/<pgid>/cwd.
	cwd, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pgid))
	if err != nil {
		cwd = ""
	}

	// Read the foreground process's environment from /proc/<pgid>/environ.
	// Format: null-separated KEY=VALUE strings.
	fgEnv := make(map[string]string)
	if envData, readErr := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pgid)); readErr == nil {
		for _, entry := range bytes.Split(bytes.TrimRight(envData, "\x00"), []byte{0}) {
			if eq := bytes.IndexByte(entry, '='); eq > 0 {
				fgEnv[string(entry[:eq])] = string(entry[eq+1:])
			}
		}
	}

	return fgArgv, cwd, fgEnv
}
