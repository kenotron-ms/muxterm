package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/workspaceauth"
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

	snapshotPath := sessiond.DefaultSnapshotPath()
	owner, err := sessiondOwnerForSnapshot(snapshotPath)
	if err != nil {
		return errors.New("sessiond: owner security state unavailable")
	}
	srv, err := sessiond.NewServerWithOwner(socketPath, owner)
	if err != nil {
		return fmt.Errorf("create sessiond server: %w", err)
	}

	cfg, _ := config.Load(config.DefaultPath()) // never errors; malformed -> defaults
	restore := srv.RestoreFromSnapshotResult(cfg.Restore.Enabled, snapshotPath)
	if n := restore.Restored; n > 0 {
		log.Printf("sessiond: restored %d workspace(s) from %s", n, snapshotPath)
	}
	if cfg.Restore.Enabled {
		sessiond.StartSnapshotWriterWithGuard(ctx, srv.Registry(), cfg.Restore.SnapshotInterval, snapshotPath, func() bool {
			return restore.SafeToWrite
		})
	}

	log.Printf("muxterm sessiond listening on %s", socketPath)
	serveErr := srv.ListenAndServe(ctx)

	if cfg.Restore.Enabled && restore.SafeToWrite {
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

// sessiondOwnerForSnapshot never replaces a missing owner record when a
// current, structurally valid snapshot already binds workspaces to one. It
// avoids inferring ownership from runtime IDs, names, or process identity.
func sessiondOwnerForSnapshot(snapshotPath string) (workspaceauth.InstanceOwner, error) {
	ownerPath := workspaceauth.DefaultOwnerPath()
	owner, err := workspaceauth.LoadOwner(ownerPath)
	if err == nil {
		return owner, nil
	}
	if !os.IsNotExist(err) {
		return workspaceauth.InstanceOwner{}, errors.New("owner record unavailable")
	}
	requiresOwner, snapshotErr := sessiond.SnapshotRequiresOwner(snapshotPath)
	if snapshotErr == nil && requiresOwner {
		return workspaceauth.InstanceOwner{}, errors.New("owner record unavailable")
	}
	return workspaceauth.LoadOrCreateOwner(ownerPath)
}
