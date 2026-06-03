package service

import (
	"fmt"
	"os"
)

func Uninstall() error {
	cmd := &execCommander{}
	switch DetectPlatform() {
	case "linux":
		return uninstallLinux(SystemdUnitPath(), SessiondSystemdUnitPath(), cmd)
	case "darwin":
		return uninstallDarwin(LaunchdPlistPath(), cmd)
	case "windows":
		return fmt.Errorf("Windows service uninstallation is not yet supported")
	default:
		return fmt.Errorf("unsupported platform: %s", DetectPlatform())
	}
}

func uninstallLinux(webUnitPath, sessiondUnitPath string, cmd Commander) error {
	cmd.Run("systemctl", "--user", "disable", "--now", "muxterm.service")
	cmd.Run("systemctl", "--user", "disable", "--now", "muxterm-sessiond.service")
	cmd.Run("systemctl", "--user", "daemon-reload")
	if err := os.Remove(webUnitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove unit file: %w", err)
	}
	if err := os.Remove(sessiondUnitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove sessiond unit file: %w", err)
	}
	return nil
}

func uninstallDarwin(plistPath string, cmd Commander) error {
	cmd.Run("launchctl", "unload", plistPath)
	if err := os.Remove(plistPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove plist file: %w", err)
	}
	return nil
}

func IsInstalled() bool {
	var path string
	switch DetectPlatform() {
	case "linux":
		path = SystemdUnitPath()
	case "darwin":
		path = LaunchdPlistPath()
	default:
		return false
	}
	_, err := os.Stat(path)
	return err == nil
}
