package config

import (
	"testing"
)

func TestDefaultPathUsesXDGConfigHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "/tmp/xdg")
	got := DefaultPath()
	want := "/tmp/xdg/muxterm/config.toml"
	if got != want {
		t.Errorf("DefaultPath() = %q, want %q", got, want)
	}
}

func TestDefaultPathFallsBackToHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", "/home/tester")
	got := DefaultPath()
	want := "/home/tester/.config/muxterm/config.toml"
	if got != want {
		t.Errorf("DefaultPath() = %q, want %q", got, want)
	}
}
