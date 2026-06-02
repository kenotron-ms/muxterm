package service

import (
	"os"
	"path/filepath"
)

type Commander interface {
	Run(name string, args ...string) ([]byte, error)
}

func SystemdUnitPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", "muxterm.service")
}

func SessiondSystemdUnitPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", "muxterm-sessiond.service")
}

func LaunchdPlistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", "com.muxterm.plist")
}
