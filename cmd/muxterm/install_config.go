package main

import (
	"fmt"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// writeInstallServerConfig persists `muxterm install`'s --public-origin and
// --behind-reverse-proxy flags into the muxterm config file at path, and
// returns the resulting [server] section along with whether anything was
// written.
//
// The deployment topology lives in the CONFIG FILE, never in the generated
// systemd unit or launchd plist. Three independent reasons:
//
//  1. Injection. internal/service renders both the unit and the plist from
//     text/template with no escaping of any kind. A public origin is an
//     operator-supplied string that legitimately contains characters those
//     formats treat as syntax -- `%` is a systemd specifier, `&`/`<` break
//     XML, and a newline in the value would open a whole new directive line
//     in the [Service] section. config.Write goes through a TOML encoder
//     that quotes and escapes the value properly.
//
//  2. Survival across upgrades. README documents `muxterm install` as the
//     upgrade command, and service.Install unconditionally overwrites the
//     unit/plist on every run. Anything living only in ExecStart silently
//     disappears the next time the operator upgrades -- turning a working
//     reverse-proxy deployment back into one that redirects the browser to
//     127.0.0.1, which is the exact bug public_origin exists to fix.
//
//  3. Visibility. resolveServerConfig gives CLI flags precedence over the
//     config file, so a unit-baked --public-origin would outrank the
//     config.toml an operator naturally edits -- and there is nothing in
//     config.toml to hint at where the winning value came from. Writing to
//     the file makes the config the single place the value lives, and the
//     single place to change it.
//
// Absent flags mean "leave the configured values alone": when neither flag
// is supplied the file is not opened, not rewritten, and not created. That
// is what makes a bare `muxterm install` upgrade non-destructive to an
// already-configured origin.
func writeInstallServerConfig(cli Config, path string) (config.ServerConfig, bool, error) {
	// Read first regardless: even with no flags supplied the caller needs
	// to know the CONFIGURED addr, so it can tell whether the installed
	// unit is carrying one the config file does not account for.
	//
	// LoadStrictServer, not Load: a malformed file degrades every section
	// to defaults, and writing that back would silently replace the
	// operator's whole config -- theme, keybindings, and the [server]
	// values this function exists to preserve -- with built-in defaults,
	// during an upgrade they ran for unrelated reasons.
	cfg, malformed, err := config.LoadStrictServer(path)
	if err != nil {
		return config.ServerConfig{}, false, fmt.Errorf("read %s: %w", path, err)
	}
	if malformed {
		return config.ServerConfig{}, false, fmt.Errorf(
			"%s could not be parsed. Installing would overwrite it with built-in "+
				"defaults and lose every setting in it. Fix the file, or move it aside "+
				"and re-run", path)
	}

	if cli.Addr == "" && cli.PublicOrigin == "" && !cli.BehindReverseProxy {
		// Nothing to persist. Report the CONFIGURED section so the caller
		// can reason about it, but write nothing: a bare install must
		// leave an already-configured deployment exactly as it found it.
		return cfg.Server, false, nil
	}

	// Same one-way precedence as resolveServerConfig: a supplied flag wins
	// over the file, an absent flag leaves the file's value in place.
	// --behind-reverse-proxy can only turn the setting on; to turn it off,
	// edit the config file.
	next := cfg.Server
	if cli.Addr != "" {
		if err := config.ValidateAddr(cli.Addr); err != nil {
			return config.ServerConfig{}, false, err
		}
		next.Addr = cli.Addr
	}
	if cli.PublicOrigin != "" {
		next.PublicOrigin = cli.PublicOrigin
	}
	if cli.BehindReverseProxy {
		next.BehindReverseProxy = true
	}
	// Normalize BEFORE Validate so validation reports on the value that
	// will actually be written and later used.
	next = next.Normalize()

	// Validate as if behind_reverse_proxy were on, whatever it actually is.
	// ServerConfig.Validate short-circuits to nil when BehindReverseProxy is
	// false, so an origin supplied without the flag would otherwise be
	// written entirely unchecked and only blow up much later, at the startup
	// where the operator finally flips behind_reverse_proxy = true. Reject a
	// malformed origin here, at the moment it is typed.
	// Only when an origin is actually in play. Forcing the check
	// unconditionally would demand a public_origin from an operator who
	// supplied nothing but --addr -- and --addr alone is exactly what the
	// unit-migration message tells them to run, so that combination has to
	// work on a host that has never configured an origin.
	if next.PublicOrigin != "" || next.BehindReverseProxy {
		check := next
		check.BehindReverseProxy = true
		if err := check.Validate(); err != nil {
			return config.ServerConfig{}, false, err
		}
	}

	// Nothing above this line has written anything: an invalid origin fails
	// the install with the config file untouched.
	cfg.Server = next
	if err := config.Write(path, cfg); err != nil {
		return config.ServerConfig{}, false, err
	}
	return next, true, nil
}
