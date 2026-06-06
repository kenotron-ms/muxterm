package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/user/muxterm/internal/config"
)

// writeTempConfig writes contents to a config.toml file inside t.TempDir()
// and returns the full path to that file.
func writeTempConfig(t *testing.T, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatalf("writeTempConfig: %v", err)
	}
	return path
}

func TestDefaults(t *testing.T) {
	cfg := config.Defaults()

	// Theme
	if cfg.Theme.Palette != "tokyo-night" {
		t.Errorf("Theme.Palette: got %q, want %q", cfg.Theme.Palette, "tokyo-night")
	}

	// Font
	wantFamily := "Monospace"
	if cfg.Font.Family != wantFamily {
		t.Errorf("Font.Family: got %q, want %q", cfg.Font.Family, wantFamily)
	}
	if cfg.Font.Size != 13 {
		t.Errorf("Font.Size: got %d, want 13", cfg.Font.Size)
	}

	// Terminal
	if cfg.Terminal.CursorStyle != "block" {
		t.Errorf("Terminal.CursorStyle: got %q, want %q", cfg.Terminal.CursorStyle, "block")
	}
	if !cfg.Terminal.CursorBlink {
		t.Errorf("Terminal.CursorBlink: got false, want true")
	}
	if cfg.Terminal.Scrollback != 10000 {
		t.Errorf("Terminal.Scrollback: got %d, want 10000", cfg.Terminal.Scrollback)
	}
	if cfg.Terminal.Bell != "visual" {
		t.Errorf("Terminal.Bell: got %q, want %q", cfg.Terminal.Bell, "visual")
	}

	// Keys
	if cfg.Keys.NextSession != "ctrl+shift+]" {
		t.Errorf("Keys.NextSession: got %q, want %q", cfg.Keys.NextSession, "ctrl+shift+]")
	}
	if cfg.Keys.Split != `ctrl+shift+\` {
		t.Errorf("Keys.Split: got %q, want %q", cfg.Keys.Split, `ctrl+shift+\`)
	}
	if cfg.Keys.MaximizeRegion != "ctrl+shift+m" {
		t.Errorf("Keys.MaximizeRegion: got %q, want %q", cfg.Keys.MaximizeRegion, "ctrl+shift+m")
	}
	if cfg.Keys.PopOut != "ctrl+shift+o" {
		t.Errorf("Keys.PopOut: got %q, want %q", cfg.Keys.PopOut, "ctrl+shift+o")
	}
	if cfg.Keys.OpenLauncher != "ctrl+shift+p" {
		t.Errorf("Keys.OpenLauncher: got %q, want %q", cfg.Keys.OpenLauncher, "ctrl+shift+p")
	}
	if cfg.Keys.FocusDriver != "ctrl+shift+a" {
		t.Errorf("Keys.FocusDriver: got %q, want %q", cfg.Keys.FocusDriver, "ctrl+shift+a")
	}

	// Workspace
	if cfg.Workspace.DefaultPresentation != "docked" {
		t.Errorf("Workspace.DefaultPresentation: got %q, want %q", cfg.Workspace.DefaultPresentation, "docked")
	}
	if len(cfg.Workspace.Rails) != 1 || cfg.Workspace.Rails[0] != "sessions" {
		t.Errorf("Workspace.Rails: got %v, want [sessions]", cfg.Workspace.Rails)
	}

	// Driver
	if cfg.Driver.Autostart != false {
		t.Errorf("Driver.Autostart: got true, want false")
	}
	if cfg.Driver.SharedWindowPolicy != "follow" {
		t.Errorf("Driver.SharedWindowPolicy: got %q, want %q", cfg.Driver.SharedWindowPolicy, "follow")
	}
	if cfg.Driver.Launch != "muxterm-agent" {
		t.Errorf("Driver.Launch: got %q, want %q", cfg.Driver.Launch, "muxterm-agent")
	}
}

func TestLoadMissingFileReturnsDefaults(t *testing.T) {
	cfg, err := config.Load("/nonexistent/path/to/config.toml")
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}
	if cfg.Theme.Palette != "tokyo-night" {
		t.Errorf("Theme.Palette: got %q, want %q", cfg.Theme.Palette, "tokyo-night")
	}
	if cfg.Terminal.Scrollback != 10000 {
		t.Errorf("Terminal.Scrollback: got %d, want 10000", cfg.Terminal.Scrollback)
	}
}

func TestLoadOverridesDefaults(t *testing.T) {
	const tomlContent = `
[theme]
palette = "gruvbox"

[font]
size = 16

[terminal]
scrollback = 50000
bell = "off"

[keys]
open_launcher = "ctrl+k"

[workspace]
default_presentation = "single"
`
	path := writeTempConfig(t, tomlContent)

	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}

	// Overridden values must be applied.
	if cfg.Theme.Palette != "gruvbox" {
		t.Errorf("Theme.Palette: got %q, want %q", cfg.Theme.Palette, "gruvbox")
	}
	if cfg.Font.Size != 16 {
		t.Errorf("Font.Size: got %d, want 16", cfg.Font.Size)
	}
	if cfg.Terminal.Scrollback != 50000 {
		t.Errorf("Terminal.Scrollback: got %d, want 50000", cfg.Terminal.Scrollback)
	}
	if cfg.Terminal.Bell != "off" {
		t.Errorf("Terminal.Bell: got %q, want %q", cfg.Terminal.Bell, "off")
	}
	if cfg.Keys.OpenLauncher != "ctrl+k" {
		t.Errorf("Keys.OpenLauncher: got %q, want %q", cfg.Keys.OpenLauncher, "ctrl+k")
	}
	if cfg.Workspace.DefaultPresentation != "single" {
		t.Errorf("Workspace.DefaultPresentation: got %q, want %q", cfg.Workspace.DefaultPresentation, "single")
	}

	// Untouched keys must retain their default values.
	defaults := config.Defaults()
	if cfg.Font.Family != defaults.Font.Family {
		t.Errorf("Font.Family: got %q, want default %q", cfg.Font.Family, defaults.Font.Family)
	}
	if cfg.Keys.NextSession != "ctrl+shift+]" {
		t.Errorf("Keys.NextSession: got %q, want %q", cfg.Keys.NextSession, "ctrl+shift+]")
	}
}

func TestLoadMalformedFallsBackToDefaults(t *testing.T) {
	// A deliberately broken TOML string (unterminated string value).
	const malformed = "[theme]\npalette = \"unterminated"
	path := writeTempConfig(t, malformed)

	cfg, err := config.Load(path)

	// 1. Load must NOT return an error for a malformed config.
	if err != nil {
		t.Fatalf("Load() returned unexpected error: %v", err)
	}
	// 2. Fell back to default theme palette.
	if cfg.Theme.Palette != "tokyo-night" {
		t.Errorf("Theme.Palette: got %q, want %q", cfg.Theme.Palette, "tokyo-night")
	}
	// 3. Fully reset to defaults, not partially parsed.
	if cfg.Terminal.Scrollback != 10000 {
		t.Errorf("Terminal.Scrollback: got %d, want 10000", cfg.Terminal.Scrollback)
	}
}
