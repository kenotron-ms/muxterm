package server

import (
	"testing"

	"github.com/user/muxterm/internal/sessiond"
)

// fakeDaemonConn is a test double satisfying DaemonConn. It records the calls it
// receives so tests can assert on the serve layer's interaction with the daemon.
type fakeDaemonConn struct {
	attached  string
	inputs    []string
	resizes   [][3]int
	createdID int
	handlers  sessiond.Handlers
}

func (f *fakeDaemonConn) ListWorkspaces() ([]sessiond.WorkspaceInfo, error) {
	return []sessiond.WorkspaceInfo{{WorkspaceID: "w1", Name: "dev", PaneCount: 1}}, nil
}

func (f *fakeDaemonConn) CreateWorkspace(name string) (string, error) {
	return "w2", nil
}

func (f *fakeDaemonConn) RenameWorkspace(workspaceID, name string) error {
	return nil
}

func (f *fakeDaemonConn) CloseWorkspace(workspaceID string) error {
	return nil
}

func (f *fakeDaemonConn) Attach(workspaceID, breakpoint string) (sessiond.Composition, error) {
	f.attached = workspaceID
	return sessiond.Composition{
		WorkspaceID: workspaceID,
		Panes:       []sessiond.PaneInfo{{PaneID: 1, Cols: 80, Rows: 24}},
	}, nil
}

func (f *fakeDaemonConn) RenamePane(paneID int, name string) error { return nil }

func (f *fakeDaemonConn) ClosePane(paneID int) error { return nil }

func (f *fakeDaemonConn) SaveLayout(workspaceID, breakpoint, layout string) error { return nil }

func (f *fakeDaemonConn) CreatePane(cmd []string) (int, error) {
	return f.createdID, nil
}

func (f *fakeDaemonConn) CreateBrowserPane(port int, path string, headers map[string]string) (int, error) {
	return f.createdID, nil
}

func (f *fakeDaemonConn) Input(paneID uint32, data []byte) error {
	f.inputs = append(f.inputs, string(data))
	return nil
}

func (f *fakeDaemonConn) Resize(paneID, cols, rows int) error {
	f.resizes = append(f.resizes, [3]int{paneID, cols, rows})
	return nil
}

func (f *fakeDaemonConn) SetHandlers(h sessiond.Handlers) {
	f.handlers = h
}

func (f *fakeDaemonConn) Run() error { return nil }

func (f *fakeDaemonConn) Close() error { return nil }

// TestDaemonConnInterfaceSatisfied is a compile-time assertion that both the
// real *sessiond.Client and the test double satisfy the DaemonConn seam.
func TestDaemonConnInterfaceSatisfied(t *testing.T) {
	var _ DaemonConn = (*fakeDaemonConn)(nil)
	var _ DaemonConn = (*sessiond.Client)(nil)
}
