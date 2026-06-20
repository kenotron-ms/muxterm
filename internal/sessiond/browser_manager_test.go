package sessiond

import (
	"sync"
	"testing"

	"github.com/go-rod/rod"
)

// TestBrowserManagerStructFields verifies BrowserManager has all required fields
// with the correct types. This is a compile-time test: it fails before
// browser_manager.go exists, passes after the struct is declared.
func TestBrowserManagerStructFields(t *testing.T) {
	var bm BrowserManager

	// mu field: sync.Mutex (take address to avoid copy-lock lint warning)
	var _ *sync.Mutex = &bm.mu

	// chromium field: *ChromiumManager
	var _ *ChromiumManager = bm.chromium

	// browser field: *rod.Browser
	var _ *rod.Browser = bm.browser

	// pages field: map[int]*BrowserPage
	var _ map[int]*BrowserPage = bm.pages

	// maxPages field: int
	var _ int = bm.maxPages

	// broadcast field: func(paneID int, data []byte)
	var _ func(paneID int, data []byte) = bm.broadcast

	// broadcastJSON field: func(msg any)
	var _ func(msg any) = bm.broadcastJSON
}

// TestBrowserPageStructFields verifies BrowserPage has all required fields
// with the correct types.
func TestBrowserPageStructFields(t *testing.T) {
	var bp BrowserPage

	// paneID field: int
	var _ int = bp.paneID

	// page field: *rod.Page
	var _ *rod.Page = bp.page

	// stopCh field: chan struct{}
	var _ chan struct{} = bp.stopCh

	// manager field: *BrowserManager
	var _ *BrowserManager = bp.manager
}
