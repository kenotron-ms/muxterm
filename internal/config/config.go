// Package config defines the muxterm configuration structure and hardcoded defaults.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/BurntSushi/toml"
)

// Config is the top-level configuration for muxterm.
type Config struct {
	Theme     ThemeConfig     `toml:"theme"      json:"theme"`
	Font      FontConfig      `toml:"font"       json:"font"`
	Terminal  TerminalConfig  `toml:"terminal"   json:"terminal"`
	Keys      KeysConfig      `toml:"keys"       json:"keys"`
	Workspace WorkspaceConfig `toml:"workspace"  json:"workspace"`
	Driver    DriverConfig    `toml:"driver"     json:"driver"`
	Server    ServerConfig    `toml:"server"     json:"server"`
	Restore   RestoreConfig   `toml:"restore"    json:"restore"`
}

// ServerConfig holds deployment-topology settings that decide how muxterm
// derives its own public-facing URLs and whether the loopback auth bypass
// applies. Both fields are explicit and opt-in, and are NEVER derived from
// request headers (X-Forwarded-Host, X-Forwarded-Proto, or anything else):
// headers are spoofable, and the design rejects trusting them for any
// trust-relevant value.
//
// These fields are deliberately absent from Merge(), which backs the
// browser-facing PATCH /api/config route — a deployment-topology and
// security setting must not be mutable from a web request.
type ServerConfig struct {
	// PublicOrigin is the canonical public origin at which muxterm is
	// reachable through its fronting reverse proxy, e.g.
	// "https://muxterm.ampbox.io". Scheme and host (with optional port)
	// only — no path, no trailing slash. Empty by default. Ignored
	// entirely when BehindReverseProxy is false.
	PublicOrigin string `toml:"public_origin"        json:"public_origin"`
	// BehindReverseProxy opts muxterm into reverse-proxy mode: every
	// public-facing URL muxterm builds derives from PublicOrigin, and the
	// IsLocalhost() auth bypass is disabled entirely. Opt-in, default
	// false. The bypass must go, because the proxy's own hop to muxterm is
	// indistinguishable from a genuinely local caller at the RemoteAddr
	// level — honoring it would silently grant unauthenticated access to
	// genuinely remote traffic.
	BehindReverseProxy bool `toml:"behind_reverse_proxy" json:"behind_reverse_proxy"`
}

