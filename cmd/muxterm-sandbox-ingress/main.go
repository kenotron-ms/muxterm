// muxterm-sandbox-ingress is the fixed sessiond runtime adapter for a sealed
// sandbox image. It has no Azure lifecycle code and accepts no cloud/browser
// credentials.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sandboxingress"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const (
	runtimeSocket = "/run/muxterm/sessiond.sock"
	runtimeListen = ":8443"
)

func main() {
	if err := run(); err != nil {
		// Runtime inputs and terminal data remain private: do not print them.
		fmt.Fprintln(os.Stderr, "muxterm sandbox ingress: unavailable")
		os.Exit(1)
	}
}

func run() error {
	// sessiond's pane children inherit this process environment. Reject
	// credential-shaped inherited names before reading the four sealed runtime
	// bindings, and never report names or values on failure.
	if err := sandboxingress.RejectInheritedCredentialEnvironment(os.Environ()); err != nil {
		return err
	}
	cfg, err := sandboxingress.ParseRuntimeConfig(
		os.Getenv("MUXTERM_SANDBOX_PROTOCOL"),
		os.Getenv("MUXTERM_SANDBOX_PROFILE_CHECKSUM"),
		os.Getenv("MUXTERM_SANDBOX_GENERATION"),
		os.Getenv("MUXTERM_SANDBOX_INGRESS_VERIFY_KEY"),
		runtimeSocket,
	)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	if err := os.MkdirAll(filepath.Dir(runtimeSocket), 0o700); err != nil {
		return err
	}
	daemon, err := sessiond.NewServer(runtimeSocket)
	if err != nil {
		return err
	}
	daemonDone := make(chan error, 1)
	go func() { daemonDone <- daemon.ListenAndServe(ctx) }()
	if err := waitForSocket(ctx, runtimeSocket); err != nil {
		cancel()
		<-daemonDone
		return err
	}
	defer func() { cancel(); <-daemonDone }()

	adapter, err := sandboxingress.New(cfg)
	if err != nil {
		return err
	}
	httpServer := &http.Server{
		Addr: runtimeListen, Handler: sandboxingress.RuntimeHandler(adapter, func() bool {
			return sessiond.IsAlive(runtimeSocket)
		}), ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout: 30 * time.Second, MaxHeaderBytes: 4 << 10,
	}
	listener, err := net.Listen("tcp", runtimeListen)
	if err != nil {
		return err
	}
	defer listener.Close() //nolint:errcheck
	serverDone := make(chan error, 1)
	go func() { serverDone <- httpServer.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_ = httpServer.Shutdown(shutdownCtx)
		<-serverDone
		return nil
	case err := <-serverDone:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func waitForSocket(ctx context.Context, socket string) error {
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if sessiond.IsAlive(socket) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("sessiond socket unavailable")
		case <-ticker.C:
		}
	}
}
