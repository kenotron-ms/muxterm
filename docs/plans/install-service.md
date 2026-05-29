# Install/Uninstall Service Commands — Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Add `muxterm install` and `muxterm uninstall` CLI commands that install/uninstall muxterm as a system service (systemd on Linux, launchd on macOS, stub on Windows).

**Architecture:** A new `internal/service` package handles platform detection, service file template rendering, and install/uninstall operations. The CLI layer (`cli.go` / `main.go`) adds two new modes that delegate to this package. Platform-specific behavior is abstracted behind a `Commander` interface for testability — same pattern as `internal/deploy`'s `Runner` interface.

**Tech Stack:** Go 1.24, `text/template`, `os/exec` (systemctl/launchctl), standard library only (no new dependencies).

---

## Existing Code Context

**CLI structure:** `muxterm/cmd/muxterm/cli.go` has a `Config` struct with fields `Mode`, `Addr`, `Secret`, `Target`. `ParseArgs()` uses a switch on `args[0]` to dispatch to mode-specific parsers. `main.go` switches on `cfg.Mode` to call `runLocal`, `runServe`, `runDeploy`.

**Test conventions:** Standard `testing` package, no testify. Direct `t.Errorf`/`t.Fatalf` assertions. Mock interfaces for external commands (see `internal/deploy/ssh_test.go` `mockRunner`).

**Secret generation:** `server.GenerateSecret()` in `internal/server/auth.go` returns a 64-char hex string. We reuse this for auto-generating install secrets.

**Go module:** `github.com/user/muxterm` in `muxterm/go.mod`.

**All commands run from:** `~/workspace/muxplex/muxterm/`

---

### Task 1: Platform detection and service config types

**Files:**
- Create: `muxterm/internal/service/service.go`
- Test: `muxterm/internal/service/service_test.go`

**Step 1: Write the failing tests**

Create `muxterm/internal/service/service_test.go`:

```go
package service

import (
	"runtime"
	"testing"
)

func TestDetectPlatform_ReturnsCurrentOS(t *testing.T) {
	p := DetectPlatform()
	want := runtime.GOOS
	if p != want {
		t.Errorf("DetectPlatform() = %q, want %q", p, want)
	}
}

func TestServiceConfig_Defaults(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Addr != "localhost:8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "localhost:8080")
	}
	if cfg.BinaryPath != "" {
		t.Errorf("BinaryPath = %q, want empty (resolved at install time)", cfg.BinaryPath)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v`

Expected: Compilation error — package `service` doesn't exist yet.

**Step 3: Write the implementation**

Create `muxterm/internal/service/service.go`:

```go
package service

import "runtime"

// ServiceConfig holds parameters for service installation.
type ServiceConfig struct {
	BinaryPath string // absolute path to the muxterm binary
	Addr       string // listen address (e.g. "localhost:8080")
	Secret     string // auth secret
	SafePATH   string // PATH environment variable for the service
}

// DetectPlatform returns the current OS: "linux", "darwin", or "windows".
func DetectPlatform() string {
	return runtime.GOOS
}

// DefaultConfig returns a ServiceConfig with sensible defaults.
// BinaryPath and Secret are left empty — they must be resolved at install time.
func DefaultConfig() ServiceConfig {
	return ServiceConfig{
		Addr: "localhost:8080",
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v`

Expected: PASS

**Step 5: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/internal/service/service.go muxterm/internal/service/service_test.go && git commit -m "feat(service): add platform detection and service config types"
```

---

### Task 2: Systemd unit template

**Files:**
- Modify: `muxterm/internal/service/service.go`
- Test: `muxterm/internal/service/service_test.go`

**Step 1: Write the failing tests**

Append to `muxterm/internal/service/service_test.go`:

```go
func TestRenderSystemdUnit_ContainsBinaryPath(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "abc123",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	if !contains(out, "/usr/local/bin/muxterm") {
		t.Error("output missing binary path")
	}
}

