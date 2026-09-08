//go:build unix

package sessiond

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// These pin the four outcomes of the bind-time ownership probe. The behaviour
// under test is a decision about whether a file may be DELETED, so each case
// also asserts what happened to the file -- getting the classification right
// and the consequence wrong would be no better than the bug this replaces.

func TestProbeSocket_NothingThere(t *testing.T) {
	path := filepath.Join(t.TempDir(), "absent.sock")
	state, err := ProbeSocket(path)
	if err != nil {
		t.Fatalf("ProbeSocket returned error: %v", err)
	}
	if state != SocketFree {
		t.Fatalf("state = %v, want SocketFree", state)
	}
	if err := ClaimSocket(path); err != nil {
		t.Fatalf("ClaimSocket on a free path: %v", err)
	}
}

func TestProbeSocket_LiveListenerIsOwned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "live.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close() //nolint:errcheck

	state, err := ProbeSocket(path)
	if err != nil {
		t.Fatalf("ProbeSocket returned error: %v", err)
	}
	if state != SocketOwned {
		t.Fatalf("state = %v, want SocketOwned", state)
	}

	claimErr := ClaimSocket(path)
	if !errors.Is(claimErr, ErrSocketOwned) {
		t.Fatalf("ClaimSocket error = %v, want ErrSocketOwned", claimErr)
	}
	// The whole point: the live daemon's name must SURVIVE the refusal.
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("ClaimSocket removed a live listener's socket: %v", err)
	}
	// And it must still be reachable.
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("live listener became unreachable after a refused claim: %v", err)
	}
	c.Close() //nolint:errcheck
}

func TestProbeSocket_StaleFileIsRemovable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "stale.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	// Close the listener but put the NAME back, which is exactly the residue a
	// daemon killed with SIGKILL leaves behind.
	if err := ln.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	ln2, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("relisten: %v", err)
	}
	f, err := ln2.(*net.UnixListener).File()
	if err != nil {
		t.Fatalf("dup listener fd: %v", err)
	}
	ln2.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = ln2.Close()
	_ = f.Close()

	state, err := ProbeSocket(path)
	if err != nil {
		t.Fatalf("ProbeSocket returned error: %v", err)
	}
	if state != SocketStale {
		t.Fatalf("state = %v, want SocketStale", state)
	}
	if err := ClaimSocket(path); err != nil {
		t.Fatalf("ClaimSocket on a stale socket: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("ClaimSocket left the stale socket in place, stat err = %v", err)
	}
	// A normal restart must still work afterwards.
	ln3, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("could not bind after claiming a stale socket: %v", err)
	}
	ln3.Close() //nolint:errcheck
}

func TestProbeSocket_NonSocketFileIsRefusedNotDeleted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notasocket")
	if err := os.WriteFile(path, []byte("important"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	state, err := ProbeSocket(path)
	if state != SocketBlocked {
		t.Fatalf("state = %v, want SocketBlocked (err = %v)", state, err)
	}
	if err := ClaimSocket(path); err == nil {
		t.Fatal("ClaimSocket accepted a non-socket path")
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil || string(data) != "important" {
		t.Fatalf("ClaimSocket damaged a non-socket file: data=%q err=%v", data, readErr)
	}
}

// TestListenAndServe_RefusesWhenSocketOwned is the regression test for the
// actual incident: a second daemon must not be able to take a live daemon's
// name, and the live daemon must be reachable after the attempt.
func TestListenAndServe_RefusesWhenSocketOwned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "owned.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close() //nolint:errcheck

	srv, err := NewServer(path)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	err = srv.ListenAndServe(t.Context())
	if !errors.Is(err, ErrSocketOwned) {
		t.Fatalf("ListenAndServe error = %v, want ErrSocketOwned", err)
	}
	c, dialErr := net.Dial("unix", path)
	if dialErr != nil {
		t.Fatalf("incumbent listener was stranded by the refused start: %v", dialErr)
	}
	c.Close() //nolint:errcheck
}
