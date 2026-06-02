package sessiond

import (
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"
)

// fakeDaemon is an in-process Unix-socket server used to test the serve-side
// Client in isolation. It accepts exactly one connection and hands it to a
// per-test handler. The listener is closed and the socket file removed on
// cleanup.
type fakeDaemon struct {
	sockPath string
}

// newFakeDaemon starts a fake daemon that accepts exactly one connection and
// passes the accepted net.Conn to handler in a goroutine.
func newFakeDaemon(t *testing.T, handler func(conn net.Conn)) *fakeDaemon {
	t.Helper()
	sock := filepath.Join(t.TempDir(), "fake.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	t.Cleanup(func() {
		_ = ln.Close()
	})
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		handler(conn)
	}()
	return &fakeDaemon{sockPath: sock}
}

func TestDialConnects(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		time.Sleep(200 * time.Millisecond)
		_ = conn.Close()
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	if c == nil {
		t.Fatal("Dial returned nil *Client")
	}
}

// mustUnmarshal unmarshals data into v, failing the test on error.
func mustUnmarshal(t *testing.T, data []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
}

func TestListWorkspaces(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		kind, payload, err := ReadFrame(conn)
		if err != nil {
			t.Errorf("ReadFrame: %v", err)
			return
		}
		if kind != FrameControl {
			t.Errorf("kind = %#x, want FrameControl", kind)
			return
		}
		var req Message
		mustUnmarshal(t, payload, &req)
		if req.Type != TypeListWorkspaces {
			t.Errorf("req.Type = %q, want %q", req.Type, TypeListWorkspaces)
			return
		}
		_ = WriteControl(conn, &Message{
			Type: TypeWorkspaceList,
			CID:  req.CID,
			Workspaces: []WorkspaceInfo{
				{WorkspaceID: "w1", Name: "dev", PaneCount: 2},
				{WorkspaceID: "w2", Name: "", PaneCount: 0},
			},
		})
		time.Sleep(50 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	wss, err := c.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(wss) != 2 {
		t.Fatalf("len(wss) = %d, want 2", len(wss))
	}
	if wss[0].WorkspaceID != "w1" || wss[0].Name != "dev" || wss[0].PaneCount != 2 {
		t.Errorf("wss[0] = %+v, want {w1 dev 2}", wss[0])
	}
	if wss[1].WorkspaceID != "w2" || wss[1].Name != "" || wss[1].PaneCount != 0 {
		t.Errorf("wss[1] = %+v, want {w2 \"\" 0}", wss[1])
	}
}

func TestCreateRenameCloseWorkspace(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			if kind != FrameControl {
				continue
			}
			var req Message
			mustUnmarshal(t, payload, &req)
			switch req.Type {
			case TypeCreateWorkspace:
				if req.Name != "ops" {
					t.Errorf("create req.Name = %q, want %q", req.Name, "ops")
				}
				_ = WriteControl(conn, &Message{Type: TypeWorkspaceCreated, CID: req.CID, WorkspaceID: "w9"})
			case TypeRenameWorkspace:
				if req.WorkspaceID != "w9" || req.Name != "prod" {
					t.Errorf("rename req = {%q %q}, want {w9 prod}", req.WorkspaceID, req.Name)
				}
				_ = WriteControl(conn, &Message{Type: TypeOK, CID: req.CID, WorkspaceID: req.WorkspaceID})
			case TypeCloseWorkspace:
				if req.WorkspaceID != "w9" {
					t.Errorf("close req.WorkspaceID = %q, want %q", req.WorkspaceID, "w9")
				}
				_ = WriteControl(conn, &Message{Type: TypeOK, CID: req.CID})
			}
		}
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	id, err := c.CreateWorkspace("ops")
	if err != nil {
		t.Fatalf("CreateWorkspace: %v", err)
	}
	if id != "w9" {
		t.Errorf("CreateWorkspace id = %q, want %q", id, "w9")
	}
	if err := c.RenameWorkspace("w9", "prod"); err != nil {
		t.Fatalf("RenameWorkspace: %v", err)
	}
	if err := c.CloseWorkspace("w9"); err != nil {
		t.Fatalf("CloseWorkspace: %v", err)
	}
}
