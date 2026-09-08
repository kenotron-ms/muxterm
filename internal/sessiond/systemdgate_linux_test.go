//go:build linux

package sessiond

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// TestEnsureDaemon_InheritedInvocationIDDoesNotGate pins the CORRECTED systemd
// gate: an INVOCATION_ID that was merely INHERITED must not suppress the spawn.
//
// This replaces a test that asserted the opposite. The old contract -- "the
// variable is set, therefore systemd supervises my daemon" -- is false for
// every descendant of a unit, because exec propagates the variable
// indefinitely. On a machine running muxterm as a user unit that includes every
// shell in every pane and every command run inside one, so the gate fired for
// exactly the processes that most needed to spawn their own daemon: a dev
// instance with its own isolated runtime directory came up with a serve and no
// sessiond at all.
//
// A `go test` process has INVOCATION_ID unset and a non-systemd parent, so
// setting the variable here reproduces the inherited case precisely.
func TestEnsureDaemon_InheritedInvocationIDDoesNotGate(t *testing.T) {
	t.Setenv("INVOCATION_ID", "deadbeef")
	dir := t.TempDir()
	// acquireSpawnLock resolves its lock file from socketDir(), i.e. from
	// XDG_RUNTIME_DIR -- NOT from the socketPath argument. Without this the
	// test creates sessiond.spawn.lock in the developer's REAL runtime
	// directory, alongside the production daemon's socket. That is the same
	// class of dev-touches-production leak this change exists to close, and
	// it is not acceptable in the test suite either.
	t.Setenv("XDG_RUNTIME_DIR", dir)
	socketPath := filepath.Join(dir, "missing.sock")
	logPath := filepath.Join(dir, "sessiond.log")

	// The spawn is attempted and then fails to come up, because what gets
	// spawned here is the test binary with a "sessiond" argument it does not
	// understand. The failure is not what is under test -- the ATTEMPT is.
	if err := EnsureDaemon(socketPath, logPath); err == nil {
		t.Fatal("EnsureDaemon returned nil: the inherited INVOCATION_ID gated the spawn")
	}
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("log file %q should exist (a spawn was attempted), stat err = %v", logPath, err)
	}
}

// TestStartedBySystemd_RequiresSystemdParent pins the discriminator itself:
// the variable alone is not enough, the parent must be a systemd manager too.
func TestStartedBySystemd_RequiresSystemdParent(t *testing.T) {
	t.Setenv("INVOCATION_ID", "")
	if startedBySystemd() {
		t.Fatal("startedBySystemd() true with no INVOCATION_ID")
	}
	t.Setenv("INVOCATION_ID", "deadbeef")
	if startedBySystemd() {
		t.Fatalf("startedBySystemd() true for a process whose parent is %q, not systemd", parentCommForTest())
	}
}

// parentCommForTest reports the test process's parent command name, for the
// failure message above.
func parentCommForTest() string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", os.Getppid()))
	if err != nil {
		return "unknown"
	}
	return string(b)
}
