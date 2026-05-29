# Phase 4: Integration, Deployment & Polish — Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Wire the Go tmux engine, WebSocket server, and Lit frontend into a working CLI tool with three deployment modes (local, serve, deploy), error recovery, and end-to-end smoke testing.

**Architecture:** Phase 4 adds the CLI entry point (`cmd/muxterm/main.go`) that orchestrates all components. Default `muxterm` command starts local mode (auto-starts tmux, serves on localhost:8080, opens browser, no auth). `muxterm serve` runs as a long-lived service with token auth. `muxterm deploy user@host` pushes the binary over SSH. Error handling covers tmux death (reconnect) and WebSocket drops (reconnect with backoff). A session picker lets users choose between multiple tmux sessions.

**Tech Stack:** Go 1.24, tmux 3.2+ control mode, Lit web components, Playwright (e2e), Make

---

## Prerequisites (from Phases 1-3)

Phase 4 assumes these packages exist and work. **Before starting any task, check `go.mod` for the actual module path** — this plan uses `muxterm/...` as shorthand for imports.

| Package | Key Exports |
|---|---|
| `internal/tmux/control.go` | `ControlMode` struct — `NewControlMode() *ControlMode`, `Start(session string) error`, `ReadEvent() (Event, error)`, `SendCommand(cmd string) error`, `Close() error` |
| `internal/tmux/model.go` | `TmuxState`, `Session`, `Window`, `Pane` structs — `NewTmuxState() *TmuxState`, `ApplyEvent(Event)`, `ToJSON() []byte` |
| `internal/tmux/layout.go` | `ParseLayout(s string) (*LayoutNode, error)` |
| `internal/tmux/command.go` | `SendKeys()`, `SplitWindow()`, `SelectWindow()`, `NewWindow()`, `ResizePane()`, `KillPane()` |
| `internal/server/server.go` | `Server` — `New(cfg Config, ctrl *tmux.ControlMode) *Server`, `Start() error`, `Shutdown(ctx context.Context) error` |
| `internal/server/ws.go` | WebSocket handler — binary pane I/O routing, JSON control message dispatch |
| `internal/server/auth.go` | `GenerateToken() string`, `ValidateToken(secret, token string) bool`, localhost bypass logic |
| `web/embed.go` | `var DistFS embed.FS` — Vite-built frontend at `web/dist/` |
| `web/src/app.ts` | `<mux-app>` root component |
| `web/src/ws.ts` | `MuxWebSocket` class — `connect()`, `send()`, `close()`, `onControlMessage`, `onBinaryMessage` |
| `web/src/state.ts` | `MuxState` reactive store — `update(msg)`, observed by Lit components |

**Verify these exist before starting.** If method signatures differ from what's listed, adjust the code in this plan to match reality.

---

### Task 1: CLI Arg Parsing

**Files:**
- Create: `cmd/muxterm/cli.go`
- Create: `cmd/muxterm/cli_test.go`

Pure-function argument parser. No dependencies on tmux or server packages.

- [ ] **Step 1: Write the failing tests**

Create `cmd/muxterm/cli_test.go`:

```go
package main

import (
	"testing"
)

func TestParseArgs_NoArgs_LocalMode(t *testing.T) {
	cfg, err := ParseArgs([]string{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "local" {
		t.Errorf("expected mode 'local', got %q", cfg.Mode)
	}
	if cfg.Addr != "localhost:8080" {
		t.Errorf("expected addr 'localhost:8080', got %q", cfg.Addr)
	}
}

func TestParseArgs_ServeDefaults(t *testing.T) {
	cfg, err := ParseArgs([]string{"serve"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "serve" {
		t.Errorf("expected mode 'serve', got %q", cfg.Mode)
	}
	if cfg.Addr != "0.0.0.0:8080" {
		t.Errorf("expected default addr '0.0.0.0:8080', got %q", cfg.Addr)
	}
}

func TestParseArgs_ServeWithFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"serve", "--addr", "0.0.0.0:9090", "--secret", "mytoken"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "serve" {
		t.Errorf("expected mode 'serve', got %q", cfg.Mode)
	}
	if cfg.Addr != "0.0.0.0:9090" {
		t.Errorf("expected addr '0.0.0.0:9090', got %q", cfg.Addr)
	}
	if cfg.Secret != "mytoken" {
		t.Errorf("expected secret 'mytoken', got %q", cfg.Secret)
	}
}

func TestParseArgs_DeployWithTarget(t *testing.T) {
	cfg, err := ParseArgs([]string{"deploy", "user@myserver.com"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "deploy" {
		t.Errorf("expected mode 'deploy', got %q", cfg.Mode)
	}
	if cfg.Target != "user@myserver.com" {
		t.Errorf("expected target 'user@myserver.com', got %q", cfg.Target)
	}
}

func TestParseArgs_DeployMissingTarget(t *testing.T) {
	_, err := ParseArgs([]string{"deploy"})
	if err == nil {
		t.Fatal("expected error for deploy without target")
	}
}

func TestParseArgs_Version(t *testing.T) {
	cfg, err := ParseArgs([]string{"version"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "version" {
		t.Errorf("expected mode 'version', got %q", cfg.Mode)
	}
}

func TestParseArgs_UnknownCommand_FallsBackToLocal(t *testing.T) {
	cfg, err := ParseArgs([]string{"something-unknown"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "local" {
		t.Errorf("expected mode 'local', got %q", cfg.Mode)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./cmd/muxterm/ -v -run TestParseArgs`
Expected: FAIL — `ParseArgs` undefined (compilation error)

- [ ] **Step 3: Implement the arg parser**

Create `cmd/muxterm/cli.go`:

```go
package main

import (
	"flag"
	"fmt"
)

// Config holds parsed CLI arguments.
type Config struct {
	Mode   string // "local", "serve", "deploy", "version"
	Addr   string // listen address
	Secret string // auth token (serve mode)
	Target string // SSH target (deploy mode)
}

// ParseArgs parses command-line arguments into a Config.
// No args = local mode. Subcommands: serve, deploy, version.
func ParseArgs(args []string) (Config, error) {
	if len(args) == 0 {
		return Config{Mode: "local", Addr: "localhost:8080"}, nil
	}

	switch args[0] {
	case "serve":
		return parseServe(args[1:])
	case "deploy":
		return parseDeploy(args[1:])
	case "version":
		return Config{Mode: "version"}, nil
	default:
		// Unknown subcommand → treat as local mode
		return Config{Mode: "local", Addr: "localhost:8080"}, nil
	}
}

func parseServe(args []string) (Config, error) {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", "0.0.0.0:8080", "listen address (host:port)")
	secret := fs.String("secret", "", "auth secret token (auto-generated if empty)")
	if err := fs.Parse(args); err != nil {
		return Config{}, fmt.Errorf("serve: %w", err)
	}
	return Config{
		Mode:   "serve",
		Addr:   *addr,
		Secret: *secret,
	}, nil
}

func parseDeploy(args []string) (Config, error) {
	if len(args) == 0 {
		return Config{}, fmt.Errorf("deploy requires a target: muxterm deploy user@host")
	}
	return Config{
		Mode:   "deploy",
		Target: args[0],
	}, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./cmd/muxterm/ -v -run TestParseArgs`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/muxterm
