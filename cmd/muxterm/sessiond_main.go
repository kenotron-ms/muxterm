package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// runSessiond is the Phase-1 daemon entrypoint. It resolves the daemon's Unix
// socket path, installs SIGINT/SIGTERM handling, and serves until signalled.
func runSessiond(_ Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	stateRoot, err := sessiond.RecoveryStateRoot()
	if err != nil {
		return fmt.Errorf("resolve sessiond recovery state: %w", err)
	}
	return serveRecoverySessiond(ctx, socketPath, stateRoot)
}

// serveSessiond is the testable core of the daemon entrypoint. It ensures the
// socket's parent directory exists, constructs the frozen Phase-1 server, and
// runs it until ctx is cancelled. Binding and stale-socket cleanup are owned by
// the daemon (NewServer/ListenAndServe) per the frozen contract; this returns
// nil on a graceful (ctx-driven) shutdown.
func serveSessiond(ctx context.Context, socketPath string) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}

	srv, err := sessiond.NewServer(socketPath)
	if err != nil {
		return fmt.Errorf("create sessiond server: %w", err)
	}

	log.Printf("muxterm sessiond listening on %s", socketPath)
	return srv.ListenAndServe(ctx)
}

// serveRecoverySessiond is the production daemon path. NewRecoveryServer opens,
// loads, validates, and reconstructs the durable state before ListenAndServe can
// bind the ordinary socket; the memory-only helper above remains available to
// existing fixtures.
func serveRecoverySessiond(ctx context.Context, socketPath, stateRoot string) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}

	srv, err := sessiond.NewRecoveryServer(socketPath, stateRoot)
	if err != nil {
		return fmt.Errorf("create recovery sessiond server: %w", err)
	}

	log.Printf("muxterm recovery sessiond listening on %s", socketPath)
	return srv.ListenAndServe(ctx)
}
