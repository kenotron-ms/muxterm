package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// runSessiond is the Phase-1 daemon entrypoint. It resolves the daemon's Unix
// socket path, installs SIGINT/SIGTERM handling, and serves until signalled.
// If the --handoff flag is present in os.Args, it runs in handoff-receive mode
// to take over a live-upgrade state transfer from an older binary.
func runSessiond(_ Config) error {
	for _, arg := range os.Args {
		if arg == "--handoff" {
			return runSessiondHandoff()
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}
	return serveSessiond(ctx, socketPath)
}

// serveSessiond is the testable core of the daemon entrypoint. It ensures the
// socket's parent directory exists, constructs the frozen Phase-1 server, and
// runs it until ctx is cancelled. On startup it attempts crash recovery from a
// snapshot file before accepting connections. Binding and stale-socket cleanup
// are owned by the daemon (NewServer/ListenAndServe) per the frozen contract;
// this returns nil on a graceful (ctx-driven) shutdown.
func serveSessiond(ctx context.Context, socketPath string) error {
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}

	snapshotPath := sessiond.DefaultSnapshotPath()

	// Load user config for restore strategies.
	cfg, _ := config.Load(config.DefaultPath())

	// Attempt crash recovery. If a valid snapshot exists, re-spawn all saved
	// panes so the user's workspaces survive a daemon crash or system reboot.
	var srv *sessiond.Server
	if snap, ok, err := sessiond.LoadCrashSnapshot(snapshotPath); err != nil {
		log.Printf("muxterm sessiond: crash snapshot error (%v); starting fresh", err)
	} else if ok && len(snap.Workspaces) > 0 {
		log.Printf("muxterm sessiond: restoring %d workspace(s) from crash snapshot", len(snap.Workspaces))
		restored, restoreErr := sessiond.RestoreFromCrashSnapshot(snap, socketPath)
		if restoreErr != nil {
			log.Printf("muxterm sessiond: crash restore failed (%v); starting fresh", restoreErr)
		} else {
			srv = restored
		}
	}

	if srv == nil {
		var err error
		srv, err = sessiond.NewServer(socketPath)
		if err != nil {
			return fmt.Errorf("create sessiond server: %w", err)
		}
	}
	srv.SnapshotPath = snapshotPath
	srv.RestoreStrategies = cfg.Restore.Strategies

	log.Printf("muxterm sessiond listening on %s", socketPath)
	return srv.ListenAndServe(ctx)
}

// runSessiondHandoff runs the new sessiond in handoff-receive mode. It:
//  1. Creates a temp Unix socket (sessiond-new.sock) for receiving state.
//  2. Dials the OLD canonical socket and sends a TypeHandoff message so the
//     old sessiond knows where to send its state and PTY FDs.
//  3. Accepts one connection on the temp socket and calls ReceiveHandoffConn.
//  4. Starts serving on the canonical socket path (ListenAndServe removes the
//     old socket file and creates a fresh one automatically).
func runSessiondHandoff() error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	socketPath, err := sessiond.SocketPath()
	if err != nil {
		return fmt.Errorf("resolve sessiond socket path: %w", err)
	}

	socketDir := filepath.Dir(socketPath)
	if err := os.MkdirAll(socketDir, 0o700); err != nil {
		return fmt.Errorf("create socket dir: %w", err)
	}

	handoffSocket := filepath.Join(socketDir, "sessiond-new.sock")
	os.Remove(handoffSocket) // clear any stale socket from a previous interrupted handoff

	// Step 1: Create the temp handoff listener BEFORE signalling the old sessiond.
	// This ensures the old sessiond can connect immediately upon receiving TypeHandoff.
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: handoffSocket, Net: "unix"})
	if err != nil {
		return fmt.Errorf("listen handoff socket: %w", err)
	}
	defer os.Remove(handoffSocket) //nolint:errcheck
	defer ln.Close()               //nolint:errcheck

	// Step 2: Dial the OLD canonical socket and send TypeHandoff.
	go func() {
		// Brief delay to make sure the listener above is ready to accept.
		time.Sleep(20 * time.Millisecond)
		conn, dialErr := net.Dial("unix", socketPath)
		if dialErr != nil {
			log.Printf("sessiond handoff: dial old sessiond: %v", dialErr)
			return
		}
		writeErr := sessiond.WriteControl(conn, &sessiond.Message{
			Type:          sessiond.TypeHandoff,
			HandoffSocket: handoffSocket,
		})
		conn.Close()
		if writeErr != nil {
			log.Printf("sessiond handoff: send TypeHandoff: %v", writeErr)
		}
	}()

	// Step 3: Accept the connection from the old sessiond (30s timeout).
	if err := ln.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		return fmt.Errorf("set deadline: %w", err)
	}
	uc, err := ln.AcceptUnix()
	if err != nil {
		return fmt.Errorf("accept handoff connection: %w", err)
	}
	defer uc.Close() //nolint:errcheck

	// Step 4: Receive state + PTY FDs and reconstruct a new Server.
	srv, err := sessiond.ReceiveHandoffConn(uc, socketPath)
	if err != nil {
		return fmt.Errorf("receive handoff: %w", err)
	}

	// Clean up: close the handoff socket so ListenAndServe can bind the canonical one.
	ln.Close()
	os.Remove(handoffSocket) //nolint:errcheck

	log.Printf("muxterm sessiond (handoff) listening on %s", socketPath)
	return srv.ListenAndServe(ctx)
}
