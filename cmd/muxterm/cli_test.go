package main

import (
	"testing"
)

func TestParseArgs_NoArgs_LocalMode(t *testing.T) {
	cfg, err := ParseArgs([]string{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "local" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "local")
	}
	if cfg.Addr != "127.0.0.1:8311" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "127.0.0.1:8311")
	}
}

func TestParseArgs_ServeDefaults(t *testing.T) {
	cfg, err := ParseArgs([]string{"serve"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "serve" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "serve")
	}
	if cfg.Addr != "127.0.0.1:8311" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "127.0.0.1:8311")
	}
	if cfg.Secret != "" {
		t.Errorf("Secret = %q, want empty string", cfg.Secret)
	}
}

func TestParseArgs_ServeWithFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"serve", "--addr", "127.0.0.1:8311", "--secret", "mysecret"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "serve" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "serve")
	}
	if cfg.Addr != "127.0.0.1:8311" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "127.0.0.1:8311")
	}
	if cfg.Secret != "mysecret" {
		t.Errorf("Secret = %q, want %q", cfg.Secret, "mysecret")
	}
}

func TestParseArgs_DeployWithTarget(t *testing.T) {
	cfg, err := ParseArgs([]string{"deploy", "user@host"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "deploy" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "deploy")
	}
	if cfg.Target != "user@host" {
		t.Errorf("Target = %q, want %q", cfg.Target, "user@host")
	}
}

func TestParseArgs_DeployMissingTarget(t *testing.T) {
	_, err := ParseArgs([]string{"deploy"})
	if err == nil {
		t.Fatal("expected error for deploy without target, got nil")
	}
}

func TestParseArgs_Version(t *testing.T) {
	cfg, err := ParseArgs([]string{"version"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "version" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "version")
	}
}

func TestParseArgs_UnknownCommand_ReturnsError(t *testing.T) {
	_, err := ParseArgs([]string{"bogus"})
	if err == nil {
		t.Fatal("expected error for unknown command, got nil")
	}
}

func TestParseArgs_HelpFlags(t *testing.T) {
	for _, arg := range []string{"--help", "-h", "help"} {
		t.Run(arg, func(t *testing.T) {
			cfg, err := ParseArgs([]string{arg})
			if err != nil {
				t.Fatalf("ParseArgs(%q): unexpected error: %v", arg, err)
			}
			if cfg.Mode != "help" {
				t.Errorf("ParseArgs(%q): Mode = %q, want %q", arg, cfg.Mode, "help")
			}
		})
	}
}

func TestParseArgs_Doctor(t *testing.T) {
	cfg, err := ParseArgs([]string{"doctor"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "doctor" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "doctor")
	}
}

func TestParseArgs_Install_DefaultFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"install"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "install" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "install")
	}
	if cfg.Addr != "127.0.0.1:8311" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "127.0.0.1:8311")
	}
	if cfg.Secret != "" {
		t.Errorf("Secret = %q, want empty (auto-generated at install time)", cfg.Secret)
	}
}

func TestParseArgs_Install_WithFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"install", "--addr", "0.0.0.0:8311", "--secret", "mysecret"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "install" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "install")
	}
	if cfg.Addr != "0.0.0.0:8311" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "0.0.0.0:8311")
	}
	if cfg.Secret != "mysecret" {
		t.Errorf("Secret = %q, want %q", cfg.Secret, "mysecret")
	}
}

func TestParseArgs_Sessiond(t *testing.T) {
	cfg, err := ParseArgs([]string{"sessiond"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "sessiond" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "sessiond")
	}
}

func TestParseArgs_Uninstall(t *testing.T) {
	cfg, err := ParseArgs([]string{"uninstall"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "uninstall" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "uninstall")
	}
}

// TestParseArgs_OpenBrowser_NowUnknown verifies that "open-browser" is no longer
// a recognized command (browser panes now use CDP via TypeCreateBrowserPane).
func TestParseArgs_OpenBrowser_NowUnknown(t *testing.T) {
	_, err := ParseArgs([]string{"open-browser", "5173"})
	if err == nil {
		t.Fatal("expected error for open-browser (removed command), got nil")
	}
}
