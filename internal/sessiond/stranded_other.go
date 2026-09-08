//go:build !linux

package sessiond

// FindStrandedListener is unimplemented off Linux, following the same
// graceful-degradation contract as parentPID: the only way to observe a socket
// whose bound name has been unlinked is the kernel's own socket table, and
// Linux exposes that as /proc/net/unix with no cgo-free equivalent here.
//
// false unconditionally means callers report the generic "daemon unreachable"
// message instead of the specific stranded diagnosis. Nothing breaks: the
// bind-time refusal (ClaimSocket) that PREVENTS stranding is platform-neutral
// and still applies here, so this only affects how an already-stranded daemon
// is explained, not whether one can be created.
func FindStrandedListener(path string) (*StrandedDaemon, bool) {
	return nil, false
}
