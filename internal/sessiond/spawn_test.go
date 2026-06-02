//go:build unix

package sessiond

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestSocketPath_UsesXDGRuntimeDir(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1234")
	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath returned error: %v", err)
	}
	want := "/run/user/1234/muxterm/sessiond.sock"
	if got != want {
		t.Fatalf("SocketPath = %q, want %q", got, want)
	}
}

func TestSocketPath_FallbackWhenXDGUnset(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "")
	got, err := SocketPath()
	if err != nil {
		t.Fatalf("SocketPath returned error: %v", err)
	}
	want := filepath.Join(os.TempDir(), fmt.Sprintf("muxterm-%d", os.Getuid()), "sessiond.sock")
	if got != want {
		t.Fatalf("SocketPath = %q, want %q", got, want)
	}
}

func TestIsAlive_NoSocketFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.sock")
	if IsAlive(path) {
		t.Fatalf("IsAlive(%q) = true, want false for non-existent path", path)
	}
}

func TestIsAlive_StaleSocketFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stale.sock")
	if err := os.WriteFile(path, []byte("not a socket"), 0o600); err != nil {
		t.Fatalf("writing stale file: %v", err)
	}
	if IsAlive(path) {
		t.Fatalf("IsAlive(%q) = true, want false for non-socket file", path)
	}
}

func TestIsAlive_LiveListener(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	defer ln.Close()
	if !IsAlive(path) {
		t.Fatalf("IsAlive(%q) = false, want true for live listener", path)
	}
}

func TestSpawnCommand_StartsInNewSession(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "logs", "spawn.log")
	proc, err := SpawnCommand("sleep", []string{"30"}, logPath)
	if err != nil {
		t.Fatalf("SpawnCommand returned error: %v", err)
	}
	defer func() {
		_ = proc.Kill()
		_, _ = proc.Wait()
	}()

	childPgid, err := syscall.Getpgid(proc.Pid)
	if err != nil {
		t.Fatalf("Getpgid(child=%d): %v", proc.Pid, err)
	}
	if childPgid != proc.Pid {
		t.Fatalf("child pgid = %d, want %d (its own pid, i.e. new session leader)", childPgid, proc.Pid)
	}

	ourPgid, err := syscall.Getpgid(os.Getpid())
	if err != nil {
		t.Fatalf("Getpgid(self=%d): %v", os.Getpid(), err)
	}
	if childPgid == ourPgid {
		t.Fatalf("child pgid == our pgid (%d); child did not detach into a new session", ourPgid)
	}
}

// TestSpawn_SurvivesParentExit verifies that a process launched via SpawnCommand
// outlives the process that launched it. The test re-execs its own binary as an
// intermediate launcher (MUXTERM_SPAWN_HELPER=1); that launcher spawns a detached
// grandchild which sleeps 1s and then touches the marker file before exiting. The
// launcher itself exits immediately, so the marker only appears if the grandchild
// reparented to init and survived.
func TestSpawn_SurvivesParentExit(t *testing.T) {
	if os.Getenv("MUXTERM_SPAWN_HELPER") == "1" {
		// Running as the intermediate launcher.
		marker := os.Getenv("MUXTERM_SPAWN_MARKER")
		logPath := os.Getenv("MUXTERM_SPAWN_LOG")
		_, err := SpawnCommand("sh", []string{"-c", fmt.Sprintf("sleep 1; touch %q", marker)}, logPath)
		if err != nil {
			os.Exit(2)
		}
		// Exit immediately, orphaning the grandchild.
		os.Exit(0)
	}

	dir := t.TempDir()
	marker := filepath.Join(dir, "marker")
	logPath := filepath.Join(dir, "logs", "helper.log")

	cmd := exec.Command(os.Args[0], "-test.run", "TestSpawn_SurvivesParentExit")
	cmd.Env = append(os.Environ(),
		"MUXTERM_SPAWN_HELPER=1",
		"MUXTERM_SPAWN_MARKER="+marker,
		"MUXTERM_SPAWN_LOG="+logPath,
	)
	if err := cmd.Run(); err != nil {
		t.Fatalf("launcher process failed: %v", err)
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(marker); err == nil {
			return // grandchild survived and touched the marker
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("marker %q never appeared; grandchild did not survive parent exit", marker)
}

func TestDefaultLogPath_SitsBesideSocket(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", "/run/user/1234")
	got, err := DefaultLogPath()
	if err != nil {
		t.Fatalf("DefaultLogPath returned error: %v", err)
	}
	want := "/run/user/1234/muxterm/sessiond.log"
	if got != want {
		t.Fatalf("DefaultLogPath = %q, want %q", got, want)
	}
}
