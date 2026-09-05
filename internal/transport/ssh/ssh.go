// Package ssh reaches a remote sessiond over the system `ssh` binary.
//
// It shells out rather than reimplementing the protocol, which is why keys,
// ProxyJump, bastions, Match blocks, agent forwarding, and hardware keys all
// work for free: whatever the user's ssh already does, this does. The far side
// runs `muxterm sessiond-connect`, which pipes its stdio to the LOCAL Unix
// socket on that machine, so sessiond never gets a network listener and its
// SO_PEERCRED check is satisfied without change — the remote process is the
// user, talking to a local socket.
package ssh

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/transport"
)

// sshBinary is the client executable. It is resolved from PATH so the user's
// own ssh (and therefore their config, agent, and key setup) is used.
const sshBinary = "ssh"

// Transport is the SSH implementation of transport.Transport.
type Transport struct {
	// RemoteBinary optionally names an ABSOLUTE path to muxterm on the far
	// side. Empty (the default) means resolve `muxterm` through a login shell.
	//
	// Set it when the login shell is a bad place to run things — most
	// commonly a host whose profile scripts print to stdout, which would
	// inject text into the framed protocol stream and desynchronize it. An
	// absolute path skips the login shell entirely.
	RemoteBinary string
}

// New returns an SSH transport with default settings.
func New() *Transport { return &Transport{} }

var _ transport.Transport = (*Transport)(nil)

// Name is the registry key and the qualifier in HostRef.ID ("ssh:<alias>").
func (t *Transport) Name() string { return "ssh" }

// Identity reports IdentityPeerCred: the remote end of the pipe runs as the
// authenticated user and connects to a local Unix socket, so sessiond's
// SO_PEERCRED uid check passes with no additional handshake.
//
// This is a property of SSH, not of remoting. Other transports prove nothing
// (transport.IdentityNone), so callers must not treat peercred as a given.
func (t *Transport) Identity() transport.IdentityModel {
	return transport.IdentityPeerCred
}

// Dial runs `ssh <target> muxterm sessiond-connect` and returns its
// stdin/stdout pipes as a net.Conn carrying a binary-clean byte stream to the
// remote sessiond socket.
//
// ctx governs establishing the connection, not its lifetime (net.Dialer
// semantics): the returned conn is ended by Close, never by cancelling ctx.
// There is no handshake to interrupt — the stream exists the moment ssh execs
// — so ctx is checked before starting rather than tied to the child.
func (t *Transport) Dial(ctx context.Context, host transport.HostRef) (net.Conn, error) {
	target, err := targetOf(host)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	cmd := exec.Command(sshBinary, append(baseArgs(target), t.remoteCommand())...) //nolint:gosec
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("ssh %s: stdin pipe: %w", target, err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("ssh %s: stdout pipe: %w", target, err)
	}
	// Captured, never inherited: ssh's diagnostics must not land in the byte
	// stream, and they are the only explanation of an exit-255 failure.
	stderr := &syncBuffer{}
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("ssh %s: start: %w", target, err)
	}
	return &sshConn{
		cmd:    cmd,
		stdin:  stdin,
		stdout: stdout,
		stderr: stderr,
		target: target,
	}, nil
}

// targetOf extracts the ssh target from host.
//
// It is deliberately ADDRESS-AGNOSTIC: an alias, a hostname, an IPv4 or IPv6
// literal, a tailnet name, or a user@host all pass through untouched, because
// the system ssh is the only thing entitled to interpret them. The single
// rejected value is the empty string, which is not a target in any of those
// forms.
func targetOf(host transport.HostRef) (string, error) {
	if host.Addr == "" {
		return "", fmt.Errorf("ssh transport: host %q has no address", host.ID)
	}
	return host.Addr, nil
}

// baseArgs are the ssh flags every invocation shares, followed by the target.
//
//   - -T: never allocate a pseudo-terminal. A PTY would apply ONLCR and turn
//     every 0x0A in the framed protocol into 0x0D 0x0A, silently corrupting the
//     stream. This also overrides a user config that forces RequestTTY.
//   - -o BatchMode=yes: never prompt for a password or passphrase, so a dial
//     against a host with no usable key fails immediately instead of hanging
//     on a prompt no one can answer.
//   - --: end of options, so a target is never parsed as a flag.
func baseArgs(target string) []string {
	return []string{"-T", "-o", "BatchMode=yes", "--", target}
}

// remoteCommand builds the single command string ssh hands to the remote shell.
//
// ssh joins its trailing arguments with spaces and gives the result to the
// remote user's shell, so all quoting must be INSIDE this one string: passing
// "bash", "-lc", "muxterm sessiond-connect" as separate arguments would arrive
// as `bash -lc muxterm sessiond-connect` and run the wrong thing.
//
// The login shell is not optional in the default case. Verified: a
// non-interactive ssh gets PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:
// /usr/bin:/sbin:/bin with no ~/.local/bin, so `ssh host muxterm
// sessiond-connect` fails with command-not-found on a host where muxterm is
// installed and working. `bash -lc` reads the profile that puts it on PATH.
func (t *Transport) remoteCommand() string {
	if t.RemoteBinary != "" {
		return shellQuote(t.RemoteBinary) + " sessiond-connect"
	}
	return "bash -lc " + shellQuote("muxterm sessiond-connect")
}

// shellQuote single-quotes s for the remote shell, rendering an embedded quote
// using the standard close-escape-reopen sequence, so no input can escape the
// quoting. The literal form is not spelled out here: gofmt rewrites a bare
// pair of apostrophes in a doc comment into a typographic quote.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