func TestRenderSystemdUnit_ContainsServeCommand(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "0.0.0.0:9090",
		Secret:     "secret123",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	if !contains(out, "muxterm serve --addr 0.0.0.0:9090 --secret secret123") {
		t.Errorf("output missing serve command with flags, got:\n%s", out)
	}
}

func TestRenderSystemdUnit_ContainsPATH(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin:/usr/local/bin:/home/user/.local/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	if !contains(out, "Environment=PATH=/usr/bin:/usr/local/bin:/home/user/.local/bin") {
		t.Errorf("output missing PATH environment, got:\n%s", out)
	}
}

func TestRenderSystemdUnit_HasRequiredSections(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	for _, section := range []string{"[Unit]", "[Service]", "[Install]"} {
		if !contains(out, section) {
			t.Errorf("output missing section %q", section)
		}
	}
}

// contains is a test helper that checks substring presence.
func contains(s, substr string) bool {
	return len(s) >= len(substr) && containsStr(s, substr)
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run Systemd`

Expected: Compilation error — `RenderSystemdUnit` undefined.

**Step 3: Write the implementation**

Add to `muxterm/internal/service/service.go`:

```go
import (
	"bytes"
	"runtime"
	"text/template"
)

var systemdTemplate = template.Must(template.New("systemd").Parse(`[Unit]
Description=muxterm
After=network.target

[Service]
Type=simple
ExecStart={{.BinaryPath}} serve --addr {{.Addr}} --secret {{.Secret}}
Restart=on-failure
RestartSec=5s
Environment=PATH={{.SafePATH}}

[Install]
WantedBy=default.target
`))

// RenderSystemdUnit renders a systemd user unit file from the given config.
func RenderSystemdUnit(cfg ServiceConfig) (string, error) {
	var buf bytes.Buffer
	if err := systemdTemplate.Execute(&buf, cfg); err != nil {
		return "", err
	}
	return buf.String(), nil
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run Systemd`

Expected: PASS (4 tests)

**Step 5: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/internal/service/ && git commit -m "feat(service): add systemd unit template rendering"
```

---

### Task 3: Launchd plist template

**Files:**
- Modify: `muxterm/internal/service/service.go`
- Modify: `muxterm/internal/service/service_test.go`

**Step 1: Write the failing tests**

Append to `muxterm/internal/service/service_test.go`:

```go
func TestRenderLaunchdPlist_ContainsBinaryPath(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "abc123",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "/usr/local/bin/muxterm") {
		t.Error("output missing binary path")
	}
}

func TestRenderLaunchdPlist_ContainsLabel(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "com.muxterm") {
		t.Error("output missing label com.muxterm")
	}
}

func TestRenderLaunchdPlist_ContainsServeArgs(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "0.0.0.0:9090",
		Secret:     "secret123",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "<string>serve</string>") {
		t.Error("output missing serve argument")
	}
	if !contains(out, "<string>--addr</string>") {
		t.Error("output missing --addr argument")
	}
	if !contains(out, "<string>0.0.0.0:9090</string>") {
		t.Error("output missing addr value")
	}
	if !contains(out, "<string>--secret</string>") {
		t.Error("output missing --secret argument")
	}
	if !contains(out, "<string>secret123</string>") {
		t.Error("output missing secret value")
	}
}

func TestRenderLaunchdPlist_ContainsPATH(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "/usr/bin:/usr/local/bin") {
		t.Error("output missing PATH value")
	}
}

func TestRenderLaunchdPlist_IsValidXML(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "<?xml version=") {
		t.Error("output missing XML declaration")
	}
	if !contains(out, "</plist>") {
		t.Error("output missing closing </plist> tag")
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run Launchd`

Expected: Compilation error — `RenderLaunchdPlist` undefined.

**Step 3: Write the implementation**

Add to `muxterm/internal/service/service.go`:

```go
var launchdTemplate = template.Must(template.New("launchd").Parse(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.muxterm</string>
    <key>ProgramArguments</key>
    <array>
        <string>{{.BinaryPath}}</string>
        <string>serve</string>
        <string>--addr</string>
        <string>{{.Addr}}</string>
        <string>--secret</string>
        <string>{{.Secret}}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{.SafePATH}}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/muxterm.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/muxterm.log</string>
</dict>
</plist>
`))

