# Session Persistence — Phase 2: One Binary, Two Roles + Lifecycle & systemd Implementation Plan

> **Execution:** Use the subagent-driven-development workflow to implement this plan.

**Goal:** Make the Phase-1 `sessiond` daemon runnable and persistent: add a `muxterm sessiond` subcommand, an auto-spawn/detach path so `serve` can launch a daemon that outlives it, and a `muxterm install` flow that installs the daemon as its own systemd unit (so it survives `serve` restarts).

**Architecture:** A single `muxterm` binary exposes two roles via subcommands — `serve` (web, ephemeral) and `sessiond` (long-lived PTY daemon). The daemon listens on a Unix socket under `$XDG_RUNTIME_DIR/muxterm/sessiond.sock`. When `serve` finds the socket dead it spawns `muxterm sessiond` detached (new session via `Setsid`, stdio to a logfile) so it reparents to init. Under systemd the daemon gets its **own** unit (separate cgroup) and the web unit declares `Wants=`/`After=` it, because `systemctl --user restart` would otherwise kill a daemon spawned inside the web unit's cgroup.

**Tech Stack:** Go 1.24, module `github.com/user/muxterm`. Stdlib `testing` (NO testify), `t.Fatalf`/`t.Errorf`. `net` (Unix sockets), `os/exec` + stdlib `syscall` (`SysProcAttr{Setsid:true}`), `text/template` (unit files). Tests run via `go test -v ./...` (`make test`).

---

## Source of truth & scope

- **Design doc (authoritative):** `docs/plans/2026-06-01-session-persistence-design.md`, especially the section **"One binary, two roles: lifecycle & restart survival."** This plan must never contradict it.
- **Phase 2 ONLY.** In scope: the `sessiond` subcommand, socket-path resolution, liveness check, auto-spawn/detach, the `sessiond_main` wiring, and `muxterm install` writing **both** systemd units.
- **Explicitly OUT of scope** (do not touch): the daemon internals / `sessiond.Server` itself (Phase 1); repointing the web server off tmux onto the sessiond client (Phase 3); the browser multiplexer (Phase 4); buffer fidelity (Phase 5). `serve`'s actual terminal data source stays exactly as it is today — Phase 3 repoints it. Phase 2 only adds the subcommand and makes the daemon auto-spawnable and installable.

## Frozen contract this plan conforms to (the integration seam)

The wire/lifecycle contract is **FROZEN** in the design doc's **"## Wire Protocol (frozen v1 contract)"** section (see *"Server lifecycle signatures (frozen, Phases 1–3)"*). This plan does **not** invent or hedge those names — it matches them byte-for-byte. The relevant frozen signatures are:

```go
// Owned & implemented by Phase 1 (internal/sessiond):
func NewServer(socketPath string) (*Server, error)
func (s *Server) ListenAndServe(ctx context.Context) error  // returns nil on ctx cancel (graceful)

// Owned & implemented by THIS plan (Phase 2, internal/sessiond/spawn.go):
func SocketPath() (string, error)            // $XDG_RUNTIME_DIR/muxterm/sessiond.sock + documented fallback
func DefaultLogPath() (string, error)
func EnsureDaemon(socketPath, logPath string) error   // GATED OFF under systemd (detect via INVOCATION_ID)
```

> **These are frozen, not negotiable.** Phase 3 calls `SocketPath()` (handling its error) and then `EnsureDaemon(path, log)`; the daemon entrypoint constructs via `NewServer(socketPath)` and runs via `ListenAndServe(ctx)`, which returns **nil on context cancel** (graceful shutdown). There is **no** `Listen()`/`Serve()`/`Close()` three-method shape — do not assume it. The two daemon-construction call sites live in **Task 7** (`cmd/muxterm/sessiond_main.go`); everything else here is independent of the daemon's internals.

**Why the helpers return an `error`.** `SocketPath`/`DefaultLogPath` carry an `error` slot in the frozen signature so XDG/home-dir resolution can fail loudly in future hardening rather than silently returning a wrong path. Phase 2's implementation currently never errors (pure path joins), but it **must keep the `(string, error)` arity** because Phase 3 imports and error-checks these exact signatures.

## Dependency note (read before Task 5) — honest deviation from the brief

The brief suggested adding `golang.org/x/sys`. **We deliberately do not**, because the detach mechanism is `exec.Cmd.SysProcAttr`, whose type is **`*syscall.SysProcAttr`** (stdlib `syscall`, not `golang.org/x/sys/unix`). `syscall.SysProcAttr` already exposes the `Setsid bool` field we need on Linux/macOS/BSD. Adding `golang.org/x/sys` would be an unused dependency (YAGNI) — `os/exec` cannot consume `x/sys/unix`'s `SysProcAttr` type anyway. Liveness uses stdlib `net`; stale-socket cleanup uses stdlib `os`. **No new module dependency is added in Phase 2.** If a reviewer insists on `x/sys`, that is a one-line `go get` but it would sit unused.

Because `syscall.SysProcAttr{Setsid:true}` is unix-only, the new `spawn.go` / `spawn_test.go` files carry a `//go:build unix` constraint (the project is already unix-only: it depends on `creack/pty` and uses `syscall.SIGINT`/`SIGTERM`).

---

## Task list

1. Socket-path resolver (`SocketPath`, `DefaultLogPath`)
2. Liveness check (`IsAlive`)
3. Auto-spawn / detach (`SpawnCommand`, `Spawn`) — incl. survives-parent-exit test
4. Daemon ensure orchestration (`EnsureDaemon`)
5. `sessiond` subcommand parsing (`cli.go`)
6. `sessiond` dispatch in `main()` + best-effort auto-spawn in `serve`
7. `sessiond_main` wiring (`runSessiond` / `serveSessiond`)
8. systemd unit templates (sessiond unit + web unit `Wants=`/`After=`)
9. `muxterm install` writes BOTH units + daemon-reload; `uninstall` removes both

