package sessiond

import (
	"context"
	"os/exec"
	"sync"
	"testing"
)

// TestBrowserManagerStructFields verifies BrowserManager has all required fields
// with the correct types. This is a compile-time test: it fails before
// browser_manager.go exists, passes after the struct is declared.
func TestBrowserManagerStructFields(t *testing.T) {
	var bm BrowserManager

	// mu field: sync.Mutex (take address to avoid copy-lock lint warning)
	var _ *sync.Mutex = &bm.mu

	// chromiumCmd field: *exec.Cmd (nil until first OpenPage call)
	var _ *exec.Cmd = bm.chromiumCmd

	// cdp field: *CDPConn (nil until first OpenPage call)
	var _ *CDPConn = bm.cdp

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

	// sessionID field: string (CDP flattened session ID)
	var _ string = bp.sessionID

	// targetID field: string (CDP target ID)
	var _ string = bp.targetID

	// cdp field: *CDPConn
	var _ *CDPConn = bp.cdp

	// manager field: *BrowserManager
	var _ *BrowserManager = bp.manager

	// cancel field: context.CancelFunc
	var _ context.CancelFunc = bp.cancel
}