// RenderLaunchdPlist renders a macOS launchd plist from the given config.
func RenderLaunchdPlist(cfg ServiceConfig) (string, error) {
	var buf bytes.Buffer
	if err := launchdTemplate.Execute(&buf, cfg); err != nil {
		return "", err
	}
	return buf.String(), nil
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run Launchd`

Expected: PASS (5 tests)

**Step 5: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/internal/service/ && git commit -m "feat(service): add launchd plist template rendering"
```

---

### Task 4: Commander interface and service paths

**Files:**
- Create: `muxterm/internal/service/commander.go`
- Modify: `muxterm/internal/service/service_test.go`

**Step 1: Write the failing tests**

Append to `muxterm/internal/service/service_test.go`:

```go
import "os"

func TestSystemdUnitPath_UsesHomeDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("cannot determine home dir: %v", err)
	}
	got := SystemdUnitPath()
	want := home + "/.config/systemd/user/muxterm.service"
	if got != want {
		t.Errorf("SystemdUnitPath() = %q, want %q", got, want)
	}
}

func TestLaunchdPlistPath_UsesHomeDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("cannot determine home dir: %v", err)
	}
	got := LaunchdPlistPath()
	want := home + "/Library/LaunchAgents/com.muxterm.plist"
	if got != want {
		t.Errorf("LaunchdPlistPath() = %q, want %q", got, want)
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run Path`

Expected: Compilation error — `SystemdUnitPath` and `LaunchdPlistPath` undefined.

**Step 3: Write the implementation**

Create `muxterm/internal/service/commander.go`:

```go
package service

import (
	"os"
	"path/filepath"
)

// Commander abstracts shell command execution for testability.
type Commander interface {
	Run(name string, args ...string) ([]byte, error)
}

// SystemdUnitPath returns the path for the systemd user unit file.
func SystemdUnitPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", "muxterm.service")
}

// LaunchdPlistPath returns the path for the macOS launchd plist file.
func LaunchdPlistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", "com.muxterm.plist")
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run Path`

Expected: PASS (2 tests)

**Step 5: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/internal/service/ && git commit -m "feat(service): add Commander interface and service file paths"
```

---

### Task 5: Install function

**Files:**
- Create: `muxterm/internal/service/install.go`
- Create: `muxterm/internal/service/install_test.go`

**Step 1: Write the failing tests**

Create `muxterm/internal/service/install_test.go`:

```go
package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// mockCommander captures executed commands and can return preset errors.
type mockCommander struct {
	commands []mockCmd
	err      error // if set, Run() returns this error
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
	tmpDir := t.TempDir()
	unitPath := filepath.Join(tmpDir, "muxterm.service")
	mock := &mockCommander{}

	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "testsecret",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}

	err := installLinux(cfg, unitPath, mock)
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	data, err := os.ReadFile(unitPath)
	if err != nil {
		t.Fatalf("read unit file: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "/usr/local/bin/muxterm") {
		t.Error("unit file missing binary path")
	}
	if !strings.Contains(content, "testsecret") {
		t.Error("unit file missing secret")
	}
	if !strings.Contains(content, "[Service]") {
		t.Error("unit file missing [Service] section")
	}
}

func TestInstall_Linux_RunsSystemctlEnable(t *testing.T) {
	tmpDir := t.TempDir()
	unitPath := filepath.Join(tmpDir, "muxterm.service")
	mock := &mockCommander{}

	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}

	err := installLinux(cfg, unitPath, mock)
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	// Should call: systemctl --user daemon-reload, then systemctl --user enable --now muxterm.service
	if len(mock.commands) < 2 {
		t.Fatalf("expected at least 2 commands, got %d", len(mock.commands))
	}

	reload := mock.commands[0]
	if reload.Name != "systemctl" {
		t.Errorf("first command = %q, want systemctl", reload.Name)
	}
	reloadArgs := strings.Join(reload.Args, " ")
	if !strings.Contains(reloadArgs, "daemon-reload") {
		t.Errorf("first command args = %q, want daemon-reload", reloadArgs)
	}

	enable := mock.commands[1]
	if enable.Name != "systemctl" {
		t.Errorf("second command = %q, want systemctl", enable.Name)
	}
	enableArgs := strings.Join(enable.Args, " ")
	if !strings.Contains(enableArgs, "enable") || !strings.Contains(enableArgs, "--now") {
		t.Errorf("second command args = %q, want enable --now", enableArgs)
	}
}

