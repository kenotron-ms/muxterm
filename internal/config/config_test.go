package config_test

import (
	"testing"

	"github.com/user/muxterm/internal/config"
)

func TestDefaults(t *testing.T) {
	cfg := config.Defaults()

	// Theme
	if cfg.Theme.Palette != "tokyo-night" {
		t.Errorf("Theme.Palette: got %q, want %q", cfg.Theme.Palette, "tokyo-night")
	}

	// Font
	wantFamily := "'SF Mono', 'JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code', 'Menlo', 'Consolas', monospace"
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