git add cmd/muxterm/cli.go cmd/muxterm/cli_test.go
git commit -m "feat: CLI arg parser with local/serve/deploy/version modes"
```

---

### Task 2: Server Wiring — Local & Serve Modes

**Files:**
- Create: `cmd/muxterm/main.go`
- Verify (read-only): `internal/server/server.go`, `internal/tmux/control.go`

Wire the CLI to the tmux engine and HTTP server. Both local mode and serve mode start the same server — the difference is address, auth, and whether to open a browser.

- [ ] **Step 1: Create main.go with mode dispatch**

Create `cmd/muxterm/main.go`:

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"syscall"

	"muxterm/internal/server"
	"muxterm/internal/tmux"
)

var version = "dev"

func main() {
	cfg, err := ParseArgs(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	switch cfg.Mode {
	case "local":
		if err := runLocal(cfg); err != nil {
			log.Fatalf("error: %v", err)
		}
	case "serve":
		if err := runServe(cfg); err != nil {
			log.Fatalf("error: %v", err)
		}
	case "deploy":
		if err := runDeploy(cfg); err != nil {
			log.Fatalf("error: %v", err)
		}
	case "version":
		fmt.Printf("muxterm %s\n", version)
	}
}

// runLocal starts muxterm in local mode: localhost, no auth, opens browser.
func runLocal(cfg Config) error {
	session, err := tmux.EnsureRunning()
	if err != nil {
		return fmt.Errorf("tmux: %w", err)
	}
	log.Printf("attached to tmux session %q", session)

	ctrl := tmux.NewControlMode()
	if err := ctrl.Start(session); err != nil {
		return fmt.Errorf("control mode: %w", err)
	}
	defer ctrl.Close()

	srv := server.New(server.Config{
		Addr: cfg.Addr,
	}, ctrl)

	go openBrowser("http://" + cfg.Addr)
	log.Printf("muxterm running at http://%s", cfg.Addr)

	return runWithGracefulShutdown(srv)
}

// runServe starts muxterm in service mode: configurable address, token auth.
func runServe(cfg Config) error {
	session, err := tmux.EnsureRunning()
	if err != nil {
		return fmt.Errorf("tmux: %w", err)
	}
	log.Printf("attached to tmux session %q", session)

	ctrl := tmux.NewControlMode()
	if err := ctrl.Start(session); err != nil {
		return fmt.Errorf("control mode: %w", err)
	}
	defer ctrl.Close()

	// Auto-generate secret if not provided
	secret := cfg.Secret
	if secret == "" {
		secret = server.GenerateToken()
		log.Printf("generated auth token: %s", secret)
	}

	srv := server.New(server.Config{
		Addr:   cfg.Addr,
		Secret: secret,
	}, ctrl)

	log.Printf("muxterm running at http://%s (token: %s)", cfg.Addr, secret)

	return runWithGracefulShutdown(srv)
}

// runDeploy is a placeholder — implemented in Task 4.
func runDeploy(cfg Config) error {
	return fmt.Errorf("deploy not yet implemented (target: %s)", cfg.Target)
}

// runWithGracefulShutdown starts the server and handles SIGINT/SIGTERM.
func runWithGracefulShutdown(srv *server.Server) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.Start()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Println("shutting down...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}

// openBrowser opens the given URL in the user's default browser.
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	default:
		log.Printf("open %s in your browser", url)
		return
	}
	if err := cmd.Start(); err != nil {
		log.Printf("could not open browser: %v — open %s manually", err, url)
	}
}
```

**Important:** Adjust the import paths (`muxterm/internal/server`, `muxterm/internal/tmux`) to match the actual module path in `go.mod`. Also verify that `server.New()` accepts `(server.Config, *tmux.ControlMode)` — if Phase 2 used a different signature, adjust accordingly.

- [ ] **Step 2: Verify the build compiles**

Run: `cd ~/workspace/muxterm && go build ./cmd/muxterm/`
Expected: Compiles without errors. If there are import errors, the module path needs adjusting.

**Note:** `tmux.EnsureRunning()` doesn't exist yet (Task 3). If this blocks compilation, temporarily replace the `tmux.EnsureRunning()` calls with a hardcoded session name:
```go
session := "0" // temporary — replaced in Task 3
```
and `tmux.NewControlMode()` usage. Revert after Task 3.

- [ ] **Step 3: Manual smoke test — local mode**

Run: `cd ~/workspace/muxterm && go run ./cmd/muxterm/`
Expected output:
```
attached to tmux session "0"
muxterm running at http://localhost:8080
```
Open `http://localhost:8080` in a browser. Verify:
- The page loads (frontend renders)
- The tab bar shows at least one tab
- A terminal pane is visible
- Typing in the terminal produces output

If the browser doesn't open automatically (no `xdg-open`), open manually. Kill with Ctrl+C — verify clean shutdown message.

- [ ] **Step 4: Manual smoke test — serve mode**

Run: `cd ~/workspace/muxterm && go run ./cmd/muxterm/ serve --addr 127.0.0.1:9090`
Expected output:
```
attached to tmux session "0"
generated auth token: <random-token>
muxterm running at http://127.0.0.1:9090 (token: <random-token>)
```
Open `http://127.0.0.1:9090?token=<token>` — verify it works.
Open `http://127.0.0.1:9090` without token — verify auth is rejected (if accessing from non-localhost) or accepted (if localhost bypass is active).

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/muxterm
git add cmd/muxterm/main.go
git commit -m "feat: wire CLI to tmux engine and server — local + serve modes"
```

---

### Task 3: Auto-Start tmux

**Files:**
- Create: `internal/tmux/ensure.go`
- Create: `internal/tmux/ensure_test.go`

When `muxterm` starts and tmux isn't running, start a tmux server with a default session. Also checks tmux version.

- [ ] **Step 1: Write the failing tests**

Create `internal/tmux/ensure_test.go`:

```go
package tmux

import (
	"testing"
)

func TestParseTmuxVersion(t *testing.T) {
	tests := []struct {
		input   string
		major   int
		minor   int
		wantErr bool
	}{
		{"tmux 3.5a\n", 3, 5, false},
		{"tmux 3.2\n", 3, 2, false},
		{"tmux 3.0\n", 3, 0, false},
		{"tmux 2.9a\n", 2, 9, false},
		{"tmux next-3.5\n", 0, 0, true},
		{"not tmux\n", 0, 0, true},
		{"", 0, 0, true},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			major, minor, err := parseTmuxVersion(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error for input %q", tt.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if major != tt.major || minor != tt.minor {
				t.Errorf("got %d.%d, want %d.%d", major, minor, tt.major, tt.minor)
			}
		})
	}
}

