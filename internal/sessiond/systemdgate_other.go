//go:build !linux

package sessiond

import "os"

// startedBySystemd keeps the pre-existing environment-variable test off Linux.
//
// There is no systemd here (macOS uses launchd, which sets no INVOCATION_ID),
// so in practice this is false for every real process on this platform and the
// parent-process refinement in the Linux build would have nothing to
// discriminate. Preserving the plain variable test also keeps a container or
// CI runner that deliberately exports INVOCATION_ID behaving exactly as it did
// before.
func startedBySystemd() bool {
	return os.Getenv("INVOCATION_ID") != ""
}
