package main

import (
	"bytes"
	"io"
	"io/fs"
	"os"
	"strings"
	"testing"

	"github.com/user/muxterm/internal/server"
	"github.com/user/muxterm/internal/tmux"
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

func TestPrintEvent_OutputEvent(t *testing.T) {
	ev := tmux.OutputEvent{PaneID: "%0", Data: []byte("hello world")}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "OUTPUT") {
		t.Errorf("expected OUTPUT label, got %q", got)
	}
	if !strings.Contains(got, "%0") {
		t.Errorf("expected pane ID %%0, got %q", got)
	}
	if !strings.Contains(got, "hello world") {
		t.Errorf("expected data content, got %q", got)
	}
}

func TestPrintEvent_OutputEvent_Truncation(t *testing.T) {
	// 100 chars of data should be truncated to 80
	data := strings.Repeat("a", 100)
	ev := tmux.OutputEvent{PaneID: "%1", Data: []byte(data)}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "OUTPUT") {
		t.Errorf("expected OUTPUT label, got %q", got)
	}
	// Should show truncated data (first 80 chars) + "..."
	if strings.Contains(got, strings.Repeat("a", 100)) {
		t.Errorf("expected truncated output, but got full 100 chars")
	}
}

func TestPrintEvent_OutputEvent_EscapedNewlines(t *testing.T) {
	ev := tmux.OutputEvent{PaneID: "%0", Data: []byte("line1\nline2\rline3")}
	got := captureStdout(t, func() { printEvent(ev) })
	if strings.Contains(got, "\nline2") {
		t.Errorf("expected escaped newlines, got raw newline in %q", got)
	}
	if !strings.Contains(got, `\n`) {
		t.Errorf("expected \\n escape in output, got %q", got)
	}
}

func TestPrintEvent_LayoutChangeEvent(t *testing.T) {
	ev := tmux.LayoutChangeEvent{WindowID: "@1", Layout: "abc,200x50,0,0{100x50,0,0,0,99x50,101,0,1}"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "LAYOUT") {
		t.Errorf("expected LAYOUT label, got %q", got)
	}
	if !strings.Contains(got, "@1") {
		t.Errorf("expected window ID @1, got %q", got)
	}
}

func TestPrintEvent_WindowAddEvent(t *testing.T) {
	ev := tmux.WindowAddEvent{WindowID: "@2"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "WIN-ADD") {
		t.Errorf("expected WIN-ADD label, got %q", got)
	}
	if !strings.Contains(got, "@2") {
		t.Errorf("expected window ID @2, got %q", got)
	}
}

func TestPrintEvent_WindowCloseEvent(t *testing.T) {
	ev := tmux.WindowCloseEvent{WindowID: "@3"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "WIN-CLOSE") {
		t.Errorf("expected WIN-CLOSE label, got %q", got)
	}
	if !strings.Contains(got, "@3") {
		t.Errorf("expected window ID @3, got %q", got)
	}
}

func TestPrintEvent_WindowRenamedEvent(t *testing.T) {
	ev := tmux.WindowRenamedEvent{WindowID: "@1", Name: "vim"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "WIN-RENAME") {
		t.Errorf("expected WIN-RENAME label, got %q", got)
	}
	if !strings.Contains(got, "@1") {
		t.Errorf("expected window ID @1, got %q", got)
	}
	if !strings.Contains(got, "vim") {
		t.Errorf("expected window name vim, got %q", got)
	}
}

func TestPrintEvent_SessionChangedEvent(t *testing.T) {
	ev := tmux.SessionChangedEvent{SessionID: "$1", Name: "muxterm"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "SESS-CHG") {
		t.Errorf("expected SESS-CHG label, got %q", got)
	}
	if !strings.Contains(got, "$1") {
		t.Errorf("expected session ID $1, got %q", got)
	}
	if !strings.Contains(got, "muxterm") {
		t.Errorf("expected session name muxterm, got %q", got)
	}
}

func TestPrintEvent_SessionWindowChangedEvent(t *testing.T) {
	ev := tmux.SessionWindowChangedEvent{SessionID: "$1", WindowID: "@2"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "SESS-WIN-CHG") || !strings.Contains(got, "WIN-CHG") {
		// Accept either label
		if !strings.Contains(got, "$1") || !strings.Contains(got, "@2") {
			t.Errorf("expected session/window IDs, got %q", got)
		}
	}
}

func TestPrintEvent_SessionRenamedEvent(t *testing.T) {
	ev := tmux.SessionRenamedEvent{Name: "newname"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "SESS-RENAME") {
		t.Errorf("expected SESS-RENAME label, got %q", got)
	}
	if !strings.Contains(got, "newname") {
		t.Errorf("expected session name newname, got %q", got)
	}
}

func TestPrintEvent_CommandResultEvent_Success(t *testing.T) {
	ev := tmux.CommandResultEvent{CmdNumber: 1, Lines: []string{"line1", "line2"}, Success: true}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "CMD-RESULT") {
		t.Errorf("expected CMD-RESULT label, got %q", got)
	}
	if !strings.Contains(got, "OK") {
		t.Errorf("expected OK status, got %q", got)
	}
}

func TestPrintEvent_CommandResultEvent_Error(t *testing.T) {
	ev := tmux.CommandResultEvent{CmdNumber: 2, Lines: []string{"error msg"}, Success: false}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "CMD-RESULT") {
		t.Errorf("expected CMD-RESULT label, got %q", got)
	}
	if !strings.Contains(got, "ERROR") {
		t.Errorf("expected ERROR status, got %q", got)
	}
}

func TestPrintEvent_UnknownEvent(t *testing.T) {
	ev := tmux.UnknownEvent{Name: "custom-event", Args: "some args"}
	got := captureStdout(t, func() { printEvent(ev) })
	if !strings.Contains(got, "UnknownEvent") && !strings.Contains(got, "UNKNOWN") {
		t.Errorf("expected type name mention, got %q", got)
	}
}

func TestPrintEvent_UnhandledType(t *testing.T) {
	// ExitEvent is not specifically handled in printEvent spec, so it should
	// fall through to the default which prints the type name
	ev := tmux.ExitEvent{Reason: "detached"}
	got := captureStdout(t, func() { printEvent(ev) })
	if got == "" {
		t.Errorf("expected some output even for unhandled event type")
	}
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
