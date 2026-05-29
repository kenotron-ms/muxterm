package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type mockCommander struct {
	commands []mockCmd
	err      error
}

type mockCmd struct {
	Name string
	Args []string
}

func (m *mockCommander) Run(name string, args ...string) ([]byte, error) {
	m.commands = append(m.commands, mockCmd{Name: name, Args: args})
	if m.err != nil {
		return nil, m.err
	}
	return nil, nil
}

func (m *mockCommander) findCommand(name string) *mockCmd {
	for i := range m.commands {
		if m.commands[i].Name == name {
			return &m.commands[i]
		}
	}
	return nil
}

func TestInstall_Linux_WritesUnitFile(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "test-secret",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, cmd)
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	data, err := os.ReadFile(unitPath)
	if err != nil {
		t.Fatalf("reading unit file: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "/usr/local/bin/muxterm") {
		t.Error("unit file missing binary path")
	}
	if !strings.Contains(content, "test-secret") {
		t.Error("unit file missing secret")
	}
}

func TestInstall_Linux_RunsSystemctlEnable(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, cmd)
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	if len(cmd.commands) != 3 {
		t.Fatalf("expected 3 commands, got %d", len(cmd.commands))
	}

	reload := cmd.commands[0]
	if reload.Name != "systemctl" {
		t.Errorf("first command = %q, want systemctl", reload.Name)
	}
	wantReloadArgs := []string{"--user", "daemon-reload"}
	if !sliceEqual(reload.Args, wantReloadArgs) {
		t.Errorf("reload args = %v, want %v", reload.Args, wantReloadArgs)
	}

	enable := cmd.commands[1]
	if enable.Name != "systemctl" {
		t.Errorf("second command = %q, want systemctl", enable.Name)
	}
	wantEnableArgs := []string{"--user", "enable", "--now", "muxterm.service"}
	if !sliceEqual(enable.Args, wantEnableArgs) {
		t.Errorf("enable args = %v, want %v", enable.Args, wantEnableArgs)
	}

	linger := cmd.commands[2]
	if linger.Name != "loginctl" {
		t.Errorf("third command = %q, want loginctl", linger.Name)
	}
	wantLingerArgs := []string{"enable-linger"}
	if !sliceEqual(linger.Args, wantLingerArgs) {
		t.Errorf("linger args = %v, want %v", linger.Args, wantLingerArgs)
	}
}

func TestInstall_Darwin_WritesPlistFile(t *testing.T) {
	tmp := t.TempDir()
	plistPath := filepath.Join(tmp, "com.muxterm.plist")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "darwin-secret",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	cmd := &mockCommander{}

	err := installDarwin(cfg, plistPath, cmd)
	if err != nil {
		t.Fatalf("installDarwin() error: %v", err)
	}

	data, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatalf("reading plist file: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "/usr/local/bin/muxterm") {
		t.Error("plist file missing binary path")
	}
	if !strings.Contains(content, "darwin-secret") {
		t.Error("plist file missing secret")
	}
}

func TestInstall_Darwin_RunsLaunchctl(t *testing.T) {
	tmp := t.TempDir()
	plistPath := filepath.Join(tmp, "com.muxterm.plist")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	err := installDarwin(cfg, plistPath, cmd)
	if err != nil {
		t.Fatalf("installDarwin() error: %v", err)
	}

	if len(cmd.commands) != 1 {
		t.Fatalf("expected 1 command, got %d", len(cmd.commands))
	}

	load := cmd.commands[0]
	if load.Name != "launchctl" {
		t.Errorf("command = %q, want launchctl", load.Name)
	}
	wantArgs := []string{"load", plistPath}
	if !sliceEqual(load.Args, wantArgs) {
		t.Errorf("args = %v, want %v", load.Args, wantArgs)
	}
}

func TestInstall_Linux_CreatesMissingDirs(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "deep", "nested", "dir", "muxterm.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, cmd)
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	if _, err := os.Stat(unitPath); os.IsNotExist(err) {
		t.Error("unit file was not created in nested directory")
	}
}

func sliceEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