func TestInstall_Darwin_WritesPlistFile(t *testing.T) {
	tmpDir := t.TempDir()
	plistPath := filepath.Join(tmpDir, "com.muxterm.plist")
	mock := &mockCommander{}

	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "testsecret",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}

	err := installDarwin(cfg, plistPath, mock)
	if err != nil {
		t.Fatalf("installDarwin() error: %v", err)
	}

	data, err := os.ReadFile(plistPath)
	if err != nil {
		t.Fatalf("read plist file: %v", err)
	}
	content := string(data)
	if !strings.Contains(content, "com.muxterm") {
		t.Error("plist file missing label")
	}
	if !strings.Contains(content, "/usr/local/bin/muxterm") {
		t.Error("plist file missing binary path")
	}
}

func TestInstall_Darwin_RunsLaunchctl(t *testing.T) {
	tmpDir := t.TempDir()
	plistPath := filepath.Join(tmpDir, "com.muxterm.plist")
	mock := &mockCommander{}

	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}

	err := installDarwin(cfg, plistPath, mock)
	if err != nil {
		t.Fatalf("installDarwin() error: %v", err)
	}

	if len(mock.commands) < 1 {
		t.Fatal("expected at least 1 command (launchctl)")
	}

	cmd := mock.commands[0]
	if cmd.Name != "launchctl" {
		t.Errorf("command = %q, want launchctl", cmd.Name)
	}
	args := strings.Join(cmd.Args, " ")
	if !strings.Contains(args, "load") {
		t.Errorf("args = %q, want load", args)
	}
}

