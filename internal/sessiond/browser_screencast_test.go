package sessiond

import (
	"context"
	"testing"
)

// TestBrowserPageScreencastMethodsExist verifies startScreencast and
// captureScreenshot are defined on *BrowserPage with the correct signatures.
// This is a compile-time test: it fails before browser_screencast.go exists,
// passes once the methods are declared.
func TestBrowserPageScreencastMethodsExist(t *testing.T) {
	// Verify startScreencast exists with correct signature.
	var _ func(context.Context) error = (&BrowserPage{}).startScreencast

	// Verify captureScreenshot exists with correct signature.
	var _ func(context.Context) ([]byte, error) = (&BrowserPage{}).captureScreenshot
}

// TestRunEventLoopSignature verifies runEventLoop exists with the expected
// signature (takes context, no return). This is a compile-time check.
func TestRunEventLoopSignature(t *testing.T) {
	var _ func(context.Context) = (&BrowserPage{}).runEventLoop
}
