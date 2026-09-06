package ssh

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/transport"
)

// sshExitFailure is the exit status ssh itself uses when the connection fails
// (unreachable host, rejected key, unknown host key). It has to be told apart
// from a remote command's own nonzero exit, or "host is down" and "muxterm is
// not installed" collapse into the same useless message.
const sshExitFailure = 255

// ProbeState is the outcome of looking for muxterm on the far side. The three
// states are deliberately distinct because each needs different UI: one is
// ready, one works but should be reported, one needs an install.
type ProbeState int

const (
	// ProbeUnknown is the zero value, used only when the probe did not
	// complete (it returned an error).
	ProbeUnknown ProbeState = iota
	// ProbePresent means muxterm is on the NON-interactive PATH: the plain
	// `ssh host muxterm …` form works. This is the good case.
	ProbePresent
	// ProbeLoginShellOnly means muxterm exists and a login shell finds it, but
	// a non-interactive ssh does not. This is the common install (~/.local/bin,
	// which non-interactive ssh's PATH omits). Dial handles it — that is why
	// Dial goes through `bash -lc` — so it is reported, not fatal.
	ProbeLoginShellOnly
	// ProbeAbsent means neither probe found muxterm: it is not installed.
	ProbeAbsent
)

// String renders the state for logs and diagnostics.
func (s ProbeState) String() string {
	switch s {
	case ProbePresent:
		return "present"
	case ProbeLoginShellOnly:
		return "login-shell-only"
	case ProbeAbsent:
		return "absent"
	default:
		return "unknown"
	}
}

// ProbeResult is the structured answer from Probe.
type ProbeResult struct {
	// State is the three-way outcome.
	State ProbeState
	// Path is the resolved remote path to muxterm, empty when absent.
	Path string
}

// ProvisionError is the typed error Provision returns for every state except
// ProbePresent, so a caller can switch on State with errors.As instead of
// matching strings.
//
// ProbeLoginShellOnly is NOT fatal for this transport: Dial invokes through a
// login shell precisely so that case works. It is surfaced because it is worth
// telling a user about (and worth offering to fix), not because the host is
// unusable.
type ProvisionError struct {
	// Host is the host that was probed.
	Host transport.HostRef
	// State is why provisioning is not complete.
	State ProbeState
	// Path is the resolved remote path, when one was found.
	Path string
}

// Error renders a message specific to the state, never a generic failure.
func (e *ProvisionError) Error() string {
	switch e.State {
	case ProbeLoginShellOnly:
		return fmt.Sprintf("muxterm on %s is at %s, which only a login shell finds (not on the non-interactive ssh PATH)",
			e.Host.DisplayName, e.Path)
	case ProbeAbsent:
		return fmt.Sprintf("muxterm is not installed on %s — install it there, e.g. `muxterm deploy %s`",
			e.Host.DisplayName, e.Host.Addr)
	default:
		return fmt.Sprintf("muxterm on %s: probe state %s", e.Host.DisplayName, e.State)
	}
}

// Probe reports whether muxterm is reachable on host and how.
//
// It costs one ssh round trip in the good case and two otherwise: the
// non-interactive PATH is checked first, and only when that misses is the
// login shell asked. A non-nil error means the probe itself could not run (ssh
// failed to connect, ctx cancelled) — which is a different thing from any of
// the three ProbeStates and must not be shown as "not installed".
func (t *Transport) Probe(ctx context.Context, host transport.HostRef) (ProbeResult, error) {
	target, err := targetOf(host)
	if err != nil {
		return ProbeResult{}, err
	}
	name := "muxterm"
	if t.RemoteBinary != "" {
		name = t.RemoteBinary
	}
	lookup := "command -v " + shellQuote(name)

	// 1. Non-interactive PATH — what a plain `ssh host muxterm …` would get.
	r, err := runSSH(ctx, target, lookup)
	if err != nil {
		return ProbeResult{}, err
	}
	if r.code == 0 {
		return ProbeResult{State: ProbePresent, Path: lastLine(r.stdout)}, nil
	}
	if r.code == sshExitFailure {
		return ProbeResult{}, fmt.Errorf("ssh %s: connection failed (exit %d)%s", target, r.code, stderrSuffix(r.stderr))
	}

	// 2. Login-shell PATH — the profile that puts ~/.local/bin on PATH.
	r, err = runSSH(ctx, target, "bash -lc "+shellQuote(lookup))
	if err != nil {
		return ProbeResult{}, err
	}
	if r.code == sshExitFailure {
		return ProbeResult{}, fmt.Errorf("ssh %s: connection failed (exit %d)%s", target, r.code, stderrSuffix(r.stderr))
	}
	if r.code == 0 {
		// Last line, not the whole output: a login shell's profile may print
		// its own banner before the answer.
		if p := lastLine(r.stdout); p != "" {
			return ProbeResult{State: ProbeLoginShellOnly, Path: p}, nil
		}
	}
	return ProbeResult{State: ProbeAbsent}, nil
}

// Provision reports whether muxterm is usable on host, distinguishing the three
// probe outcomes rather than collapsing them into one failure: nil when the
// remote is fully ready, and a *ProvisionError carrying the State otherwise.
// Use Probe directly when the structured result is wanted without the error
// dance.
//
// It does not install anything. Getting the binary onto a host is
// `muxterm deploy <host>` (internal/deploy), which already exists and is not
// duplicated here.
func (t *Transport) Provision(ctx context.Context, host transport.HostRef) error {
	res, err := t.Probe(ctx, host)
	if err != nil {
		return err
	}
	if res.State == ProbePresent {
		return nil
	}
	return &ProvisionError{Host: host, State: res.State, Path: res.Path}
}

// sshRun is one completed ssh invocation.
type sshRun struct {
	stdout string
	stderr string
	code   int
}

// runSSH executes a remote command and collects its output. ctx bounds the
// probe and kills ssh on cancellation — unlike Dial, where ctx governs only
// establishing a connection whose lifetime outlives it.
//
// A nonzero exit is reported in sshRun.code, not as an error: for a probe,
// "command not found" is an ANSWER. A non-nil error means ssh could not be run
// at all.
func runSSH(ctx context.Context, target, remote string) (sshRun, error) {
	cmd := exec.CommandContext(ctx, sshBinary, append(baseArgs(target), remote)...) //nolint:gosec
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return sshRun{stdout: string(out), stderr: string(ee.Stderr), code: ee.ExitCode()}, nil
		}
		return sshRun{code: -1}, fmt.Errorf("ssh %s: %w", target, err)
	}
	return sshRun{stdout: string(out), code: 0}, nil
}

// lastLine returns the final non-empty line of s, trimmed. `command -v` prints
// the path last, so this survives anything a login shell's profile printed
// first.
func lastLine(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if v := strings.TrimSpace(lines[i]); v != "" {
			return v
		}
	}
	return ""
}