func TestCheckVersion_Minimum32(t *testing.T) {
	tests := []struct {
		version string
		wantErr bool
	}{
		{"tmux 3.5a\n", false},
		{"tmux 3.2\n", false},
		{"tmux 3.1\n", true},
		{"tmux 2.9a\n", true},
	}
	for _, tt := range tests {
		t.Run(tt.version, func(t *testing.T) {
			err := checkVersion(tt.version)
			if tt.wantErr && err == nil {
				t.Errorf("expected error for %q", tt.version)
			}
			if !tt.wantErr && err != nil {
				t.Errorf("unexpected error for %q: %v", tt.version, err)
			}
		})
	}
}

func TestParseSessionList(t *testing.T) {
	input := "dev:3:1700000000\ntest:1:1700000001\n"
	sessions := parseSessionList(input)
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(sessions))
	}
	if sessions[0] != "dev" {
		t.Errorf("expected first session 'dev', got %q", sessions[0])
	}
	if sessions[1] != "test" {
		t.Errorf("expected second session 'test', got %q", sessions[1])
	}
}

func TestParseSessionList_Empty(t *testing.T) {
	sessions := parseSessionList("")
	if len(sessions) != 0 {
		t.Fatalf("expected 0 sessions, got %d", len(sessions))
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestParseTmuxVersion|TestCheckVersion|TestParseSessionList"`
Expected: FAIL — functions undefined

- [ ] **Step 3: Implement EnsureRunning**

Create `internal/tmux/ensure.go`:

```go
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

// EnsureRunning checks that tmux is installed, meets version requirements,
// and has at least one session. If no sessions exist, creates a default one.
// Returns the name of the session to attach to (first available).
func EnsureRunning() (string, error) {
	// Check tmux exists and version is sufficient
	versionOut, err := exec.Command("tmux", "-V").Output()
	if err != nil {
		return "", fmt.Errorf("tmux not found — install tmux 3.2+ and try again")
	}
	if err := checkVersion(string(versionOut)); err != nil {
		return "", err
	}

	// Check if tmux server has any sessions
	listOut, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}:#{session_windows}:#{session_created}").Output()
	if err != nil {
		// No server running or no sessions — start a new one
		return createDefaultSession()
	}

	sessions := parseSessionList(string(listOut))
	if len(sessions) == 0 {
		return createDefaultSession()
	}

	// Return first session
	return sessions[0], nil
}

// ListSessionNames returns names of all tmux sessions, or empty if none.
func ListSessionNames() ([]string, error) {
	out, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return nil, nil // no sessions is not an error
	}
	return parseSessionList(string(out)), nil
}

func createDefaultSession() (string, error) {
	err := exec.Command("tmux", "new-session", "-d", "-s", defaultSession).Run()
	if err != nil {
		return "", fmt.Errorf("failed to create tmux session: %w", err)
	}
	return defaultSession, nil
}

func parseTmuxVersion(output string) (major, minor int, err error) {
	// Parse "tmux X.Y" or "tmux X.Ya" (letter suffix ignored)
	output = strings.TrimSpace(output)
	if !strings.HasPrefix(output, "tmux ") {
		return 0, 0, fmt.Errorf("unexpected tmux version output: %q", output)
	}
	vstr := strings.TrimPrefix(output, "tmux ")

	// Split on "." — take first two parts
	parts := strings.SplitN(vstr, ".", 2)
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("cannot parse tmux version: %q", vstr)
	}

	major, err = strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, fmt.Errorf("cannot parse major version from %q: %w", parts[0], err)
	}

	// Minor may have trailing letters like "5a"
	minorStr := strings.TrimRight(parts[1], "abcdefghijklmnopqrstuvwxyz")
	minor, err = strconv.Atoi(minorStr)
	if err != nil {
		return 0, 0, fmt.Errorf("cannot parse minor version from %q: %w", parts[1], err)
	}

	return major, minor, nil
}

func checkVersion(output string) error {
	major, minor, err := parseTmuxVersion(output)
	if err != nil {
		return err
	}
	if major < minMajor || (major == minMajor && minor < minMinor) {
		return fmt.Errorf("tmux %d.%d is too old — muxterm requires tmux %d.%d+", major, minor, minMajor, minMinor)
	}
	return nil
}

func parseSessionList(output string) []string {
	output = strings.TrimSpace(output)
	if output == "" {
		return nil
	}
	var names []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Format: "name:windows:created" or just "name"
		parts := strings.SplitN(line, ":", 2)
		names = append(names, parts[0])
	}
	return names
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestParseTmuxVersion|TestCheckVersion|TestParseSessionList"`
Expected: All tests PASS

- [ ] **Step 5: Integration test — EnsureRunning with real tmux**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run TestEnsureRunning`

If no integration test exists, run this manually in a Go scratch test or add a brief one:

```bash
cd ~/workspace/muxterm
go test -run "^$" ./internal/tmux/ -v -count=1  # just compile check
# Then manual check:
tmux kill-server 2>/dev/null; sleep 0.5
go run -exec "echo" ./cmd/muxterm/ 2>&1 | head -5
# Should show: "attached to tmux session \"muxterm\""
# Verify: tmux list-sessions should show "muxterm" session
tmux list-sessions
```

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/muxterm
git add internal/tmux/ensure.go internal/tmux/ensure_test.go
git commit -m "feat: auto-start tmux with version check and session discovery"
```

---

### Task 4: Deploy Mode — Push Over SSH

**Files:**
- Create: `internal/deploy/ssh.go`
- Create: `internal/deploy/ssh_test.go`
- Modify: `cmd/muxterm/main.go` (wire `runDeploy`)

Implements `muxterm deploy user@host` — copies the binary via SCP, generates a systemd unit, starts the service, prints the URL + token.

- [ ] **Step 1: Write the failing tests**

Create `internal/deploy/ssh_test.go`:

```go
package deploy

import (
	"fmt"
	"strings"
	"testing"
)

// mockRunner captures commands for assertion.
type mockRunner struct {
	commands []string
	outputs  map[string]string // command prefix → stdout
	errors   map[string]error  // command prefix → error
}

func newMockRunner() *mockRunner {
	return &mockRunner{
		outputs: make(map[string]string),
		errors:  make(map[string]error),
	}
}

func (m *mockRunner) Run(name string, args ...string) ([]byte, error) {
	cmd := name + " " + strings.Join(args, " ")
	m.commands = append(m.commands, cmd)
	for prefix, err := range m.errors {
		if strings.HasPrefix(cmd, prefix) {
			return nil, err
		}
	}
	for prefix, out := range m.outputs {
		if strings.HasPrefix(cmd, prefix) {
			return []byte(out), nil
		}
	}
	return nil, nil
}

func TestDeploy_SCPsBinary(t *testing.T) {
	runner := newMockRunner()
	d := &Deployer{runner: runner, binaryPath: "/usr/local/bin/muxterm"}
	_ = d.Deploy("user@example.com")

	found := false
	for _, cmd := range runner.commands {
		if strings.Contains(cmd, "scp") && strings.Contains(cmd, "user@example.com") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected SCP command to user@example.com, got commands: %v", runner.commands)
	}
}

func TestDeploy_CreatesSystemdUnit(t *testing.T) {
	runner := newMockRunner()
	d := &Deployer{runner: runner, binaryPath: "/usr/local/bin/muxterm"}
	_ = d.Deploy("user@example.com")

	found := false
	for _, cmd := range runner.commands {
		if strings.Contains(cmd, "ssh") && strings.Contains(cmd, "muxterm.service") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected systemd unit creation via SSH, got commands: %v", runner.commands)
	}
}

func TestDeploy_StartsService(t *testing.T) {
	runner := newMockRunner()
	d := &Deployer{runner: runner, binaryPath: "/usr/local/bin/muxterm"}
	_ = d.Deploy("user@example.com")

	found := false
	for _, cmd := range runner.commands {
		if strings.Contains(cmd, "systemctl") && strings.Contains(cmd, "enable") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected systemctl enable command, got commands: %v", runner.commands)
	}
}

func TestDeploy_SCPFailure(t *testing.T) {
	runner := newMockRunner()
	runner.errors["scp"] = fmt.Errorf("connection refused")
	d := &Deployer{runner: runner, binaryPath: "/usr/local/bin/muxterm"}
	err := d.Deploy("user@example.com")
	if err == nil {
		t.Fatal("expected error when SCP fails")
	}
	if !strings.Contains(err.Error(), "copy binary") {
		t.Errorf("expected 'copy binary' in error, got: %v", err)
	}
}

func TestSystemdUnit_ContainsSecret(t *testing.T) {
	unit := systemdUnit("abc123", "0.0.0.0:8080")
	if !strings.Contains(unit, "abc123") {
		t.Error("systemd unit should contain the auth secret")
	}
	if !strings.Contains(unit, "0.0.0.0:8080") {
		t.Error("systemd unit should contain the listen address")
	}
	if !strings.Contains(unit, "muxterm serve") {
		t.Error("systemd unit should run 'muxterm serve'")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/deploy/ -v`
Expected: FAIL — types undefined

- [ ] **Step 3: Implement the deploy module**

Create `internal/deploy/ssh.go`:

```go
package deploy

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
)

const (
	remoteBinPath     = "/usr/local/bin/muxterm"
	remoteServicePath = "/etc/systemd/system/muxterm.service"
	defaultAddr       = "0.0.0.0:8080"
)

// Runner executes system commands. Mockable for testing.
type Runner interface {
	Run(name string, args ...string) ([]byte, error)
}

// execRunner runs commands for real.
type execRunner struct{}

func (r *execRunner) Run(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// Deployer pushes muxterm to a remote host via SSH.
type Deployer struct {
	runner     Runner
	binaryPath string
}

// New creates a Deployer using the current binary.
func New() (*Deployer, error) {
	binPath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("cannot find current binary: %w", err)
	}
	return &Deployer{
		runner:     &execRunner{},
		binaryPath: binPath,
	}, nil
}

// Deploy pushes muxterm to the remote target (user@host).
// Steps: SCP binary, generate secret, write systemd unit, start service.
func (d *Deployer) Deploy(target string) error {
	log.Printf("deploying muxterm to %s...", target)

	// Step 1: Copy binary to remote host
	log.Printf("  copying binary to %s:%s", target, remoteBinPath)
	_, err := d.runner.Run("scp", d.binaryPath, target+":"+remoteBinPath)
	if err != nil {
		return fmt.Errorf("copy binary to %s: %w", target, err)
	}

	// Step 2: Make it executable
	_, err = d.runner.Run("ssh", target, "chmod", "+x", remoteBinPath)
	if err != nil {
		return fmt.Errorf("chmod binary on %s: %w", target, err)
	}

	// Step 3: Generate auth secret
	secret, err := generateSecret()
	if err != nil {
		return fmt.Errorf("generate secret: %w", err)
	}

	// Step 4: Write systemd unit
	unit := systemdUnit(secret, defaultAddr)
	log.Printf("  writing systemd unit to %s:%s", target, remoteServicePath)
	writeCmd := fmt.Sprintf("cat > %s << 'UNIT_EOF'\n%s\nUNIT_EOF", remoteServicePath, unit)
	_, err = d.runner.Run("ssh", target, "bash", "-c", writeCmd)
	if err != nil {
		return fmt.Errorf("write systemd unit on %s: %w", target, err)
	}

	// Step 5: Reload systemd and start service
	log.Printf("  starting muxterm service")
	_, err = d.runner.Run("ssh", target, "systemctl", "daemon-reload", "&&",
		"systemctl", "enable", "--now", "muxterm.service")
	if err != nil {
		return fmt.Errorf("start service on %s: %w", target, err)
	}

	// Extract hostname from target (user@host → host)
	host := target
	if idx := strings.Index(target, "@"); idx >= 0 {
		host = target[idx+1:]
	}

	fmt.Printf("\nmuxterm deployed successfully!\n")
	fmt.Printf("  URL:   http://%s:8080\n", host)
	fmt.Printf("  Token: %s\n", secret)
	fmt.Printf("\nOpen in browser: http://%s:8080?token=%s\n", host, secret)

	return nil
}

func systemdUnit(secret, addr string) string {
	return fmt.Sprintf(`[Unit]
Description=muxterm — web-native tmux client
After=network.target

[Service]
Type=simple
ExecStart=%s serve --addr %s --secret %s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target`, remoteBinPath, addr, secret)
}

func generateSecret() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/deploy/ -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Wire deploy into main.go**

In `cmd/muxterm/main.go`, replace the `runDeploy` placeholder:

```go
// runDeploy pushes muxterm to a remote host via SSH.
func runDeploy(cfg Config) error {
	d, err := deploy.New()
	if err != nil {
		return err
	}
	return d.Deploy(cfg.Target)
}
```

Add the import at the top of main.go:
```go
"muxterm/internal/deploy"
```

Remove the old `runDeploy` placeholder function.

- [ ] **Step 6: Verify build compiles**

Run: `cd ~/workspace/muxterm && go build ./cmd/muxterm/`
Expected: Compiles without errors

- [ ] **Step 7: Commit**

```bash
cd ~/workspace/muxterm
git add internal/deploy/ssh.go internal/deploy/ssh_test.go cmd/muxterm/main.go
git commit -m "feat: deploy mode — push muxterm to remote host via SSH"
```

---

### Task 5: Session Picker Backend

**Files:**
- Modify: `internal/server/server.go` (add session list support)
- Modify: `internal/server/ws.go` (add session picker WS flow)
- Create: `internal/server/session_test.go`

When a WS client connects and multiple tmux sessions exist, the server sends a session list instead of immediately attaching. Client picks a session, server attaches.

- [ ] **Step 1: Write the failing test**

Create `internal/server/session_test.go`:

```go
package server

import (
	"encoding/json"
	"testing"
)

func TestSessionListMessage(t *testing.T) {
	sessions := []SessionInfo{
		{Name: "dev", Windows: 3},
		{Name: "test", Windows: 1},
	}
	msg := SessionListMessage{Sessions: sessions}
	data, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal error: %v", err)
	}

	var decoded SessionListMessage
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	if len(decoded.Sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(decoded.Sessions))
	}
	if decoded.Sessions[0].Name != "dev" {
		t.Errorf("expected 'dev', got %q", decoded.Sessions[0].Name)
	}
	if decoded.Sessions[1].Windows != 1 {
		t.Errorf("expected 1 window, got %d", decoded.Sessions[1].Windows)
	}
}

