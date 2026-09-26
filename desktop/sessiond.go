//go:build desktop

package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// runSessiond makes this binary answer `muxterm-desktop sessiond`.
//
// This is NOT optional plumbing. sessiond.Spawn re-execs os.Executable() with
// the single argument "sessiond" (internal/sessiond/spawn.go), so whatever
// binary calls EnsureDaemon must be able to BE the daemon. Without this, a
// desktop launch on a machine with no daemon running would re-exec the desktop
// app and open a second window instead of starting sessiond.
//
// It mirrors cmd/muxterm's serveSessiond using the same exported sessiond and
// config APIs. It is not a second implementation of the daemon: the daemon is
// internal/sessiond, and both entrypoints are the same dozen calls in the same
// order, so a desktop-spawned daemon is indistinguishable from a CLI-spawned
// one -- same socket, same snapshot file, same protocol.
func runSessiond() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}

	srv, err := sessiond.NewServer(socketPath)
	if err != nil {
		return fmt.Errorf("create sessiond server: %w", err)
	}

	cfg, _ := config.Load(config.DefaultPath()) // malformed -> defaults
	snapshotPath := sessiond.DefaultSnapshotPath()

	writerCtx, stopWriter := context.WithCancel(ctx)
	defer stopWriter()

	var snapshotWriterDone <-chan struct{}
	if n := srv.RestoreFromSnapshot(cfg.Restore.Enabled, snapshotPath); n > 0 {
		log.Printf("sessiond: restored %d workspace(s) from %s", n, snapshotPath)
	}
	if cfg.Restore.Enabled {
		snapshotWriterDone = sessiond.StartSnapshotWriter(
			writerCtx, srv.Registry(), cfg.Restore.SnapshotInterval, snapshotPath)
	}

	log.Printf("sessiond listening on %s", socketPath)
	serveErr := srv.ListenAndServe(ctx)
	stopWriter()

	if cfg.Restore.Enabled {
		<-snapshotWriterDone
		snap := sessiond.BuildSnapshot(srv.Registry(), "shutdown")
		if err := sessiond.WriteSnapshot(snapshotPath, snap); err != nil {
			log.Printf("sessiond: shutdown snapshot flush failed: %v", err)
		}
	}
	return serveErr
}
