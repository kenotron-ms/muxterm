package main

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// TestServeSessiond_ListensThenShutsDown verifies the testable core of the
// daemon entrypoint: serveSessiond binds the Unix socket, serves until its
// context is cancelled, and returns nil on graceful shutdown (the nil-on-cancel
// guarantee is load-bearing per the frozen Phase-1 contract).
func TestServeSessiond_ListensThenShutsDown(t *testing.T) {
	socketPath := filepath.Join(t.TempDir(), "sub", "sessiond.sock")

	ctx, cancel := context.WithCancel(context.Background())

	errCh := make(chan error, 1)
	go func() {
		errCh <- serveSessiond(ctx, socketPath)
	}()

	// Wait up to 3s for the daemon to start accepting connections.
	if !waitFor(3*time.Second, func() bool { return sessiond.IsAlive(socketPath) }) {
		cancel()
		t.Fatalf("daemon never became alive on %s", socketPath)
	}

	cancel()

	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("serveSessiond returned non-nil error on graceful cancel: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("serveSessiond did not return within 3s after cancel")
	}
}

// waitFor polls cond until it is true or the timeout elapses.
func waitFor(timeout time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}