func TestInstall_Linux_CreatesMissingDirs(t *testing.T) {
	tmpDir := t.TempDir()
	// Use a nested path that doesn't exist yet
	unitPath := filepath.Join(tmpDir, "deep", "nested", "muxterm.service")
	mock := &mockCommander{}

	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}

	err := installLinux(cfg, unitPath, mock)
	if err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	if _, err := os.Stat(unitPath); os.IsNotExist(err) {
		t.Error("unit file was not created")
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run TestInstall`

Expected: Compilation error — `installLinux` and `installDarwin` undefined.

**Step 3: Write the implementation**

Create `muxterm/internal/service/install.go`:

```go
package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// execCommander implements Commander using os/exec.
type execCommander struct{}

func (e *execCommander) Run(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// Install installs muxterm as a service on the current platform.
// It resolves the binary path, captures the current PATH, generates the
// appropriate service file, enables it, and starts it.
func Install(cfg ServiceConfig) error {
	// Resolve binary path if not set.
	if cfg.BinaryPath == "" {
		exe, err := os.Executable()
		if err != nil {
			return fmt.Errorf("resolve binary path: %w", err)
		}
		cfg.BinaryPath = exe
	}

	// Capture current PATH for the service environment.
	if cfg.SafePATH == "" {
		cfg.SafePATH = os.Getenv("PATH")
	}

	cmd := &execCommander{}

	switch DetectPlatform() {
	case "linux":
		return installLinux(cfg, SystemdUnitPath(), cmd)
	case "darwin":
		return installDarwin(cfg, LaunchdPlistPath(), cmd)
	case "windows":
		return fmt.Errorf("Windows service installation is not yet supported. Run 'muxterm serve' manually instead")
	default:
		return fmt.Errorf("unsupported platform: %s", DetectPlatform())
	}
}

// installLinux writes a systemd user unit and enables it.
func installLinux(cfg ServiceConfig, unitPath string, cmd Commander) error {
	content, err := RenderSystemdUnit(cfg)
	if err != nil {
		return fmt.Errorf("render systemd unit: %w", err)
	}

	// Create parent directories if they don't exist.
	if err := os.MkdirAll(filepath.Dir(unitPath), 0755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}

	if err := os.WriteFile(unitPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("write unit file: %w", err)
	}

	// Reload systemd and enable the service.
	if _, err := cmd.Run("systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %w", err)
	}
	if _, err := cmd.Run("systemctl", "--user", "enable", "--now", "muxterm.service"); err != nil {
		return fmt.Errorf("systemctl enable: %w", err)
	}

	return nil
}

// installDarwin writes a launchd plist and loads it.
func installDarwin(cfg ServiceConfig, plistPath string, cmd Commander) error {
	content, err := RenderLaunchdPlist(cfg)
	if err != nil {
		return fmt.Errorf("render launchd plist: %w", err)
	}

	// Create parent directories if they don't exist.
	if err := os.MkdirAll(filepath.Dir(plistPath), 0755); err != nil {
		return fmt.Errorf("create directory: %w", err)
	}

	if err := os.WriteFile(plistPath, []byte(content), 0644); err != nil {
		return fmt.Errorf("write plist file: %w", err)
	}

	// Load the agent.
	if _, err := cmd.Run("launchctl", "load", plistPath); err != nil {
		return fmt.Errorf("launchctl load: %w", err)
	}

	return nil
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run TestInstall`

Expected: PASS (5 tests)

**Step 5: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/internal/service/ && git commit -m "feat(service): add Install function for linux and darwin"
```

---

### Task 6: Uninstall function

**Files:**
- Create: `muxterm/internal/service/uninstall.go`
- Create: `muxterm/internal/service/uninstall_test.go`

**Step 1: Write the failing tests**

Create `muxterm/internal/service/uninstall_test.go`:

```go
package service

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestUninstall_Linux_StopsService(t *testing.T) {
	tmpDir := t.TempDir()
	unitPath := filepath.Join(tmpDir, "muxterm.service")
	// Create the unit file so uninstall has something to remove.
	if err := os.WriteFile(unitPath, []byte("[Unit]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	mock := &mockCommander{}

	err := uninstallLinux(unitPath, mock)
	if err != nil {
		t.Fatalf("uninstallLinux() error: %v", err)
	}

	if len(mock.commands) < 2 {
		t.Fatalf("expected at least 2 commands, got %d", len(mock.commands))
	}

	// First command: systemctl --user disable --now muxterm.service
	disable := mock.commands[0]
	if disable.Name != "systemctl" {
		t.Errorf("first command = %q, want systemctl", disable.Name)
	}
	disableArgs := strings.Join(disable.Args, " ")
	if !strings.Contains(disableArgs, "disable") || !strings.Contains(disableArgs, "--now") {
		t.Errorf("first command args = %q, want disable --now", disableArgs)
	}

	// Second command: systemctl --user daemon-reload
	reload := mock.commands[1]
	reloadArgs := strings.Join(reload.Args, " ")
	if !strings.Contains(reloadArgs, "daemon-reload") {
		t.Errorf("second command args = %q, want daemon-reload", reloadArgs)
	}
}

func TestUninstall_Linux_RemovesUnitFile(t *testing.T) {
	tmpDir := t.TempDir()
	unitPath := filepath.Join(tmpDir, "muxterm.service")
	if err := os.WriteFile(unitPath, []byte("[Unit]\n"), 0644); err != nil {
		t.Fatal(err)
	}
	mock := &mockCommander{}

	err := uninstallLinux(unitPath, mock)
	if err != nil {
		t.Fatalf("uninstallLinux() error: %v", err)
	}

	if _, err := os.Stat(unitPath); !os.IsNotExist(err) {
		t.Error("unit file should have been removed")
	}
}

func TestUninstall_Linux_NoFileIsNotError(t *testing.T) {
	tmpDir := t.TempDir()
	unitPath := filepath.Join(tmpDir, "muxterm.service") // does not exist
	mock := &mockCommander{}

	// Should not error even if the file doesn't exist.
	err := uninstallLinux(unitPath, mock)
	if err != nil {
		t.Fatalf("uninstallLinux() error: %v (should tolerate missing file)", err)
	}
}

func TestUninstall_Darwin_RunsLaunchctlUnload(t *testing.T) {
	tmpDir := t.TempDir()
	plistPath := filepath.Join(tmpDir, "com.muxterm.plist")
	if err := os.WriteFile(plistPath, []byte("<plist/>"), 0644); err != nil {
		t.Fatal(err)
	}
	mock := &mockCommander{}

	err := uninstallDarwin(plistPath, mock)
	if err != nil {
		t.Fatalf("uninstallDarwin() error: %v", err)
	}

	if len(mock.commands) < 1 {
		t.Fatal("expected at least 1 command (launchctl)")
	}

	cmd := mock.commands[0]
	if cmd.Name != "launchctl" {
		t.Errorf("command = %q, want launchctl", cmd.Name)
	}
	args := strings.Join(cmd.Args, " ")
	if !strings.Contains(args, "unload") {
		t.Errorf("args = %q, want unload", args)
	}
}

func TestUninstall_Darwin_RemovesPlistFile(t *testing.T) {
	tmpDir := t.TempDir()
	plistPath := filepath.Join(tmpDir, "com.muxterm.plist")
	if err := os.WriteFile(plistPath, []byte("<plist/>"), 0644); err != nil {
		t.Fatal(err)
	}
	mock := &mockCommander{}

	err := uninstallDarwin(plistPath, mock)
	if err != nil {
		t.Fatalf("uninstallDarwin() error: %v", err)
	}

	if _, err := os.Stat(plistPath); !os.IsNotExist(err) {
		t.Error("plist file should have been removed")
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run TestUninstall`

Expected: Compilation error — `uninstallLinux` and `uninstallDarwin` undefined.

**Step 3: Write the implementation**

Create `muxterm/internal/service/uninstall.go`:

```go
package service

import (
	"fmt"
	"os"
	"os/exec"
)

// Uninstall removes the muxterm service from the current platform.
func Uninstall() error {
	cmd := &execCommander{}

	switch DetectPlatform() {
	case "linux":
		return uninstallLinux(SystemdUnitPath(), cmd)
	case "darwin":
		return uninstallDarwin(LaunchdPlistPath(), cmd)
	case "windows":
		return fmt.Errorf("Windows service uninstallation is not yet supported")
	default:
		return fmt.Errorf("unsupported platform: %s", DetectPlatform())
	}
}

// uninstallLinux stops and disables the systemd user service, then removes the unit file.
func uninstallLinux(unitPath string, cmd Commander) error {
	// Stop and disable (ignore errors — service might not be running).
	cmd.Run("systemctl", "--user", "disable", "--now", "muxterm.service")
	cmd.Run("systemctl", "--user", "daemon-reload")

	// Remove unit file (tolerate missing file).
	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove unit file: %w", err)
	}

	return nil
}

// uninstallDarwin unloads the launchd agent and removes the plist file.
func uninstallDarwin(plistPath string, cmd Commander) error {
	// Unload (ignore errors — agent might not be loaded).
	cmd.Run("launchctl", "unload", plistPath)

	// Remove plist file (tolerate missing file).
	if err := os.Remove(plistPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove plist file: %w", err)
	}

	return nil
}

// IsInstalled returns true if the service file exists on the current platform.
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
```

Note: The `uninstallLinux` function intentionally ignores errors from `systemctl` commands. The `mockCommander` type is already defined in `install_test.go` — both test files are in the same `service` package, so it's shared.

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v -run TestUninstall`

Expected: PASS (5 tests)

**Step 5: Run all service tests together**

Run: `cd ~/workspace/muxplex/muxterm && go test ./internal/service/ -v`

Expected: All tests PASS (no duplicate symbol errors — `mockCommander` is only defined in `install_test.go`).

**Step 6: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/internal/service/ && git commit -m "feat(service): add Uninstall function and IsInstalled check"
```

---

### Task 7: CLI integration — ParseArgs

**Files:**
- Modify: `muxterm/cmd/muxterm/cli.go`
- Modify: `muxterm/cmd/muxterm/cli_test.go`

**Step 1: Write the failing tests**

Append to `muxterm/cmd/muxterm/cli_test.go`:

```go
func TestParseArgs_Install_DefaultFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"install"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "install" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "install")
	}
	if cfg.Addr != "localhost:8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "localhost:8080")
	}
	if cfg.Secret != "" {
		t.Errorf("Secret = %q, want empty (auto-generated at install time)", cfg.Secret)
	}
}

func TestParseArgs_Install_WithFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"install", "--addr", "0.0.0.0:9090", "--secret", "mysecret"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "install" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "install")
	}
	if cfg.Addr != "0.0.0.0:9090" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "0.0.0.0:9090")
	}
	if cfg.Secret != "mysecret" {
		t.Errorf("Secret = %q, want %q", cfg.Secret, "mysecret")
	}
}

func TestParseArgs_Uninstall(t *testing.T) {
	cfg, err := ParseArgs([]string{"uninstall"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "uninstall" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "uninstall")
	}
}
```

**Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxplex/muxterm && go test ./cmd/muxterm/ -v -run "Install|Uninstall"`

Expected: FAIL — `Mode = "local"` (unknown commands fall through to local mode).

**Step 3: Modify `cli.go`**

In `muxterm/cmd/muxterm/cli.go`, add to the switch in `ParseArgs()`:

Add these two cases before the `default:` case in the switch statement:

```go
	case "install":
		return parseInstall(args[1:])
	case "uninstall":
		return Config{Mode: "uninstall"}, nil
```

Add the `parseInstall` function after `parseDeploy`:

```go
func parseInstall(args []string) (Config, error) {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	addr := fs.String("addr", "localhost:8080", "listen address for the service")
	secret := fs.String("secret", "", "auth secret (auto-generated if empty)")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}
	return Config{
		Mode:   "install",
		Addr:   *addr,
		Secret: *secret,
	}, nil
}
```

**Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./cmd/muxterm/ -v -run "Install|Uninstall"`

Expected: PASS (3 new tests)

**Step 5: Verify all existing CLI tests still pass**

Run: `cd ~/workspace/muxplex/muxterm && go test ./cmd/muxterm/ -v -run TestParseArgs`

Expected: All PASS (no regressions — the new cases don't affect `default:` behavior).

**Step 6: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/cmd/muxterm/cli.go muxterm/cmd/muxterm/cli_test.go && git commit -m "feat(cli): add install and uninstall to ParseArgs"
```

---

### Task 8: CLI integration — main.go dispatch

**Files:**
- Modify: `muxterm/cmd/muxterm/main.go`

**Step 1: Add the import for the service package**

In `muxterm/cmd/muxterm/main.go`, add `"github.com/user/muxterm/internal/service"` to the import block.

**Step 2: Add install and uninstall cases to the main switch**

In the `main()` function's switch on `cfg.Mode`, add these cases before the closing `}`:

```go
	case "install":
		if err := runInstall(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
	case "uninstall":
		if err := runUninstall(); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
```

**Step 3: Add `runInstall` and `runUninstall` functions**

Add after `runDeploy`:

```go
// runInstall installs muxterm as a system service.
func runInstall(cfg Config) error {
	secret := cfg.Secret
	if secret == "" {
		s, err := server.GenerateSecret()
		if err != nil {
			return fmt.Errorf("generate secret: %w", err)
		}
		secret = s
	}

	svcCfg := service.ServiceConfig{
		Addr:   cfg.Addr,
		Secret: secret,
	}

	if err := service.Install(svcCfg); err != nil {
		return err
	}

	fmt.Printf("muxterm installed and running at http://%s\n", cfg.Addr)
	if cfg.Secret == "" {
		fmt.Printf("auto-generated secret: %s\n", secret)
	}
	return nil
}

// runUninstall removes the muxterm system service.
func runUninstall() error {
	if err := service.Uninstall(); err != nil {
		return err
	}
	fmt.Println("muxterm service removed")
	return nil
}
```

**Step 4: Verify the full project compiles**

Run: `cd ~/workspace/muxplex/muxterm && go build ./cmd/muxterm/`

Expected: Build succeeds with no errors.

**Step 5: Run all tests**

Run: `cd ~/workspace/muxplex/muxterm && go test ./... -v 2>&1 | tail -30`

Expected: All packages PASS.

**Step 6: Commit**

```bash
cd ~/workspace/muxplex && git add muxterm/cmd/muxterm/main.go && git commit -m "feat(cli): wire install and uninstall commands to main dispatch"
```

---

### Task 9: End-to-end verification

**Files:** None (verification only)

**Step 1: Build the binary**

Run: `cd ~/workspace/muxplex/muxterm && go build -o bin/muxterm ./cmd/muxterm/`

Expected: Build succeeds.

**Step 2: Test the install help**

Run: `cd ~/workspace/muxplex/muxterm && ./bin/muxterm install --help 2>&1 || true`

Expected: Prints flag usage for `--addr` and `--secret` (the `flag` package does this automatically when `--help` is passed). The exit code may be non-zero (flag's default behavior for help), which is fine.

**Step 3: Test install on this Linux machine**

Run: `cd ~/workspace/muxplex/muxterm && ./bin/muxterm install --addr localhost:9999 --secret testinstall`

Expected: Writes a systemd user unit to `~/.config/systemd/user/muxterm.service` and runs `systemctl --user enable --now`. Prints `muxterm installed and running at http://localhost:9999`.

**Step 4: Verify the unit file was created**

Run: `cat ~/.config/systemd/user/muxterm.service`

Expected: Shows the systemd unit with the correct binary path, `--addr localhost:9999`, and `--secret testinstall`.

**Step 5: Verify the service is running (or check its status)**

Run: `systemctl --user status muxterm.service 2>&1 || true`

Expected: Shows service status (may be running or failed depending on tmux availability — either is fine for verification purposes).

**Step 6: Test uninstall**

Run: `cd ~/workspace/muxplex/muxterm && ./bin/muxterm uninstall`

Expected: Prints `muxterm service removed`.

**Step 7: Verify the unit file was removed**

Run: `ls ~/.config/systemd/user/muxterm.service 2>&1`

Expected: "No such file or directory".

**Step 8: Run the full test suite one final time**

Run: `cd ~/workspace/muxplex/muxterm && go test ./... -v 2>&1 | tail -20`

Expected: All packages PASS.

**Step 9: Commit any final fixes**

If any issues were found and fixed during verification:

```bash
cd ~/workspace/muxplex && git add -A && git commit -m "fix(service): fixes from end-to-end verification"
```
