package server

import (
	"context"
	"encoding/json"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/user/muxterm/internal/sessiond"
)

// startEchoDaemon launches a scripted Unix-socket daemon that speaks the frozen
// sessiond framing. It answers list-workspaces and attach with canned replies,
// ignores resize, and echoes any pane-data frame straight back. It exercises the
// whole serve relay path without spawning a real PTY. Returns the socket path.
func startEchoDaemon(t *testing.T) string {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "echo.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen unix: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				for {
					kind, payload, err := sessiond.ReadFrame(conn)
					if err != nil {
						return
					}
					switch kind {
					case sessiond.FrameControl:
						var msg sessiond.Message
						if err := json.Unmarshal(payload, &msg); err != nil {
							continue
						}
						switch msg.Type {
						case sessiond.TypeListWorkspaces:
							_ = sessiond.WriteControl(conn, &sessiond.Message{
								Type: sessiond.TypeWorkspaceList,
								CID:  msg.CID,
								Workspaces: []sessiond.WorkspaceInfo{
									{WorkspaceID: "w1", Name: "dev", PaneCount: 1},
								},
							})
						case sessiond.TypeAttach:
							_ = sessiond.WriteControl(conn, &sessiond.Message{
								Type:        sessiond.TypeComposition,
								CID:         msg.CID,
								WorkspaceID: msg.WorkspaceID,
								Panes:       []sessiond.PaneInfo{{PaneID: 1, Cols: 80, Rows: 24}},
							})
						case sessiond.TypeResize:
							// no reply
						}
					case sessiond.FramePaneData:
						paneID, data := sessiond.DecodePaneData(payload)
						_ = sessiond.WritePaneData(conn, paneID, data)
					}
				}
			}(conn)
		}
	}()

	return sock
}

// TestE2EBrowserToDaemonRoundTrip proves the full stack: a real server.Server
// with a dialer to a real in-process daemon socket; a real WebSocket client
// attaches, receives the composition, sends input, and receives the echoed pane
// output as a binary frame -- all over the frozen wire protocol.
func TestE2EBrowserToDaemonRoundTrip(t *testing.T) {
	sock := startEchoDaemon(t)

	srv := New(Config{Addr: "127.0.0.1:0"})
	srv.Hub().SetDialer(func() (DaemonConn, error) { return sessiond.Dial(sock) })

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws"
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("websocket.Dial: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	mustWriteText(t, ctx, conn, `{"type":"attach","cid":1,"workspaceId":"w1"}`)
	waitForType(t, ctx, conn, sessiond.TypeComposition)

	mustWriteBinary(t, ctx, conn, EncodeBinaryFrame(1, []byte("ping")))
	waitForBinary(t, ctx, conn, 1, "ping")
}

// mustWriteText writes a text frame or fails the test.
func mustWriteText(t *testing.T, ctx context.Context, conn *websocket.Conn, s string) {
	t.Helper()
	if err := conn.Write(ctx, websocket.MessageText, []byte(s)); err != nil {
		t.Fatalf("write text: %v", err)
	}
}

// mustWriteBinary writes a binary frame or fails the test.
func mustWriteBinary(t *testing.T, ctx context.Context, conn *websocket.Conn, b []byte) {
	t.Helper()
	if err := conn.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatalf("write binary: %v", err)
	}
}

// waitForType reads frames until it sees a text frame whose frozen Message Type
// equals typ, or fails when ctx expires. Other frames (config, workspace-list)
// are skipped.
func waitForType(t *testing.T, ctx context.Context, conn *websocket.Conn, typ string) {
	t.Helper()
	for {
		mt, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waitForType %q: read: %v", typ, err)
		}
		if mt != websocket.MessageText {
			continue
		}
		var m sessiond.Message
		if err := json.Unmarshal(data, &m); err != nil {
			continue
		}
		if m.Type == typ {
			return
		}
	}
}

// waitForBinary reads frames until it sees a binary frame decoding to the given
// paneID and data, or fails when ctx expires. Non-matching frames are skipped.
func waitForBinary(t *testing.T, ctx context.Context, conn *websocket.Conn, wantPane uint32, wantData string) {
	t.Helper()
	for {
		mt, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waitForBinary (%d,%q): read: %v", wantPane, wantData, err)
		}
		if mt != websocket.MessageBinary {
			continue
		}
		paneID, payload, err := DecodeBinaryFrame(data)
		if err != nil {
			continue
		}
		if paneID == wantPane && string(payload) == wantData {
			return
		}
	}
}
