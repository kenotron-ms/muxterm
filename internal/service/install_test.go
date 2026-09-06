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
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd)
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
	// The written unit is mechanism only: a bare `serve`, no --addr and no
	// credential. Both are policy and live in muxterm's config file, which
	// this installer does not overwrite on an upgrade.
	if !strings.Contains(content, "ExecStart=/usr/local/bin/muxterm serve\n") {
		t.Errorf("unit file missing bare 'serve' ExecStart, got:\n%s", content)
	}
	for _, unwanted := range []string{"--addr", "--secret", "localhost:8080"} {
		if strings.Contains(content, unwanted) {
			t.Errorf("unit file must not carry %q, got:\n%s", unwanted, content)
		}
	}
}

func TestInstall_Linux_RunsSystemctlEnable(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd)
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	if len(cmd.commands) != 4 {
		t.Fatalf("expected 4 commands, got %d", len(cmd.commands))
	}

	reload := cmd.commands[0]
	if reload.Name != "systemctl" || !sliceEqual(reload.Args, []string{"--user", "daemon-reload"}) {
		t.Errorf("command[0] = %q %v, want systemctl [--user daemon-reload]", reload.Name, reload.Args)
	}

	enableSessiond := cmd.commands[1]
	if enableSessiond.Name != "systemctl" || !sliceEqual(enableSessiond.Args, []string{"--user", "enable", "--now", "muxterm-sessiond.service"}) {
		t.Errorf("command[1] = %q %v, want systemctl [--user enable --now muxterm-sessiond.service]", enableSessiond.Name, enableSessiond.Args)
	}

	enableWeb := cmd.commands[2]
	if enableWeb.Name != "systemctl" || !sliceEqual(enableWeb.Args, []string{"--user", "enable", "--now", "muxterm.service"}) {
		t.Errorf("command[2] = %q %v, want systemctl [--user enable --now muxterm.service]", enableWeb.Name, enableWeb.Args)
	}

	linger := cmd.commands[3]
	if linger.Name != "loginctl" || !sliceEqual(linger.Args, []string{"enable-linger"}) {
		t.Errorf("command[3] = %q %v, want loginctl [enable-linger]", linger.Name, linger.Args)
	}
}

func TestInstall_Linux_WritesBothUnitFiles(t *testing.T) {
	tmp := t.TempDir()
	unitPath := filepath.Join(tmp, "muxterm.service")
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd)
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
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
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
	// Same as the systemd unit: ProgramArguments is {BinaryPath, "serve"}.
	if !strings.Contains(content, "<string>serve</string>") {
		t.Errorf("plist file missing <string>serve</string>, got:\n%s", content)
	}
	for _, unwanted := range []string{"--addr", "--secret", "localhost:8080"} {
		if strings.Contains(content, unwanted) {
			t.Errorf("plist file must not carry %q, got:\n%s", unwanted, content)
		}
	}
}

func TestInstall_Darwin_RunsLaunchctl(t *testing.T) {
	tmp := t.TempDir()
	plistPath := filepath.Join(tmp, "com.muxterm.plist")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
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
	sessiondPath := filepath.Join(tmp, "deep", "nested", "dir", "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	err := installLinux(cfg, unitPath, sessiondPath, cmd)
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
