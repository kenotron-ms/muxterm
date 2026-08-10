//go:build linux

package loginbackend

import (
	"fmt"
	"os/user"

	"github.com/msteinert/pam/v2"
)

// PAMBackend authenticates against the current OS user's own PAM stack,
// using the "login" service — the standard service most distros configure
// for direct local-account password checks (matching how `login`/`su`
// would authenticate this same account). If your target distro's PAM
// config doesn't define a "login" service (check /etc/pam.d/), substitute
// "sshd" or "common-auth" here and document the substitution in this
// task's verification evidence.
type PAMBackend struct{}

// NewPAMBackend returns a PAM-backed LoginBackend for Linux.
func NewPAMBackend() *PAMBackend {
	return &PAMBackend{}
}

// New returns the Linux PAM-backed LoginBackend. It never fails at
// construction time (PAM failures surface per-Authenticate-call instead,
// so a transient PAM misconfiguration doesn't prevent the whole server
// from starting for loopback-only use).
func New() (LoginBackend, error) {
	return NewPAMBackend(), nil
}

// Authenticate verifies password against the current OS user's own PAM
// stack. Fails closed: any PAM error (wrong password, PAM init failure,
// missing service file) is returned as a non-nil error.
func (b *PAMBackend) Authenticate(password string) error {
	u, err := user.Current()
	if err != nil {
		return fmt.Errorf("pam: determine current user: %w", err)
	}

	tx, err := pam.StartFunc("login", u.Username, func(s pam.Style, _ string) (string, error) {
		switch s {
		case pam.PromptEchoOff:
			return password, nil
		case pam.PromptEchoOn:
			return u.Username, nil
		default:
			return "", nil
		}
	})
	if err != nil {
		return fmt.Errorf("pam: start transaction: %w", err)
	}
	defer tx.End() //nolint:errcheck

	if err := tx.Authenticate(0); err != nil {
		return fmt.Errorf("pam: authenticate: %w", err)
	}
	return nil
}