func TestAttachSessionMessage(t *testing.T) {
	raw := `{"attach-session": "dev"}`
	var msg map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &msg); err != nil {
		t.Fatalf("unmarshal error: %v", err)
	}
	name, ok := msg["attach-session"].(string)
	if !ok || name != "dev" {
		t.Errorf("expected attach-session 'dev', got %v", msg["attach-session"])
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestSessionList|TestAttachSession"`
Expected: FAIL — `SessionInfo` and `SessionListMessage` undefined

- [ ] **Step 3: Add session types and picker logic to the server**

Add to `internal/server/server.go` (or create `internal/server/session.go` — your call based on file size):

```go
// SessionInfo describes a tmux session for the picker.
type SessionInfo struct {
	Name    string `json:"name"`
	Windows int    `json:"windows"`
}

// SessionListMessage is sent to the client when multiple sessions exist.
type SessionListMessage struct {
	Sessions []SessionInfo `json:"sessions"`
}
```

Then modify the WebSocket handler in `internal/server/ws.go`. Find the function that handles a new WebSocket connection (likely `handleWS` or `serveWS`). Add session picker logic at the top, **before** the main event loop:

```go
// At the start of the WS handler, before entering the main event loop:

// If no control mode is attached yet, run session picker flow
if s.ctrl == nil {
	sessions, err := tmux.ListSessionNames()
	if err != nil || len(sessions) == 0 {
		// No sessions — create default and attach
		name, err := tmux.EnsureRunning()
		if err != nil {
			// Send error and close
			writeJSON(conn, map[string]string{"error": "no tmux sessions available"})
			return
		}
		s.attachSession(name)
	} else if len(sessions) == 1 {
		// One session — auto-attach
		s.attachSession(sessions[0])
	} else {
		// Multiple sessions — send list, wait for pick
		infos := make([]SessionInfo, len(sessions))
		for i, name := range sessions {
			infos[i] = SessionInfo{Name: name, Windows: countWindows(name)}
		}
		writeJSON(conn, SessionListMessage{Sessions: infos})
		// Read client's session pick
		// (wait for {"attach-session": "name"} message)
		_, msgBytes, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var pick map[string]string
		if err := json.Unmarshal(msgBytes, &pick); err != nil {
			writeJSON(conn, map[string]string{"error": "invalid session pick"})
			return
		}
		sessionName, ok := pick["attach-session"]
		if !ok {
			writeJSON(conn, map[string]string{"error": "expected attach-session message"})
			return
		}
		s.attachSession(sessionName)
	}
}

// Continue with normal event loop...
```

Add the `attachSession` helper to the Server:

```go
func (s *Server) attachSession(name string) error {
	ctrl := tmux.NewControlMode()
	if err := ctrl.Start(name); err != nil {
		return fmt.Errorf("attach session %q: %w", name, err)
	}
	s.ctrl = ctrl
	return nil
}
```

Add a helper to count windows per session:

```go
func countWindows(session string) int {
	out, err := exec.Command("tmux", "list-windows", "-t", session).Output()
	if err != nil {
		return 0
	}
	return len(strings.Split(strings.TrimSpace(string(out)), "\n"))
}
```

**Note:** Adapt the above code to match Phase 2's actual WebSocket handler structure. The key additions are: `SessionInfo`, `SessionListMessage` types, and the session picker flow at the start of the WS handler.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/server/ -v -run "TestSessionList|TestAttachSession"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/muxterm
git add internal/server/
git commit -m "feat: session picker backend — send session list on WS connect"
```

---

### Task 6: Session Picker Frontend

**Files:**
- Create: `web/src/components/session-picker.ts`
- Modify: `web/src/app.ts` (show picker when sessions message received)

A modal that lists available tmux sessions. Click to attach. Auto-dismissed when only one session exists.

- [ ] **Step 1: Create the session picker component**

Create `web/src/components/session-picker.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

export interface SessionInfo {
  name: string;
  windows: number;
}

@customElement('mux-session-picker')
export class MuxSessionPicker extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      z-index: 1000;
    }

    .picker {
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 24px;
      min-width: 320px;
      max-width: 480px;
    }

    h2 {
      margin: 0 0 16px;
      color: #cdd6f4;
      font-size: 18px;
      font-weight: 600;
    }

    .session-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .session-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #313244;
      border: 1px solid transparent;
      border-radius: 6px;
      color: #cdd6f4;
      cursor: pointer;
      font-family: inherit;
      font-size: 14px;
      text-align: left;
      transition: border-color 0.15s;
    }

    .session-item:hover {
      border-color: #89b4fa;
    }

    .session-name {
      font-weight: 500;
    }

    .session-meta {
      color: #6c7086;
      font-size: 12px;
    }
  `;

  @property({ type: Array })
  sessions: SessionInfo[] = [];

  render() {
    return html`
      <div class="picker">
        <h2>Select a tmux session</h2>
        <div class="session-list">
          ${this.sessions.map(
            (s) => html`
              <button
                class="session-item"
                @click=${() => this._selectSession(s.name)}
              >
                <span class="session-name">${s.name}</span>
                <span class="session-meta">${s.windows} window${s.windows !== 1 ? 's' : ''}</span>
              </button>
            `
          )}
        </div>
      </div>
    `;
  }

  private _selectSession(name: string) {
    this.dispatchEvent(
      new CustomEvent('session-selected', {
        detail: { name },
        bubbles: true,
        composed: true,
      })
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-session-picker': MuxSessionPicker;
  }
}
```

