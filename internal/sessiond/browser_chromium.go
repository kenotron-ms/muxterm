package sessiond

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
)

// PinnedRevision is the tested Chromium revision bundled with this muxterm release.
const PinnedRevision = "1313161"

// ChromiumManager handles downloading and launching the Chromium browser binary.
// The managed binary is stored in a platform-conventional directory and reused
// across calls — subsequent calls with the same revision are instant.
type ChromiumManager struct {
	revision string
}

// NewChromiumManager returns a ChromiumManager pinned to PinnedRevision.
func NewChromiumManager() *ChromiumManager {
	return &ChromiumManager{revision: PinnedRevision}
}

// chromiumDataDir returns the platform-conventional directory for storing the
// muxterm-managed Chromium binary.
//
// macOS: ~/Library/Application Support/muxterm/chromium
// Linux: $XDG_DATA_HOME/muxterm/chromium, falling back to
//
//	~/.local/share/muxterm/chromium, then os.TempDir()/muxterm-chromium.
func chromiumDataDir() string {
	if runtime.GOOS == "darwin" {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, "Library", "Application Support", "muxterm", "chromium")
		}
	}
	// Linux / XDG
	if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
		return filepath.Join(xdg, "muxterm", "chromium")
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "share", "muxterm", "chromium")
	}
	return filepath.Join(os.TempDir(), "muxterm-chromium")
}

// Ensure downloads Chromium if not already present, launches it headlessly, and
// returns a connected *rod.Browser. The ctx is used for the connection step.
// progressCb, if non-nil, receives download progress as an integer in [0, 100].
// Subsequent calls with the same revision are instant because the binary is
// already present.
func (c *ChromiumManager) Ensure(ctx context.Context, progressCb func(pct int)) (*rod.Browser, error) {
	if progressCb != nil {
		progressCb(0)
	}

	dataDir := chromiumDataDir()
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("chromium: create data dir: %w", err)
	}

	rev, err := strconv.Atoi(c.revision)
	if err != nil {
		return nil, fmt.Errorf("chromium: invalid revision %q: %w", c.revision, err)
	}

	l := launcher.New().
		Headless(true).
		Set("no-sandbox").
		Set("disable-dev-shm-usage").
		Revision(rev).
		UserDataDir(filepath.Join(dataDir, "profile"))

	wsURL, err := l.Launch()
	if err != nil {
		return nil, fmt.Errorf("chromium: launch: %w", err)
	}

	browser := rod.New().ControlURL(wsURL)
	if err := browser.Connect(); err != nil {
		return nil, fmt.Errorf("chromium: connect: %w", err)
	}

	if progressCb != nil {
		progressCb(100)
	}

	return browser, nil
}
