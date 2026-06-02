package sessiond

import (
	"encoding/json"
	"errors"
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

func TestAttachReturnsComposition(t *testing.T) {
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
		if req.Type != TypeAttach {
			t.Errorf("req.Type = %q, want %q", req.Type, TypeAttach)
			return
		}
		_ = WriteControl(conn, &Message{
			Type:        TypeComposition,
			CID:         req.CID,
			WorkspaceID: req.WorkspaceID,
			Panes: []PaneInfo{
				{PaneID: 1, Cols: 80, Rows: 24, Title: "shell"},
				{PaneID: 2, Cols: 80, Rows: 24},
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

	comp, err := c.Attach("w1")
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if comp.WorkspaceID != "w1" {
		t.Errorf("comp.WorkspaceID = %q, want %q", comp.WorkspaceID, "w1")
	}
	if len(comp.Panes) != 2 {
		t.Fatalf("len(comp.Panes) = %d, want 2", len(comp.Panes))
	}
	if comp.Panes[0].PaneID != 1 || comp.Panes[0].Cols != 80 || comp.Panes[0].Rows != 24 || comp.Panes[0].Title != "shell" {
		t.Errorf("comp.Panes[0] = %+v, want {1 80 24 shell}", comp.Panes[0])
	}
}

func TestAttachEmptyCompositionIsValid(t *testing.T) {
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
		_ = WriteControl(conn, &Message{
			Type:        TypeComposition,
			CID:         req.CID,
			WorkspaceID: req.WorkspaceID,
		})
		time.Sleep(50 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	comp, err := c.Attach("empty")
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	if comp.WorkspaceID != "empty" {
		t.Errorf("comp.WorkspaceID = %q, want %q", comp.WorkspaceID, "empty")
	}
	if len(comp.Panes) != 0 {
		t.Errorf("len(comp.Panes) = %d, want 0", len(comp.Panes))
	}
}

func TestCreatePaneReturnsID(t *testing.T) {
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
		if req.Type != TypeCreatePane {
			t.Errorf("req.Type = %q, want %q", req.Type, TypeCreatePane)
		}
		if req.WorkspaceID != "" {
			t.Errorf("req.WorkspaceID = %q, want \"\" (connection-scoped)", req.WorkspaceID)
		}
		if len(req.Cmd) != 1 || req.Cmd[0] != "bash" {
			t.Errorf("req.Cmd = %v, want [bash]", req.Cmd)
		}
		_ = WriteControl(conn, &Message{Type: TypePaneCreated, CID: req.CID, PaneID: 7})
		time.Sleep(50 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	id, err := c.CreatePane([]string{"bash"})
	if err != nil {
		t.Fatalf("CreatePane: %v", err)
	}
	if id != 7 {
		t.Errorf("CreatePane id = %d, want 7", id)
	}
}

func TestAttachUnknownWorkspace(t *testing.T) {
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
		_ = WriteControl(conn, &Message{
			Type:        TypeError,
			CID:         req.CID,
			Code:        CodeUnknownWorkspace,
			Error:       "no such workspace",
			WorkspaceID: req.WorkspaceID,
		})
		time.Sleep(50 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	_, err = c.Attach("nope")
	if err == nil {
		t.Fatal("Attach: expected error, got nil")
	}
	var de *DaemonError
	if !errors.As(err, &de) {
		t.Fatalf("Attach error = %T, want *DaemonError", err)
	}
	if de.Code != CodeUnknownWorkspace {
		t.Errorf("de.Code = %q, want %q", de.Code, CodeUnknownWorkspace)
	}
}