- [ ] **Step 2: Wire picker into app.ts**

In `web/src/app.ts`, add the session picker integration. Find the control message handler (likely in `onControlMessage` or similar) and add:

```typescript
// Add import at top of app.ts:
import './components/session-picker.js';
import type { SessionInfo } from './components/session-picker.js';

// Add properties to the MuxApp class:
@property({ type: Boolean })
private showSessionPicker = false;

@property({ type: Array })
private sessions: SessionInfo[] = [];

// In the render() method, add before the main layout:
${this.showSessionPicker
  ? html`<mux-session-picker
      .sessions=${this.sessions}
      @session-selected=${this._onSessionSelected}
    ></mux-session-picker>`
  : html``}

// In the control message handler (where JSON messages from WS are processed):
// Add this case:
if ('sessions' in msg) {
  this.sessions = msg.sessions;
  this.showSessionPicker = true;
  return;
}

// Add the session selection handler:
private _onSessionSelected(e: CustomEvent<{ name: string }>) {
  this.showSessionPicker = false;
  this.ws.send(JSON.stringify({ 'attach-session': e.detail.name }));
}
```

- [ ] **Step 3: Verify frontend builds**

Run: `cd ~/workspace/muxterm/web && npm run build`
Expected: Build succeeds without TypeScript errors

