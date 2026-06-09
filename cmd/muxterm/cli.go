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
	Mode        string // local, serve, sessiond, deploy, install, uninstall, version, open-browser
	Addr        string // listen address
	Secret      string // auth token for serve mode
	Target      string // SSH target for deploy mode
	BrowserPort int    // open-browser mode only: the port to open as a browser pane
}

// ParseArgs parses command-line arguments and returns a Config.
// It is a pure function with no side effects beyond flag parsing.
func ParseArgs(args []string) (Config, error) {
	if len(args) == 0 {
		return Config{
			Mode: "local",
			Addr: "localhost:8080",
		}, nil
	}

	switch args[0] {
	case "serve":
		return parseServe(args[1:])
	case "sessiond":
		return Config{Mode: "sessiond"}, nil
	case "deploy":
		return parseDeploy(args[1:])
	case "version":
		return Config{Mode: "version"}, nil
	case "install":
		return parseInstall(args[1:])
	case "open-browser":
		return parseOpenBrowser(args[1:])
	case "uninstall":
		return Config{Mode: "uninstall"}, nil
	default:
		// Unknown command falls back to local mode.
		return Config{
			Mode: "local",
			Addr: "localhost:8080",
		}, nil
	}
}

func parseServe(args []string) (Config, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	addr := fs.String("addr", "0.0.0.0:8080", "listen address")
	secret := fs.String("secret", "", "auth secret")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:   "serve",
		Addr:   *addr,
		Secret: *secret,
	}, nil
}

func parseDeploy(args []string) (Config, error) {
	fs := flag.NewFlagSet("deploy", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
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
	fs.SetOutput(os.Stderr)
	addr := fs.String("addr", "localhost:8080", "listen address for the service")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:   "install",
		Addr:   *addr,
		Secret: *secret,
	}, nil
}

func parseOpenBrowser(args []string) (Config, error) {
	fs := flag.NewFlagSet("open-browser", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	addr := fs.String("addr", "localhost:8080", "listen address")
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
