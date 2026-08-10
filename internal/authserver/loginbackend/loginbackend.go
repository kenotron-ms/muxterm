// Package loginbackend authenticates a password against the current OS
// user's own credentials. There is no username parameter: sessiond (and
// therefore muxterm) always runs as exactly one OS user, so identity is
// implicit — the only question is "is this the right password for the
// account this process is already running as?"
package loginbackend

// LoginBackend verifies a password against the current OS user's own
// credentials (PAM on Linux; OpenDirectory on macOS in Phase 4; LogonUser
// on Windows in Phase 5).
type LoginBackend interface {
	// Authenticate returns nil if password is correct for the current OS
	// user, or a non-nil error otherwise (wrong password, backend
	// unavailable, etc). Callers MUST treat any non-nil error as "deny
	// access" — this contract fails closed by construction: there is no
	// distinguished "backend broken, allow anyway" return value.
	Authenticate(password string) error
}