// Validate enforces the design's fail-closed startup rule:
// behind_reverse_proxy without a usable public_origin is a hard
// configuration error, never a silent fall back to a loopback-derived URL
// — that fallback would reproduce the exact "browser redirected to
// 127.0.0.1" bug this configuration exists to fix. Callers MUST refuse to
// start the HTTP listener on a non-nil error.
//
// When BehindReverseProxy is false, PublicOrigin is inapplicable and is
// ignored entirely — not an error.
func (s ServerConfig) Validate() error {
	if !s.BehindReverseProxy {
		return nil
	}
	if s.PublicOrigin == "" {
		return errors.New(`config: behind_reverse_proxy is set but public_origin is empty; set public_origin (e.g. "https://muxterm.example.com") or unset behind_reverse_proxy`)
	}
	u, err := url.Parse(s.PublicOrigin)
	if err != nil {
		return fmt.Errorf("config: public_origin %q is not a valid URL: %w", s.PublicOrigin, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("config: public_origin %q must use the http or https scheme", s.PublicOrigin)
	}
	if u.Host == "" {
		return fmt.Errorf("config: public_origin %q must include a host", s.PublicOrigin)
	}
	return nil
}

// BaseURL returns PublicOrigin ready to have an absolute path appended
// (trailing slashes trimmed, so "https://x/" + "/auth/callback" cannot
// produce a double slash that would break the exact-match redirect-URI
// comparison). Only meaningful when BehindReverseProxy is true.
func (s ServerConfig) BaseURL() string {
	return strings.TrimRight(s.PublicOrigin, "/")
}

// ThemeConfig controls visual palette selection.
type ThemeConfig struct {
	Palette string `toml:"palette" json:"palette"`
}

// FontConfig controls the terminal font family and size.
type FontConfig struct {
	Family string `toml:"family" json:"family"`
	Size   int    `toml:"size"   json:"size"`
}

// TerminalConfig controls terminal emulator behaviour.
// Bell accepts: "visual" | "audible" | "off".
type TerminalConfig struct {
	CursorStyle string `toml:"cursor_style"  json:"cursor_style"`
	CursorBlink bool   `toml:"cursor_blink"  json:"cursor_blink"`
	Scrollback  int    `toml:"scrollback"    json:"scrollback"`
	Bell        string `toml:"bell"          json:"bell"`
}

// KeysConfig defines muxterm's own UI keybindings.
// These are muxterm UI actions only.
type KeysConfig struct {
	NextSession    string `toml:"next_session"     json:"next_session"`
	Split          string `toml:"split"            json:"split"`
	MaximizeRegion string `toml:"maximize_region"  json:"maximize_region"`
	PopOut         string `toml:"pop_out"          json:"pop_out"`
	OpenLauncher   string `toml:"open_launcher"    json:"open_launcher"`
	FocusDriver    string `toml:"focus_driver"     json:"focus_driver"`
}

// WorkspaceConfig controls workspace layout and presentation.
type WorkspaceConfig struct {
	DefaultPresentation string   `toml:"default_presentation" json:"default_presentation"`
	Rails               []string `toml:"rails"                json:"rails"`
}

// DriverConfig controls the muxterm-agent driver lifecycle.
// SharedWindowPolicy is RESERVED — parsed and carried through to the client
// but NOT acted on in Phase 5.
type DriverConfig struct {
	Autostart          bool   `toml:"autostart"           json:"autostart"`
	SharedWindowPolicy string `toml:"shared_window_policy" json:"shared_window_policy"`
	Launch             string `toml:"launch"              json:"launch"`
}

// RestoreConfig controls session-restore snapshotting: periodic capture of
// each pane's cwd, argv, agent identity, and recent output to disk, plus
// boot-time restore from the most recent snapshot — matching what
// tmux-resurrect + tmux-continuum do together for a real tmux session.
//
// Config-file-only, like DriverConfig/ServerConfig above: deliberately absent
// from Merge() (see its doc comment) since a browser PATCH must never toggle
// disk-persistence behavior.
type RestoreConfig struct {
	// Enabled turns periodic snapshotting and boot-time restore on or off.
	// When false, sessiond behaves exactly as it does today: a cold-start
	// blank default workspace on every start, nothing ever written to disk.
	Enabled bool `toml:"enabled" json:"enabled"`
	// SnapshotInterval is how often the daemon captures a fresh snapshot of
	// every live workspace/pane while running. Authored in TOML as a
	// duration string (e.g. "30s"); BurntSushi/toml decodes that directly
	// into a time.Duration.
	SnapshotInterval time.Duration `toml:"snapshot_interval" json:"snapshot_interval"`
}

// Load reads a TOML config file from path and returns a Config.
// Resolution rules:
//   - Missing file → Defaults(), no error (config is optional)
//   - Malformed file → Defaults() + logged warning, no error (a typo can never take the app down)
//   - Present and valid → Defaults() with the file's set fields applied on top (partial configs supported)
func Load(path string) (Config, error) {
	cfg := Defaults()
	if _, statErr := os.Stat(path); errors.Is(statErr, fs.ErrNotExist) {
		return cfg, nil
	}
	if _, err := toml.DecodeFile(path, &cfg); err != nil {
		log.Printf("config: %s is malformed (%v); using built-in defaults", path, err)
		return Defaults(), nil
	}
	return cfg, nil
}

// Merge returns a copy of base with non-zero fields from partial applied.
// Rules:
//   - string fields: applied if partial value is non-empty
//   - int fields: applied if partial value is non-zero
//   - bool fields: always applied from partial (Go zero bool is false;
//     partial updates cannot clear a bool back to false — document this limitation)
func Merge(base, partial Config) Config {
	result := base
	if partial.Theme.Palette != "" {
		result.Theme.Palette = partial.Theme.Palette
	}
	if partial.Font.Family != "" {
		result.Font.Family = partial.Font.Family
	}
	if partial.Font.Size != 0 {
		result.Font.Size = partial.Font.Size
	}
	if partial.Terminal.CursorStyle != "" {
		result.Terminal.CursorStyle = partial.Terminal.CursorStyle
	}
	result.Terminal.CursorBlink = partial.Terminal.CursorBlink
	if partial.Terminal.Scrollback != 0 {
		result.Terminal.Scrollback = partial.Terminal.Scrollback
	}
	if partial.Terminal.Bell != "" {
		result.Terminal.Bell = partial.Terminal.Bell
	}
	return result
}

// Write encodes cfg as TOML and atomically writes it to path.
// Parent directories are created if they do not exist.
func Write(path string, cfg Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("config.Write: mkdir: %w", err)
	}
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("config.Write: create: %w", err)
	}
	defer f.Close()
	if err := toml.NewEncoder(f).Encode(cfg); err != nil {
		return fmt.Errorf("config.Write: encode: %w", err)
	}
	return nil
}

// Defaults returns a Config populated with hardcoded default values.
func Defaults() Config {
	return Config{
		Theme: ThemeConfig{
			Palette: "tokyo-night",
		},
		Font: FontConfig{
			// Default to the server-bundled JetBrains Mono Nerd Font.
			// The WOFF2 files are served from /fonts/ by the muxterm server,
			// so Nerd Font glyphs render correctly in any browser without
			// requiring the user to install fonts on their client machine.
			Family: "JetBrainsMonoNerdFont",
			Size:   13,
		},
		Terminal: TerminalConfig{
			CursorStyle: "block",
			CursorBlink: true,
			Scrollback:  10000,
			Bell:        "visual",
		},
		Keys: KeysConfig{
			NextSession:    "ctrl+shift+]",
			Split:          `ctrl+shift+\`,
			MaximizeRegion: "ctrl+shift+m",
			PopOut:         "ctrl+shift+o",
			OpenLauncher:   "ctrl+shift+p",
			FocusDriver:    "ctrl+shift+a",
		},
		Workspace: WorkspaceConfig{
			DefaultPresentation: "docked",
			Rails:               []string{"sessions"},
		},
		Driver: DriverConfig{
			Autostart:          false,
			SharedWindowPolicy: "follow",
			Launch:             "muxterm-agent",
		},
		// Direct/local-dev topology by default: no reverse proxy, no
		// public origin. Stated explicitly rather than left implicit so
		// the shipped default posture is readable here.
		Server: ServerConfig{
			PublicOrigin:       "",
			BehindReverseProxy: false,
		},
		Restore: RestoreConfig{
			Enabled:          true,
			SnapshotInterval: 30 * time.Second,
		},
	}
}
