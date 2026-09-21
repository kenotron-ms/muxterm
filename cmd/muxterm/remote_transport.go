package main

import (
	"context"
	"errors"
	"log"
	"net"
	"os"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/deploy"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/transport"
	"github.com/kenotron-ms/muxterm/internal/transport/relay"
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

// newRemoteTransport enables the owner-enrolled relay without replacing SSH.
// The private config path is process configuration, never a browser parameter.
func newRemoteTransport() (server.RemoteTransport, error) {
	ssh := newSSHRemoteTransport()
	path := os.Getenv("MUXTERM_RELAY_CONFIG")
	if path == "" {
		return ssh, nil
	}
	cfg, err := relay.LoadConfig(path)
	if err != nil {
		return nil, err
	}
	t, err := relay.New(cfg)
	if err != nil {
		return nil, err
	}
	return &remoteTransports{ssh: ssh, relay: t, host: transport.HostRef{ID: cfg.Host, DisplayName: cfg.DisplayName}}, nil
}

type remoteTransports struct {
	ssh   server.RemoteTransport
	relay *relay.Transport
	host  transport.HostRef
}

func (t *remoteTransports) Name() string { return "remote" }
func (t *remoteTransports) Dial(ctx context.Context, h transport.HostRef) (net.Conn, error) {
	if strings.HasPrefix(h.ID, "sandbox:") {
		return t.relay.Dial(ctx, h)
	}
	if !strings.HasPrefix(h.ID, "ssh:") {
		return nil, errors.New("unknown remote transport")
	}
	return t.ssh.Dial(ctx, h)
}
func (t *remoteTransports) Discover(ctx context.Context) ([]transport.HostRef, error) {
	hosts, err := t.ssh.Discover(ctx)
	if err != nil {
		log.Printf("SSH discovery: %v", err)
	}
	// An enrolled host remains visible during an outage. Dial/Probe perform the
	// authenticated liveness check; discovery alone never claims connectivity.
	h := t.host
	if h.DisplayName == "" {
		h.DisplayName = "Sandbox"
	}
	return append(hosts, h), nil
}
func (t *remoteTransports) Probe(ctx context.Context, h transport.HostRef) (server.ProbeReport, error) {
	if strings.HasPrefix(h.ID, "sandbox:") {
		c, err := t.relay.Dial(ctx, h)
		if err != nil {
			return server.ProbeReport{State: "unknown"}, err
		}
		defer c.Close()
		return server.ProbeReport{State: "present"}, nil
	}
	return t.ssh.Probe(ctx, h)
}
func (t *remoteTransports) Install(ctx context.Context, h transport.HostRef) error {
	if strings.HasPrefix(h.ID, "sandbox:") {
		return errors.New("sandbox agent is provisioned separately; cannot install over SSH")
	}
	return t.ssh.Install(ctx, h)
}

func admitRelayServer(addr string, behindProxy bool) error {
	if os.Getenv("MUXTERM_RELAY_CONFIG") == "" {
		return nil
	}
	host, _, err := net.SplitHostPort(addr)
	ip := net.ParseIP(host)
	if err != nil || ip == nil || !ip.IsLoopback() || behindProxy {
		return errors.New("owner-enrolled relay requires a loopback muxterm server without a reverse proxy")
	}
	return nil
}

func addEnrolledRelay(s *server.Server, tr server.RemoteTransport) error {
	if t, ok := tr.(*remoteTransports); ok {
		h := t.host
		if h.DisplayName == "" {
			h.DisplayName = "Sandbox"
		}
		return s.Hub().Remotes().Add(h)
	}
	return nil
}