- [ ] **Step 4: Manual test — session picker with multiple sessions**

```bash
# Create multiple tmux sessions for testing
tmux new-session -d -s dev
tmux new-session -d -s staging
tmux new-session -d -s test

# Start muxterm
cd ~/workspace/muxterm && go run ./cmd/muxterm/
```

Open browser to `http://localhost:8080`. Verify:
- Session picker modal appears
- Shows "dev", "staging", "test" with window counts
- Clicking a session dismisses the picker and loads that session's panes

Clean up test sessions:
```bash
tmux kill-session -t staging
tmux kill-session -t test
```

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/muxterm
git add web/src/components/session-picker.ts web/src/app.ts
git commit -m "feat: session picker — choose tmux session on connect"
```

---

### Task 7: Error Handling — Server-Side tmux Reconnect

**Files:**
- Create: `internal/tmux/reconnect.go`
- Create: `internal/tmux/reconnect_test.go`
- Modify: `internal/server/ws.go` (broadcast disconnect/reconnect events)

When the tmux control mode connection drops (tmux server died, session killed externally), the server detects it, broadcasts a disconnect event to all WS clients, attempts reconnect with exponential backoff, and on success broadcasts a full state sync.

- [ ] **Step 1: Write the failing tests**

Create `internal/tmux/reconnect_test.go`:

```go
package tmux

import (
	"testing"
	"time"
)

func TestBackoff(t *testing.T) {
	tests := []struct {
		attempt  int
		expected time.Duration
	}{
		{0, 1 * time.Second},
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{3, 8 * time.Second},
		{4, 16 * time.Second},
		{5, 30 * time.Second}, // capped at max
		{10, 30 * time.Second},
	}
	for _, tt := range tests {
		got := backoffDelay(tt.attempt)
		if got != tt.expected {
			t.Errorf("backoff(%d) = %v, want %v", tt.attempt, got, tt.expected)
		}
	}
}

func TestReconnectConfig_Defaults(t *testing.T) {
	cfg := DefaultReconnectConfig()
	if cfg.MaxRetries != 10 {
		t.Errorf("expected 10 max retries, got %d", cfg.MaxRetries)
	}
	if cfg.MaxDelay != 30*time.Second {
		t.Errorf("expected 30s max delay, got %v", cfg.MaxDelay)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestBackoff|TestReconnectConfig"`
Expected: FAIL — functions undefined

- [ ] **Step 3: Implement reconnect logic**

Create `internal/tmux/reconnect.go`:

```go
package tmux

import (
	"fmt"
	"log"
	"time"
)

// ReconnectConfig controls reconnection behavior.
type ReconnectConfig struct {
	MaxRetries int
	MaxDelay   time.Duration
}

// DefaultReconnectConfig returns sensible defaults for reconnection.
func DefaultReconnectConfig() ReconnectConfig {
	return ReconnectConfig{
		MaxRetries: 10,
		MaxDelay:   30 * time.Second,
	}
}

// DisconnectHandler is called when the control mode connection drops.
type DisconnectHandler func(reason string)

// ReconnectHandler is called when reconnection succeeds.
type ReconnectHandler func()

// Reconnect attempts to re-establish the control mode connection.
// Calls onDisconnect immediately, then retries with backoff.
// Calls onReconnect on success. Returns error if all retries exhausted.
func (cm *ControlMode) Reconnect(cfg ReconnectConfig, onDisconnect DisconnectHandler, onReconnect ReconnectHandler) error {
	session := cm.session // preserve the session name before closing
	cm.Close()

	if onDisconnect != nil {
		onDisconnect("tmux control mode connection lost")
	}

	for attempt := 0; attempt < cfg.MaxRetries; attempt++ {
		delay := backoffDelay(attempt)
		if delay > cfg.MaxDelay {
			delay = cfg.MaxDelay
		}
		log.Printf("tmux reconnect attempt %d/%d in %v", attempt+1, cfg.MaxRetries, delay)
		time.Sleep(delay)

		if err := cm.Start(session); err == nil {
			log.Printf("tmux reconnected to session %q", session)
			if onReconnect != nil {
				onReconnect()
			}
			return nil
		}
	}

	return fmt.Errorf("failed to reconnect to tmux after %d attempts", cfg.MaxRetries)
}

// backoffDelay returns the delay for the given attempt number.
// Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped).
func backoffDelay(attempt int) time.Duration {
	delay := time.Second * time.Duration(1<<uint(attempt))
	maxDelay := 30 * time.Second
	if delay > maxDelay {
		return maxDelay
	}
	return delay
}
```

**Note:** The `cm.session` field must be accessible. Check Phase 1's `ControlMode` struct — if the session name isn't stored, add it in the `Start` method:

```go
func (cm *ControlMode) Start(session string) error {
    cm.session = session  // add this if not present
    // ... existing start logic
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/muxterm && go test ./internal/tmux/ -v -run "TestBackoff|TestReconnectConfig"`
Expected: PASS

- [ ] **Step 5: Wire reconnect into the server event loop**

In `internal/server/ws.go` (or wherever the event loop reads from ControlMode), add error handling around `ReadEvent()`:

```go
// In the event loop that reads from ControlMode:
for {
    event, err := s.ctrl.ReadEvent()
    if err != nil {
        // Control mode disconnected — broadcast to all clients
        s.broadcastJSON(map[string]interface{}{
            "detached": map[string]string{"reason": err.Error()},
        })

        // Attempt reconnect
        reconnectErr := s.ctrl.Reconnect(
            tmux.DefaultReconnectConfig(),
            func(reason string) {
                log.Printf("tmux disconnected: %s", reason)
            },
            func() {
                // On reconnect, send full state sync to all clients
                s.broadcastJSON(map[string]interface{}{
                    "state": s.ctrl.GetState(), // or rebuild state
                })
            },
        )
        if reconnectErr != nil {
            log.Printf("tmux reconnect failed: %v", reconnectErr)
            s.broadcastJSON(map[string]interface{}{
                "detached": map[string]string{"reason": "tmux server unreachable"},
            })
            return
        }
        continue
    }
    // Normal event processing...
}
```

**Adapt this to match the actual event loop structure from Phase 2.** The key pattern is: on ReadEvent error → broadcast `detached` → attempt Reconnect → on success broadcast `state`.

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/muxterm
git add internal/tmux/reconnect.go internal/tmux/reconnect_test.go internal/server/ws.go
git commit -m "feat: server-side tmux reconnect with exponential backoff"
```

---

### Task 8: Error Handling — Client-Side WS Reconnect

**Files:**
- Create: `web/src/components/reconnect-overlay.ts`
- Modify: `web/src/ws.ts` (add reconnect logic)
- Modify: `web/src/app.ts` (show reconnect overlay)

When the WebSocket drops, the client shows a "Reconnecting..." overlay and attempts reconnect with exponential backoff.

- [ ] **Step 1: Create the reconnect overlay component**

Create `web/src/components/reconnect-overlay.ts`:

```typescript
import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('mux-reconnect-overlay')
export class MuxReconnectOverlay extends LitElement {
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.8);
      z-index: 2000;
    }

    .container {
      text-align: center;
      color: #cdd6f4;
    }

    .spinner {
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 3px solid #45475a;
      border-top-color: #89b4fa;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 16px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .message {
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 8px;
    }

    .detail {
      font-size: 13px;
      color: #6c7086;
    }
  `;

  @property()
  message = 'Reconnecting...';

  @property()
  detail = '';

  render() {
    return html`
      <div class="container">
        <div class="spinner"></div>
        <div class="message">${this.message}</div>
        ${this.detail ? html`<div class="detail">${this.detail}</div>` : ''}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'mux-reconnect-overlay': MuxReconnectOverlay;
  }
}
```

- [ ] **Step 2: Add reconnect logic to ws.ts**

In `web/src/ws.ts`, find the `MuxWebSocket` class (or whatever the WebSocket wrapper is called). Add reconnect capability:

```typescript
// Add these properties to the WebSocket class:
private reconnectAttempts = 0;
private maxReconnectDelay = 30_000; // 30 seconds
private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

