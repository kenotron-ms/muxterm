package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

type execCommander struct{}

func (e *execCommander) Run(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

func Install(cfg ServiceConfig) error {
	if cfg.BinaryPath == "" {
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("resolve binary path: %w", err)
		}
		cfg.BinaryPath = exe
	}
	if cfg.SafePATH == "" {
		cfg.SafePATH = os.Getenv("PATH")
	}
	cmd := &execCommander{}
	switch DetectPlatform() {
	case "linux":
		return installLinux(cfg, SystemdUnitPath(), SessiondSystemdUnitPath(), cmd)
	case "darwin":
		return installDarwin(cfg, LaunchdPlistPath(), cmd)
	case "windows":
		return fmt.Errorf("Windows service installation is not yet supported. Run 'muxterm serve' manually instead")
	default:
		return fmt.Errorf("unsupported platform: %s", DetectPlatform())
	}
}

func installLinux(cfg ServiceConfig, webUnitPath, sessiondUnitPath string, cmd Commander) error {
	// Render and write the sessiond unit FIRST so it is in place before the web unit,
	// which Wants/After it.
	sessiondContent, err := RenderSessiondSystemdUnit(cfg)
	if err != nil {
		return fmt.Errorf("render sessiond systemd unit: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(sessiondUnitPath), 0755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	if err := os.WriteFile(sessiondUnitPath, []byte(sessiondContent), 0644); err != nil {
		return fmt.Errorf("write sessiond unit file: %w", err)
	}

	webContent, err := RenderSystemdUnit(cfg)
	if err != nil {
		return fmt.Errorf("render systemd unit: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(webUnitPath), 0755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	if err := os.WriteFile(webUnitPath, []byte(webContent), 0644); err != nil {
		return fmt.Errorf("write unit file: %w", err)
	}

	if _, err := cmd.Run("systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	// Enable sessiond before the web unit so it is up first.
	if _, err := cmd.Run("systemctl", "--user", "enable", "--now", "muxterm-sessiond.service"); err != nil {
		return fmt.Errorf("systemctl enable sessiond: %w", err)
	}
	if _, err := cmd.Run("systemctl", "--user", "enable", "--now", "muxterm.service"); err != nil {
		return fmt.Errorf("systemctl enable: %w", err)
	}

	// Enable user lingering so systemd starts the user service at boot, even before the user logs in.
	// Without this, muxterm.service only runs during active login sessions.
	if _, err := cmd.Run("loginctl", "enable-linger"); err != nil {
		// Print warning but don't fail — loginctl might require root on some systems.
		fmt.Printf("Warning: could not enable lingering for user service. muxterm may not survive reboots: %v\n", err)
	}

	return nil
}

func installDarwin(cfg ServiceConfig, plistPath string, cmd Commander) error {
	content, err := RenderLaunchdPlist(cfg)
	if err != nil {
		return fmt.Errorf("render launchd plist: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(plistPath), 0755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}
	if err := os.WriteFile(plistPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("write plist file: %w", err)
	}
	if _, err := cmd.Run("launchctl", "load", plistPath); err != nil {
		return fmt.Errorf("launchctl load: %w", err)
	}
	return nil
}
