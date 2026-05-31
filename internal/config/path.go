package config

import (
	"os"
	"path/filepath"
)

// DefaultPath returns the default path to the muxterm config file.
// It follows the XDG Base Directory specification:
//   - If XDG_CONFIG_HOME is set, uses $XDG_CONFIG_HOME/muxterm/config.toml
//   - Otherwise falls back to $HOME/.config/muxterm/config.toml
func DefaultPath() string {
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, "muxterm", "config.toml")
}
