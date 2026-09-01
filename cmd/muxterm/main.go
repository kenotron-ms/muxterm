package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/authserver"
	"github.com/kenotron-ms/muxterm/internal/authserver/loginbackend"
	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/deploy"
	"github.com/kenotron-ms/muxterm/internal/mcp"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/service"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	webstatic "github.com/kenotron-ms/muxterm/web"
)

var version = "dev"

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
	case "doctor":
		if err := runDoctor(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "read-screen":
		if err := runReadScreen(cfg.Args); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "session":
		if err := runSession(cfg.Args); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "pane":
		if err := runPane(cfg.Args); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "layout":
		if err := runLayout(cfg.Args); err != nil {
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

// resolveServerConfig merges the serve-mode CLI overrides on top of the
// config file's [server] section, following this repo's existing
// precedence (flag beats file, file beats the zero default). Consistent
// with config.Merge's documented bool limitation, --behind-reverse-proxy
// cannot be used to turn a config-file `behind_reverse_proxy = true` back
// off; remove the file value instead.
//
// SERVE MODE ONLY. runLocal deliberately does NOT call this: bare
// `muxterm` is loopback-only by definition and must stay that way even on
// a host whose config.toml sets behind_reverse_proxy = true (which is
// exactly the production host). Honoring the file there would disable the
// loopback bypass and point the local browser at the public origin,
// breaking local interactive use on the one machine where it matters most.
func resolveServerConfig(cli Config, file config.ServerConfig) config.ServerConfig {
	out := file
	if cli.PublicOrigin != "" {
		out.PublicOrigin = cli.PublicOrigin
	}
	if cli.BehindReverseProxy {
		out.BehindReverseProxy = true
	}
	return out
}

// publicBaseURL returns the origin muxterm must use whenever it constructs
// one of its own public-facing absolute URLs. Today that is the muxterm-web
// OAuth redirect URI; when Phase 2 (MCP-over-HTTP) adds the RFC 8414
// authorization-server metadata and the RFC 9728 protected-resource
// metadata / canonical /mcp resource URI, those MUST derive from this same
// function so the values cannot drift apart.
//
// Behind a reverse proxy the origin is the operator-configured
// public_origin: a fixed value resolved once at startup, never derived
// per-request from a Host or X-Forwarded-* header — headers are spoofable
// and the design rejects trusting them for any trust-relevant value.
//
// Otherwise it is the pre-existing loopback derivation from addr (the
// server's listen address), where a "0.0.0.0" or unparseable host is
// normalized to 127.0.0.1 because the browser reaches muxterm over
// loopback in that topology.
func publicBaseURL(addr string, sc config.ServerConfig) string {
	if sc.BehindReverseProxy {
		return sc.BaseURL()
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// webRedirectURIFor returns the exact-match redirect URI for the
// muxterm-web OAuth client. authserver's validateRedirectURI compares this
// value byte-for-byte against the incoming redirect_uri, so it must be
// exactly the URL the browser will actually be sent back to.
func webRedirectURIFor(addr string, sc config.ServerConfig) string {
	return publicBaseURL(addr, sc) + "/auth/callback"
}

// newAuthServer wires the platform login backend (PAM on Linux; a
// fail-closed stub on other platforms until Phases 4-5) into a new
// AuthServer for addr. A non-nil error means the login backend is
// unavailable; callers MUST still start the HTTP server (loopback access
// is unaffected) but MUST pass the resulting nil *authserver.AuthServer
// through to server.Config so the auth middleware fails closed for any
// non-loopback caller — see design doc Error Handling, "Login backend
// unavailable."
func newAuthServer(addr string, sc config.ServerConfig) (*authserver.AuthServer, error) {
	backend, err := loginbackend.New()
	if err != nil {
		return nil, err
	}

	tokenDir := filepath.Join(filepath.Dir(config.DefaultPath()), "auth")

	return authserver.New(authserver.Config{
		WebRedirectURI: webRedirectURIFor(addr, sc),
		LoginBackend:   backend,
		TokenStoreDir:  tokenDir,
		RateLimiter:    authserver.NewRateLimiter(5, 15*time.Minute),
	})
}

// runLocal starts muxterm in local mode: starts the HTTP server on localhost,
// wires the per-browser sessiond dialer, opens a browser, and blocks until
// shutdown.
func runLocal(cfg Config) error {
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults

	// Local mode is loopback-only BY DEFINITION and deliberately ignores
	// the [server] section entirely: it never reads that section off the
	// resolved config, never applies serve mode's flag-over-file
	// resolution to it, and never runs its startup validation. (Those three
	// names are deliberately not spelled out here: the C4 guard greps this
	// function body for them, and even a mention in a comment trips it.)
	// Bare `muxterm` on a host whose config.toml sets behind_reverse_proxy =
	// true — i.e. the production host — must still behave exactly as it
	// does today: loopback bypass on, loopback-derived redirect URI, no
	// startup error. Honoring the file here would send the *local* browser
	// to the public origin and turn the bypass off, breaking local
	// interactive use on the one machine where it matters most. Only
	// `serve` mode honors the new fields.
	//
	// The explicit zero config.ServerConfig{} below is what pins that:
	// BehindReverseProxy is false, so webRedirectURIFor falls through to
	// the pre-existing loopback derivation, byte-for-byte unchanged.
	localServerCfg := config.ServerConfig{}

	authSrv, err := newAuthServer(cfg.Addr, localServerCfg)
	if err != nil {
		log.Printf("muxterm: login backend unavailable (%v) — non-loopback access will be denied; local access is unaffected", err)
	}

	srv := server.New(server.Config{
		Addr:          cfg.Addr,
		StaticFS:      mustSubFS(webstatic.Dist, "dist"),
		ConfigPath:    config.DefaultPath(),
		InitialConfig: resolved,
		AuthServer:    authSrv,
		// No BehindReverseProxy field is set: local mode leaves it at its
		// zero false, keeping the IsLocalhost() bypass exactly as today.
		WebRedirectURI: webRedirectURIFor(cfg.Addr, localServerCfg),
		Version:        version,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())

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

// runServe starts muxterm in serve mode, wires the per-browser sessiond dialer,
// and blocks until shutdown. The daemon is ensured lazily by the dialer (per
// browser), which is a no-op under systemd where the daemon is its own unit.
func runServe(cfg Config) error {
	resolved, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults

	// Serve mode is the ONLY mode that honors the [server] section. Fail
	// closed BEFORE the listener binds: an ambiguous or misconfigured
	// security posture must deny, never silently downgrade to a
	// loopback-derived URL (which is the exact bug Phase 3 fixes).
	srvCfg := resolveServerConfig(cfg, resolved.Server)
	if err := srvCfg.Validate(); err != nil {
		return err
	}

	authSrv, err := newAuthServer(cfg.Addr, srvCfg)
	if err != nil {
		log.Printf("muxterm: login backend unavailable (%v) — non-loopback access will be denied; local access is unaffected", err)
	}

	srv := server.New(server.Config{
		Addr:               cfg.Addr,
		StaticFS:           mustSubFS(webstatic.Dist, "dist"),
		NoAuth:             cfg.NoAuth,
		ConfigPath:         config.DefaultPath(),
		InitialConfig:      resolved,
		AuthServer:         authSrv,
		WebRedirectURI:     webRedirectURIFor(cfg.Addr, srvCfg),
		BehindReverseProxy: srvCfg.BehindReverseProxy,
		Version:            version,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer())

	// Publish serve-layer URL so the MCP server can discover the tunnel API.
	if err := sessiond.WriteServerURL(cfg.Addr); err != nil {
		log.Printf("muxterm: could not write server URL: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Printf("muxterm listening on %s", cfg.Addr)
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

// runInstall installs muxterm as a system service.
func runInstall(cfg Config) error {
	svcCfg := service.ServiceConfig{
		Addr:   cfg.Addr,
		Secret: cfg.Secret,
		Force:  cfg.Force,
	}
	if err := service.Install(svcCfg); err != nil {
		return err
	}
	fmt.Printf("muxterm installed and running at http://%s\n", cfg.Addr)
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

// runAmplifierBundleInstall adds muxterm's Amplifier BEHAVIOR (behaviors/
// muxterm.yaml) as an app bundle -- deliberately not the top-level bundle.md.
// bundle.md is a full, standalone app bundle that includes all of
// amplifier-foundation as a base dependency; installing THAT as an --app
// bundle would silently force amplifier-foundation's entire agent/skill/tool
// surface onto every session for every user, regardless of what bundle they
// already run. behaviors/muxterm.yaml carries only what muxterm itself
// needs (the hooks-muxterm-session hook, the tool-mcp wiring, the
// muxterm-expert agent, muxterm's own context) with no foundation
// dependency baked in -- exactly what an --app "always compose this in"
// install should add.
//
// The URI's #subdirectory fragment points directly at the .yaml file, not
// its containing directory: `amplifier bundle add` requires a subdirectory
// to contain a file literally named bundle.md or bundle.yaml, and
// behaviors/muxterm.yaml matches neither name -- confirmed by testing both
// forms directly (`#subdirectory=behaviors` fails with "missing bundle.md
// or bundle.yaml"; `#subdirectory=behaviors/muxterm.yaml` succeeds).
// Precedented elsewhere in the ecosystem: amplifier-bundle-digital-twin-
// universe's own app-bundle install uses the identical
// #subdirectory=behaviors/<name>.yaml shape.
//
// The --app flag makes the behavior active on every Amplifier session, not
// just when explicitly selected.
func runAmplifierBundleInstall() error {
	const bundleURI = "git+https://github.com/kenotron-ms/muxterm@main#subdirectory=behaviors/muxterm.yaml"

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
