//go:build linux

package cos

import (
	"os/exec"
	"syscall"
)

// setPdeathsig asks the kernel to SIGKILL the sidecar if this process dies.
//
// The supervisor stops the sidecar on every ORDERLY exit it knows about, but
// there are exits it does not get to see: a panic, a SIGKILL, an OOM kill, a
// systemd cgroup teardown. In every one of those the Python child is inherited
// by init and keeps running - holding the amplifier session that a freshly
// started muxterm would then open a SECOND sidecar on, which is precisely the
// two-writers-one-transcript defect the queue exists to prevent.
//
// PR_SET_PDEATHSIG is the kernel's own answer and it needs no cooperation from
// the dying process, which is the point: nothing survives a SIGKILL to run
// cleanup, so cleanup has to be arranged in advance.
//
// One caveat, inherent to the mechanism: pdeathsig fires when the parent
// THREAD that forked exits, not only when the whole process does. If the Go
// runtime ever retires that OS thread the sidecar is killed early. The
// supervise loop treats that as an ordinary sidecar death and restarts it with
// backoff, so the failure mode is a restart, not a lost session.
func setPdeathsig(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Pdeathsig = syscall.SIGKILL
}
