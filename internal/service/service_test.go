package service

import (
	"encoding/xml"
	"os"
	"runtime"
	"strings"
	"testing"
)

func TestRenderSystemdUnit_ContainsBinaryPath(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "abc123",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	if !contains(out, "/usr/local/bin/muxterm") {
		t.Error("output missing binary path")
	}
}

func TestRenderSystemdUnit_ContainsServeCommand(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "0.0.0.0:9090",
		Secret:     "secret123",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	if !contains(out, "muxterm serve --addr 0.0.0.0:9090 --secret secret123") {
		t.Errorf("output missing serve command with flags, got:\n%s", out)
	}
}

func TestRenderSystemdUnit_ContainsPATH(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin:/usr/local/bin:/home/user/.local/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	if !contains(out, "Environment=PATH=/usr/bin:/usr/local/bin:/home/user/.local/bin") {
		t.Errorf("output missing PATH environment, got:\n%s", out)
	}
}

func TestRenderSystemdUnit_HasRequiredSections(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	for _, section := range []string{"[Unit]", "[Service]", "[Install]"} {
		if !contains(out, section) {
			t.Errorf("output missing section %q", section)
		}
	}
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && containsStr(s, substr)
}

func containsStr(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func TestDetectPlatform_ReturnsCurrentOS(t *testing.T) {
	p := DetectPlatform()
	want := runtime.GOOS
	if p != want {
		t.Errorf("DetectPlatform() = %q, want %q", p, want)
	}
}

func TestServiceConfig_Defaults(t *testing.T) {
	cfg := DefaultConfig()
	if cfg.Addr != "localhost:8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, "localhost:8080")
	}
	if cfg.BinaryPath != "" {
		t.Errorf("BinaryPath = %q, want empty (resolved at install time)", cfg.BinaryPath)
	}
}

func TestRenderLaunchdPlist_ContainsBinaryPath(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "abc123",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "<string>/usr/local/bin/muxterm</string>") {
		t.Error("output missing binary path")
	}
}

func TestRenderLaunchdPlist_ContainsLabel(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "abc123",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "<string>com.muxterm</string>") {
		t.Error("output missing label com.muxterm")
	}
}

func TestRenderLaunchdPlist_ContainsServeArgs(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "0.0.0.0:9090",
		Secret:     "secret123",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	for _, want := range []string{
		"<string>serve</string>",
		"<string>--addr</string>",
		"<string>0.0.0.0:9090</string>",
		"<string>--secret</string>",
		"<string>secret123</string>",
	} {
		if !contains(out, want) {
			t.Errorf("output missing %s", want)
		}
	}
}

func TestRenderLaunchdPlist_ContainsPATH(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin:/usr/local/bin:/home/user/.local/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !contains(out, "<string>/usr/bin:/usr/local/bin:/home/user/.local/bin</string>") {
		t.Errorf("output missing PATH environment, got:\n%s", out)
	}
}

func TestRenderLaunchdPlist_IsValidXML(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "abc123",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderLaunchdPlist(cfg)
	if err != nil {
		t.Fatalf("RenderLaunchdPlist() error: %v", err)
	}
	if !strings.HasPrefix(out, "<?xml") {
		t.Error("output missing XML declaration")
	}
	if !strings.HasSuffix(strings.TrimSpace(out), "</plist>") {
		t.Error("output missing closing </plist> tag")
	}
	// Validate well-formed XML
	if err := xml.Unmarshal([]byte(out), new(interface{})); err != nil {
		t.Errorf("output is not valid XML: %v", err)
	}
}

func TestSystemdUnitPath_UsesHomeDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("cannot determine home dir: %v", err)
	}
	got := SystemdUnitPath()
	want := home + "/.config/systemd/user/muxterm.service"
	if got != want {
		t.Errorf("SystemdUnitPath() = %q, want %q", got, want)
	}
}

func TestRenderSessiondSystemdUnit_ContainsSessiondCommand(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "abc123",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderSessiondSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSessiondSystemdUnit() error: %v", err)
	}
	if !contains(out, "/usr/local/bin/muxterm sessiond") {
		t.Errorf("output missing sessiond command, got:\n%s", out)
	}
	if !contains(out, "Restart=on-failure") {
		t.Errorf("output missing Restart=on-failure, got:\n%s", out)
	}
	for _, section := range []string{"[Unit]", "[Service]", "[Install]"} {
		if !contains(out, section) {
			t.Errorf("output missing section %q", section)
		}
	}
}

func TestRenderSessiondSystemdUnit_ContainsPATH(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin:/usr/local/bin",
	}
	out, err := RenderSessiondSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSessiondSystemdUnit() error: %v", err)
	}
	if !contains(out, "Environment=PATH=/usr/bin:/usr/local/bin") {
		t.Errorf("output missing PATH environment, got:\n%s", out)
	}
}

func TestRenderSystemdUnit_WebUnitDependsOnSessiond(t *testing.T) {
	cfg := ServiceConfig{
		BinaryPath: "/usr/local/bin/muxterm",
		Addr:       "localhost:8080",
		Secret:     "s",
		SafePATH:   "/usr/bin",
	}
	out, err := RenderSystemdUnit(cfg)
	if err != nil {
		t.Fatalf("RenderSystemdUnit() error: %v", err)
	}
	if !contains(out, "Wants=muxterm-sessiond.service") {
		t.Errorf("web unit missing Wants=muxterm-sessiond.service, got:\n%s", out)
	}
	if !contains(out, "After=muxterm-sessiond.service") {
		t.Errorf("web unit missing After=muxterm-sessiond.service, got:\n%s", out)
	}
}

func TestSessiondSystemdUnitPath_UsesHomeDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("cannot determine home dir: %v", err)
	}
	got := SessiondSystemdUnitPath()
	want := home + "/.config/systemd/user/muxterm-sessiond.service"
	if got != want {
		t.Errorf("SessiondSystemdUnitPath() = %q, want %q", got, want)
	}
}

func TestLaunchdPlistPath_UsesHomeDir(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("cannot determine home dir: %v", err)
	}
	got := LaunchdPlistPath()
	want := home + "/Library/LaunchAgents/com.muxterm.plist"
	if got != want {
		t.Errorf("LaunchdPlistPath() = %q, want %q", got, want)
	}
}
