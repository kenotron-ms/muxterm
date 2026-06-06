// Package config defines the muxterm configuration structure and hardcoded defaults.
package config

import (
	"errors"
	"io/fs"
	"log"
	"os"

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
// These are muxterm UI actions only — never tmux keys.
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

// Defaults returns a Config populated with hardcoded default values.
func Defaults() Config {
	return Config{
		Theme: ThemeConfig{
			Palette: "tokyo-night",
		},
		Font: FontConfig{
			// Match Zellij's web client ("Monospace"): resolves to the
			// OS-configured default monospace font, which renders crisply.
			Family: "Monospace",
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
