package server

import "github.com/kenotron-ms/muxterm/internal/sessiond"

// DaemonConn is the serve-side seam over a single sessiond connection. One
// DaemonConn backs exactly one browser WebSocket: the serve layer dials a fresh
// connection per browser and drives it through this interface. *sessiond.Client
// satisfies it; tests fake it. Exporting the seam lets cmd/muxterm name it when
// wiring a DialFunc.
type DaemonConn interface {
	ListWorkspaces() ([]sessiond.WorkspaceInfo, error)
	CreateWorkspace(name string) (string, error)
	RenameWorkspace(workspaceID, name string) error
	CloseWorkspace(workspaceID string) error
	Attach(workspaceID, breakpoint string) (sessiond.Composition, error)
	RenamePane(paneID int, name string) error
	SaveLayout(workspaceID, breakpoint, layout string) error
	CreatePane(cmd []string, placement string, referencePaneID int) (int, error)
	// CreateBrowserCDPPane creates a browser-cdp surface pane in the attached workspace.
	// Returns the server-assigned workspace-local pane ID. HTTP server layer starts
	// actual Chromium page separately via BrowserManager.OpenPage(paneID).
	CreateBrowserCDPPane(placement string, referencePaneID int) (int, error)
	ClosePane(paneID int) error
	Input(paneID uint32, data []byte) error
	Resize(paneID, cols, rows int) error
	BrowserActionResult(msg sessiond.Message) error
	SetHandlers(h sessiond.Handlers)
	Run() error
	Close() error
}

// DialFunc creates a new daemon connection for one browser WebSocket. It is
// injectable so tests can supply a fake instead of dialing a real socket.
type DialFunc func() (DaemonConn, error)