Each task is a full TDD micro-cycle: write failing test → run it (see it fail) → implement → run it (see it pass) → commit.

---

### Task 1: Socket-path resolver

Resolve the daemon's Unix socket path from `$XDG_RUNTIME_DIR` with a documented fallback, plus a sibling logfile path. This mirrors the existing XDG pattern in `internal/config/path.go`.

**Files:**
- Create: `internal/sessiond/spawn.go`
- Create: `internal/sessiond/spawn_test.go`

> The implementer may find Phase 1 already created `internal/sessiond/` with other files. That is fine — only **create the two `spawn*` files**; do not modify Phase 1 files.

**Step 1: Write the failing test**

Create `internal/sessiond/spawn_test.go`:

```go
//go:build unix

package sessiond

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestSocketPath_UsesXDGRuntimeDir(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1234")
	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath() error: %v", err)
	}
	want := "/run/user/1234/muxterm/sessiond.sock"
	if got != want {
		t.Errorf("SocketPath() = %q, want %q", got, want)
	}
}

func TestSocketPath_FallbackWhenXDGUnset(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "")
	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath() error: %v", err)
	}
	want := filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-%d", os.Getuid()), "sessiond.sock")
	if got != want {
		t.Errorf("SocketPath() fallback = %q, want %q", got, want)
	}
}

func TestDefaultLogPath_SitsBesideSocket(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1234")
	got, err := DefaultLogPath()
	if err != nil {
		t.Fatalf("DefaultLogPath() error: %v", err)
	}
	want := "/run/user/1234/muxterm/sessiond.log"
	if got != want {
		t.Errorf("DefaultLogPath() = %q, want %q", got, want)
	}
}
```

> **Frozen-signature note:** `SocketPath` and `DefaultLogPath` return `(string, error)` to match the frozen contract (Phase 3 imports and error-checks these exact signatures). The Phase 2 implementation never actually errors — the path is a pure join — but the arity is load-bearing across phases, so the tests destructure the error even though it is always `nil` here.

**Step 2: Run test to verify it fails**

Run: `go test ./internal/sessiond/ -run 'TestSocketPath|TestDefaultLogPath' -v`
Expected: FAIL — compile error `undefined: SocketPath` / `undefined: DefaultLogPath`.

**Step 3: Write minimal implementation**

Create `internal/sessiond/spawn.go`:

```go
//go:build unix

// Package sessiond — lifecycle helpers (Phase 2): socket-path resolution,
// liveness checking, and detached auto-spawn of the daemon process.
package sessiond

import (
	"fmt"
	"os"
	"path/filepath"
)

// socketDir returns the directory that holds the daemon's Unix socket and
// logfile. It follows the XDG runtime convention:
//   - $XDG_RUNTIME_DIR/muxterm        when XDG_RUNTIME_DIR is set
//   - $TMPDIR/muxterm-<uid>           otherwise (documented fallback)
//
// The fallback uses a uid-scoped directory under the system temp dir so two
// users on the same host never collide on the socket path.
func socketDir() string {
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base != "" {
		return filepath.Join(base, "muxterm")
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-%d", os.Getuid()))
}

// SocketPath returns the absolute path to the sessiond Unix socket. It returns
// an (always-nil today) error to match the FROZEN contract signature that
// Phase 3 imports and error-checks; the error slot is reserved for future
// XDG/home-dir resolution failures.
func SocketPath() (string, error) {
	return filepath.Join(socketDir(), "sessiond.sock"), nil
}

// DefaultLogPath returns the logfile the detached daemon's stdout/stderr are
// redirected to. It sits beside the socket so cleanup is a single directory.
// Like SocketPath it returns (string, error) to match the frozen contract.
func DefaultLogPath() (string, error) {
	return filepath.Join(socketDir(), "sessiond.log"), nil
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./internal/sessiond/ -run 'TestSocketPath|TestDefaultLogPath' -v`
Expected: PASS (3 tests ok).

**Step 5: Commit**

```
git add internal/sessiond/spawn.go internal/sessiond/spawn_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): resolve daemon socket and log paths via XDG

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 2: Liveness check

`serve` must decide whether a daemon is already running. A live socket = something is accepting connections; a missing file or a stale socket file (left by a crashed daemon) = dead.

**Files:**
- Modify: `internal/sessiond/spawn.go`
- Modify: `internal/sessiond/spawn_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/spawn_test.go`:

```go
func TestIsAlive_NoSocketFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.sock")
	if IsAlive(path) {
		t.Errorf("IsAlive(%q) = true, want false (no socket)", path)
	}
}

func TestIsAlive_StaleSocketFile(t *testing.T) {
	// A plain file at the socket path (no listener) must read as dead.
	path := filepath.Join(t.TempDir(), "stale.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
		t.Fatalf("write stale file: %v", err)
	}
	if IsAlive(path) {
		t.Errorf("IsAlive(stale file) = true, want false")
	}
}

