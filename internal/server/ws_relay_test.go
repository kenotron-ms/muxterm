package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// trackingDaemonConn wraps fakeDaemonConn and records which create method was called.
type trackingDaemonConn struct {
	fakeDaemonConn
	createPaneCalled bool
}

func (f *trackingDaemonConn) CreatePane(cmd []string, placement string, referencePaneID int) (int, error) {
	f.createPaneCalled = true
	return f.createdID, nil
}

// TestAttachClient_OnPaneAdded_RelaysBrowserSurfaceKind and
// TestHandleTextInput_TypeCreateBrowserPane_CallsCreateBrowserPane lived here,
// along with trackingDaemonConn.CreateBrowserPane. They were removed when
// muxterm dropped browser pane support: TypeCreateBrowserPane,
// DaemonConn.CreateBrowserPane, and Message/PaneInfo.SurfaceKind no longer
// exist. The surviving test below still covers the TypeCreatePane relay path.

// TestHandleTextInput_TypeCreatePane_TerminalSurfaceKind verifies that a
// TypeCreatePane message routes to CreatePane.
func TestHandleTextInput_TypeCreatePane_TerminalSurfaceKind(t *testing.T) {
	fake := &trackingDaemonConn{fakeDaemonConn: fakeDaemonConn{createdID: 11}}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	c := &Client{
		hub:    NewHub(nil),
		ctx:    ctx,
		cancel: cancel,
		daemon: fake,
	}
	c.writeTextFn = func(data []byte) error { return nil }
	c.writeBinaryFn = func(data []byte) error { return nil }

	msg := sessiond.Message{
		Type: sessiond.TypeCreatePane,
		CID:  77,
		Cmd:  []string{"bash"},
	}
	data, _ := json.Marshal(msg)
	c.handleTextInput(data)

	if !fake.createPaneCalled {
		t.Fatal("expected CreatePane to be called for TypeCreatePane")
	}
}
