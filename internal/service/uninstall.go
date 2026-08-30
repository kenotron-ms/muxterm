package service

import (
	"context"
	"fmt"
	"os"
	"time"
)

const serviceUninstallTimeout = 30 * time.Second

func Uninstall() error {
	cmd := &execCommander{}
	ctx, cancel := context.WithTimeout(context.Background(), serviceUninstallTimeout)
	defer cancel()
	switch DetectPlatform() {
	case "linux":
		return uninstallLinuxWithContext(ctx, SystemdUnitPath(), SessiondSystemdUnitPath(), cmd)
	case "darwin":
		return uninstallDarwinWithContext(ctx, LaunchdPlistPath(), SessiondLaunchdPlistPath(), cmd)
	case "windows":
		return fmt.Errorf("Windows service uninstallation is not yet supported")
	default:
		return fmt.Errorf("unsupported platform: %s", DetectPlatform())
	}
}

func uninstallLinux(webUnitPath, sessiondUnitPath string, cmd Commander) error {
	ctx := context.Background()
	return uninstallLinuxWithContext(ctx, webUnitPath, sessiondUnitPath, cmd)
}

func uninstallLinuxWithContext(
	ctx context.Context,
	webUnitPath, sessiondUnitPath string,
	cmd Commander,
) error {
	webPresent, err := ownedDefinitionPresent(webUnitPath)
	if err != nil {
		return fmt.Errorf("inspect web unit file: %w", err)
	}
	sessiondPresent, err := ownedDefinitionPresent(sessiondUnitPath)
	if err != nil {
		return fmt.Errorf("inspect sessiond unit file: %w", err)
	}
	if !webPresent && !sessiondPresent {
		return nil
	}

	if webPresent {
		if _, err := cmd.Run(ctx, "systemctl", "--user", "disable", "--now", "muxterm.service"); err != nil {
			return fmt.Errorf("systemctl disable web: %w", err)
		}
	}
	if sessiondPresent {
		if _, err := cmd.Run(ctx, "systemctl", "--user", "disable", "--now", "muxterm-sessiond.service"); err != nil {
			return fmt.Errorf("systemctl disable sessiond: %w", err)
		}
	}
	if webPresent {
		if err := removeOwnedDefinition(webUnitPath); err != nil {
			return fmt.Errorf("remove web unit file: %w", err)
		}
	}
	if sessiondPresent {
		if err := removeOwnedDefinition(sessiondUnitPath); err != nil {
			return fmt.Errorf("remove sessiond unit file: %w", err)
		}
	}
	if _, err := cmd.Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	return nil
}

func uninstallDarwin(webPlistPath, sessiondPlistPath string, cmd Commander) error {
	ctx := context.Background()
	return uninstallDarwinWithContext(ctx, webPlistPath, sessiondPlistPath, cmd)
}

func uninstallDarwinWithContext(
	ctx context.Context,
	webPlistPath, sessiondPlistPath string,
	cmd Commander,
) error {
	webPresent, err := ownedDefinitionPresent(webPlistPath)
	if err != nil {
		return fmt.Errorf("inspect web plist: %w", err)
	}
	sessiondPresent, err := ownedDefinitionPresent(sessiondPlistPath)
	if err != nil {
		return fmt.Errorf("inspect sessiond plist: %w", err)
	}
	if !webPresent && !sessiondPresent {
		return nil
	}

	supervisor := newDarwinSupervisor(cmd, os.Getuid(), webPlistPath, sessiondPlistPath)
	if webPresent {
		if _, err := cmd.Run(ctx, "launchctl", "bootout", supervisor.webServiceTarget); err != nil {
			return fmt.Errorf("launchctl bootout web: %w", err)
		}
	}
	if sessiondPresent {
		if _, err := cmd.Run(ctx, "launchctl", "bootout", supervisor.sessiondServiceTarget); err != nil {
			return fmt.Errorf("launchctl bootout sessiond: %w", err)
		}
	}
	if webPresent {
		if err := removeOwnedDefinition(webPlistPath); err != nil {
			return fmt.Errorf("remove web plist: %w", err)
		}
	}
	if sessiondPresent {
		if err := removeOwnedDefinition(sessiondPlistPath); err != nil {
			return fmt.Errorf("remove sessiond plist: %w", err)
		}
	}
	return nil
}

func IsInstalled() bool {
	switch DetectPlatform() {
	case "linux":
		return definitionsPresent(SystemdUnitPath(), SessiondSystemdUnitPath())
	case "darwin":
		return definitionsPresent(LaunchdPlistPath(), SessiondLaunchdPlistPath())
	default:
		return false
	}
}

func definitionsPresent(paths ...string) bool {
	for _, path := range paths {
		present, err := ownedDefinitionPresent(path)
		if err != nil || !present {
			return false
		}
	}
	return true
}

func ownedDefinitionPresent(path string) (bool, error) {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("owned definition is not a regular file")
	}
	return true, nil
}

func removeOwnedDefinition(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
