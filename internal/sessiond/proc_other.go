//go:build !linux

package sessiond

import "syscall"

// processLive reports whether pid still exists. Off Linux there is no /proc to
// read a state character from, so this cannot distinguish a zombie from a
// running process -- but the caller that cares (waitForExit) reaps with Wait4
// first, and the daemon-restart path is Linux-only anyway because peerPID is.
func processLive(pid int) bool {
	return syscall.Kill(pid, 0) == nil
}
