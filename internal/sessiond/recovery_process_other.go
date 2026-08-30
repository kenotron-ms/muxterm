//go:build (!linux && !darwin) || (darwin && !cgo)

package sessiond

import "fmt"

// Keep the portable path limit at Darwin's smaller sockaddr_un capacity. The
// platform has no supported privileged-recovery implementation, or Darwin's
// required libproc binding is unavailable, so callers fail closed before a
// bind attempt.
const (
	recoveryUnixSocketPathMaximum    = 103
	recoveryProcessIdentitySupported = false
)

func inspectRecoveryProcessBoundary(pid int) (recoveryProcessBoundaryIdentity, error) {
	_ = pid
	return recoveryProcessBoundaryIdentity{}, fmt.Errorf("recovery: process inspection unsupported on this platform")
}

func inspectRecoveryProcess(pid int) (recoveryProcessIdentity, error) {
	_ = pid
	return recoveryProcessIdentity{}, fmt.Errorf("recovery: process inspection unsupported on this platform")
}

func resolveRecoveryExecutable(product, pathValue string, owner uint32) (recoveryExecutableIdentity, error) {
	_ = product
	_ = pathValue
	_ = owner
	return recoveryExecutableIdentity{}, fmt.Errorf("recovery: executable identity inspection unsupported on this platform")
}

func revalidateRecoveryExecutable(identity recoveryExecutableIdentity) error {
	_ = identity
	return fmt.Errorf("recovery: executable identity inspection unsupported on this platform")
}

func recoveryExecutablePinMatches(identity recoveryExecutableIdentity) bool {
	_ = identity
	return false
}

func validateRecoveryDirectoryPlatform(path string, owner uint32) error {
	_ = path
	_ = owner
	return fmt.Errorf("recovery: secure directory validation unsupported on this platform")
}

func validateRecoveryPrivateDirectory(path string, owner uint32) error {
	_ = path
	_ = owner
	return fmt.Errorf("recovery: secure directory validation unsupported on this platform")
}

func ensureRecoveryDirectoryPath(path string, owner uint32) error {
	_ = path
	_ = owner
	return fmt.Errorf("recovery: secure directory creation unsupported on this platform")
}