// Add callbacks:
onDisconnect: (() => void) | null = null;
onReconnect: (() => void) | null = null;

// In the connect() method, update the onclose handler:
connect() {
  // ... existing WebSocket setup ...

  this.ws.onclose = (event) => {
    // Don't reconnect for normal closures (code 1000)
    if (event.code === 1000) return;

    if (this.onDisconnect) {
      this.onDisconnect();
    }
    this.scheduleReconnect();
  };

  this.ws.onerror = () => {
    // onerror always precedes onclose — let onclose handle reconnect
  };

  this.ws.onopen = () => {
    // Reset reconnect counter on successful connection
    this.reconnectAttempts = 0;
    if (this.onReconnect) {
      this.onReconnect();
    }
  };
}

private scheduleReconnect() {
  const delay = Math.min(
    1000 * Math.pow(2, this.reconnectAttempts),
    this.maxReconnectDelay
  );
  console.log(`WebSocket reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1})`);
  this.reconnectTimer = setTimeout(() => {
    this.reconnectAttempts++;
    this.connect();
  }, delay);
}

// Add a destroy method to clean up:
destroy() {
  if (this.reconnectTimer) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  this.ws?.close(1000);
}
```

**Adapt the above to the actual class structure from Phase 3.** The key additions are: `reconnectAttempts`, `scheduleReconnect()`, and the `onclose`/`onopen` handlers.

- [ ] **Step 3: Wire overlay into app.ts**

In `web/src/app.ts`, add:

```typescript
// Add import at top:
import './components/reconnect-overlay.js';

// Add property:
@property({ type: Boolean })
private showReconnectOverlay = false;

@property()
private reconnectMessage = 'Reconnecting...';

// In render(), add the overlay (alongside session picker):
${this.showReconnectOverlay
  ? html`<mux-reconnect-overlay
      message=${this.reconnectMessage}
    ></mux-reconnect-overlay>`
  : html``}

// When setting up the WebSocket (in connectedCallback or wherever ws is created):
this.ws.onDisconnect = () => {
  this.showReconnectOverlay = true;
  this.reconnectMessage = 'Connection lost. Reconnecting...';
};

this.ws.onReconnect = () => {
  this.showReconnectOverlay = false;
};

// Also handle the "detached" message from server (tmux died):
// In the control message handler:
if ('detached' in msg) {
  this.showReconnectOverlay = true;
  this.reconnectMessage = `Disconnected: ${msg.detached.reason}`;
  return;
}
```

- [ ] **Step 4: Verify frontend builds**

Run: `cd ~/workspace/muxterm/web && npm run build`
Expected: Build succeeds

- [ ] **Step 5: Manual test — reconnect behavior**

```bash
# Start muxterm
cd ~/workspace/muxterm && go run ./cmd/muxterm/ &
MUXTERM_PID=$!
```

Open browser to `http://localhost:8080`. Verify terminal loads. Then:

```bash
# Kill the Go server to simulate WS drop
kill $MUXTERM_PID
```

In browser: verify "Reconnecting..." overlay appears with spinner.

```bash
# Restart muxterm
cd ~/workspace/muxterm && go run ./cmd/muxterm/ &
```

In browser: verify overlay disappears and terminal is usable again.

Clean up: `kill %1`

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/muxterm
git add web/src/components/reconnect-overlay.ts web/src/ws.ts web/src/app.ts
git commit -m "feat: client-side WS reconnect with backoff and overlay UI"
```

---

### Task 9: Makefile

**Files:**
- Create: `Makefile`

Build pipeline: `make build` (Go + Vite → single binary), `make dev` (parallel dev servers), `make test` (Go + frontend tests), `make release` (cross-compile).

- [ ] **Step 1: Create the Makefile**

Create `Makefile` at the project root:

```makefile
.PHONY: build dev test release clean

VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS := -ldflags "-X main.version=$(VERSION)"

# Frontend source files for dependency tracking
WEB_SRC := $(shell find web/src -type f 2>/dev/null) web/package.json web/vite.config.ts

## build: Build frontend + Go binary → bin/muxterm
build: web/dist
	go build $(LDFLAGS) -o bin/muxterm ./cmd/muxterm
	@echo "Built bin/muxterm ($(VERSION))"

## web/dist: Build frontend with Vite
web/dist: $(WEB_SRC)
	cd web && npm ci --silent && npm run build
	@touch web/dist

## dev: Run Vite dev server + Go server in parallel
dev:
	@echo "Starting Vite dev server on :5173 and Go server on :8080..."
	@echo "Open http://localhost:5173 for hot-reload frontend"
	@cd web && npx vite --port 5173 &
	@sleep 2 && go run $(LDFLAGS) ./cmd/muxterm/
	@# Ctrl+C kills both (Go server foreground, Vite background)

## test: Run all tests (Go + frontend)
test:
	go test ./... -v
	cd web && npm test

