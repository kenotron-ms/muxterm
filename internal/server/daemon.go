package server

import (
	"encoding/json"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

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
	CloseIntent(target sessiond.CloseTarget) (sessiond.CloseOutcome, error)
	CloseConfirm(ticket string) (sessiond.CloseOutcome, error)
	Attach(workspaceID, breakpoint, clientKind string) (sessiond.Composition, error)
	RenamePane(paneID int, name string) error
	SaveLayout(workspaceID, breakpoint, layout string) error
	CreatePane(cmd []string, placement string, referencePaneID int) (int, error)
	// CreateBrowserPane allocates a client-rendered browser pane handle (surfaceKind
	// "browser") in the attached workspace and returns its workspace-local id. No
	// server-side engine is created.
	CreateBrowserPane(placement string, referencePaneID int) (int, error)
	ClosePane(paneID int) error
	Input(paneID uint32, data []byte) error
	Resize(paneID, cols, rows int) error
	// PaneFocus tells the daemon this pane became the visible+OS-focused view in
	// this browser client, carrying its current measured size.
	PaneFocus(paneID uint32, cols, rows int) error
	BrowserActionResult(msg sessiond.Message) error
	// BrowserCommand relays a browser-command to the daemon (broadcast to workspace
	// subscribers). payload is the pre-marshalled command JSON.
	BrowserCommand(paneID int, cid uint64, payload json.RawMessage) error
	// BrowserResult relays a browser-result back to the daemon (broadcast to
	// workspace subscribers, echoing the command cid).
	BrowserResult(paneID int, cid uint64, payload json.RawMessage) error
	// BrowserURL relays a browser-url notification to the daemon (broadcast to
	// workspace subscribers): a client-rendered browser pane committed a
	// navigation to url.
	BrowserURL(paneID int, url string) error
	// BrowserLoad relays a browser-load notification to the daemon (broadcast
	// to workspace subscribers): a client-rendered browser pane finished
	// loading url.
	BrowserLoad(paneID int, url string) error
	// PreviewSubscribe turns sidebar preview tiles on or off for this daemon
	// connection. It is per-connection and off by default; a daemon too old to
	// know the message type returns an error, which the relay reports to the
	// browser so it can fall back rather than wait.
	PreviewSubscribe(enabled bool) error
	SetHandlers(h sessiond.Handlers)
	Run() error
	Close() error
}

// DialFunc creates a new daemon connection for one browser WebSocket. It is
// injectable so tests can supply a fake instead of dialing a real socket.
type DialFunc func() (DaemonConn, error)
