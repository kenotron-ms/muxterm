package service

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const serviceInstallTimeout = 30 * time.Second

func Install(cfg ServiceConfig) error {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return fmt.Errorf("normalize service configuration: %w", err)
	}

	cmd := &execCommander{}
	probe := &protocolSessiondProbe{}
	ctx, cancel := context.WithTimeout(context.Background(), serviceInstallTimeout)
	defer cancel()

	var disposition ReplacementDisposition
	switch DetectPlatform() {
	case "linux":
		disposition, err = installLinuxWithContext(
			ctx,
			normalized,
			SystemdUnitPath(),
			SessiondSystemdUnitPath(),
			cmd,
			probe,
		)
	case "darwin":
		disposition, err = installDarwinWithContext(
			ctx,
			normalized,
			LaunchdPlistPath(),
			SessiondLaunchdPlistPath(),
			cmd,
			probe,
		)
	case "windows":
		return fmt.Errorf("Windows service installation is not yet supported. Run 'muxterm serve' manually instead")
	default:
		return fmt.Errorf("unsupported platform: %s", DetectPlatform())
	}
	if err != nil {
		return err
	}

	switch disposition {
	case ReplacementCommitted, ReplacementCurrent:
		fmt.Printf("muxterm replacement outcome: %s\n", disposition)
	case "":
	default:
		return fmt.Errorf("invalid successful replacement disposition %q", disposition)
	}
	return nil
}

func installLinux(
	cfg ServiceConfig,
	webUnitPath, sessiondUnitPath string,
	cmd Commander,
	probe SessiondProbe,
) error {
	ctx, cancel := context.WithTimeout(context.Background(), serviceInstallTimeout)
	defer cancel()
	_, err := installLinuxWithContext(ctx, cfg, webUnitPath, sessiondUnitPath, cmd, probe)
	return err
}

