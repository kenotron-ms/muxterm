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
	if cfg.Addr != "localhost:8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "localhost:8080")
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
	if cfg.Addr != "0.0.0.0:8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "0.0.0.0:8080")
	}
	if cfg.Secret != "" {
		t.Errorf("Secret = %q, want empty string", cfg.Secret)
	}
}

func TestParseArgs_ServeWithFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"serve", "--addr", "127.0.0.1:9090", "--secret", "mysecret"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "serve" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "serve")
	}
	if cfg.Addr != "127.0.0.1:9090" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "127.0.0.1:9090")
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

func TestParseArgs_UnknownCommand_FallsBackToLocal(t *testing.T) {
	cfg, err := ParseArgs([]string{"bogus"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "local" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "local")
	}
	if cfg.Addr != "localhost:8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "localhost:8080")
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
	if cfg.Addr != "localhost:8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "localhost:8080")
	}
	if cfg.Secret != "" {
		t.Errorf("Secret = %q, want empty (auto-generated at install time)", cfg.Secret)
	}
}

func TestParseArgs_Install_WithFlags(t *testing.T) {
	cfg, err := ParseArgs([]string{"install", "--addr", "0.0.0.0:9090", "--secret", "mysecret"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != "install" {
		t.Errorf("Mode = %q, want %q", cfg.Mode, "install")
	}
	if cfg.Addr != "0.0.0.0:9090" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "0.0.0.0:9090")
	}
	if cfg.Secret != "mysecret" {
		t.Errorf("Secret = %q, want %q", cfg.Secret, "mysecret")
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