func TestIsAlive_LiveListener(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("net.Listen unix: %v", err)
	}
	defer ln.Close()
	if !IsAlive(path) {
		t.Errorf("IsAlive(live listener) = false, want true")
	}
}
```

Add `"net"` to the test file's import block.

**Step 2: Run test to verify it fails**

Run: `go test ./internal/sessiond/ -run TestIsAlive -v`
Expected: FAIL — `undefined: IsAlive`.

**Step 3: Write minimal implementation**

Add to `internal/sessiond/spawn.go` (and add `"net"` and `"time"` to its imports):

```go
// IsAlive reports whether a sessiond daemon is currently accepting connections
// on socketPath. A missing file, a stale socket file with no listener, or a
// non-socket file all read as dead (false). A successful dial reads as alive.
func IsAlive(socketPath string) bool {
	conn, err := net.DialTimeout("unix", socketPath, 250*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./internal/sessiond/ -run TestIsAlive -v`
Expected: PASS (3 tests ok).

**Step 5: Commit**

```
git add internal/sessiond/spawn.go internal/sessiond/spawn_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): add Unix-socket liveness check

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 3: Auto-spawn / detach (the "abduco trick")

Launch a child process in a **new session** (`Setsid`) with stdio redirected to a logfile, so when the launching process exits the child reparents to init and survives. This is the manual/dev/SSH persistence path.

**Files:**
- Modify: `internal/sessiond/spawn.go`
- Modify: `internal/sessiond/spawn_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/spawn_test.go`. The second test re-execs the test binary as an intermediate launcher that spawns a grandchild and then exits — proving the grandchild outlives its parent.

```go
func TestSpawnCommand_StartsInNewSession(t *testing.T) {
	// Spawn a harmless long-running process and assert it is its own session
	// leader (process-group id == its own pid), i.e. detached from us.
	logPath := filepath.Join(t.TempDir(), "spawn.log")
	proc, err := SpawnCommand("sleep", []string{"30"}, logPath)
	if err != nil {
		t.Fatalf("SpawnCommand: %v", err)
	}
	defer func() {
		_ = proc.Kill()
		_, _ = proc.Wait()
	}()

	childPgid, err := syscall.Getpgid(proc.Pid)
	if err != nil {
		t.Fatalf("Getpgid(child): %v", err)
	}
	if childPgid != proc.Pid {
		t.Errorf("child pgid = %d, want == child pid %d (new session)", childPgid, proc.Pid)
	}
	ourPgid, _ := syscall.Getpgid(os.Getpid())
	if childPgid == ourPgid {
		t.Errorf("child shares our process group %d; expected a detached session", ourPgid)
	}
}

func TestSpawn_SurvivesParentExit(t *testing.T) {
	// Helper branch: when re-executed with MUXTERM_SPAWN_HELPER=1, act as the
	// intermediate launcher — spawn a grandchild that touches MARKER after a
	// delay, then exit immediately.
	if os.Getenv("MUXTERM_SPAWN_HELPER") == "1" {
		marker := os.Getenv("MUXTERM_MARKER")
		logPath := filepath.Join(filepath.Dir(marker), "helper-spawn.log")
		_, _ = SpawnCommand("sh", []string{"-c", "sleep 1; touch " + marker}, logPath)
		os.Exit(0)
	}

	dir := t.TempDir()
	marker := filepath.Join(dir, "alive")

	launcher := exec.Command(os.Args[0], "-test.run=^TestSpawn_SurvivesParentExit$")
	launcher.Env = append(os.Environ(),
		"MUXTERM_SPAWN_HELPER=1",
		"MUXTERM_MARKER="+marker,
	)
	if err := launcher.Start(); err != nil {
		t.Fatalf("start launcher: %v", err)
	}
	if err := launcher.Wait(); err != nil {
		t.Fatalf("launcher exited with error: %v", err)
	}

	// The launcher (intermediate parent) has now exited. The grandchild sleeps
	// 1s then touches MARKER. If it appears, the grandchild outlived its parent.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(marker); err == nil {
			return // success: grandchild survived parent exit
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("marker %q never appeared; detached grandchild did not survive parent exit", marker)
}
```

Add `"os/exec"`, `"syscall"`, and (if not already present) `"time"` to the test file's import block.

**Step 2: Run test to verify it fails**

Run: `go test ./internal/sessiond/ -run 'TestSpawnCommand_StartsInNewSession|TestSpawn_SurvivesParentExit' -v`
Expected: FAIL — `undefined: SpawnCommand`.

**Step 3: Write minimal implementation**

Add to `internal/sessiond/spawn.go` (add `"os/exec"` and `"syscall"` to its imports):

```go
// SpawnCommand starts name+args as a detached background process: a new session
// (Setsid) with stdin closed and stdout/stderr appended to logPath. Because the
// child is a session leader, it reparents to init and survives the caller's exit.
// The returned *os.Process is the live child; callers that do not intend to wait
// on it may simply discard it.
func SpawnCommand(name string, args []string, logPath string) (*os.Process, error) {
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		return nil, fmt.Errorf("create log dir: %w", err)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open log file: %w", err)
	}
	// The child inherits a dup of logFile's fd; we close our copy after Start.
	defer logFile.Close()

	cmd := exec.Command(name, args...)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// Setsid puts the child in a brand-new session/process-group so it detaches
	// from our controlling terminal and reparents to init when we exit.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %q: %w", name, err)
	}
	return cmd.Process, nil
}

// Spawn launches `muxterm sessiond` detached, using the currently running
// executable as the binary. stdout/stderr go to logPath.
func Spawn(logPath string) (*os.Process, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("resolve own executable: %w", err)
	}
	return SpawnCommand(exe, []string{"sessiond"}, logPath)
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./internal/sessiond/ -run 'TestSpawnCommand_StartsInNewSession|TestSpawn_SurvivesParentExit' -v`
Expected: PASS (both tests ok). The survival test takes ~1–2s.

**Step 5: Commit**

```
git add internal/sessiond/spawn.go internal/sessiond/spawn_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): detached auto-spawn via Setsid (survives parent exit)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 4: Daemon ensure orchestration (gated OFF under systemd)

One function `serve` will call on startup. Behavior, in order:

1. **If running under systemd** (detected via the `INVOCATION_ID` env var systemd sets for every unit it starts), `EnsureDaemon` is a **no-op returning nil** — under systemd the daemon is its **own** unit (`muxterm-sessiond.service`) with its **own** cgroup, so auto-spawning a second copy inside the web unit's cgroup would double-spawn and race the managed daemon. This gate is the fix for the review's flagged double-spawn/cgroup-race.
2. Otherwise, if the daemon is already live, do nothing.
3. Otherwise, clear any stale socket, spawn detached, and poll until the socket comes up.

**Files:**
- Modify: `internal/sessiond/spawn.go`
- Modify: `internal/sessiond/spawn_test.go`

**Step 1: Write the failing test**

Append to `internal/sessiond/spawn_test.go`. We unit-test **two** branches that need no real daemon binary listening: (a) the systemd gate (no-op when `INVOCATION_ID` is set), and (b) the already-alive branch (a live listener ⇒ return nil immediately without spawning). Both assert **no log file** is created, proving no spawn happened.

```go
func TestEnsureDaemon_SystemdGate_NoSpawn(t *testing.T) {
	// systemd sets INVOCATION_ID for every unit it starts. Its presence means
	// "managed unit" — the dedicated muxterm-sessiond.service owns the daemon,
	// so EnsureDaemon must NOT auto-spawn (avoids the double-spawn/cgroup race).
	t.Setenv("INVOCATION_ID", "deadbeefcafef00d")

	dir := t.TempDir()
	socketPath := filepath.Join(dir, "missing.sock") // deliberately NOT alive
	logPath := filepath.Join(dir, "should-not-be-written.log")

	if err := EnsureDaemon(socketPath, logPath); err != nil {
		t.Fatalf("EnsureDaemon under systemd = %v, want nil (no-op)", err)
	}
	if _, err := os.Stat(logPath); err == nil {
		t.Errorf("log file created at %q; EnsureDaemon must be a no-op under systemd", logPath)
	}
}

func TestEnsureDaemon_AlreadyAlive_NoSpawn(t *testing.T) {
	// Ensure the systemd gate does not mask this branch even if the test host
	// happens to run under systemd (e.g. CI via systemd-run).
	t.Setenv("INVOCATION_ID", "")

	path := filepath.Join(t.TempDir(), "live.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("net.Listen unix: %v", err)
	}
	defer ln.Close()

	logPath := filepath.Join(t.TempDir(), "should-not-be-written.log")
	if err := EnsureDaemon(path, logPath); err != nil {
		t.Fatalf("EnsureDaemon(live) = %v, want nil", err)
	}
	// Because the daemon was already alive, no spawn happened, so no log file.
	if _, err := os.Stat(logPath); err == nil {
		t.Errorf("log file was created at %q; EnsureDaemon should not have spawned", logPath)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/sessiond/ -run TestEnsureDaemon -v`
Expected: FAIL — `undefined: EnsureDaemon`.

**Step 3: Write minimal implementation**

Add to `internal/sessiond/spawn.go`:

```go
// EnsureDaemon guarantees a live daemon at socketPath for the manual/dev/SSH
// path. It is GATED OFF under systemd: systemd sets INVOCATION_ID for every
// unit it starts, and under systemd the daemon runs as its own unit
// (muxterm-sessiond.service) with its own cgroup, so auto-spawning a second
// copy inside the web unit's cgroup would double-spawn and race. When that env
// var is present, EnsureDaemon is a no-op.
//
// Otherwise: if a daemon is already accepting connections it returns
// immediately; else it removes any stale socket file, spawns `muxterm sessiond`
// detached (logging to logPath), and polls until the socket is live or a short
// timeout elapses.
func EnsureDaemon(socketPath, logPath string) error {
	// systemd gate: under a managed unit, the dedicated sessiond unit owns the
	// daemon — do not auto-spawn.
	if os.Getenv("INVOCATION_ID") != "" {
		return nil
	}
	if IsAlive(socketPath) {
		return nil
	}
	// Clear a stale socket left by a crashed daemon so the new one can bind.
	if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	if _, err := Spawn(logPath); err != nil {
		return fmt.Errorf("spawn sessiond: %w", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if IsAlive(socketPath) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("sessiond did not become reachable at %s within timeout", socketPath)
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./internal/sessiond/ -run TestEnsureDaemon -v`
Expected: PASS (both `TestEnsureDaemon_SystemdGate_NoSpawn` and `TestEnsureDaemon_AlreadyAlive_NoSpawn`).

Then run the whole package: `go test ./internal/sessiond/ -v`
Expected: PASS (all `spawn*` tests; Phase-1 tests unaffected).

**Step 5: Commit**

```
git add internal/sessiond/spawn.go internal/sessiond/spawn_test.go
git commit -m "$(cat <<'EOF'
feat(sessiond): EnsureDaemon orchestrates liveness, stale cleanup, spawn

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 5: `sessiond` subcommand parsing

Add a `sessiond` case to the CLI parser. Keep `serve` and the no-arg default behavior unchanged.

**Files:**
- Modify: `cmd/muxterm/cli.go` (the `ParseArgs` switch, ~line 28–45; the `Config.Mode` doc comment, ~line 12)
- Modify: `cmd/muxterm/cli_test.go`

**Step 1: Write the failing test**

Append to `cmd/muxterm/cli_test.go`:

```go
func TestParseArgs_Sessiond(t *testing.T) {
	cfg, err := ParseArgs([]string{"sessiond"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "sessiond" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "sessiond")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./cmd/muxterm/ -run TestParseArgs_Sessiond -v`
Expected: FAIL — falls back to `"local"` mode, so `Mode = "local", want "sessiond"`.

**Step 3: Write minimal implementation**

In `cmd/muxterm/cli.go`, update the `Config.Mode` comment to include the new mode:

```go
	Mode   string // local, serve, sessiond, deploy, install, uninstall, version
```

Add a case to the `switch args[0]` block in `ParseArgs` (place it right after the `case "serve":` line):

```go
	case "sessiond":
		return Config{Mode: "sessiond"}, nil
```

**Step 4: Run test to verify it passes**

Run: `go test ./cmd/muxterm/ -run TestParseArgs_Sessiond -v`
Expected: PASS.

**Step 5: Commit**

```
git add cmd/muxterm/cli.go cmd/muxterm/cli_test.go
git commit -m "$(cat <<'EOF'
feat(cli): parse the sessiond subcommand

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 7: `sessiond_main` wiring

> **Note on ordering:** implement this (Task 7) **before** wiring the dispatch (Task 6), because `main()`'s new `case "sessiond"` will call `runSessiond`, which must exist for the package to compile. We commit them together-ish; this task creates the function, Task 6 calls it.

Create the entrypoint that runs the Phase-1 daemon: resolve the socket path, ensure its directory exists, clear any stale socket, construct the server, and run it until SIGINT/SIGTERM.

**Files:**
- Create: `cmd/muxterm/sessiond_main.go`
- Create: `cmd/muxterm/sessiond_main_test.go`

**Step 1: Write the failing test**

Create `cmd/muxterm/sessiond_main_test.go`. The test runs `serveSessiond` against a temp socket path in a goroutine, waits for the socket to go live, then cancels and asserts a clean return.

```go
package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/user/muxterm/internal/sessiond"
)

func TestServeSessiond_ListensThenShutsDown(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "sessiond.sock")
	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() { errCh <- serveSessiond(ctx, socketPath) }()

	// Wait for the daemon to come up.
	deadline := time.Now().Add(3 * time.Second)
	for !sessiond.IsAlive(socketPath) {
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("sessiond did not start listening on %s", socketPath)
		}
		time.Sleep(20 * time.Millisecond)
	}

	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("serveSessiond returned error on shutdown: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("serveSessiond did not return after context cancel")
	}
}
```

> **Frozen-contract note:** this test exercises the real Phase-1 server through the **frozen** `NewServer(socketPath) (*Server, error)` + `ListenAndServe(ctx)` signatures. Because `ListenAndServe` returns **nil on context cancel** (graceful shutdown, per the frozen contract), the assertion `err == nil` after `cancel()` is now correct and load-bearing. There is no `Listen()`/`Serve()`/`Close()` shape to adapt to.

**Step 2: Run test to verify it fails**

Run: `go test ./cmd/muxterm/ -run TestServeSessiond -v`
Expected: FAIL — `undefined: serveSessiond`.

**Step 3: Write minimal implementation**

Create `cmd/muxterm/sessiond_main.go`:

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/user/muxterm/internal/sessiond"
)

// runSessiond runs the long-lived session daemon (the `muxterm sessiond` role).
// It owns all PTYs and per-pane scrollback and listens on the Unix socket under
// $XDG_RUNTIME_DIR/muxterm/sessiond.sock. It blocks until SIGINT/SIGTERM, then
// shuts down gracefully (ListenAndServe returns nil on context cancel).
func runSessiond(_ Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	return serveSessiond(ctx, socketPath)
}

// serveSessiond is the testable core of runSessiond: it constructs the Phase-1
// daemon bound to socketPath and serves until ctx is canceled. It ensures the
// socket's parent directory exists; binding and stale-socket cleanup are owned
// by the daemon (NewServer/ListenAndServe), per the frozen contract.
func serveSessiond(ctx context.Context, socketPath string) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}

	// ── Phase-1 integration seam ───────────────────────────────────────────
	// Construct and run the daemon via the FROZEN signatures (design doc:
	// "Server lifecycle signatures"). NewServer returns (*Server, error);
	// ListenAndServe(ctx) blocks and returns nil on graceful context cancel.
	srv, err := sessiond.NewServer(socketPath)
	if err != nil {
		return fmt.Errorf("create sessiond server: %w", err)
	}
	log.Printf("muxterm sessiond listening on %s", socketPath)
	return srv.ListenAndServe(ctx) // returns nil when ctx is canceled (graceful)
	// ───────────────────────────────────────────────────────────────────────
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./cmd/muxterm/ -run TestServeSessiond -v`
Expected: PASS.

**Step 5: Commit**

```
git add cmd/muxterm/sessiond_main.go cmd/muxterm/sessiond_main_test.go
git commit -m "$(cat <<'EOF'
feat(cmd): wire runSessiond to run the Phase-1 daemon on the Unix socket

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 6: Dispatch `sessiond` in `main()` + best-effort auto-spawn in `serve`

Hook the new mode into `main()`'s switch, and have `serve` best-effort-ensure the daemon is up on startup (logged, non-fatal — Phase 3 will make `serve` actually connect to it).

**Files:**
- Modify: `cmd/muxterm/main.go` — the `switch cfg.Mode` block (~line 38–66), and `runServe` (~line 99–139)

**Step 1: Write the failing test**

There is no clean unit seam for `main()`'s switch, and a full `serve` run needs tmux. Verify this task by **build + manual smoke** instead of a new unit test (the dispatch correctness is covered by Task 5's parser test and Task 7's `serveSessiond` test). Proceed to Step 3.

**Step 2: (build gate) confirm current build is green**

Run: `go build ./...`
Expected: success (no output).

**Step 3: Write minimal implementation**

In `cmd/muxterm/main.go`, add a `case "sessiond"` to the `switch cfg.Mode` block, right after the `case "serve":` block:

```go
	case "sessiond":
		if err := runSessiond(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
```

Then, at the **top of `runServe`** (right after the function's opening brace, before the secret-generation block), add the best-effort daemon ensure. Note the frozen helpers return `(string, error)`, so resolve them first and chain the error checks; all failures are **non-fatal** (logged, then continue):

```go
	// Best-effort: make sure the persistence daemon is up. In the manual/dev/SSH
	// case this auto-spawns a detached `muxterm sessiond`. Non-fatal in Phase 2 —
	// serve still uses its existing data source; Phase 3 repoints it onto the
	// daemon's Unix socket. (Under systemd EnsureDaemon is a no-op — the daemon
	// is its own unit; see `muxterm install`.)
	if sockPath, err := sessiond.SocketPath(); err != nil {
		log.Printf("serve: cannot resolve sessiond socket path (continuing): %v", err)
	} else if logPath, err := sessiond.DefaultLogPath(); err != nil {
		log.Printf("serve: cannot resolve sessiond log path (continuing): %v", err)
	} else if err := sessiond.EnsureDaemon(sockPath, logPath); err != nil {
		log.Printf("serve: sessiond not ready (continuing): %v", err)
	}
```

Add the import to the existing import block in `cmd/muxterm/main.go`:

```go
	"github.com/user/muxterm/internal/sessiond"
```

> `log` and `os` and `fmt` are already imported in `main.go`; do not re-add them.

**Step 4: Verify build + full test suite**

Run: `go build ./...`
Expected: success.

Run: `go vet ./cmd/muxterm/ ./internal/sessiond/`
Expected: no findings.

Manual smoke (optional but recommended):
```
go build -o /tmp/muxterm ./cmd/muxterm
/tmp/muxterm sessiond &        # starts the daemon
ls "$XDG_RUNTIME_DIR/muxterm/" # expect sessiond.sock
kill %1
```
Expected: `sessiond.sock` appears while the daemon runs.

**Step 5: Commit**

```
git add cmd/muxterm/main.go
git commit -m "$(cat <<'EOF'
feat(cmd): dispatch sessiond subcommand and auto-ensure daemon in serve

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 8: systemd unit templates — sessiond unit + web unit `Wants=`/`After=`

Generate a `muxterm-sessiond.service` unit (`Restart=on-failure`) and make the existing `muxterm.service` web unit declare a dependency on it. Separate unit = separate cgroup = the daemon survives `systemctl --user restart muxterm`.

**launchd parity — explicitly DEFERRED:** macOS launchd does **not** have systemd's cgroup-kill-on-restart behavior — each launchd agent is already its own independent job, so the web agent restarting never kills a separately spawned daemon, and the Task-6 auto-spawn path already covers macOS. A dedicated `com.muxterm.sessiond` launchd agent is therefore **not** added in Phase 2. (Per the `self-managing-tool-patterns` skill: launchd uses `bootstrap`/`bootout` and independent per-job plists.) Revisit only if macOS users want boot-time daemon start without a `serve` launch.

**Files:**
- Modify: `internal/service/service.go` (templates + render funcs, ~line 9–70)
- Modify: `internal/service/commander.go` (add a path helper, ~line 12–15)
- Modify: `internal/service/service_test.go`

**Step 1: Write the failing test**

Append to `internal/service/service_test.go`:

```go
func TestRenderSessiondSystemdUnit_ContainsSessiondCommand(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderSessiondSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSessiondSystemdUnit() error: %v", err)
	}
	if !contains(out, "/usr/local/bin/muxterm sessiond") {
		t.Errorf("output missing `<binary> sessiond` ExecStart, got:\n%s", out)
	}
	if !contains(out, "Restart=on-failure") {
		t.Error("sessiond unit missing Restart=on-failure")
	}
	for _, section := range []string{"[Unit]", "[Service]", "[Install]"} {
		if !contains(out, section) {
			t.Errorf("sessiond unit missing section %q", section)
		}
	}
}

func TestRenderSessiondSystemdUnit_ContainsPATH(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/bin/muxterm",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderSessiondSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSessiondSystemdUnit() error: %v", err)
	}
	if !contains(out, "Environment=PATH=/usr/bin:/usr/local/bin") {
		t.Errorf("sessiond unit missing PATH, got:\n%s", out)
	}
}

func TestRenderSystemdUnit_WebUnitDependsOnSessiond(t *testing.T) {
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
	if !contains(out, "Wants=muxterm-sessiond.service") {
		t.Errorf("web unit missing Wants=muxterm-sessiond.service, got:\n%s", out)
	}
	if !contains(out, "After=muxterm-sessiond.service") {
		t.Errorf("web unit missing After=muxterm-sessiond.service, got:\n%s", out)
	}
}

func TestSessiondSystemdUnitPath_UsesHomeDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("cannot determine home dir: %v", err)
	}
	got := SessiondSystemdUnitPath()
	want := home + "/.config/systemd/user/muxterm-sessiond.service"
	if got != want {
		t.Errorf("SessiondSystemdUnitPath() = %q, want %q", got, want)
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/service/ -run 'Sessiond|WebUnitDependsOnSessiond' -v`
Expected: FAIL — `undefined: RenderSessiondSystemdUnit`, `undefined: SessiondSystemdUnitPath`, and the web-unit dependency assertion fails.

**Step 3: Write minimal implementation**

In `internal/service/service.go`, update the **web** systemd template's `[Unit]` section to declare the dependency, and add a new sessiond template + render func. Replace the existing `systemdTemplate` var (lines 9–22) with:

```go
var systemdTemplate = template.Must(template.New("systemd").Parse(`[Unit]
Description=muxterm
After=network.target muxterm-sessiond.service
Wants=muxterm-sessiond.service

[Service]
Type=simple
ExecStart={{.BinaryPath}} serve --addr {{.Addr}} --secret {{.Secret}}
Restart=on-failure
RestartSec=5s
Environment=PATH={{.SafePATH}}

[Install]
WantedBy=default.target
`))

var sessiondSystemdTemplate = template.Must(template.New("sessiond-systemd").Parse(`[Unit]
Description=muxterm sessiond (session persistence daemon)
After=network.target

[Service]
Type=simple
ExecStart={{.BinaryPath}} sessiond
Restart=on-failure
RestartSec=5s
Environment=PATH={{.SafePATH}}

[Install]
WantedBy=default.target
`))
```

Add a render function next to `RenderSystemdUnit` (after it, ~line 70):

```go
// RenderSessiondSystemdUnit renders the muxterm-sessiond.service user unit.
// The daemon runs as its OWN unit (separate cgroup) so a `systemctl --user
// restart muxterm` of the web unit does not kill it.
func RenderSessiondSystemdUnit(cfg ServiceConfig) (string, error) {
	var buf bytes.Buffer
	if err := sessiondSystemdTemplate.Execute(&buf, cfg); err != nil {
		return "", err
	}
	return buf.String(), nil
}
```

In `internal/service/commander.go`, add the path helper after `SystemdUnitPath`:

```go
func SessiondSystemdUnitPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "systemd", "user", "muxterm-sessiond.service")
}
```

**Step 4: Run test to verify it passes**

Run: `go test ./internal/service/ -run 'Sessiond|WebUnitDependsOnSessiond' -v`
Expected: PASS.

Run the full package to confirm the existing render/section tests still pass (the web template still has `[Unit]`/`[Service]`/`[Install]` and the serve command):
Run: `go test ./internal/service/ -v`
Expected: PASS (existing `TestRenderSystemdUnit_*` still green; install tests are updated in Task 9).

**Step 5: Commit**

```
git add internal/service/service.go internal/service/commander.go internal/service/service_test.go
git commit -m "$(cat <<'EOF'
feat(service): render sessiond systemd unit; web unit Wants/After it

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 9: `install` writes BOTH units + daemon-reload; `uninstall` removes both

`muxterm install` must write the sessiond unit **and** the web unit, reload systemd, and enable both (sessiond first, so it is up before the web unit starts). `uninstall` must remove both for a clean cycle.

**Files:**
- Modify: `internal/service/install.go` — `Install` (~line 16–38) and `installLinux` (~line 40–66)
- Modify: `internal/service/install_test.go` — existing Linux tests call `installLinux` with the old signature and must be updated
- Modify: `internal/service/uninstall.go` — `uninstallLinux` (~line 22–29) and `Uninstall` (~line 8–20)
- Modify: `internal/service/uninstall_test.go` — update expectations

**Step 1: Write the failing test**

First, **update** the three existing `installLinux(...)` call sites in `internal/service/install_test.go` to the new 4-argument signature `installLinux(cfg, webUnitPath, sessiondUnitPath, cmd)`:

- `TestInstall_Linux_WritesUnitFile` — change the call to:
  ```go
  sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
  err := installLinux(cfg, unitPath, sessiondPath, cmd)
  ```
- `TestInstall_Linux_CreatesMissingDirs` — change the call to:
  ```go
  sessiondPath := filepath.Join(tmp, "deep", "nested", "dir", "muxterm-sessiond.service")
  err := installLinux(cfg, unitPath, sessiondPath, cmd)
  ```
- `TestInstall_Linux_RunsSystemctlEnable` — replace its body's command-count and ordering assertions (the old "exactly 3 commands" no longer holds) with the new expectation below.

Replace `TestInstall_Linux_RunsSystemctlEnable` entirely with:

```go
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

	if err := installLinux(cfg, unitPath, sessiondPath, cmd); err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	// Expected sequence: daemon-reload, enable sessiond, enable web, linger.
	want := [][]string{
		{"systemctl", "--user", "daemon-reload"},
		{"systemctl", "--user", "enable", "--now", "muxterm-sessiond.service"},
		{"systemctl", "--user", "enable", "--now", "muxterm.service"},
		{"loginctl", "enable-linger"},
	}
	if len(cmd.commands) != len(want) {
		t.Fatalf("got %d commands, want %d: %+v", len(cmd.commands), len(want), cmd.commands)
	}
	for i, w := range want {
		got := append([]string{cmd.commands[i].Name}, cmd.commands[i].Args...)
		if !sliceEqual(got, w) {
			t.Errorf("command[%d] = %v, want %v", i, got, w)
		}
	}
}
```

Add a new test that both files are written:

```go
func TestInstall_Linux_WritesBothUnitFiles(t *testing.T) {
	tmp := t.TempDir()
	webPath := filepath.Join(tmp, "muxterm.service")
	sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "test-secret",
		SafePATH:   "/usr/bin",
	}
	cmd := &mockCommander{}

	if err := installLinux(cfg, webPath, sessiondPath, cmd); err != nil {
		t.Fatalf("installLinux() error: %v", err)
	}

	web, err := os.ReadFile(webPath)
	if err != nil {
		t.Fatalf("read web unit: %v", err)
	}
	if !strings.Contains(string(web), "Wants=muxterm-sessiond.service") {
		t.Error("web unit missing Wants=muxterm-sessiond.service")
	}

	sd, err := os.ReadFile(sessiondPath)
	if err != nil {
		t.Fatalf("read sessiond unit: %v", err)
	}
	if !strings.Contains(string(sd), "/usr/local/bin/muxterm sessiond") {
		t.Error("sessiond unit missing `<binary> sessiond` ExecStart")
	}
}
```

**Step 2: Run test to verify it fails**

Run: `go test ./internal/service/ -run TestInstall_Linux -v`
Expected: FAIL — compile error (`installLinux` still takes 3 args) and/or assertion failures.

**Step 3: Write minimal implementation**

In `internal/service/install.go`, update the Linux branch of `Install`:

```go
	case "linux":
		return installLinux(cfg, SystemdUnitPath(), SessiondSystemdUnitPath(), cmd)
```

Replace `installLinux` with the two-unit version:

```go
func installLinux(cfg ServiceConfig, webUnitPath, sessiondUnitPath string, cmd Commander) error {
	// Write the sessiond unit first (the web unit Wants/After it).
	sessiondContent, err := RenderSessiondSystemdUnit(cfg)
	if err != nil {
		return fmt.Errorf("render sessiond unit: %w", err)
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
	// Enable the daemon before the web unit so it is up first.
	if _, err := cmd.Run("systemctl", "--user", "enable", "--now", "muxterm-sessiond.service"); err != nil {
		return fmt.Errorf("systemctl enable sessiond: %w", err)
	}
	if _, err := cmd.Run("systemctl", "--user", "enable", "--now", "muxterm.service"); err != nil {
		return fmt.Errorf("systemctl enable: %w", err)
	}

	// Enable user lingering so the units start at boot before the user logs in.
	if _, err := cmd.Run("loginctl", "enable-linger"); err != nil {
		fmt.Printf("Warning: could not enable lingering for user service. muxterm may not survive reboots: %v\n", err)
	}

	return nil
}
```

Now update `uninstall.go`. Change `Uninstall`'s Linux branch to pass both paths:

```go
	case "linux":
		return uninstallLinux(SystemdUnitPath(), SessiondSystemdUnitPath(), cmd)
```

Replace `uninstallLinux`:

```go
func uninstallLinux(webUnitPath, sessiondUnitPath string, cmd Commander) error {
	cmd.Run("systemctl", "--user", "disable", "--now", "muxterm.service")
	cmd.Run("systemctl", "--user", "disable", "--now", "muxterm-sessiond.service")
	cmd.Run("systemctl", "--user", "daemon-reload")
	if err := os.Remove(webUnitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove web unit file: %w", err)
	}
	if err := os.Remove(sessiondUnitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove sessiond unit file: %w", err)
	}
	return nil
}
```

**Step 4: Update the uninstall test, then run all service tests**

Open `internal/service/uninstall_test.go` and update any call to `uninstallLinux(unitPath, cmd)` to the new signature `uninstallLinux(webPath, sessiondPath, cmd)` (add a `sessiondPath := filepath.Join(tmp, "muxterm-sessiond.service")` alongside the existing temp unit path). If a test asserts an exact command count for the disable sequence, bump it to match the new sequence (disable web, disable sessiond, daemon-reload = 3 `Run` calls).

Run: `go test ./internal/service/ -v`
Expected: PASS (all install/uninstall/render tests green).

**Step 5: Commit**

```
git add internal/service/install.go internal/service/install_test.go internal/service/uninstall.go internal/service/uninstall_test.go
git commit -m "$(cat <<'EOF'
feat(service): install/uninstall both web and sessiond systemd units

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 10: Final verification

Confirm the whole tree builds, vets, and tests clean.

**Step 1: Build**

Run: `go build ./...`
Expected: success (no output).

**Step 2: Vet**

Run: `go vet ./...`
Expected: no findings.

**Step 3: Full test suite**

Run: `make test`  (equivalently `go test -v ./...`)
Expected: PASS across all packages. New Phase-2 tests of note:
- `internal/sessiond`: `TestSocketPath_*`, `TestDefaultLogPath_*`, `TestIsAlive_*`, `TestSpawnCommand_StartsInNewSession`, `TestSpawn_SurvivesParentExit`, `TestEnsureDaemon_SystemdGate_NoSpawn`, `TestEnsureDaemon_AlreadyAlive_NoSpawn`
- `cmd/muxterm`: `TestParseArgs_Sessiond`, `TestServeSessiond_ListensThenShutsDown`
- `internal/service`: `TestRenderSessiondSystemdUnit_*`, `TestRenderSystemdUnit_WebUnitDependsOnSessiond`, `TestSessiondSystemdUnitPath_UsesHomeDir`, `TestInstall_Linux_WritesBothUnitFiles`, updated `TestInstall_Linux_RunsSystemctlEnable`

**Step 4: Manual end-to-end smoke (optional)**

```
go build -o /tmp/muxterm ./cmd/muxterm
/tmp/muxterm sessiond &                       # role 1: daemon
sleep 1
ls -l "${XDG_RUNTIME_DIR:-/tmp/muxterm-$(id -u)}/muxterm/"   # expect sessiond.sock
kill %1; wait 2>/dev/null
```
Expected: `sessiond.sock` present while the daemon runs; clean exit on kill.

**Step 5: Commit (only if any cleanup/formatting changes were needed)**

```
git add -A
git commit -m "$(cat <<'EOF'
chore(phase2): final build/vet/test verification for binary lifecycle

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

## Definition of done (Phase 2)

- [ ] Helpers match the **frozen contract** signatures exactly: `SocketPath() (string, error)`, `DefaultLogPath() (string, error)`, `EnsureDaemon(socketPath, logPath string) error`. The daemon is constructed/run via the frozen `NewServer(socketPath) (*Server, error)` + `ListenAndServe(ctx) error` (nil on cancel) — there is no `Listen()`/`Serve()`/`Close()` shape.
- [ ] `muxterm sessiond` runs the Phase-1 daemon on `$XDG_RUNTIME_DIR/muxterm/sessiond.sock` (with documented fallback) and shuts down **gracefully (returns nil)** on SIGINT/SIGTERM — proven by `TestServeSessiond_ListensThenShutsDown` asserting nil-on-cancel.
- [ ] `serve` best-effort auto-spawns a **detached** daemon (new session via `Setsid`, stdio → logfile) that survives the parent's exit — proven by `TestSpawn_SurvivesParentExit`.
- [ ] `EnsureDaemon` is **gated OFF under systemd** (no-op when `INVOCATION_ID` is set), preventing the double-spawn/cgroup race — proven by `TestEnsureDaemon_SystemdGate_NoSpawn`.
- [ ] `IsAlive` correctly distinguishes live / missing / stale sockets; `EnsureDaemon` is a no-op when the daemon is already up.
- [ ] `muxterm install` writes **both** `muxterm-sessiond.service` and `muxterm.service`, the web unit declares `Wants=`/`After=` the daemon, both are enabled (sessiond first), and `uninstall` removes both.
- [ ] launchd parity is explicitly deferred with documented rationale (auto-spawn covers macOS; no cgroup-kill problem).
- [ ] No new module dependency added (stdlib `syscall.SysProcAttr{Setsid:true}` is the mechanism; rationale documented).
- [ ] `go build ./...`, `go vet ./...`, and `make test` all pass.

## Out-of-scope reminders (do NOT do these in Phase 2)

- Do **not** modify `internal/sessiond/server.go` or any Phase-1 daemon internals (only `spawn.go`/`spawn_test.go` are new in this package).
- Do **not** repoint `serve`'s terminal data source from tmux onto the sessiond client — that is Phase 3. `serve`'s existing tmux behavior must remain intact; the only addition to `runServe` is the best-effort `EnsureDaemon` call.
- Do **not** touch web (`web/src/`) or any buffer implementation.
