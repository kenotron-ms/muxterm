package sessiond

import (
	"testing"
)

// TestBrowserPageScreencastMethodsExist verifies startScreencast and
// stopScreencast are defined on *BrowserPage with the correct signatures.
// This is a compile-time test: it fails before browser_screencast.go exists,
// passes once the methods are declared.
func TestBrowserPageScreencastMethodsExist(t *testing.T) {
	// Verify startScreencast and stopScreencast exist with correct signatures.
	var _ func() = (&BrowserPage{}).startScreencast
	var _ func() = (&BrowserPage{}).stopScreencast
}

// TestStopScreencast verifies that stopScreencast closes stopCh exactly once.
// Calling it once must not panic; calling it a second time must panic
// (close of closed channel is the documented contract).
func TestStopScreencast(t *testing.T) {
	bp := &BrowserPage{
		stopCh: make(chan struct{}),
	}

	// First call must not panic and must close the channel.
	bp.stopScreencast()

	// Verify the channel is closed.
	select {
	case <-bp.stopCh:
		// channel is closed — correct
	default:
		t.Fatal("stopScreencast: stopCh was not closed")
	}

	// Second call must panic (close of closed channel).
	defer func() {
		if r := recover(); r == nil {
			t.Error("stopScreencast: second call did not panic as documented")
		}
	}()
	bp.stopScreencast()
}
