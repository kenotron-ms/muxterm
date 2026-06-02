//go:build unix

package sessiond

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
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
