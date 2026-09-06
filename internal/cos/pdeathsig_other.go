//go:build !linux

package cos

import "os/exec"

// setPdeathsig is a no-op off Linux: SysProcAttr.Pdeathsig does not exist on
// darwin or Windows, and there is no portable equivalent. The orderly-shutdown
// paths (Close, the ListenAndServe defer, the supervise loop) still stop the
// sidecar there; only the SIGKILL/panic case is unprotected.
func setPdeathsig(*exec.Cmd) {}
