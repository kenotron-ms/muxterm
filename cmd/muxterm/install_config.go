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
	if cli.PublicOrigin == "" && !cli.BehindReverseProxy {
		return config.ServerConfig{}, false, nil
	}

	// config.Load never errors: a missing file yields Defaults(), and a
	// malformed one yields Defaults() plus a logged warning (visible on
	// stderr right above this install's output). The err is checked anyway
	// so a future non-nil return cannot silently clobber the file.
	cfg, err := config.Load(path)
	if err != nil {
		return config.ServerConfig{}, false, fmt.Errorf("read %s: %w", path, err)
	}

	// Same one-way precedence as resolveServerConfig: a supplied flag wins
	// over the file, an absent flag leaves the file's value in place.
	// --behind-reverse-proxy can only turn the setting on; to turn it off,
	// edit the config file.
	next := cfg.Server
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
	check := next
	check.BehindReverseProxy = true
	if err := check.Validate(); err != nil {
		return config.ServerConfig{}, false, err
	}

	// Nothing above this line has written anything: an invalid origin fails
	// the install with the config file untouched.
	cfg.Server = next
	if err := config.Write(path, cfg); err != nil {
		return config.ServerConfig{}, false, err
	}
	return next, true, nil
}
