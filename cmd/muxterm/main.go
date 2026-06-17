package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/deploy"
	"github.com/kenotron-ms/muxterm/internal/mcp"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/service"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	webstatic "github.com/kenotron-ms/muxterm/web"
)

var version = "dev"

// sessiondProto is incremented only when the sessiond state/wire format
// changes incompatibly. A matching value between old and new binaries means
// sessions survive an upgrade without a PTY handoff; a changed value triggers
// the full SCM_RIGHTS handoff protocol. Most releases will never bump this.
var sessiondProto = "1"

func main() {
	cfg, err := ParseArgs(os.Args[1:])
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	switch cfg.Mode {
	case "help":
		printUsage(os.Stdout)
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
	case "open-browser":
		if err := runOpenBrowser(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "doctor":
		if err := runDoctor(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "mcp":
		if err := runMCPCommand(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "amplifier-install":
		if err := runAmplifierBundleInstall(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "version":
		fmt.Printf("muxterm %s (MCP: stdio)\n", version)
	case "version-json":
		// Machine-readable version info used by the upgrade path: the new binary
		// is invoked as `muxterm version-json` to determine whether sessiondProto
		// changed and a PTY handoff is required.
		fmt.Printf(`{"version":%q,"sessiondProto":%q}`+"\n", version, sessiondProto)
	}
}

// runDoctor reports the status of the muxterm daemon and system service.
func runDoctor() error {
	const (
		ok   = "\u2713" // ✓
		fail = "\u2717" // ✗
	)

	fmt.Printf("muxterm %s\n\n", version)

	// Daemon
	sock, err := sessiond.SocketPath()
	if err != nil {
		fmt.Printf("  %s  daemon:  could not determine socket path: %v\n", fail, err)
	} else {
		fmt.Printf("     socket:  %s\n", sock)
		if _, err := os.Stat(sock); os.IsNotExist(err) {
			fmt.Printf("  %s  daemon:  not running (socket not found)\n", fail)
			fmt.Printf("     hint:    start with 'muxterm' or check service logs\n")
		} else {
			c, dialErr := sessiond.Dial(sock)
			if dialErr != nil {
				fmt.Printf("  %s  daemon:  socket exists but connection failed: %v\n", fail, dialErr)
			} else {
				c.Close() //nolint:errcheck
				fmt.Printf("  %s  daemon:  running\n", ok)
			}
		}
	}

	// Log
	if logPath, err := sessiond.DefaultLogPath(); err == nil {
		if _, err := os.Stat(logPath); err == nil {
			fmt.Printf("     log:     %s\n", logPath)
		}
	}

	// Service
	fmt.Println()
	switch runtime.GOOS {
	case "darwin":
		plistPath := service.LaunchdPlistPath()
		if _, err := os.Stat(plistPath); err == nil {
			fmt.Printf("  %s  service: launchd agent installed\n", ok)
			fmt.Printf("     plist:   %s\n", plistPath)
		} else {
			fmt.Printf("  %s  service: not installed\n", fail)
			fmt.Printf("     hint:    run 'muxterm install' to auto-start on login\n")
		}
	default:
		unitPath := service.SystemdUnitPath()
		if _, err := os.Stat(unitPath); err == nil {
			fmt.Printf("  %s  service: systemd unit installed\n", ok)
			fmt.Printf("     unit:    %s\n", unitPath)
		} else {
			fmt.Printf("  %s  service: not installed\n", fail)
			fmt.Printf("     hint:    run 'muxterm install' to auto-start on login\n")
		}
	}

	return nil
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
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults
	srv := server.New(server.Config{
		Addr:          cfg.Addr,
		StaticFS:      mustSubFS(webstatic.Dist, "dist"),
		ConfigPath:    config.DefaultPath(),
		InitialConfig: resolved,
		Version:       version,
		SessiondProto: sessiondProto,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())
	startVersionPoller(srv)

	// Publish serve-layer URL so the MCP server can discover the tunnel API.
	if err := sessiond.WriteServerURL(cfg.Addr); err != nil {
		log.Printf("muxterm: could not write server URL: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	browserHost := cfg.Addr
	if _, port, err := net.SplitHostPort(cfg.Addr); err == nil {
		browserHost = "localhost:" + port
	}
	go openBrowser("http://" + browserHost)

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

	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults
	srv := server.New(server.Config{
		Addr:          cfg.Addr,
		Secret:        secret,
		StaticFS:      mustSubFS(webstatic.Dist, "dist"),
		NoAuth:        cfg.NoAuth,
		ConfigPath:    config.DefaultPath(),
		InitialConfig: resolved,
		Version:       version,
		SessiondProto: sessiondProto,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())
	startVersionPoller(srv)

	// Publish serve-layer URL so the MCP server can discover the tunnel API.
	if err := sessiond.WriteServerURL(cfg.Addr); err != nil {
		log.Printf("muxterm: could not write server URL: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Generate and print access token
	token, err := server.GenerateToken(secret)
	if err != nil {
		return fmt.Errorf("generate token: %w", err)
	}
	log.Printf("muxterm listening on %s", cfg.Addr)
	log.Printf("access token: %s", token)

	return srv.ListenAndServe(ctx)
}

// startVersionPoller starts a background goroutine that polls the GitHub
// releases API and updates the hub's latestVersion when a newer release is
// found. The first check happens after a short delay so server startup is not
// blocked; subsequent checks run every hour.
func startVersionPoller(srv *server.Server) {
	go func() {
		// Delay the first check slightly so the server is fully initialised.
		time.Sleep(10 * time.Second)
		check := func() {
			tag, _, _, err := server.FetchLatestRelease()
			if err != nil || tag == "" || tag == version {
				return
			}
			srv.Hub().SetLatestVersion(tag)
			log.Printf("muxterm: update available: %s (current: %s)", tag, version)
		}
		check()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			check()
		}
	}()
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
		Force:  cfg.Force,
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

// runOpenBrowser registers a browser pane with a running muxterm server by
// POSTing to /api/pane. It reports actionable errors for the three failure
// modes: server not reachable, sessiond not running (503), and other errors.
func runOpenBrowser(cfg Config) error {
	url := "http://" + cfg.Addr + "/api/pane"
	body := fmt.Sprintf(`{"surfaceKind":"browser","browserPort":%d,"browserPath":"/"}`, cfg.BrowserPort)
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		return fmt.Errorf("muxterm not running or not reachable at %s", cfg.Addr)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusServiceUnavailable {
		io.Copy(io.Discard, resp.Body) //nolint:errcheck
		return fmt.Errorf("muxterm is running but sessiond is not available — is the daemon started?")
	}
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("server returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	io.Copy(io.Discard, resp.Body) //nolint:errcheck
	fmt.Printf("browser pane opened: port %d\n", cfg.BrowserPort)
	return nil
}

// runAmplifierBundleInstall adds the muxterm Amplifier bundle as an app bundle
// by running: amplifier bundle add --app git+https://github.com/kenotron-ms/muxterm@main#subdirectory=bundle
// The --app flag makes the bundle active on every Amplifier session, not just
// when explicitly selected.
func runAmplifierBundleInstall() error {
	const bundleURI = "git+https://github.com/kenotron-ms/muxterm@main#subdirectory=bundle"

	cmd := exec.Command("amplifier", "bundle", "add", "--app", bundleURI)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("amplifier bundle add failed: %w\n\nMake sure 'amplifier' is installed and on your PATH.", err)
	}
	return nil
}

// runMCPCommand starts the MCP server with stdio transport. stdout is the
// JSON-RPC transport; all logging is redirected to stderr so it does not
// corrupt the wire protocol. Only the "stdio" transport is supported in Phase
// 4; SSE will be added in Phase 5.
func runMCPCommand(cfg Config) error {
	if cfg.Transport != "stdio" {
		return fmt.Errorf("unsupported MCP transport %q: only stdio supported; SSE arrives in Phase 5", cfg.Transport)
	}
	// Redirect all log output to stderr so stdout stays clean for JSON-RPC.
	log.SetOutput(os.Stderr)

	srv, closer := mcp.NewStdioServer()
	defer closer() //nolint:errcheck

	log.Printf("mcp: stdio server ready")
	return srv.Run()
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
