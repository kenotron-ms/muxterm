//go:build linux

package sessiond

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// TestFindStrandedListener_DetectsUnlinkedLiveSocket builds the real condition
// in-process -- bind a listener, then unlink its name while keeping it open --
// and asserts it is recognised. That is precisely the state a daemon is left
// in when another one binds over it and exits.
func TestFindStrandedListener_DetectsUnlinkedLiveSocket(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stranded.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	// Keep the listener open but take its name away, exactly as a second
	// daemon's os.Remove + its own listener close would.
	ln.(*net.UnixListener).SetUnlinkOnClose(false)
	defer ln.Close() //nolint:errcheck
	if err := os.Remove(path); err != nil {
		t.Fatalf("unlink: %v", err)
	}

	info, ok := FindStrandedListener(path)
	if !ok {
		t.Fatal("FindStrandedListener did not detect a live listener with no name")
	}
	if info.Path != path {
		t.Errorf("Path = %q, want %q", info.Path, path)
	}
	if info.Inode == 0 {
		t.Error("Inode = 0, want the kernel socket inode")
	}
	if info.PID != os.Getpid() {
		t.Errorf("PID = %d, want this process (%d)", info.PID, os.Getpid())
	}

	// The hint has to carry the two things a human cannot get anywhere else:
	// the exact recovery command, and what it destroys.
	hint := info.RecoveryHint()
	for _, want := range []string{
		"UNREACHABLE",
		"kill " + strconv.Itoa(os.Getpid()),
		"WHAT THIS COSTS",
	} {
		if !strings.Contains(hint, want) {
			t.Errorf("RecoveryHint() missing %q:\n%s", want, hint)
		}
	}
}

// TestFindStrandedListener_QuietWhenNameExists guards the false positive that
// would matter most: a perfectly healthy daemon must never be reported as
// stranded.
func TestFindStrandedListener_QuietWhenNameExists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "healthy.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close() //nolint:errcheck

	if info, ok := FindStrandedListener(path); ok {
		t.Fatalf("healthy listener reported as stranded: %+v", info)
	}
}

// TestFindStrandedListener_QuietWhenNothingRuns covers the ordinary
// "daemon not started" case, which shares the missing-file symptom but needs
// the opposite advice.
func TestFindStrandedListener_QuietWhenNothingRuns(t *testing.T) {
	path := filepath.Join(t.TempDir(), "never-existed.sock")
	if info, ok := FindStrandedListener(path); ok {
		t.Fatalf("absent daemon reported as stranded: %+v", info)
	}
}
