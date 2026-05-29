package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

// Config holds the parsed CLI configuration.
type Config struct {
	Mode   string // local, serve, deploy, version
	Addr   string // listen address
	Secret string // auth token for serve mode
	Target string // SSH target for deploy mode
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
	case "deploy":
		return parseDeploy(args[1:])
	case "version":
		return Config{Mode: "version"}, nil
	case "install":
		return parseInstall(args[1:])
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
