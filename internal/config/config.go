// Package config defines the muxterm configuration structure and hardcoded defaults.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"

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
	Restore   RestoreConfig   `toml:"restore"    json:"restore"`
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

// RestoreDetect specifies how to detect a process eligible for a custom
// restore command. Exactly one field should be set.
type RestoreDetect struct {
	// Env names an environment variable that must be present in the foreground
	// process's environment. Its value is available as ${ENV_VAR_NAME} in the
	// Restore template.
	Env string `toml:"env,omitempty" json:"env,omitempty"`

	// Argv is a prefix string matched against the foreground process's full
	// command line (argv[0] as set by setproctitle, or the joined argv).
	// When matched, everything after the prefix is available as ${argv_suffix}
	// in the Restore template.
	//
	// Example: detect = { argv = "amplifier session=" }
	// matches a process whose title is "amplifier session=abc123" and makes
	// ${argv_suffix} = "abc123".
	Argv string `toml:"argv,omitempty" json:"argv,omitempty"`
}

// RestoreStrategy maps a detection condition to a restore command template.
// When the foreground process matches Detect, the Restore template is expanded
// and used as the pane's restore command instead of the captured argv.
//
// Template variables use shell-style ${NAME} syntax:
//   - ${ENV_VAR_NAME} — value of any env var present in the process environment
//   - ${argv_suffix} — portion of argv[0] after the detect.argv prefix
//   - ${cwd} — working directory of the foreground process
type RestoreStrategy struct {
	Detect  RestoreDetect `toml:"detect" json:"detect"`
	Restore string        `toml:"restore" json:"restore"`
}

// RestoreConfig controls crash-recovery restore behaviour.
type RestoreConfig struct {
	// Strategies is evaluated in order; the first matching strategy wins.
	// If no strategy matches, the captured argv is used as-is.
	Strategies []RestoreStrategy `toml:"strategies" json:"strategies"`

	// SnapshotInterval is how often sessiond writes a background periodic
	// snapshot, independent of registry mutations. Accepts any Go duration
	// string (e.g. "30s", "1m"). Empty or "0" disables periodic snapshots
	// (only mutation-triggered writes occur). Default: "30s".
	SnapshotInterval string `toml:"snapshot_interval" json:"snapshot_interval"`
}

// DriverConfig controls the muxterm-agent driver lifecycle.
// SharedWindowPolicy is RESERVED — parsed and carried through to the client
// but NOT acted on in Phase 5.
type DriverConfig struct {
	Autostart          bool   `toml:"autostart"           json:"autostart"`
	SharedWindowPolicy string `toml:"shared_window_policy" json:"shared_window_policy"`
	Launch             string `toml:"launch"              json:"launch"`
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
	}
}
