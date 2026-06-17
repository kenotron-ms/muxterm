package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
)

// Config holds the parsed CLI configuration.
type Config struct {
	Mode        string // local, serve, sessiond, deploy, install, uninstall, doctor, version, open-browser, mcp, amplifier-install, help
	Addr        string // listen address
	Secret      string // auth token for serve mode
	NoAuth      bool   // skip WebSocket auth check (dev only — never use in production)
	Target      string // SSH target for deploy mode
	Force       bool   // install: overwrite existing service installation
	BrowserPort int    // open-browser mode only: the port to open as a browser pane
	Transport   string // mcp mode: transport type ("stdio"); SSE arrives in Phase 5
	MCPPort     int    // mcp mode: SSE port (Phase 5, parsed but rejected for now)
}

// printUsage writes top-level help to w.
func printUsage(w io.Writer) {
	fmt.Fprintln(w, "muxterm — browser-based terminal multiplexer")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  muxterm                     Open in browser (0.0.0.0:8311, default)")
	fmt.Fprintln(w, "  muxterm serve [flags]       Start server for remote access")
	fmt.Fprintln(w, "  muxterm install [flags]     Install as a system service")
	fmt.Fprintln(w, "  muxterm uninstall           Remove system service")
	fmt.Fprintln(w, "  muxterm deploy <host>       Deploy to a remote host via SSH")
	fmt.Fprintln(w, "  muxterm doctor              Check daemon and service status")
	fmt.Fprintln(w, "  muxterm mcp [flags]         Start MCP server (stdio transport)")
	fmt.Fprintln(w, "  muxterm amplifier install   Install muxterm bundle into Amplifier")
	fmt.Fprintln(w, "  muxterm version             Print version")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Run 'muxterm <command> --help' for command-specific flags.")
}

// ParseArgs parses command-line arguments and returns a Config.
// It is a pure function with no side effects beyond flag parsing.
func ParseArgs(args []string) (Config, error) {
	if len(args) == 0 {
		return Config{
			Mode: "local",
			Addr: "0.0.0.0:8311",
		}, nil
	}

	switch args[0] {
	case "--help", "-h", "help":
		return Config{Mode: "help"}, nil
	case "serve":
		return parseServe(args[1:])
	case "sessiond":
		return Config{Mode: "sessiond"}, nil
	case "deploy":
		return parseDeploy(args[1:])
	case "version":
		return Config{Mode: "version"}, nil
	case "version-json":
		return Config{Mode: "version-json"}, nil
	case "install":
		return parseInstall(args[1:])
	case "open-browser":
		return parseOpenBrowser(args[1:])
	case "uninstall":
		return Config{Mode: "uninstall"}, nil
	case "doctor":
		return Config{Mode: "doctor"}, nil
	case "mcp":
		return parseMCP(args[1:])
	case "amplifier":
		return parseAmplifier(args[1:])
	default:
		return Config{}, fmt.Errorf("unknown command %q\n\nRun 'muxterm --help' for usage.", args[0])
	}
}

func parseAmplifier(args []string) (Config, error) {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(os.Stdout, "Usage: muxterm amplifier <command>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Commands:")
		fmt.Fprintln(os.Stdout, "  install    Add the muxterm bundle to Amplifier as an app bundle")
		return Config{Mode: "help"}, nil
	}
	switch args[0] {
	case "install":
		return Config{Mode: "amplifier-install"}, nil
	default:
		return Config{}, fmt.Errorf("unknown amplifier command %q\n\nRun 'muxterm amplifier --help' for usage.", args[0])
	}
}

func parseMCP(args []string) (Config, error) {
	fs := flag.NewFlagSet("mcp", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	transport := fs.String("transport", "stdio", "MCP transport type (only 'stdio' supported; SSE arrives in Phase 5)")
	port := fs.Int("port", 9092, "MCP SSE port (Phase 5, parsed but rejected for now)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm mcp [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Start MCP server using stdio transport (JSON-RPC 2.0 over stdin/stdout).")
		fmt.Fprintln(os.Stdout, "stdout is the JSON-RPC transport; all logging goes to stderr.")
		fmt.Fprintln(os.Stdout, "Exposes terminal, workspace, layout, and browser automation tools, plus pane:// resources.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:      "mcp",
		Transport: *transport,
		MCPPort:   *port,
	}, nil
}

func parseServe(args []string) (Config, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	addr := fs.String("addr", "0.0.0.0:8311", "listen address")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	noAuth := fs.Bool("no-auth", false, "skip WebSocket auth check (dev only — never use in production)")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm serve [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Start muxterm server for remote/shared access with optional authentication.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:   "serve",
		Addr:   *addr,
		Secret: *secret,
		NoAuth: *noAuth,
	}, nil
}

func parseDeploy(args []string) (Config, error) {
	fs := flag.NewFlagSet("deploy", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm deploy <host>")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Deploy muxterm to a remote host via SSH.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Arguments:")
		fmt.Fprintln(os.Stdout, "  <host>    SSH target (e.g. user@hostname)")
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() < 1 {
		return Config{}, fmt.Errorf("deploy requires a target argument (e.g. user@host)")
	}
	return Config{
		Mode:   "deploy",
		Target: fs.Arg(0),
	}, nil
}

func parseInstall(args []string) (Config, error) {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(os.Stdout)
	addr := fs.String("addr", "0.0.0.0:8311", "listen address for the service")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	force := fs.Bool("force", false, "stop and overwrite an existing installation")
	fs.Usage = func() {
		fmt.Fprintln(os.Stdout, "Usage: muxterm install [flags]")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Install muxterm as a system service (systemd on Linux, launchd on macOS).")
		fmt.Fprintln(os.Stdout, "Use --force to stop and overwrite an existing installation.")
		fmt.Fprintln(os.Stdout, "")
		fmt.Fprintln(os.Stdout, "Flags:")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:   "install",
		Addr:   *addr,
		Secret: *secret,
		Force:  *force,
	}, nil
}

func parseOpenBrowser(args []string) (Config, error) {
	fs := flag.NewFlagSet("open-browser", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	addr := fs.String("addr", "localhost:8311", "listen address")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	if fs.NArg() < 1 {
		return Config{}, fmt.Errorf("open-browser requires a port argument")
	}
	port, err := strconv.Atoi(fs.Arg(0))
	if err != nil {
		return Config{}, fmt.Errorf("open-browser: invalid port %q: %w", fs.Arg(0), err)
	}
	if port < 1 || port > 65535 {
		return Config{}, fmt.Errorf("open-browser: port %d out of range (1–65535)", port)
	}
	return Config{
		Mode:        "open-browser",
		Addr:        *addr,
		BrowserPort: port,
	}, nil
}
