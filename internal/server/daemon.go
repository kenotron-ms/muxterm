package server

import (
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
	CreatePane(cmd []string, placement string, referencePaneID int, clientRef string) (int, error)
	ClosePane(paneID int) error
	Input(paneID uint32, data []byte) error
	Resize(paneID, cols, rows int) error
	// PaneFocus tells the daemon this pane became the visible+OS-focused view in
	// this browser client, carrying its current measured size.
	PaneFocus(paneID uint32, cols, rows int) error
	// PreviewSubscribe turns sidebar preview tiles on or off for this daemon
	// connection. It is per-connection and off by default; a daemon too old to
	// know the message type returns an error, which the relay reports to the
	// browser so it can fall back rather than wait.
	PreviewSubscribe(enabled bool) error
	// SessionStateSubscribe turns home-view session state on or off for this
	// daemon connection. Per-connection and off by default, with the same
	// old-daemon contract as PreviewSubscribe: an error means the daemon does
	// not know the message type, and the browser should fall back rather than
	// wait for rows that will never arrive.
	SessionStateSubscribe(enabled bool) error
	SetHandlers(h sessiond.Handlers)
	Run() error
	Close() error
}

// DialFunc creates a new daemon connection for one browser WebSocket. It is
// injectable so tests can supply a fake instead of dialing a real socket.
type DialFunc func() (DaemonConn, error)
