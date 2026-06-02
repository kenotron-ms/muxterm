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
