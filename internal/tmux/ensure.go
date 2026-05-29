package tmux

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
)

const (
	minMajor       = 3
	minMinor       = 2
	defaultSession = "muxterm"
)

// parseTmuxVersion parses 'tmux X.Y' or 'tmux X.Ya' format.
// Strips 'tmux ' prefix, splits on '.', parses major as int,
// strips trailing letters from minor part then parses as int.
func parseTmuxVersion(output string) (major, minor int, err error) {
	if !strings.HasPrefix(output, "tmux ") {
		return 0, 0, fmt.Errorf("unexpected tmux version format: %q", output)
	}

	ver := strings.TrimPrefix(output, "tmux ")
	parts := strings.SplitN(ver, ".", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("unexpected tmux version format: %q", output)
	}

	major, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("invalid major version %q: %w", parts[0], err)
	}

	// Strip trailing letters from minor part (e.g. "5a" -> "5")
	minorStr := strings.TrimRight(parts[1], "abcdefghijklmnopqrstuvwxyz")
	minor, err = strconv.Atoi(minorStr)
	if err != nil {
		return 0, 0, fmt.Errorf("invalid minor version %q: %w", parts[1], err)
	}

	return major, minor, nil
}

// checkVersion calls parseTmuxVersion and returns error if version < 3.2.
func checkVersion(output string) error {
	major, minor, err := parseTmuxVersion(output)
	if err != nil {
		return err
	}

	if major < minMajor || (major == minMajor && minor < minMinor) {
		return fmt.Errorf("tmux %d.%d is too old, need >= %d.%d", major, minor, minMajor, minMinor)
	}

	return nil
}

// parseSessionList trims whitespace, splits on newlines, for each line
// splits on ':' and takes first part as session name. Returns nil for empty input.
func parseSessionList(output string) []string {
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return nil
	}

	lines := strings.Split(trimmed, "\n")
	var names []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		name, _, _ := strings.Cut(line, ":")
		names = append(names, name)
	}

	if len(names) == 0 {
		return nil
	}
	return names
}

// createDefaultSession runs 'tmux new-session -d -s muxterm', returns 'muxterm'.
func createDefaultSession() (string, error) {
	if err := exec.Command("tmux", "new-session", "-d", "-s", defaultSession).Run(); err != nil {
		return "", fmt.Errorf("create default session: %w", err)
	}
	return defaultSession, nil
}

// ListSessionNames returns names of all tmux sessions via
// 'tmux list-sessions -F #{session_name}', returns nil on error.
func ListSessionNames() ([]string, error) {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil, nil
	}
	return parseSessionList(string(out)), nil
}

// EnsureRunning checks tmux exists, parses version, verifies >= 3.2,
// lists sessions, if no sessions creates default 'muxterm' session,
// returns first session name.
func EnsureRunning() (string, error) {
	out, err := exec.Command("tmux", "-V").Output()
	if err != nil {
		return "", fmt.Errorf("tmux not found: %w", err)
	}

	if err := checkVersion(strings.TrimSpace(string(out))); err != nil {
		return "", err
	}

	names, _ := ListSessionNames()
	if len(names) > 0 {
		return names[0], nil
	}

	return createDefaultSession()
}
