package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/kenotron-ms/muxterm/internal/config"
)

// ---------------------------------------------------------------------------
// Merge tests
// ---------------------------------------------------------------------------

func TestMergeStringFieldsApplied(t *testing.T) {
	base := config.Defaults()
	partial := config.Config{}
	partial.Theme.Palette = "gruvbox"
	partial.Font.Family = "FiraCode"
	partial.Terminal.CursorStyle = "underline"
	partial.Terminal.Bell = "off"

	result := config.Merge(base, partial)

	if result.Theme.Palette != "gruvbox" {
		t.Errorf("Theme.Palette: got %q, want %q", result.Theme.Palette, "gruvbox")
	}
	if result.Font.Family != "FiraCode" {
		t.Errorf("Font.Family: got %q, want %q", result.Font.Family, "FiraCode")
	}
	if result.Terminal.CursorStyle != "underline" {
		t.Errorf("Terminal.CursorStyle: got %q, want %q", result.Terminal.CursorStyle, "underline")
	}
	if result.Terminal.Bell != "off" {
		t.Errorf("Terminal.Bell: got %q, want %q", result.Terminal.Bell, "off")
	}
}

func TestMergeEmptyStringFieldsNotApplied(t *testing.T) {
	base := config.Defaults()
	partial := config.Config{} // all strings are zero value ""

	result := config.Merge(base, partial)

	defaults := config.Defaults()
	if result.Theme.Palette != defaults.Theme.Palette {
		t.Errorf("Theme.Palette should retain base value %q, got %q", defaults.Theme.Palette, result.Theme.Palette)
	}
	if result.Font.Family != defaults.Font.Family {
		t.Errorf("Font.Family should retain base value %q, got %q", defaults.Font.Family, result.Font.Family)
	}
	if result.Terminal.CursorStyle != defaults.Terminal.CursorStyle {
		t.Errorf("Terminal.CursorStyle should retain base value %q, got %q", defaults.Terminal.CursorStyle, result.Terminal.CursorStyle)
	}
	if result.Terminal.Bell != defaults.Terminal.Bell {
		t.Errorf("Terminal.Bell should retain base value %q, got %q", defaults.Terminal.Bell, result.Terminal.Bell)
	}
}

func TestMergeIntFieldsApplied(t *testing.T) {
	base := config.Defaults()
	partial := config.Config{}
	partial.Font.Size = 16
	partial.Terminal.Scrollback = 5000

	result := config.Merge(base, partial)

	if result.Font.Size != 16 {
		t.Errorf("Font.Size: got %d, want 16", result.Font.Size)
	}
	if result.Terminal.Scrollback != 5000 {
		t.Errorf("Terminal.Scrollback: got %d, want 5000", result.Terminal.Scrollback)
	}
}

func TestMergeZeroIntFieldsNotApplied(t *testing.T) {
	base := config.Defaults()
	partial := config.Config{} // int fields are zero

	result := config.Merge(base, partial)

	defaults := config.Defaults()
	if result.Font.Size != defaults.Font.Size {
		t.Errorf("Font.Size should retain base value %d, got %d", defaults.Font.Size, result.Font.Size)
	}
	if result.Terminal.Scrollback != defaults.Terminal.Scrollback {
		t.Errorf("Terminal.Scrollback should retain base value %d, got %d", defaults.Terminal.Scrollback, result.Terminal.Scrollback)
	}
}

func TestMergeBoolAlwaysApplied(t *testing.T) {
	base := config.Defaults() // CursorBlink = true
	partial := config.Config{}
	partial.Terminal.CursorBlink = false

	result := config.Merge(base, partial)

	if result.Terminal.CursorBlink != false {
		t.Errorf("Terminal.CursorBlink: got true, want false (bool always applied from partial)")
	}
}

func TestMergeDoesNotMutateBase(t *testing.T) {
	base := config.Defaults()
	origPalette := base.Theme.Palette

	partial := config.Config{}
	partial.Theme.Palette = "solarized"

	_ = config.Merge(base, partial)

	if base.Theme.Palette != origPalette {
		t.Errorf("base was mutated: Theme.Palette changed from %q to %q", origPalette, base.Theme.Palette)
	}
}

// ---------------------------------------------------------------------------
// Write tests
// ---------------------------------------------------------------------------

func TestWriteCreatesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	cfg := config.Defaults()
	if err := config.Write(path, cfg); err != nil {
		t.Fatalf("Write() returned unexpected error: %v", err)
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file to exist at %s: %v", path, err)
	}
}

func TestWriteCreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "deep", "nested", "config.toml")

	cfg := config.Defaults()
	if err := config.Write(path, cfg); err != nil {
		t.Fatalf("Write() returned unexpected error: %v", err)
	}

	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected file to exist at %s: %v", path, err)
	}
}

func TestWriteProducesValidTOML(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	original := config.Defaults()
	original.Theme.Palette = "solarized"
	original.Font.Size = 18
	original.Terminal.Bell = "audible"

	if err := config.Write(path, original); err != nil {
		t.Fatalf("Write() returned unexpected error: %v", err)
	}

	// Read back and decode
	var readBack config.Config
	if _, err := toml.DecodeFile(path, &readBack); err != nil {
		t.Fatalf("written file is not valid TOML: %v", err)
	}

	if readBack.Theme.Palette != "solarized" {
		t.Errorf("Theme.Palette: got %q, want %q", readBack.Theme.Palette, "solarized")
	}
	if readBack.Font.Size != 18 {
		t.Errorf("Font.Size: got %d, want 18", readBack.Font.Size)
	}
	if readBack.Terminal.Bell != "audible" {
		t.Errorf("Terminal.Bell: got %q, want %q", readBack.Terminal.Bell, "audible")
	}
}

func TestWriteRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.toml")

	original := config.Defaults()
	if err := config.Write(path, original); err != nil {
		t.Fatalf("Write() failed: %v", err)
	}

	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("Load() after Write() failed: %v", err)
	}

	if loaded.Theme.Palette != original.Theme.Palette {
		t.Errorf("round-trip Theme.Palette: got %q, want %q", loaded.Theme.Palette, original.Theme.Palette)
	}
	if loaded.Font.Size != original.Font.Size {
		t.Errorf("round-trip Font.Size: got %d, want %d", loaded.Font.Size, original.Font.Size)
	}
	if loaded.Terminal.Scrollback != original.Terminal.Scrollback {
		t.Errorf("round-trip Terminal.Scrollback: got %d, want %d", loaded.Terminal.Scrollback, original.Terminal.Scrollback)
	}
}
