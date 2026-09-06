// Package transport defines how muxterm reaches a sessiond daemon that is not
// on this machine.
//
// muxterm needs exactly one thing from a remote: a bidirectional, binary-clean
// byte stream to a Unix socket inside the far machine. How that stream is
// obtained — an ssh subprocess, a WebSocket to an authenticated ingress, an
// exec API — is not muxterm's business, and nothing above this package may
// assume it. The frozen sessiond protocol is self-describing framing that
// carries no socket assumptions, so any such stream is enough:
// sessiond.DialConn turns one into a working client.
//
// Five properties vary per transport, and this package exists so that none of
// them leak into callers: stream acquisition, peer identity, discovery,
// provisioning, and liveness. In particular, SSH's answers are unusually
// generous (SO_PEERCRED passes because the far side of the pipe runs as the
// user against a local socket) and must not be allowed to harden into
// assumptions — see Identity/IdentityModel.
package transport

import (
	"context"
	"fmt"
	"net"
)

// HostRef names one reachable far end.
//
// ID and DisplayName are deliberately separate fields because they are only
// the same string for SSH. Anything durable — a namespaced workspace id, a
// stored preference — must key on ID; DisplayName is for humans and may change
// underneath you (a sandbox label is user-editable, an ssh alias is not).
type HostRef struct {
	// ID is the stable, transport-qualified identity of this host, e.g.
	// "ssh:boxb" or "sandbox:cb997d3d-…". It is never a mutable label: a
	// reference that breaks when someone renames a host is a bug that only
	// shows up in production.
	ID string
	// DisplayName is the human-facing label. It may change over time and must
	// never be used as a key.
	DisplayName string
	// Addr is the transport-specific address or target, interpreted only by
	// the transport that produced it (an ssh target, a URL, an API id).
	Addr string
}

// IdentityModel describes what, if anything, the far end can prove about the
// caller from the connection alone.
type IdentityModel int

const (
	// IdentityNone means the transport proves nothing about the caller.
	// Anything that authenticates such a stream must live in a handshake
	// above the transport.
	IdentityNone IdentityModel = iota
	// IdentityPeerCred means the far side can verify the caller's uid via
	// SO_PEERCRED, so sessiond's existing peercred check is satisfied with no
	// additional handshake.
	IdentityPeerCred
)

// String renders the identity model for logs and diagnostics.
func (m IdentityModel) String() string {
	switch m {
	case IdentityPeerCred:
		return "peercred"
	case IdentityNone:
		return "none"
	default:
		return fmt.Sprintf("IdentityModel(%d)", int(m))
	}
}

// Transport is one way of reaching a remote sessiond.
type Transport interface {
	// Name is the transport's stable registry key and the qualifier used in
	// HostRef.ID (e.g. "ssh" for ids of the form "ssh:boxb").
	Name() string

	// Dial returns a bidirectional, binary-clean byte stream to the sessiond
	// Unix socket on host. That is the ONLY contract: no framing, no
	// handshake, no ordering guarantees beyond those of a stream. Callers
	// hand the result to sessiond.DialConn.
	//
	// ctx governs establishing the connection, not its lifetime — the same
	// semantics as net.Dialer.DialContext. Close the returned net.Conn to end
	// the session.
	Dial(ctx context.Context, host HostRef) (net.Conn, error)

	// Discover enumerates candidate hosts this transport already knows about.
	// Returning an empty slice with a nil error is VALID and expected: a
	// transport may have no discovery mechanism at all, and manual entry
	// always remains available. A non-nil error means discovery was attempted
	// and failed, which is different from having nothing to report.
	Discover(ctx context.Context) ([]HostRef, error)

	// Provision gets muxterm onto the far side, or reports precisely why it
	// is not usable there. Implementations should return a typed error so a
	// caller can tell distinct remediable states apart rather than showing one
	// generic failure.
	Provision(ctx context.Context, host HostRef) error

	// Identity reports what the far end can prove about the caller from the
	// connection alone. Callers must not assume IdentityPeerCred.
	Identity() IdentityModel
}
