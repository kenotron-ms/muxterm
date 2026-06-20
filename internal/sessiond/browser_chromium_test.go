package sessiond

import (
	"runtime"
	"strings"
	"testing"
)

// TestChromiumDataDir verifies chromiumDataDir returns a non-empty path that
// contains "muxterm" in the conventional location for the current platform.
func TestChromiumDataDir(t *testing.T) {
	dir := chromiumDataDir()
	if dir == "" {
		t.Error("chromiumDataDir() returned empty string")
	}
	if !strings.Contains(dir, "muxterm") {
		t.Errorf("chromiumDataDir() = %q, want path containing 'muxterm'", dir)
	}
}

// TestChromiumPlatform verifies chromiumPlatform returns one of the three
// known chrome-for-testing platform identifiers and is consistent with
// runtime.GOOS/runtime.GOARCH.
func TestChromiumPlatform(t *testing.T) {
	platform := chromiumPlatform()
	valid := map[string]bool{
		"mac-arm64": true,
		"mac-x64":   true,
		"linux64":   true,
	}
	if !valid[platform] {
		t.Errorf("chromiumPlatform() = %q, want one of mac-arm64, mac-x64, linux64", platform)
	}
	if runtime.GOOS == "darwin" && runtime.GOARCH == "arm64" && platform != "mac-arm64" {
		t.Errorf("on darwin/arm64, chromiumPlatform() = %q, want mac-arm64", platform)
	}
	if runtime.GOOS == "darwin" && runtime.GOARCH == "amd64" && platform != "mac-x64" {
		t.Errorf("on darwin/amd64, chromiumPlatform() = %q, want mac-x64", platform)
	}
}

// TestChromiumBinRelPath verifies chromiumBinRelPath returns a non-empty
// path consistent with the current platform.
func TestChromiumBinRelPath(t *testing.T) {
	path := chromiumBinRelPath()
	if path == "" {
		t.Error("chromiumBinRelPath() returned empty string")
	}
	platform := chromiumPlatform()
	if !strings.Contains(path, "chrome-"+platform) {
		t.Errorf("chromiumBinRelPath() = %q, want path containing %q", path, "chrome-"+platform)
	}
}