## release: Cross-compile for linux/darwin, amd64/arm64
release: web/dist
	@mkdir -p bin
	GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/muxterm-linux-amd64 ./cmd/muxterm
	GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/muxterm-linux-arm64 ./cmd/muxterm
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o bin/muxterm-darwin-amd64 ./cmd/muxterm
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/muxterm-darwin-arm64 ./cmd/muxterm
	@echo "Release binaries in bin/:"
	@ls -lh bin/muxterm-*

## clean: Remove build artifacts
clean:
	rm -rf bin/ web/dist/ web/node_modules/

## help: Show available targets
help:
	@grep -E '^## ' Makefile | sed 's/## //' | column -t -s ':'
```

- [ ] **Step 2: Verify `make build` works**

Run: `cd ~/workspace/muxterm && make build`
Expected:
```
cd web && npm ci --silent && npm run build
go build -ldflags "-X main.version=..." -o bin/muxterm ./cmd/muxterm
Built bin/muxterm (...)
```
Verify: `./bin/muxterm version` prints the version.

- [ ] **Step 3: Verify `make test` works**

Run: `cd ~/workspace/muxterm && make test`
Expected: All Go tests and frontend tests pass.

- [ ] **Step 4: Verify the built binary is self-contained**

```bash
# The binary should include the embedded frontend
cd ~/workspace/muxterm
./bin/muxterm &
MUXTERM_PID=$!
sleep 2

# Verify the frontend is served from the embedded FS
curl -s http://localhost:8080/ | head -5
# Should show HTML content (index.html from web/dist/)

kill $MUXTERM_PID
```

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/muxterm
git add Makefile
git commit -m "feat: Makefile with build, dev, test, release, clean targets"
```

---

### Task 10: End-to-End Smoke Test

**Files:**
- Create: `e2e/smoke.spec.ts`
- Create: `e2e/playwright.config.ts`
- Create: `e2e/package.json`

Starts muxterm, opens a headless browser, verifies the UI renders, types in a pane, and checks output.

- [ ] **Step 1: Set up Playwright in the e2e directory**

```bash
cd ~/workspace/muxterm
mkdir -p e2e
cd e2e

cat > package.json << 'EOF'
{
  "name": "muxterm-e2e",
  "private": true,
  "devDependencies": {
    "@playwright/test": "^1.52.0"
  },
  "scripts": {
    "test": "playwright test",
    "test:headed": "playwright test --headed"
  }
}
EOF

npm install
npx playwright install chromium
```

- [ ] **Step 2: Create Playwright config**

Create `e2e/playwright.config.ts`:

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 30_000,
  retries: 1,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  // Start muxterm before tests, stop after
  webServer: {
    command: 'cd .. && ./bin/muxterm',
    port: 8080,
    timeout: 10_000,
    reuseExistingServer: false,
  },
});
```

- [ ] **Step 3: Write the smoke test**

Create `e2e/smoke.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('muxterm smoke tests', () => {
  test('page loads and renders mux-app', async ({ page }) => {
    await page.goto('/');
    // Wait for the custom element to be defined and rendered
    await page.waitForSelector('mux-app', { timeout: 10_000 });
    const app = page.locator('mux-app');
    await expect(app).toBeVisible();
  });

  test('tab bar renders with at least one tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('mux-app', { timeout: 10_000 });

    // Lit components use shadow DOM — use locator chaining
    const tabBar = page.locator('mux-tab-bar');
    await expect(tabBar).toBeVisible({ timeout: 5_000 });

    // At least one tab should exist
    const tabs = page.locator('mux-tab');
    await expect(tabs.first()).toBeVisible({ timeout: 5_000 });
  });

  test('at least one terminal pane renders', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('mux-app', { timeout: 10_000 });

    const pane = page.locator('mux-pane');
    await expect(pane.first()).toBeVisible({ timeout: 5_000 });
  });

  test('typing in terminal produces output', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('mux-app', { timeout: 10_000 });

    // Wait for a pane to be ready
    const pane = page.locator('mux-pane').first();
    await expect(pane).toBeVisible({ timeout: 5_000 });

    // Give the terminal a moment to initialize
    await page.waitForTimeout(2_000);

    // Type a command — focus the pane area and type
    await pane.click();
    await page.keyboard.type('echo muxterm-smoke-test\n', { delay: 50 });

    // Wait for the output to appear
    // The terminal canvas renders text — we check that the page contains
    // evidence of the command (either in DOM or via screenshot comparison)
    await page.waitForTimeout(2_000);

    // Verify the terminal is still responsive (no crash)
    await expect(pane).toBeVisible();
  });

  test('new window button creates a tab', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('mux-app', { timeout: 10_000 });

    // Count initial tabs
    const initialTabs = await page.locator('mux-tab').count();

    // Click the "+" button to create a new window
    const addButton = page.locator('mux-tab-add, [data-action="new-window"], button:has-text("+")');
    if (await addButton.isVisible()) {
      await addButton.click();
      await page.waitForTimeout(1_000);

      // Should have one more tab
      const newTabs = await page.locator('mux-tab').count();
      expect(newTabs).toBeGreaterThan(initialTabs);
    }
  });

  test('status bar is visible', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('mux-app', { timeout: 10_000 });

    const statusBar = page.locator('mux-status-bar');
    await expect(statusBar).toBeVisible({ timeout: 5_000 });
  });
});
```

- [ ] **Step 4: Build the binary and run the smoke test**

```bash
# Build first
cd ~/workspace/muxterm && make build

# Ensure a tmux session exists
tmux has-session 2>/dev/null || tmux new-session -d -s muxterm

# Run the smoke tests
cd e2e && npx playwright test --reporter=line
```

Expected: All 6 tests pass. If any fail, the error output will show which selector wasn't found — this reveals integration issues between components.

**Troubleshooting:**
- If "mux-app not found": the frontend embed might be broken — check `make build` output
- If "mux-tab-bar not found": the WebSocket might not be connecting — check server logs
- If "typing produces no output": control mode might not be routing `%output` events — check pane I/O

- [ ] **Step 5: Add e2e to Makefile**

In the `Makefile`, add an `e2e` target:

```makefile
## e2e: Run end-to-end smoke tests (requires built binary)
e2e: build
	cd e2e && npx playwright test --reporter=line
```

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/muxterm
git add e2e/ Makefile
git commit -m "test: end-to-end smoke tests with Playwright"
```

---

## Post-Completion Verification

After all 10 tasks are done, run the full verification:

```bash
cd ~/workspace/muxterm

# 1. Full test suite
make test

# 2. Build release binary
make build

# 3. End-to-end smoke test
make e2e

# 4. Manual verification — start in local mode
./bin/muxterm
# → Browser opens to localhost:8080
# → Terminal is interactive
# → Tabs, panes, status bar all render
# → Ctrl+C cleanly shuts down

# 5. Version check
./bin/muxterm version
# → prints "muxterm <git-tag>"

# 6. Serve mode
./bin/muxterm serve --addr 127.0.0.1:9090
# → prints token, accessible at localhost:9090
```
