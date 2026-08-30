package service

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const (
	commandOutputLimit = 64 << 10
	commandWaitDelay   = time.Second
)

type CommandResult struct {
	Stdout          []byte
	Stderr          []byte
	StdoutTruncated bool
	StderrTruncated bool
	ExitCode        int // -1 for start/cancel before exit status
}

type Commander interface {
	Run(ctx context.Context, name string, args ...string) (CommandResult, error)
}

type execCommander struct{}

type boundedWriter struct {
	data      []byte
	truncated bool
}

func (w *boundedWriter) Write(p []byte) (int, error) {
	written := len(p)
	remaining := commandOutputLimit - len(w.data)
	if len(p) > remaining {
		w.truncated = true
		p = p[:remaining]
	}
	w.data = append(w.data, p...)
	return written, nil
}

func (*execCommander) Run(ctx context.Context, name string, args ...string) (CommandResult, error) {
	var stdout, stderr boundedWriter
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	cmd.WaitDelay = commandWaitDelay

	err := cmd.Run()
	result := CommandResult{
		Stdout:          append([]byte(nil), stdout.data...),
		Stderr:          append([]byte(nil), stderr.data...),
		StdoutTruncated: stdout.truncated,
		StderrTruncated: stderr.truncated,
		ExitCode:        -1,
	}

	if err == nil {
		result.ExitCode = 0
		return result, nil
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		return result, ctxErr
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		result.ExitCode = exitErr.ExitCode()
	}
	return result, err
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

func SessiondLaunchdPlistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", "com.muxterm.sessiond.plist")
}
