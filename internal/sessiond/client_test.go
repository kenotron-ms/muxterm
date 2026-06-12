package sessiond

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
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
//
// We use os.MkdirTemp("/tmp", ...) rather than t.TempDir() to avoid macOS's
// 104-byte limit on Unix socket paths: t.TempDir() can produce paths like
// /var/folders/_j/<long-hash>/T/<TestName><random>/001/ that exceed the limit
// when combined with the socket filename and a long test name.
func newFakeDaemon(t *testing.T, handler func(conn net.Conn)) *fakeDaemon {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "mux")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "s")
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

	comp, err := c.Attach("w1", "")
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

	comp, err := c.Attach("empty", "")
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

	_, err = c.Attach("nope", "")
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

func TestInputAndResize(t *testing.T) {
	type input struct {
		paneID uint32
		data   []byte
	}
	gotInput := make(chan input, 1)
	gotResize := make(chan Message, 1)

	fd := newFakeDaemon(t, func(conn net.Conn) {
		for {
			kind, payload, err := ReadFrame(conn)
			if err != nil {
				return
			}
			switch kind {
			case FramePaneData:
				paneID, data := DecodePaneData(payload)
				gotInput <- input{paneID: paneID, data: data}
			case FrameControl:
				var req Message
				mustUnmarshal(t, payload, &req)
				if req.Type == TypeResize {
					gotResize <- req
				}
			}
		}
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()
	go c.Run()

	if err := c.Input(3, []byte("ls\r")); err != nil {
		t.Fatalf("Input: %v", err)
	}
	if err := c.Resize(3, 120, 30); err != nil {
		t.Fatalf("Resize: %v", err)
	}

	select {
	case in := <-gotInput:
		if in.paneID != 3 {
			t.Errorf("input paneID = %d, want 3", in.paneID)
		}
		if string(in.data) != "ls\r" {
			t.Errorf("input data = %q, want %q", string(in.data), "ls\r")
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for input frame")
	}

	select {
	case rz := <-gotResize:
		if rz.PaneID != 3 {
			t.Errorf("resize PaneID = %d, want 3", rz.PaneID)
		}
		if rz.Cols != 120 {
			t.Errorf("resize Cols = %d, want 120", rz.Cols)
		}
		if rz.Rows != 30 {
			t.Errorf("resize Rows = %d, want 30", rz.Rows)
		}
		if rz.WorkspaceID != "" {
			t.Errorf("resize WorkspaceID = %q, want \"\" (connection-scoped)", rz.WorkspaceID)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for resize control frame")
	}
}

// TestDispatchEvent_PaneAdded_PassesBrowserFields verifies that a TypePaneAdded message
// from the daemon carries its browser-specific fields (SurfaceKind, BrowserPort, BrowserPath,
// ProxyHeaders) all the way through dispatchEvent to the OnPaneAdded handler.
func TestDispatchEvent_PaneAdded_PassesBrowserFields(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		_ = WriteControl(conn, &Message{
			Type:         TypePaneAdded,
			PaneID:       9,
			Cols:         100,
			Rows:         30,
			Title:        "chrome",
			SurfaceKind:  "browser",
			BrowserPort:  3000,
			BrowserPath:  "/app",
			ProxyHeaders: map[string]string{"X-Custom": "value"},
		})
		time.Sleep(100 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	ch := make(chan PaneInfo, 1)
	c.SetHandlers(Handlers{
		OnPaneAdded: func(pane PaneInfo) {
			ch <- pane
		},
	})

	go c.Run()

	select {
	case pane := <-ch:
		if pane.SurfaceKind != "browser" {
			t.Errorf("SurfaceKind = %q, want %q", pane.SurfaceKind, "browser")
		}
		if pane.BrowserPort != 3000 {
			t.Errorf("BrowserPort = %d, want 3000", pane.BrowserPort)
		}
		if pane.BrowserPath != "/app" {
			t.Errorf("BrowserPath = %q, want %q", pane.BrowserPath, "/app")
		}
		if pane.ProxyHeaders["X-Custom"] != "value" {
			t.Errorf("ProxyHeaders[X-Custom] = %q, want %q", pane.ProxyHeaders["X-Custom"], "value")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for PaneAdded event")
	}
}

func TestHandlersReceiveOutputAndEvents(t *testing.T) {
	fd := newFakeDaemon(t, func(conn net.Conn) {
		_ = WritePaneData(conn, 5, []byte("hello"))
		_ = WriteControl(conn, &Message{Type: TypePaneAdded, PaneID: 6, Cols: 80, Rows: 24, Title: "vim"})
		_ = WriteControl(conn, &Message{Type: TypePaneClosed, PaneID: 5})
		_ = WriteControl(conn, &Message{Type: TypeWorkspaceRenamed, WorkspaceID: "w1", Name: "ops"})
		_ = WriteControl(conn, &Message{Type: TypeWorkspaceClosed, WorkspaceID: "w1"})
		time.Sleep(100 * time.Millisecond)
	})

	c, err := Dial(fd.sockPath)
	if err != nil {
		t.Fatalf("Dial: %v", err)
	}
	defer c.Close()

	var mu sync.Mutex
	var log []string
	add := func(s string) {
		mu.Lock()
		log = append(log, s)
		mu.Unlock()
	}

	c.SetHandlers(Handlers{
		OnPaneOutput: func(paneID uint32, data []byte) {
			add("out:" + itoa(int(paneID)) + ":" + string(data))
		},
		OnPaneAdded: func(pane PaneInfo) {
			add("added:" + itoa(pane.PaneID) + ":" + pane.Title)
		},
		OnPaneClosed: func(paneID int) {
			add("closed:" + itoa(paneID))
		},
		OnWorkspaceRenamed: func(workspaceID, name string) {
			add("renamed:" + workspaceID + ":" + name)
		},
		OnWorkspaceClosed: func(workspaceID string) {
			add("wsclosed:" + workspaceID)
		},
	})

	go c.Run()

	deadline := time.After(2 * time.Second)
	for {
		mu.Lock()
		n := len(log)
		mu.Unlock()
		if n >= 5 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("timed out waiting for events; got %d, want >= 5", n)
		case <-time.After(10 * time.Millisecond):
		}
	}

	want := []string{
		"out:5:hello",
		"added:6:vim",
		"closed:5",
		"renamed:w1:ops",
		"wsclosed:w1",
	}
	mu.Lock()
	defer mu.Unlock()
	if len(log) != len(want) {
		t.Fatalf("log = %v, want %v", log, want)
	}
	for i := range want {
		if log[i] != want[i] {
			t.Errorf("log[%d] = %q, want %q", i, log[i], want[i])
		}
	}
}
