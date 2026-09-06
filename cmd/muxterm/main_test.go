package main

import (
	"bytes"
	"context"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kenotron-ms/muxterm/internal/config"
	"github.com/kenotron-ms/muxterm/internal/server"
	"github.com/kenotron-ms/muxterm/internal/service"
	"github.com/kenotron-ms/muxterm/internal/transport"
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
	conn, err := dial(context.Background(), transport.HostRef{})
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

// runInstall is deliberately NOT invoked by any test in this file. It writes
// the real muxterm config file (config.DefaultPath()), rewrites
// ~/.config/systemd/user/muxterm{,-sessiond}.service, and ends in
// `systemctl --user enable --now` -- on a developer machine that is the live
// muxterm the test is running inside (AGENTS.md, first section). The tests
// below exercise the parts of the install path that take an explicit path or
// are pure; the end-to-end install belongs in a container, not here.

func TestRunInstall_ReportsConfiguredAddr(t *testing.T) {
	// The address runInstall reports ("muxterm installed; it will listen on
	// %s (from %s)") is the RESOLVED config address, not the raw flag: after
	// this install the service reads the address from the config file, so
	// printing the flag would misreport where the service actually listens.
	// --addr is therefore persisted, and comes back out for the report.
	path := filepath.Join(t.TempDir(), "config.toml")

	// --addr ALONE, on a host with no configured origin. This is the exact
	// form the unit-migration message tells an operator to run, so it has to
	// work without a public_origin: writeInstallServerConfig gates its
	// "validate as if behind_reverse_proxy were on" check on an origin
	// actually being in play. An earlier revision ran that check
	// unconditionally and failed here with "behind_reverse_proxy is set but
	// public_origin is empty" -- which would have made the recovery command
	// unusable on precisely the hosts that need it.
	srvCfg, wrote, err := writeInstallServerConfig(Config{
		Mode: "install",
		Addr: "127.0.0.1:8399",
	}, path)
	if err != nil {
		t.Fatalf("writeInstallServerConfig: %v", err)
	}
	if !wrote {
		t.Error("--addr should have been persisted to the config file")
	}
	if srvCfg.Addr != "127.0.0.1:8399" {
		t.Errorf("Addr = %q, want %q", srvCfg.Addr, "127.0.0.1:8399")
	}
}

func TestRunInstall_WritesNoSecretIntoTheUnit(t *testing.T) {
	// Auto-generation was removed along with the HMAC scheme, and there is no
	// longer anywhere to put a credential even if one existed:
	// service.ServiceConfig has no Secret field, and the ExecStart is a bare
	// `serve`. This renders exactly the ServiceConfig runInstall builds (see
	// the svcCfg literal there) and checks nothing credential-shaped survives.
	unit, err := service.RenderSystemdUnit(service.ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       config.DefaultAddr,
		SafePATH:   "/usr/bin",
	})
	if err != nil {
		t.Fatalf("RenderSystemdUnit: %v", err)
	}
	if strings.Contains(unit, "secret") {
		t.Errorf("installed unit must carry no credential, got:\n%s", unit)
	}
	// The address is policy and lives in the config file, so it is not in the
	// unit either -- see writeInstallServerConfig.
	if strings.Contains(unit, config.DefaultAddr) {
		t.Errorf("installed unit must not carry a listen address, got:\n%s", unit)
	}
}

func TestRunInstall_BareInstallLeavesConfigAlone(t *testing.T) {
	// A bare `muxterm install` is the documented UPGRADE command, so it must
	// not rewrite (or create) the config file: absent flags mean "leave the
	// configured deployment exactly as it was found". With nothing configured
	// there is no address to report either, and runInstall falls back to
	// config.DefaultAddr.
	path := filepath.Join(t.TempDir(), "config.toml")

	srvCfg, wrote, err := writeInstallServerConfig(Config{Mode: "install"}, path)
	if err != nil {
		t.Fatalf("writeInstallServerConfig: %v", err)
	}
	if wrote {
		t.Error("a bare install must not write the config file")
	}
	if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
		t.Errorf("a bare install must not create %s", path)
	}
	if srvCfg.Addr != "" {
		t.Errorf("Addr = %q, want empty (nothing configured; runInstall falls back to %q)", srvCfg.Addr, config.DefaultAddr)
	}
}

func TestRunUninstall_PrintsConfirmation(t *testing.T) {
	// GUARDED, NOT DELETED. runUninstall calls service.Uninstall, which runs
	// `systemctl --user disable --now muxterm.service muxterm-sessiond.service`
	// against the REAL units -- on any machine actually running muxterm this
	// test does not check a message, it terminates the user's server and every
	// live pty with it (AGENTS.md, first section). It is meaningful only in a
	// throwaway container, so it now requires saying so out loud.
	if os.Getenv("MUXTERM_ALLOW_DESTRUCTIVE_SERVICE_TESTS") != "1" {
		t.Skip("skipping: stops and disables the real muxterm service; set MUXTERM_ALLOW_DESTRUCTIVE_SERVICE_TESTS=1 in a disposable environment to run it")
	}
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