func installLinuxWithContext(
	ctx context.Context,
	cfg ServiceConfig,
	webUnitPath, sessiondUnitPath string,
	cmd Commander,
	probe SessiondProbe,
) (ReplacementDisposition, error) {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return ReplacementFailed, fmt.Errorf("normalize service configuration: %w", err)
	}
	supervisor := newLinuxSupervisor(cmd)

	incumbent, err := supervisor.SessiondIdentity(ctx)
	incumbentAbsent := errors.Is(err, errSessiondNotInstalled)
	if err != nil && !incumbentAbsent {
		return ReplacementFailed, fmt.Errorf("inspect incumbent sessiond: %w", err)
	}

	sessiondContent, err := RenderSessiondSystemdUnit(normalized)
	if err != nil {
		return ReplacementFailed, fmt.Errorf("render sessiond systemd unit: %w", err)
	}
	webContent, err := RenderSystemdUnit(normalized)
	if err != nil {
		return ReplacementFailed, fmt.Errorf("render systemd unit: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(sessiondUnitPath), 0755); err != nil {
		return ReplacementFailed, fmt.Errorf("create sessiond unit directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(webUnitPath), 0755); err != nil {
		return ReplacementFailed, fmt.Errorf("create web unit directory: %w", err)
	}
	if err := writeServiceDefinition(sessiondUnitPath, []byte(sessiondContent), 0o644); err != nil {
		return ReplacementFailed, fmt.Errorf("write sessiond unit file: %w", err)
	}
	if err := writeServiceDefinition(webUnitPath, []byte(webContent), 0o644); err != nil {
		return ReplacementFailed, fmt.Errorf("write web unit file: %w", err)
	}

	if _, err := cmd.Run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return ReplacementFailed, fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	if err := supervisor.EnableSessiond(ctx); err != nil {
		return ReplacementFailed, err
	}

	if incumbentAbsent {
		if err := supervisor.StartSessiond(ctx); err != nil {
			return ReplacementFailed, err
		}
		if _, err := waitForSessiond(
			ctx,
			supervisor,
			probe,
			sessiondSocketPath(normalized),
			nil,
			SessiondProtocolReady,
		); err != nil {
			return ReplacementFailed, err
		}
	} else if err := verifyIncumbentSessiond(
		ctx,
		supervisor,
		probe,
		sessiondSocketPath(normalized),
		incumbent,
	); err != nil {
		return ReplacementFailed, err
	}

	disposition := ReplacementDisposition("")
	restartWeb := false
	if normalized.Force && !incumbentAbsent {
		client, err := newReplacementClient(normalized, cmd)
		if err != nil {
			return ReplacementFailed, fmt.Errorf("create replacement client: %w", err)
		}
		result, err := controlledReplacement(
			ctx,
			client,
			supervisor,
			probe,
			sessiondSocketPath(normalized),
			incumbent,
		)
		if err != nil {
			return result.Disposition, err
		}
		disposition = result.Disposition
		if disposition != ReplacementCommitted && disposition != ReplacementCurrent {
			return ReplacementFailed, fmt.Errorf("invalid successful replacement disposition %q", disposition)
		}
		restartWeb = true
	}

	if err := supervisor.StartOrRestartWeb(ctx, restartWeb); err != nil {
		return ReplacementFailed, err
	}

	if _, err := cmd.Run(ctx, "loginctl", "enable-linger"); err != nil {
		return ReplacementFailed, fmt.Errorf("loginctl enable-linger: %w", err)
	}

	return disposition, nil
}

func installDarwin(
	cfg ServiceConfig,
	webPlistPath, sessiondPlistPath string,
	cmd Commander,
	probe SessiondProbe,
) error {
	ctx, cancel := context.WithTimeout(context.Background(), serviceInstallTimeout)
	defer cancel()
	_, err := installDarwinWithContext(ctx, cfg, webPlistPath, sessiondPlistPath, cmd, probe)
	return err
}

func installDarwinWithContext(
	ctx context.Context,
	cfg ServiceConfig,
	webPlistPath, sessiondPlistPath string,
	cmd Commander,
	probe SessiondProbe,
) (ReplacementDisposition, error) {
	normalized, err := normalizeServiceConfig(cfg)
	if err != nil {
		return ReplacementFailed, fmt.Errorf("normalize service configuration: %w", err)
	}
	supervisor := newDarwinSupervisor(cmd, os.Getuid(), webPlistPath, sessiondPlistPath)

	incumbent, err := supervisor.SessiondIdentity(ctx)
	incumbentAbsent := errors.Is(err, errSessiondNotInstalled)
	if err != nil && !incumbentAbsent {
		return ReplacementFailed, fmt.Errorf("inspect incumbent sessiond: %w", err)
	}

	sessiondContent, err := RenderSessiondLaunchdPlist(normalized)
	if err != nil {
		return ReplacementFailed, fmt.Errorf("render sessiond launchd plist: %w", err)
	}
	webContent, err := RenderLaunchdPlist(normalized)
	if err != nil {
		return ReplacementFailed, fmt.Errorf("render web launchd plist: %w", err)
	}

	if err := prepareLaunchdOwnedPaths(normalized); err != nil {
		return ReplacementFailed, fmt.Errorf("prepare launchd-owned paths: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(sessiondPlistPath), 0755); err != nil {
		return ReplacementFailed, fmt.Errorf("create sessiond plist directory: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(webPlistPath), 0755); err != nil {
		return ReplacementFailed, fmt.Errorf("create web plist directory: %w", err)
	}
	if err := writeServiceDefinition(sessiondPlistPath, []byte(sessiondContent), 0o600); err != nil {
		return ReplacementFailed, fmt.Errorf("write sessiond plist: %w", err)
	}
	if err := writeServiceDefinition(webPlistPath, []byte(webContent), 0o600); err != nil {
		return ReplacementFailed, fmt.Errorf("write web plist: %w", err)
	}

	if err := supervisor.EnableSessiond(ctx); err != nil {
		return ReplacementFailed, err
	}
	if incumbentAbsent {
		if err := supervisor.StartSessiond(ctx); err != nil {
			return ReplacementFailed, err
		}
		if _, err := waitForSessiond(
			ctx,
			supervisor,
			probe,
			sessiondSocketPath(normalized),
			nil,
			SessiondProtocolReady,
		); err != nil {
			return ReplacementFailed, err
		}
	} else if err := verifyIncumbentSessiond(
		ctx,
		supervisor,
		probe,
		sessiondSocketPath(normalized),
		incumbent,
	); err != nil {
		return ReplacementFailed, err
	}

	disposition := ReplacementDisposition("")
	restartWeb := false
	if normalized.Force && !incumbentAbsent {
		client, err := newReplacementClient(normalized, cmd)
		if err != nil {
			return ReplacementFailed, fmt.Errorf("create replacement client: %w", err)
		}
		result, err := controlledReplacement(
			ctx,
			client,
			supervisor,
			probe,
			sessiondSocketPath(normalized),
			incumbent,
		)
		if err != nil {
			return result.Disposition, err
		}
		disposition = result.Disposition
		if disposition != ReplacementCommitted && disposition != ReplacementCurrent {
			return ReplacementFailed, fmt.Errorf("invalid successful replacement disposition %q", disposition)
		}
		restartWeb = true
	}

	if err := supervisor.StartOrRestartWeb(ctx, restartWeb); err != nil {
		return ReplacementFailed, err
	}
	return disposition, nil
}

func verifyIncumbentSessiond(
	ctx context.Context,
	supervisor Supervisor,
	probe SessiondProbe,
	socketPath string,
	incumbent DaemonIdentity,
) error {
	if incumbent.PID <= 0 {
		return fmt.Errorf("incumbent sessiond identity is invalid")
	}
	if probe == nil {
		return fmt.Errorf("sessiond readiness probe is nil")
	}

	identity, err := supervisor.SessiondIdentity(ctx)
	if err != nil {
		return fmt.Errorf("verify incumbent sessiond identity: %w", err)
	}
	if identity.PID != incumbent.PID {
		return fmt.Errorf(
			"verify incumbent sessiond identity: expected PID %d, got %d",
			incumbent.PID,
			identity.PID,
		)
	}
	if err := probe.Probe(ctx, socketPath, SessiondProtocolReady); err != nil {
		return fmt.Errorf("verify incumbent sessiond protocol readiness: %w", err)
	}

	identity, err = supervisor.SessiondIdentity(ctx)
	if err != nil {
		return fmt.Errorf("verify incumbent sessiond identity after readiness: %w", err)
	}
	if identity.PID != incumbent.PID {
		return fmt.Errorf(
			"verify incumbent sessiond identity after readiness: expected PID %d, got %d",
			incumbent.PID,
			identity.PID,
		)
	}
	return nil
}
