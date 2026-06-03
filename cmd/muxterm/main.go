package main

import (
	"context"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/user/muxterm/internal/config"
	"github.com/user/muxterm/internal/deploy"
	"github.com/user/muxterm/internal/server"
	"github.com/user/muxterm/internal/service"
	"github.com/user/muxterm/internal/sessiond"
	webstatic "github.com/user/muxterm/web"
)

var version = "dev"

// tmuxCutoverWarning returns the one-time first-start notice making the tmux
// cutover explicit: muxterm now owns sessions via its own daemon (sessiond) and
// does NOT migrate any pre-existing tmux sessions (a deliberate clean break).
func tmuxCutoverWarning() string {
	return "muxterm now uses its own session daemon (sessiond); pre-existing tmux sessions are NOT migrated. Run `muxterm doctor` for daemon status."
}

func main() {
	cfg, err := ParseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	switch cfg.Mode {
	case "local":
		if err := runLocal(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "serve":
		if err := runServe(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "sessiond":
		if err := runSessiond(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "deploy":
		if err := runDeploy(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "install":
		if err := runInstall(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := runUninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "version":
		fmt.Printf("muxterm %s\n", version)
	}
}

// newSessiondDialerForSocket returns a DialFunc that dials the sessiond daemon
// at socketPath. It does NOT ensure a daemon is running, which makes it a pure,
// unit-testable seam: point it at any live Unix socket and it returns a
// connection-scoped client. serve/local use newSessiondDialer (which also
// ensures the daemon); this variant exists for tests.
func newSessiondDialerForSocket(socketPath string) server.DialFunc {
	return func() (server.DaemonConn, error) {
		return sessiond.Dial(socketPath)
	}
}

// newSessiondDialer returns the DialFunc used by serve/local. Each call ensures
// the sessiond daemon is reachable (Phase 2 helpers: SocketPath + DefaultLogPath
// + EnsureDaemon, a no-op under systemd) and then dials a fresh per-browser
// sessiond.Client. The hub invokes this once per browser WebSocket.
func newSessiondDialer() server.DialFunc {
	return func() (server.DaemonConn, error) {
		sock, err := sessiond.SocketPath()
		if err != nil {
			return nil, err
		}
		logPath, err := sessiond.DefaultLogPath()
		if err != nil {
			return nil, err
		}
		if err := sessiond.EnsureDaemon(sock, logPath); err != nil {
			return nil, err
		}
		return sessiond.Dial(sock)
	}
}

// runLocal starts muxterm in local mode: starts the HTTP server on localhost,
// wires the per-browser sessiond dialer, opens a browser, and blocks until
// shutdown.
func runLocal(cfg Config) error {
	srv := server.New(server.Config{
		Addr:     cfg.Addr,
		StaticFS: mustSubFS(webstatic.Dist, "dist"),
	})
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go openBrowser("http://" + cfg.Addr)

	log.Printf("notice: %s", tmuxCutoverWarning())
	log.Printf("muxterm listening on %s", cfg.Addr)
	return srv.ListenAndServe(ctx)
}

// runServe starts muxterm in serve mode: starts the HTTP server with token auth
// on the configured address, wires the per-browser sessiond dialer, and blocks
// until shutdown. The daemon is ensured lazily by the dialer (per browser),
// which is a no-op under systemd where the daemon is its own unit.
func runServe(cfg Config) error {
	// Auto-generate secret if not provided
	secret := cfg.Secret
	if secret == "" {
		s, err := server.GenerateSecret()
		if err != nil {
			return fmt.Errorf("generate secret: %w", err)
		}
		secret = s
	}

	srv := server.New(server.Config{
		Addr:     cfg.Addr,
		Secret:   secret,
		StaticFS: mustSubFS(webstatic.Dist, "dist"),
	})
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Generate and print access token
	token, err := server.GenerateToken(secret)
	if err != nil {
		return fmt.Errorf("generate token: %w", err)
	}
	log.Printf("notice: %s", tmuxCutoverWarning())
	log.Printf("muxterm listening on %s", cfg.Addr)
	log.Printf("access token: %s", token)

	return srv.ListenAndServe(ctx)
}

// runDeploy deploys muxterm to a remote host via SSH.
func runDeploy(cfg Config) error {
	d, err := deploy.New()
	if err != nil {
		return fmt.Errorf("deploy init: %w", err)
	}
	return d.Deploy(cfg.Target)
}

// runInstall installs muxterm as a system service. If no secret is provided,
// one is auto-generated and printed to the user.
func runInstall(cfg Config) error {
	secret := cfg.Secret
	if secret == "" {
		s, err := server.GenerateSecret()
		if err != nil {
			return fmt.Errorf("generate secret: %w", err)
		}
		secret = s
	}
	svcCfg := service.ServiceConfig{
		Addr:   cfg.Addr,
		Secret: secret,
	}
	if err := service.Install(svcCfg); err != nil {
		return err
	}
	fmt.Printf("muxterm installed and running at http://%s\n", cfg.Addr)
	if cfg.Secret == "" {
		fmt.Printf("auto-generated secret: %s\n", secret)
	}
	return nil
}

// runUninstall removes the muxterm system service.
func runUninstall() error {
	if err := service.Uninstall(); err != nil {
		return err
	}
	fmt.Println("muxterm service removed")
	return nil
}

// runWithGracefulShutdown blocks until srv stops or a SIGINT/SIGTERM is received,
// then performs a graceful shutdown. This consolidates the signal-handling pattern
// shared by runLocal and runServe and is the canonical way to start the server
// in a signal-aware manner from a *server.Server value.
func runWithGracefulShutdown(srv *server.Server) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	return srv.ListenAndServe(ctx)
}

// openBrowser opens the given URL in the default browser. Non-fatal if it fails.
func openBrowser(url string) {
	var cmd string
	switch runtime.GOOS {
	case "darwin":
		cmd = "open"
	case "linux":
		cmd = "xdg-open"
	default:
		return
	}
	if err := exec.Command(cmd, url).Start(); err != nil {
		log.Printf("failed to open browser: %v", err)
	}
}

// mustSubFS returns a sub-FS rooted at dir, panicking on error (embed paths
// are fixed at compile time so a panic here means a programming error).
func mustSubFS(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		panic(fmt.Sprintf("web embed sub: %v", err))
	}
	return sub
}
