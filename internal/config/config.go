// Package config defines the muxterm configuration structure and hardcoded defaults.
package config

// Config is the top-level configuration for muxterm.
type Config struct {
	Theme     ThemeConfig     `toml:"theme"`
	Font      FontConfig      `toml:"font"`
	Terminal  TerminalConfig  `toml:"terminal"`
	Keys      KeysConfig      `toml:"keys"`
	Workspace WorkspaceConfig `toml:"workspace"`
	Driver    DriverConfig    `toml:"driver"`
}

// ThemeConfig controls visual palette selection.
type ThemeConfig struct {
	Palette string `toml:"palette"`
}

// FontConfig controls the terminal font family and size.
type FontConfig struct {
	Family string `toml:"family"`
	Size   int    `toml:"size"`
}

// TerminalConfig controls terminal emulator behaviour.
// Bell accepts: "visual" | "audible" | "off".
type TerminalConfig struct {
	CursorStyle string `toml:"cursor_style"`
	CursorBlink bool   `toml:"cursor_blink"`
	Scrollback  int    `toml:"scrollback"`
	Bell        string `toml:"bell"`
}

// KeysConfig defines muxterm's own UI keybindings.
// These are muxterm UI actions only — never tmux keys.
type KeysConfig struct {
	NextSession     string `toml:"next_session"`
	Split           string `toml:"split"`
	MaximizeRegion  string `toml:"maximize_region"`
	PopOut          string `toml:"pop_out"`
	OpenLauncher    string `toml:"open_launcher"`
	FocusDriver     string `toml:"focus_driver"`
}

// WorkspaceConfig controls workspace layout and presentation.
type WorkspaceConfig struct {
	DefaultPresentation string   `toml:"default_presentation"`
	Rails               []string `toml:"rails"`
}

// DriverConfig controls the muxterm-agent driver lifecycle.
// SharedWindowPolicy is RESERVED — parsed and carried through to the client
// but NOT acted on in Phase 5.
type DriverConfig struct {
	Autostart          bool   `toml:"autostart"`
	SharedWindowPolicy string `toml:"shared_window_policy"`
	Launch             string `toml:"launch"`
}

// Defaults returns a Config populated with hardcoded default values.
func Defaults() Config {
	return Config{
		Theme: ThemeConfig{
			Palette: "tokyo-night",
		},
		Font: FontConfig{
			Family: "'SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Menlo', 'Consolas', monospace",
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
