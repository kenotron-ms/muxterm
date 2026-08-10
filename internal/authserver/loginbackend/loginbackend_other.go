//go:build !linux

package loginbackend

import (
	"fmt"
	"runtime"
)

// New reports that no login backend is implemented for this GOOS yet.
// macOS (OpenDirectory) arrives in Phase 4; Windows (LogonUser) in Phase 5.
// Callers MUST treat this error as "fail closed for non-loopback access,"
// per the design doc's Error Handling section — never as "no auth needed."
func New() (LoginBackend, error) {
	return nil, fmt.Errorf("loginbackend: no backend implemented for GOOS=%s yet (Linux/PAM only in Phase 1)", runtime.GOOS)
}
