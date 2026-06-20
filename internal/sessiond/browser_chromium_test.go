package sessiond

import (
	"context"
	"testing"

	"github.com/go-rod/rod"
)

// TestPinnedRevisionConstant verifies the PinnedRevision constant exists and
// has the expected tested Chromium revision value.
func TestPinnedRevisionConstant(t *testing.T) {
	const want = "1313161"
	if PinnedRevision != want {
		t.Errorf("PinnedRevision = %q, want %q", PinnedRevision, want)
	}
}

// TestNewChromiumManager verifies that NewChromiumManager returns a
// non-nil *ChromiumManager with revision set to PinnedRevision.
func TestNewChromiumManager(t *testing.T) {
	cm := NewChromiumManager()
	if cm == nil {
		t.Fatal("NewChromiumManager() returned nil")
	}
	if cm.revision != PinnedRevision {
		t.Errorf("cm.revision = %q, want %q", cm.revision, PinnedRevision)
	}
}

// TestChromiumManagerEnsureSignature is a compile-time check that
// ChromiumManager has an Ensure method with the expected signature.
func TestChromiumManagerEnsureSignature(t *testing.T) {
	// Verify Ensure has the right signature by assigning it to a typed variable.
	cm := NewChromiumManager()
	var _ func(ctx context.Context, progressCb func(pct int)) (*rod.Browser, error) = cm.Ensure
}
