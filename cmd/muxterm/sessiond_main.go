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

// runSessiond is the Phase-1 daemon entrypoint. It resolves the daemon's Unix
// socket path, installs SIGINT/SIGTERM handling, and serves until signalled.
func runSessiond(_ Config) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	return serveSessiond(ctx, socketPath)
}

// serveSessiond is the testable core of the daemon entrypoint. It ensures the
// socket's parent directory exists, constructs the frozen Phase-1 server,
// attempts a tmux-continuum-style boot-time restore from the last snapshot
// (a no-op when disabled or when no usable snapshot exists -- ListenAndServe's
// own EnsureDefault call falls back to today's cold-start blank workspace in
// that case, unchanged), starts the periodic snapshot writer, and runs the
// server until ctx is cancelled. Binding and stale-socket cleanup are owned by
// the daemon (NewServer/ListenAndServe) per the frozen contract; this returns
// nil on a graceful (ctx-driven) shutdown, after a best-effort final snapshot
// flush.
func serveSessiond(ctx context.Context, socketPath string) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}

	srv, err := sessiond.NewServer(socketPath)
	if err != nil {
		return fmt.Errorf("create sessiond server: %w", err)
	}

	cfg, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults
	snapshotPath := sessiond.DefaultSnapshotPath()

	if n := srv.RestoreFromSnapshot(cfg.Restore.Enabled, snapshotPath); n > 0 {
		log.Printf("sessiond: restored %d workspace(s) from %s", n, snapshotPath)
	}
	if cfg.Restore.Enabled {
		sessiond.StartSnapshotWriter(ctx, srv.Registry(), cfg.Restore.SnapshotInterval, snapshotPath)
	}

	log.Printf("muxterm sessiond listening on %s", socketPath)
	serveErr := srv.ListenAndServe(ctx)

	if cfg.Restore.Enabled {
		// Best-effort only: a kill -9/OOM gets no shutdown flush and relies
		// on the periodic write instead -- the same tradeoff tmux-continuum
		// makes.
		snap := sessiond.BuildSnapshot(srv.Registry(), "shutdown")
		if err := sessiond.WriteSnapshot(snapshotPath, snap); err != nil {
			log.Printf("sessiond: shutdown snapshot flush failed: %v", err)
		}
	}

	return serveErr
}
