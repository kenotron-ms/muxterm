// muxterm-relay-experiment assembles the first relay increment in containers.
// Normal muxterm does not enable this transport or change its configuration.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/mcp"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/transport"
	"github.com/kenotron-ms/muxterm/internal/transport/relay"
	webstatic "github.com/kenotron-ms/muxterm/web"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	mode := flag.String("mode", "", "broker, worker, serve, or mcp")
	cfgPath := flag.String("config", "", "private role-specific JSON file")
	socket := flag.String("socket", "", "existing private sessiond socket (worker or local serve)")
	addr := flag.String("addr", "127.0.0.1:18080", "listen address (broker or serve)")
	cert := flag.String("cert", "", "broker TLS certificate file")
	key := flag.String("key", "", "broker TLS private key file")
	enabled := flag.Bool("experimental", false, "acknowledge container-only experiment")
	flag.Parse()
	if !*enabled {
		return errors.New("requires --experimental; not a production deployment")
	}
	// Enforce the experiment's isolation boundary, not temporary XDG conventions.
	_, dock := os.Stat("/.dockerenv")
	_, incus := os.Stat("/run/systemd/container")
	if dock != nil && incus != nil {
		return errors.New("relay experiment requires an isolated container")
	}
	cfg, e := relay.LoadConfig(*cfgPath)
	if e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	switch *mode {
	case "broker":
		if (*cert == "") != (*key == "") {
			return errors.New("provide both TLS certificate and key")
		}
		b, e := relay.NewBroker(cfg)
		if e != nil {
			return e
		}
		if *cert == "" || *key == "" {
			if !loopback(*addr) {
				return errors.New("plaintext reference broker must bind loopback behind TLS")
			}
		}
		go b.RunSweeper(ctx)
		s := &http.Server{Addr: *addr, Handler: b, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 8192}
		go func() { <-ctx.Done(); _ = s.Close() }()
		if *cert != "" && *key != "" {
			e = s.ListenAndServeTLS(*cert, *key)
		} else {
			e = s.ListenAndServe()
		}
		if errors.Is(e, http.ErrServerClosed) {
			return nil
		}
		return e
	case "worker":
		if !filepath.IsAbs(*socket) {
			return errors.New("explicit absolute private socket required")
		}
		return relay.RunWorker(ctx, cfg, *socket)
	case "mcp":
		t, e := relay.New(cfg)
		if e != nil {
			return e
		}
		s, close := mcp.NewStdioServer(t)
		defer close()
		return s.Run()
	case "serve":
		if !loopback(*addr) || !filepath.IsAbs(*socket) {
			return errors.New("experiment serve needs loopback and explicit local socket")
		}
		t, e := relay.New(cfg)
		if e != nil {
			return e
		}
		rt := remote{t}
		assets, e := fs.Sub(webstatic.Dist, "dist")
		if e != nil {
			return e
		}
		docs, e := fs.Sub(webstatic.PublicDist, "dist-public")
		if e != nil {
			return e
		}
		s := server.New(server.Config{Addr: *addr, NoAuth: true, InitialConfig: config.Defaults(), StaticFS: assets, PublicDocFS: docs, Remotes: rt, Version: "dev"})
		s.Hub().SetDialer(func(ctx context.Context, h transport.HostRef) (server.DaemonConn, error) {
			if h.ID == "" {
				return sessiond.Dial(*socket)
			}
			c, e := t.Dial(ctx, h)
			if e != nil {
				return nil, e
			}
			return sessiond.DialConn(c), nil
		})
		// Manually configured binding only. The existing hostSession proves it by
		// ListWorkspaces for each browser; inventory alone never claims liveness.
		if e = s.Hub().Remotes().Add(transport.HostRef{ID: cfg.Host, DisplayName: "HTTPS sandbox"}); e != nil {
			return e
		}
		return s.ListenAndServe(ctx)
	default:
		return errors.New("mode must be broker, worker, serve, or mcp")
	}
}
func loopback(addr string) bool {
	h, _, e := net.SplitHostPort(addr)
	if e != nil {
		return false
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

type remote struct{ *relay.Transport }

func (r remote) Install(context.Context, transport.HostRef) error {
	return errors.New("relay image provisioning is outside this experiment")
}
func (r remote) Probe(ctx context.Context, h transport.HostRef) (server.ProbeReport, error) {
	c, e := r.Dial(ctx, h)
	if e != nil {
		return server.ProbeReport{State: "unknown"}, e
	}
	_ = c.Close()
	return server.ProbeReport{State: "present"}, nil
}
