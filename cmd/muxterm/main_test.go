package main

import (
	"bytes"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/user/muxterm/internal/server"
)

// captureStdout runs fn and returns whatever it printed to os.Stdout.
func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stdout = w

	fn()

	w.Close()
	os.Stdout = old
	var buf bytes.Buffer
	io.Copy(&buf, r)
	return buf.String()
}

func TestNewSessiondDialerDials(t *testing.T) {
	// A trivial accept loop standing in for the daemon: accept one connection,
	// keep it briefly, then close. newSessiondDialerForSocket should dial it.
	sock := filepath.Join(t.TempDir(), "sessiond.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
		conn.Close()
	}()

	dial := newSessiondDialerForSocket(sock)
	conn, err := dial()
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if conn == nil {
		t.Fatal("expected non-nil DaemonConn")
	}
	conn.Close()
}

func TestMustSubFS_Signature(t *testing.T) {
	// Verify mustSubFS is callable with the expected signature (compilation test).
	var fn func(fs.FS, string) fs.FS = mustSubFS
	_ = fn
}

func TestRunDeploy_ErrorsOnInvalidTarget(t *testing.T) {
	// runDeploy with an empty target should fail (SCP has no valid destination).
	err := runDeploy(Config{Mode: "deploy"})
	if err == nil {
		t.Fatal("expected error from runDeploy with empty target, got nil")
	}
}

func TestVersionVar(t *testing.T) {
	if version != "dev" {
		t.Errorf("version = %q, want %q", version, "dev")
	}
}

func TestOpenBrowser_Signature(t *testing.T) {
	// Compile-time check that openBrowser accepts a string.
	var fn func(string) = openBrowser
	_ = fn
}

func TestRunWithGracefulShutdown_Signature(t *testing.T) {
	// Compile-time check that runWithGracefulShutdown has the expected signature.
	var fn func(*server.Server) error = runWithGracefulShutdown
	_ = fn
}

func TestRunInstall_Signature(t *testing.T) {
	// Compile-time check that runInstall has the expected signature.
	var fn func(Config) error = runInstall
	_ = fn
}

func TestRunUninstall_Signature(t *testing.T) {
	// Compile-time check that runUninstall has the expected signature.
	var fn func() error = runUninstall
	_ = fn
}

func TestRunInstall_PrintsAddrOnSuccess(t *testing.T) {
	// When service.Install succeeds, runInstall should print the addr.
	cfg := Config{Mode: "install", Addr: "localhost:9090", Secret: "provided-secret"}
	out := captureStdout(t, func() {
		err := runInstall(cfg)
		if err != nil {
			t.Skipf("service.Install not available in this environment: %v", err)
		}
	})
	if !strings.Contains(out, "http://localhost:9090") {
		t.Errorf("expected addr in output, got %q", out)
	}
	// Clean up installed service
	runUninstall()
}

func TestRunInstall_NoAutoSecretPrintedWhenProvided(t *testing.T) {
	// When cfg.Secret is provided, runInstall should NOT print auto-generated secret.
	cfg := Config{Mode: "install", Addr: "localhost:9090", Secret: "provided-secret"}
	out := captureStdout(t, func() {
		err := runInstall(cfg)
		if err != nil {
			t.Skipf("service.Install not available in this environment: %v", err)
		}
	})
	if strings.Contains(out, "auto-generated secret") {
		t.Errorf("should not print auto-generated secret when one is provided, got %q", out)
	}
	// Clean up installed service
	runUninstall()
}

func TestRunInstall_AutoGeneratesSecretAndPrints(t *testing.T) {
	// When cfg.Secret is empty, runInstall should auto-generate and print it.
	cfg := Config{Mode: "install", Addr: "localhost:9090", Secret: ""}
	out := captureStdout(t, func() {
		err := runInstall(cfg)
		if err != nil {
			t.Skipf("service.Install not available in this environment: %v", err)
		}
	})
	if !strings.Contains(out, "auto-generated secret:") {
		t.Errorf("expected auto-generated secret in output, got %q", out)
	}
	if !strings.Contains(out, "http://localhost:9090") {
		t.Errorf("expected addr in output, got %q", out)
	}
	// Clean up installed service
	runUninstall()
}

func TestTmuxCutoverWarningText(t *testing.T) {
	got := tmuxCutoverWarning()
	for _, want := range []string{"tmux", "not", "migrat"} {
		if !strings.Contains(strings.ToLower(got), want) {
			t.Errorf("tmuxCutoverWarning() = %q, want it to contain %q", got, want)
		}
	}
}

func TestRunUninstall_PrintsConfirmation(t *testing.T) {
	// runUninstall should print confirmation message on success.
	out := captureStdout(t, func() {
		err := runUninstall()
		if err != nil {
			t.Skipf("service.Uninstall not available in this environment: %v", err)
		}
	})
	if !strings.Contains(out, "muxterm service removed") {
		t.Errorf("expected confirmation message, got %q", out)
	}
}
