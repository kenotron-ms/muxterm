package main

import (
	"context"
	"net"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/deploy"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/transport"
	sshtransport "github.com/kenotron-ms/muxterm/internal/transport/ssh"
)

// sshRemoteTransport adapts the concrete SSH transport (and the deploy
// package) to server.RemoteTransport.
//
// This adapter is the entire reason internal/server imports neither
// internal/transport/ssh nor internal/deploy: the relay knows only "some
// transport", and the choice of which one lives here, in the binary that
// assembles the process. That is what keeps the transport boundary the design
// asks for from collapsing the first time a second transport arrives.
type sshRemoteTransport struct{ t *sshtransport.Transport }

// newSSHRemoteTransport returns the SSH transport adapted for the server.
func newSSHRemoteTransport() server.RemoteTransport {
	return &sshRemoteTransport{t: sshtransport.New()}
}

func (s *sshRemoteTransport) Name() string { return s.t.Name() }

func (s *sshRemoteTransport) Dial(ctx context.Context, h transport.HostRef) (net.Conn, error) {
	return s.t.Dial(ctx, h)
}

func (s *sshRemoteTransport) Discover(ctx context.Context) ([]transport.HostRef, error) {
	return s.t.Discover(ctx)
}

// Probe maps the transport's typed probe result onto the transport-neutral
// report the Remotes API speaks. ProbeState.String() already produces exactly
// the four wire tokens, so there is no second mapping table to drift.
func (s *sshRemoteTransport) Probe(ctx context.Context, h transport.HostRef) (server.ProbeReport, error) {
	r, err := s.t.Probe(ctx, h)
	if err != nil {
		return server.ProbeReport{State: sshtransport.ProbeUnknown.String()}, err
	}
	return server.ProbeReport{
		State: r.State.String(),
		Path:  r.Path,
		User:  loginOf(h.Addr),
	}, nil
}

// Install runs a full deploy to the far side ("Install & connect").
func (s *sshRemoteTransport) Install(ctx context.Context, h transport.HostRef) error {
	d, err := deploy.New()
	if err != nil {
		return err
	}
	return d.Deploy(h.Addr)
}

// loginOf returns the user part of an ssh target, or "" when the target names
// no user (an ssh alias resolved by ~/.ssh/config, most often). Empty is an
// honest answer: this function reads the target string and nothing else, and
// guessing $USER here would put a wrong name in the connect trace.
func loginOf(addr string) string {
	if i := strings.Index(addr, "@"); i > 0 {
		return addr[:i]
	}
	return ""
}
