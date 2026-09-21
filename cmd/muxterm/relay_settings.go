package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/transport"
	"github.com/kenotron-ms/muxterm/internal/transport/relay"
)

func relayConfigPath() string {
	if p := os.Getenv("MUXTERM_RELAY_CONFIG"); p != "" {
		return p
	}
	return filepath.Join(filepath.Dir(config.DefaultPath()), "relay.json")
}

func newRemoteTransport(watch ...bool) (server.RemoteTransport, error) {
	t := &remoteTransports{ssh: newSSHRemoteTransport(), path: relayConfigPath(), conns: make(map[*trackedRelayConn]struct{})}
	if _, err := os.Stat(t.path); err == nil {
		cfg, err := relay.LoadConfig(t.path)
		if err != nil {
			return nil, err
		}
		next, err := relay.New(cfg)
		if err != nil {
			return nil, err
		}
		t.cfg = cfg
		t.relay = next
	} else if !os.IsNotExist(err) {
		return nil, errors.New("relay settings unavailable")
	}
	// The Operator's MCP helper is a separate process. Observe credential updates
	// and close its old streams too, so it cannot keep using a removed binding.
	if len(watch) > 0 && watch[0] {
		go t.watchSettings()
	}
	return t, nil
}

type remoteTransports struct {
	ssh   server.RemoteTransport
	mu    sync.RWMutex
	path  string
	cfg   relay.Config
	relay *relay.Transport
	conns map[*trackedRelayConn]struct{}
}
type trackedRelayConn struct {
	net.Conn
	owner *remoteTransports
	once  sync.Once
}

func (c *trackedRelayConn) Close() error {
	var err error
	c.once.Do(func() { c.owner.mu.Lock(); delete(c.owner.conns, c); c.owner.mu.Unlock(); err = c.Conn.Close() })
	return err
}
func (t *remoteTransports) Name() string { return "remote" }
func (t *remoteTransports) Dial(ctx context.Context, h transport.HostRef) (net.Conn, error) {
	if strings.HasPrefix(h.ID, "ssh:") {
		return t.ssh.Dial(ctx, h)
	}
	t.mu.RLock()
	next := t.relay
	t.mu.RUnlock()
	if next == nil || !strings.HasPrefix(h.ID, "sandbox:") {
		return nil, errors.New("unknown remote transport")
	}
	conn, err := next.Dial(ctx, h)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	if next != t.relay {
		t.mu.Unlock()
		conn.Close()
		return nil, relay.ErrReset
	}
	c := &trackedRelayConn{Conn: conn, owner: t}
	t.conns[c] = struct{}{}
	t.mu.Unlock()
	return c, nil
}
func (t *remoteTransports) Discover(ctx context.Context) ([]transport.HostRef, error) {
	hosts, err := t.ssh.Discover(ctx)
	if err != nil {
		log.Printf("SSH discovery: %v", err)
	}
	s := t.RelaySettings()
	if s.Configured {
		hosts = append(hosts, transport.HostRef{ID: s.Host, DisplayName: s.DisplayName})
	}
	return hosts, nil
}
func (t *remoteTransports) Probe(ctx context.Context, h transport.HostRef) (server.ProbeReport, error) {
	if strings.HasPrefix(h.ID, "sandbox:") {
		c, err := t.Dial(ctx, h)
		if err != nil {
			return server.ProbeReport{State: "unknown"}, err
		}
		c.Close()
		return server.ProbeReport{State: "present"}, nil
	}
	return t.ssh.Probe(ctx, h)
}
func (t *remoteTransports) Install(ctx context.Context, h transport.HostRef) error {
	if strings.HasPrefix(h.ID, "sandbox:") {
		return errors.New("sandbox agent must be provisioned separately")
	}
	return t.ssh.Install(ctx, h)
}
func (t *remoteTransports) RelaySettings() server.RelaySettings {
	t.mu.RLock()
	defer t.mu.RUnlock()
	s := server.RelaySettings{URL: t.cfg.URL, Host: t.cfg.Host, DisplayName: t.cfg.DisplayName, Configured: t.relay != nil}
	if s.Configured && s.DisplayName == "" {
		s.DisplayName = "Sandbox"
	}
	return s
}

var relayHostPattern = regexp.MustCompile(`^sandbox:[A-Za-z0-9_-]{1,100}$`)

func (t *remoteTransports) ConfigureRelay(ctx context.Context, input server.RelayUpdate) error {
	cfg := relay.Config{URL: strings.TrimSpace(input.URL), Host: strings.TrimSpace(input.Host), DisplayName: strings.TrimSpace(input.DisplayName), Token: strings.TrimSpace(input.Token)}
	if !relayHostPattern.MatchString(cfg.Host) || len(cfg.DisplayName) > 100 || strings.ContainsAny(cfg.DisplayName, "\r\n\x00") {
		return errors.New("enter a valid sandbox ID and display name")
	}
	if cfg.Token == "" {
		t.mu.RLock()
		if cfg.URL == t.cfg.URL && cfg.Host == t.cfg.Host {
			cfg.Token = t.cfg.Token
		}
		t.mu.RUnlock()
	}
	next, err := relay.New(cfg)
	if err != nil {
		return err
	}
	if _, err = next.Discover(ctx); err != nil {
		return errors.New("broker check failed: verify the URL, sandbox ID, access token and running worker")
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return errors.New("cannot encode relay settings")
	}
	if err = os.MkdirAll(filepath.Dir(t.path), 0700); err != nil {
		return errors.New("cannot save private relay settings")
	}
	f, err := os.CreateTemp(filepath.Dir(t.path), ".relay-*")
	if err != nil {
		return errors.New("cannot save private relay settings")
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(f.Name(), t.path)
	}
	if err != nil {
		return errors.New("cannot save private relay settings")
	}
	t.replace(cfg, next)
	return nil
}
func (t *remoteTransports) ClearRelay() error {
	if err := os.Remove(t.path); err != nil && !os.IsNotExist(err) {
		return err
	}
	t.replace(relay.Config{}, nil)
	return nil
}
func (t *remoteTransports) replace(cfg relay.Config, next *relay.Transport) {
	t.mu.Lock()
	t.cfg = cfg
	t.relay = next
	conns := make([]*trackedRelayConn, 0, len(t.conns))
	for c := range t.conns {
		conns = append(conns, c)
	}
	t.mu.Unlock()
	for _, c := range conns {
		c.Close()
	}
}
func (t *remoteTransports) watchSettings() {
	for range time.Tick(time.Second) {
		cfg, err := relay.LoadConfig(t.path)
		if err != nil {
			cfg = relay.Config{}
		}
		t.mu.RLock()
		same := cfg == t.cfg
		t.mu.RUnlock()
		if same {
			continue
		}
		var next *relay.Transport
		if cfg.Host != "" {
			next, err = relay.New(cfg)
			if err != nil {
				cfg = relay.Config{}
				next = nil
			}
		}
		t.replace(cfg, next)
	}
}
func admitRelayServer(addr string, behindProxy bool) error {
	if _, err := os.Stat(relayConfigPath()); os.IsNotExist(err) {
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
		cfg := t.RelaySettings()
		if cfg.Configured {
			return s.Hub().Remotes().Add(transport.HostRef{ID: cfg.Host, DisplayName: cfg.DisplayName})
		}
	}
	return nil
}
