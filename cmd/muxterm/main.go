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
	"strings"
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
	"github.com/kenotron-ms/muxterm/internal/transport"
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

	// The single assignment of the --remote target, before the dispatch below
	// runs anything: every socket-client subcommand reaches its daemon through
	// dialDaemon, which reads this and nothing else.
	cliRemote = cfg.Remote

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
	case "sessiond-connect":
		if err := runSessiondConnect(); err != nil {
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
	case "workspace":
		if err := runWorkspace(cfg.Args); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "pane":
		if err := runPane(cfg.Args); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "remote":
		if err := runRemote(cfg.Args); err != nil {
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

	// Public origin / reverse-proxy mode. This is the single most common
	// source of "I can't log in from my phone": when it is unset, muxterm
	// derives its own URLs from the listen address and sends remote
	// browsers to a loopback address they cannot reach. Report it here so
	// the failure is diagnosable without reading source.
	fmt.Println()
	resolved, malformed, _ := config.LoadStrictServer(config.DefaultPath())
	sc := resolved.Server
	fmt.Printf("     config:  %s\n", config.DefaultPath())
	if malformed {
		fmt.Printf("  %s  config:  could not be parsed; serve mode will refuse to start\n", fail)
	}

	// The listen address, and where it came from. Without this the one
	// artifact doctor points at -- the unit file -- no longer mentions an
	// address at all, so a confused operator has nowhere to look.
	effAddr, src := resolveAddr("", sc.Addr)
	if err := config.ValidateAddr(effAddr); err != nil {
		fmt.Printf("  %s  addr:    %v\n", fail, err)
	} else {
		listening := "nothing listening"
		mark := fail
		if c, derr := net.DialTimeout("tcp", effAddr, 500*time.Millisecond); derr == nil {
			c.Close() //nolint:errcheck
			listening, mark = "listening", ok
		}
		fmt.Printf("  %s  addr:    %s (%s) -- %s\n", mark, effAddr, src, listening)
	}
	// The installed unit may still carry an address the config file does
	// not account for, in which case the line above describes what serve
	// WOULD use, not what the running service is actually bound to. Say so
	// rather than letting a coincidental listener on the default port read
	// as confirmation.
	if found, needs := unitAddrNeedingMigration(sc.Addr); needs {
		fmt.Printf("  %s  addr:    the installed unit runs muxterm on %s, which is not in the config file\n", fail, found)
		fmt.Printf("     hint:    run 'muxterm install --addr %s' to move it into the config file\n", found)
	}
	switch {
	case sc.BehindReverseProxy && sc.PublicOrigin != "":
		fmt.Printf("  %s  origin:  %s (reverse-proxy mode on)\n", ok, sc.Normalize().BaseURL())
	case sc.BehindReverseProxy:
		fmt.Printf("  %s  origin:  behind_reverse_proxy is on but public_origin is empty; muxterm will refuse to start\n", fail)
		fmt.Printf("     hint:    set public_origin in %s\n", config.DefaultPath())
	case sc.PublicOrigin != "":
		fmt.Printf("  %s  origin:  public_origin is set to %q but behind_reverse_proxy is false, so it is IGNORED\n", fail, sc.PublicOrigin)
		fmt.Printf("     hint:    set behind_reverse_proxy = true in %s to use it\n", config.DefaultPath())
	default:
		fmt.Printf("     origin:  not configured -- URLs derive from the listen address (direct/local access only)\n")
		fmt.Printf("     hint:    reaching muxterm through a proxy or public hostname requires public_origin\n")
	}

	return nil
}

// newSessiondDialerForSocket returns a DialFunc that dials the sessiond daemon
// at socketPath. It does NOT ensure a daemon is running, which makes it a pure,
// unit-testable seam: point it at any live Unix socket and it returns a
// connection-scoped client. serve/local use newSessiondDialer (which also
// ensures the daemon); this variant exists for tests.
//
// It is the FIXED-SOCKET seam and has no transport, so a non-zero host is an
// error rather than something quietly resolved to the local socket.
func newSessiondDialerForSocket(socketPath string) server.DialFunc {
	return func(ctx context.Context, host transport.HostRef) (server.DaemonConn, error) {
		if host.ID != "" {
			return nil, fmt.Errorf("fixed-socket dialer cannot reach remote host %s", host.ID)
		}
		return sessiond.Dial(socketPath)
	}
}

// newSessiondDialer returns the DialFunc used by serve/local.
//
// A zero host is the local daemon and takes today's exact path: each call
// ensures the sessiond daemon is reachable (SocketPath + DefaultLogPath +
// EnsureDaemon, a no-op under systemd) and then dials a fresh per-browser
// sessiond.Client. The hub invokes this once per browser WebSocket.
//
// Any other host goes through tr. EnsureDaemon is deliberately NEVER run for a
// remote: `sessiond-connect` refuses to spawn a daemon by design, so a mistyped
// host fails loudly instead of silently starting a daemon somewhere
// unexpected. tr may be nil, in which case only local dials are possible.
func newSessiondDialer(tr server.RemoteTransport) server.DialFunc {
	return func(ctx context.Context, host transport.HostRef) (server.DaemonConn, error) {
		if host.ID == "" {
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

		if tr == nil {
			return nil, fmt.Errorf("no remote transport configured: cannot reach %s", host.ID)
		}
		conn, err := tr.Dial(ctx, host)
		if err != nil {
			return nil, err
		}
		return sessiond.DialConn(conn), nil
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
	if cli.Addr != "" {
		out.Addr = cli.Addr
	}
	if cli.PublicOrigin != "" {
		out.PublicOrigin = cli.PublicOrigin
	}
	if cli.BehindReverseProxy {
		out.BehindReverseProxy = true
	}
	return out
}

// resolveAddr returns the effective listen address and a human-readable
// account of where it came from.
//
// ONE home for the question "which source supplied this address". Three
// separate answers to it -- in doctor, in runServe, and in runInstall --
// diverged three times during this change, each time reporting a built-in
// default as though the config file had specified it. That sends an
// operator to a file with no answer in it, which is precisely the
// diagnostic gap moving the address into config was meant to close. Any
// new consumer must call this rather than reimplement the precedence.
//
// flagVal is the raw --addr flag, empty when unset. fileVal is
// [server].addr as it stands in the config file -- captured BEFORE any
// default-fill, or the default becomes indistinguishable from an
// operator's choice.
func resolveAddr(flagVal, fileVal string) (addr, source string) {
	switch {
	case flagVal != "":
		return flagVal, "from --addr"
	case fileVal != "":
		return fileVal, "from " + config.DefaultPath()
	default:
		return config.DefaultAddr, "built-in default"
	}
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

	rt := newSSHRemoteTransport()

	// Local mode keeps the loopback bypass, so the token is not strictly
	// required here -- but publishing it anyway keeps the handoff file's
	// shape identical across both modes and costs nothing.
	localToken, err := sessiond.NewLocalToken()
	if err != nil {
		return err
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
		LocalToken:     localToken,
		Version:        version,
		Remotes:        rt,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer(rt))

	// Publish serve-layer URL + local token so the MCP server can discover
	// and authenticate to the tunnel API.
	if err := sessiond.WriteServerURL(cfg.Addr, localToken); err != nil {
		log.Printf("muxterm: could not write server URL: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	browserHost := cfg.Addr
	if _, port, err := net.SplitHostPort(cfg.Addr); err == nil {
		browserHost = "localhost:" + port
	}
	go openBrowser("http://" + browserHost)

	// Local mode deliberately ignores [server], so there is no source to
	// name here -- cfg.Addr is the only one.
	log.Printf("muxterm listening on %s", cfg.Addr)
	return srv.ListenAndServe(ctx)
}

// runServe starts muxterm in serve mode, wires the per-browser sessiond dialer,
// and blocks until shutdown. The daemon is ensured lazily by the dialer (per
// browser), which is a no-op under systemd where the daemon is its own unit.
func runServe(cfg Config) error {
	// LoadStrictServer, not Load: a malformed config file degrades every
	// section to defaults, and for [server] that silently moves the
	// listener and clears behind_reverse_proxy (re-enabling the loopback
	// auth bypass). Serve mode depends on that section, so it refuses
	// rather than guessing.
	resolved, malformed, _ := config.LoadStrictServer(config.DefaultPath())
	if malformed {
		return fmt.Errorf(
			"config: %s could not be parsed, and serve mode depends on its [server] section "+
				"(listen address, public origin, reverse-proxy mode). Fix the file, or move it "+
				"aside to start with built-in defaults", config.DefaultPath())
	}

	// One line, once, at startup: an installed unit still passing --secret
	// is the signal that it predates the mechanism/policy split and has
	// not been regenerated. Harmless, but worth naming so the operator can
	// see why and fix it at their convenience.
	if cfg.Secret != "" {
		log.Printf("muxterm: --secret is deprecated and ignored (muxterm authenticates via browser login); " +
			"re-run `muxterm install` to regenerate a unit without it")
	}

	// Serve mode is the ONLY mode that honors the [server] section. Fail
	// closed BEFORE the listener binds: an ambiguous or misconfigured
	// security posture must deny, never silently downgrade to a
	// loopback-derived URL (which is the exact bug Phase 3 fixes).
	// Normalize BEFORE validating so both the error messages and the value
	// actually used downstream describe the same canonical origin.
	srvCfg := resolveServerConfig(cfg, resolved.Server).Normalize()
	if err := srvCfg.Validate(); err != nil {
		return err
	}

	// Captured before srvCfg's default-fill and before resolved.Server is
	// overwritten below. Once either has happened this is indistinguishable
	// from a value the file actually specified, and the startup log would
	// attribute the built-in default to the config file -- on a freshly
	// installed host, which is the exact case the log exists to explain.
	fileAddr := resolved.Server.Addr

	// ONE resolved listen address, computed once, used everywhere below.
	// cfg.Addr is the raw flag and is empty unless the operator typed it.
	// Every consumer must see the same string: srvCfg.Addr feeds the
	// listener, the OAuth exact-match redirect URI, the auth server, and
	// the MCP handoff file. Resolving the listener but not the redirect
	// URI yields a server on one port advertising a callback on another --
	// login fails for every remote user while nothing crashes and the
	// journal looks healthy.
	addr, addrSrc := resolveAddr(cfg.Addr, fileAddr)
	srvCfg.Addr = addr
	if err := config.ValidateAddr(addr); err != nil {
		return err
	}
	// Accepted-but-probably-not-what-you-meant. Logged, never fatal: a
	// setting that is merely ineffective must not take the service down.
	for _, w := range srvCfg.Warnings() {
		log.Printf("muxterm: %s", w)
	}

	// One value, one answer. Everything downstream of here -- the auth
	// server, the redirect URI, server.Config.InitialConfig, the hub's
	// resolved config, and the config write-back path that persists
	// InitialConfig to disk -- must observe the SAME [server] section.
	// Leaving `resolved` flag-free here would let the process hold two
	// answers at once: auth would use the flag-applied origin while
	// internal/server saw the file's (possibly empty) one, and a config
	// PATCH from the browser would then write that empty value back over
	// the file.
	resolved.Server = srvCfg

	authSrv, err := newAuthServer(addr, srvCfg)
	if err != nil {
		log.Printf("muxterm: login backend unavailable (%v) — non-loopback access will be denied; local access is unaffected", err)
	}

	rt := newSSHRemoteTransport()

	// Mint the same-user helper-process credential before the server is
	// built, so the middleware and the on-disk handoff file agree. Without
	// it the MCP tools have no credential at all and rely entirely on the
	// loopback bypass that behind_reverse_proxy disables.
	localToken, err := sessiond.NewLocalToken()
	if err != nil {
		return err
	}

	srv := server.New(server.Config{
		Addr:               addr,
		StaticFS:           mustSubFS(webstatic.Dist, "dist"),
		NoAuth:             cfg.NoAuth,
		ConfigPath:         config.DefaultPath(),
		InitialConfig:      resolved,
		AuthServer:         authSrv,
		WebRedirectURI:     webRedirectURIFor(addr, srvCfg),
		BehindReverseProxy: srvCfg.BehindReverseProxy,
		LocalToken:         localToken,
		Version:            version,
		Remotes:            rt,
	})
	srv.Hub().SetResolvedConfig(resolved)
	srv.Hub().SetDialer(newSessiondDialer(rt))

	// Publish serve-layer URL + local token so the MCP server can discover
	// and authenticate to the tunnel API.
	if err := sessiond.WriteServerURL(addr, localToken); err != nil {
		log.Printf("muxterm: could not write server URL: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	log.Printf("muxterm listening on %s (%s)", addr, addrSrc)
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
	// Persist the deployment topology BEFORE the service is installed and
	// started. installLinux ends in `systemctl enable --now`, and the
	// server reads its [server] section once at startup -- writing the
	// config afterwards would leave the just-started service running with
	// the old (or absent) public origin until something restarted it.
	//
	// This deliberately does NOT flow into ServiceConfig: the origin never
	// reaches the unit's ExecStart or the launchd plist. See
	// writeInstallServerConfig.
	configPath := config.DefaultPath()
	srvCfg, wrote, err := writeInstallServerConfig(cfg, configPath)
	if err != nil {
		return err
	}
	if wrote {
		fmt.Printf("wrote %s: addr=%q public_origin=%q behind_reverse_proxy=%v\n",
			configPath, srvCfg.Addr, srvCfg.PublicOrigin, srvCfg.BehindReverseProxy)
		// Accepted but probably not what you meant (e.g. an origin set
		// while behind_reverse_proxy is still false, which muxterm
		// ignores). Never fatal -- an ineffective setting must not
		// block the install.
		for _, w := range srvCfg.Warnings() {
			fmt.Fprintf(os.Stderr, "warning: %s\n", w)
		}
	}

	// Refuse to silently discard an address configured somewhere this
	// installer does not manage. The unit is about to be rewritten
	// wholesale; if its current ExecStart carries a listen address that
	// did not come from the config file, overwriting it would move the
	// listener without saying so. Report and stop instead of guessing.
	if found, ok := unitAddrNeedingMigration(srvCfg.Addr); ok {
		return fmt.Errorf(
			"the installed unit runs muxterm on %s, which is not in %s.\n\n"+
				"Installing would rewrite that unit and move the listener.\n\n"+
				"To keep %s, run:\n    muxterm install --addr %s\n\n"+
				"To accept a different address, pass --addr with the one you want.",
			found, configPath, found, found)
	}

	// The resolved address, not the raw flag: after this install the
	// service reads it from the config file, so the flag is usually empty
	// and printing it would misreport where the service actually listens.
	// srvCfg.Addr is post-write: anything the flag supplied has already
	// been persisted, so the file genuinely is the source whenever it is
	// non-empty. Empty means nothing was written and the default applies.
	effectiveAddr, addrSrc := resolveAddr("", srvCfg.Addr)

	svcCfg := service.ServiceConfig{
		Addr:  effectiveAddr,
		Force: cfg.Force,
	}
	if err := service.Install(svcCfg); err != nil {
		return err
	}
	fmt.Printf("muxterm installed; it will listen on %s (%s)\n", effectiveAddr, addrSrc)
	return nil
}

// unitAddrNeedingMigration reports an address found in the installed unit's
// ExecStart that the config file does not already account for.
//
// Deliberately NOT a migration: it does not rewrite anything, and it makes
// no attempt to be a general systemd parser. Recognizing every legal
// ExecStart -- line continuations, whitespace around "=", commented-out
// lines, "--addr=x" versus "--addr x", quoted values, "%" specifiers, the
// "ExecStart=" reset idiom, and drop-ins under muxterm.service.d/ that this
// path never even opens -- means a parser that is confidently wrong in ways
// nobody discovers. This looks for the one shape muxterm itself used to
// write, and when anything is unclear it reports nothing rather than
// guessing. A false negative costs one flag; a false positive would move
// the listener.
func unitAddrNeedingMigration(configuredAddr string) (string, bool) {
	if configuredAddr != "" {
		return "", false // config already has an answer; nothing to preserve
	}
	if runtime.GOOS != "linux" {
		return "", false
	}
	data, err := os.ReadFile(service.SystemdUnitPath())
	if err != nil {
		return "", false // no unit yet: first install
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "ExecStart=") || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		for i, f := range fields {
			var candidate string
			switch {
			case f == "--addr" || f == "-addr":
				if i+1 >= len(fields) {
					continue
				}
				candidate = fields[i+1]
			case strings.HasPrefix(f, "--addr="):
				candidate = strings.TrimPrefix(f, "--addr=")
			case strings.HasPrefix(f, "-addr="):
				candidate = strings.TrimPrefix(f, "-addr=")
			default:
				continue
			}
			candidate = strings.Trim(candidate, `"'`)
			// Only report something that is unambiguously a usable listen
			// address and differs from what a fresh install would choose.
			if config.ValidateAddr(candidate) != nil || strings.Contains(candidate, "%") {
				continue
			}
			if candidate == config.DefaultAddr {
				return "", false
			}
			return candidate, true
		}
	}
	return "", false
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
	const bundleName = "muxterm"

	cmd := exec.Command("amplifier", "bundle", "add", "--app", bundleURI)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("amplifier bundle add failed: %w\n\nMake sure 'amplifier' is installed and on your PATH.", err)
	}

	// `bundle add` is registration, not a fetch. On a machine that already ran
	// this command it prints "Bundle already registered as app bundle" and
	// stops -- leaving the CACHED module source untouched at whatever revision
	// it was first pulled at.
	//
	// That is the silent-failure shape: upgrading muxterm, re-running
	// `muxterm amplifier install`, and getting a hook from weeks ago with no
	// error to explain why the home view reports nothing. Observed in the
	// wild -- a cache holding only __init__.py, with state.py and classify.py
	// missing entirely because they postdated the first install.
	//
	// So always follow the add with an explicit refresh. --yes because this is
	// a non-interactive subprocess and the prompt would otherwise abort it.
	upd := exec.Command("amplifier", "bundle", "update", bundleName, "--yes")
	upd.Stdout = os.Stdout
	upd.Stderr = os.Stderr
	if err := upd.Run(); err != nil {
		// Non-fatal on purpose: registration succeeded, so the bundle IS
		// installed and a first-time install is already correct. Only the
		// refresh half failed, and naming the manual command is more useful
		// than failing the whole install over it.
		fmt.Fprintf(os.Stderr,
			"\nwarning: could not refresh the muxterm bundle sources: %v\n"+
				"If muxterm's Amplifier features look stale, run:\n"+
				"  amplifier bundle update %s --yes\n", err, bundleName)
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
