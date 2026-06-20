package sessiond

import (
	"os"
	"path/filepath"
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

// TestOwnDownloadedBinMissing verifies ownDownloadedBin returns "" when the
// muxterm-downloaded binary does not exist.
func TestOwnDownloadedBinMissing(t *testing.T) {
	// In a normal test environment there is no pre-downloaded binary at
	// chromiumDataDir(); we just confirm we get an empty string (not a panic).
	// If the binary actually exists on disk we skip rather than lie.
	const version = "131.0.6778.85"
	binPath := filepath.Join(chromiumDataDir(), version, chromiumBinRelPath())
	if _, err := os.Stat(binPath); err == nil {
		t.Skip("muxterm-downloaded binary present on disk — skipping absence test")
	}

	got := ownDownloadedBin()
	if got != "" {
		t.Errorf("ownDownloadedBin() = %q, want \"\" when binary absent", got)
	}
}

// TestOwnDownloadedBinPresent verifies ownDownloadedBin returns the correct
// path when a binary exists at the expected location.
func TestOwnDownloadedBinPresent(t *testing.T) {
	const version = "131.0.6778.85"
	wantPath := filepath.Join(chromiumDataDir(), version, chromiumBinRelPath())

	// Create the file in a temp dir by pointing chromiumDataDir via the
	// function itself — we just create the file where it expects to find it.
	if err := os.MkdirAll(filepath.Dir(wantPath), 0o755); err != nil {
		t.Fatalf("setup: MkdirAll: %v", err)
	}
	// Create a placeholder file (content irrelevant — only existence matters).
	f, err := os.Create(wantPath)
	if err != nil {
		t.Fatalf("setup: Create %q: %v", wantPath, err)
	}
	f.Close()
	t.Cleanup(func() { os.Remove(wantPath) })

	got := ownDownloadedBin()
	if got != wantPath {
		t.Errorf("ownDownloadedBin() = %q, want %q", got, wantPath)
	}
}

// TestRodCachedBinMissing verifies rodCachedBin returns "" when the go-rod
// cache directory does not exist or is empty.
func TestRodCachedBinMissing(t *testing.T) {
	// We cannot reliably guarantee the rod cache is absent on every machine, so
	// we accept either: (a) the cache is absent → returns ""; (b) the cache
	// has entries but none match the candidate paths → returns "".  If a real
	// binary is found we skip rather than fail.
	got := rodCachedBin()
	// If a valid binary is found, stat it to confirm existence — that is also
	// correct behaviour; just not the "missing" scenario.
	if got != "" {
		if _, err := os.Stat(got); err != nil {
			t.Errorf("rodCachedBin() = %q but file does not exist: %v", got, err)
		}
		t.Skipf("go-rod cache binary found at %q — skipping absence test", got)
	}
}

// TestRodCachedBinFound verifies rodCachedBin returns a path when a
// Chromium binary is present inside the go-rod cache directory structure.
func TestRodCachedBinFound(t *testing.T) {
	home := t.TempDir()
	// Mimic the go-rod cache layout:
	// ~/.cache/rod/browser/<revision>/Chromium.app/Contents/MacOS/Chromium
	revision := "chromium-1234567"
	binRel := filepath.Join("Chromium.app", "Contents", "MacOS", "Chromium")
	binPath := filepath.Join(home, ".cache", "rod", "browser", revision, binRel)
	if err := os.MkdirAll(filepath.Dir(binPath), 0o755); err != nil {
		t.Fatalf("setup: MkdirAll: %v", err)
	}
	f, err := os.Create(binPath)
	if err != nil {
		t.Fatalf("setup: Create %q: %v", binPath, err)
	}
	f.Close()

	// rodCachedBin hard-codes os.UserHomeDir(); we need to inject our temp
	// home.  We do that by temporarily overriding HOME.
	t.Setenv("HOME", home)

	got := rodCachedBin()
	if got != binPath {
		t.Errorf("rodCachedBin() = %q, want %q", got, binPath)
	}
}
