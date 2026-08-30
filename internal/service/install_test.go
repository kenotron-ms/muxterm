package service

import (
	"context"
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

func (m *mockCommander) Run(_ context.Context, name string, args ...string) (CommandResult, error) {
	m.commands = append(m.commands, mockCmd{Name: name, Args: args})
	if m.err != nil {
		return CommandResult{}, m.err
	}
	if name == "systemctl" && sliceEqual(args, []string{
		"--user",
		"show",
		"--property=MainPID",
		"--value",
		"muxterm-sessiond.service",
	}) {
		return CommandResult{Stdout: []byte("41001\n"), ExitCode: 0}, nil
	}
	if name == "launchctl" && len(args) == 2 && args[0] == "print" {
		return CommandResult{Stdout: []byte("\tpid = 41001\n"), ExitCode: 0}, nil
	}
	return CommandResult{ExitCode: 0}, nil
}

func (m *mockCommander) findCommand(name string) *mockCmd {
	for i := range m.commands {
		if m.commands[i].Name == name {
			return &m.commands[i]
		}
	}
	return nil
}

type mockProbe struct{}

func (*mockProbe) Probe(context.Context, string, ReadinessRequirement) error {
	return nil
}

func TestInstall_Linux_WritesUnitFile(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "test-secret",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd, &mockProbe{})
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
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd, &mockProbe{})
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	if len(cmd.commands) != 8 {
		t.Fatalf("expected 8 commands, got %d", len(cmd.commands))
	}

	identity := cmd.commands[0]
	if identity.Name != "systemctl" || !sliceEqual(identity.Args, []string{
		"--user",
		"show",
		"--property=MainPID",
		"--value",
		"muxterm-sessiond.service",
	}) {
		t.Errorf("command[0] = %q %v, want systemctl sessiond identity query", identity.Name, identity.Args)
	}

	reload := cmd.commands[1]
	if reload.Name != "systemctl" || !sliceEqual(reload.Args, []string{"--user", "daemon-reload"}) {
		t.Errorf("command[1] = %q %v, want systemctl [--user daemon-reload]", reload.Name, reload.Args)
	}

	enableSessiond := cmd.commands[2]
	if enableSessiond.Name != "systemctl" || !sliceEqual(enableSessiond.Args, []string{"--user", "enable", "muxterm-sessiond.service"}) {
		t.Errorf("command[2] = %q %v, want systemctl [--user enable muxterm-sessiond.service]", enableSessiond.Name, enableSessiond.Args)
	}

	enableWeb := cmd.commands[5]
	if enableWeb.Name != "systemctl" || !sliceEqual(enableWeb.Args, []string{"--user", "enable", "muxterm.service"}) {
		t.Errorf("command[5] = %q %v, want systemctl [--user enable muxterm.service]", enableWeb.Name, enableWeb.Args)
	}

	startWeb := cmd.commands[6]
	if startWeb.Name != "systemctl" || !sliceEqual(startWeb.Args, []string{"--user", "start", "muxterm.service"}) {
		t.Errorf("command[6] = %q %v, want systemctl [--user start muxterm.service]", startWeb.Name, startWeb.Args)
	}

	linger := cmd.commands[7]
	if linger.Name != "loginctl" || !sliceEqual(linger.Args, []string{"enable-linger"}) {
		t.Errorf("command[7] = %q %v, want loginctl [enable-linger]", linger.Name, linger.Args)
	}
}

func TestInstall_Linux_WritesBothUnitFiles(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "test-secret",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd, &mockProbe{})
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	webData, err := os.ReadFile(unitPath)
	if err != nil {
		t.Fatalf("reading web unit file: %v", err)
	}
	if !strings.Contains(string(webData), "Wants=muxterm-sessiond.service") {
		t.Error("web unit file missing Wants=muxterm-sessiond.service")
	}

	sessiondData, err := os.ReadFile(sessiondPath)
	if err != nil {
		t.Fatalf("reading sessiond unit file: %v", err)
	}
	if !strings.Contains(string(sessiondData), "/usr/local/bin/muxterm sessiond") {
		t.Error("sessiond unit file missing '/usr/local/bin/muxterm sessiond'")
	}
}

func TestInstall_Darwin_WritesPlistFile(t *testing.T) {
	tmp := t.TempDir()
	plistPath := filepath.Join(tmp, "com.muxterm.plist")
	sessiondPlistPath := filepath.Join(tmp, "com.muxterm.sessiond.plist")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "darwin-secret",
		SafePATH:   "/usr/bin:/usr/local/bin",
		RuntimeDir: filepath.Join(tmp, "muxterm", "runtime"),
		StateDir:   filepath.Join(tmp, "muxterm", "state"),
		LogDir:     filepath.Join(tmp, "muxterm", "log"),
	}
	if err := os.MkdirAll(cfg.RuntimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := installDarwin(cfg, plistPath, sessiondPlistPath, cmd, &mockProbe{})
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
	sessiondPlistPath := filepath.Join(tmp, "com.muxterm.sessiond.plist")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
		RuntimeDir: filepath.Join(tmp, "muxterm", "runtime"),
		StateDir:   filepath.Join(tmp, "muxterm", "state"),
		LogDir:     filepath.Join(tmp, "muxterm", "log"),
	}
	if err := os.MkdirAll(cfg.RuntimeDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := &mockCommander{}

	err := installDarwin(cfg, plistPath, sessiondPlistPath, cmd, &mockProbe{})
	if err != nil {
		t.Fatalf("installDarwin() error: %v", err)
	}

	if len(cmd.commands) != 4 {
		t.Fatalf("expected 4 commands, got %d", len(cmd.commands))
	}

	load := cmd.commands[3]
	if load.Name != "launchctl" {
		t.Errorf("command[3] = %q, want launchctl", load.Name)
	}
	if len(load.Args) != 3 || load.Args[0] != "bootstrap" || load.Args[2] != plistPath {
		t.Errorf("command[3] args = %v, want launchctl bootstrap <gui-domain> %q", load.Args, plistPath)
	}
}

func TestInstall_Linux_CreatesMissingDirs(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "deep", "nested", "dir", "muxterm.service")
	sessiondPath := filepath.Join(tmp, "deep", "nested", "dir", "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd, &mockProbe{})
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
