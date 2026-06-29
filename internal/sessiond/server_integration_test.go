package sessiond

import (
	"bytes"
	"encoding/json"
	"net"
	"testing"
	"time"
)

// tClient is an end-to-end test client speaking the frozen wire protocol over a
// real Unix socket. A single reader goroutine demuxes incoming frames into two
// channels: control envelopes (FrameControl) and pane-output bytes
// (FramePaneData). Producers never block, so a test may interleave waitCtrl and
// waitData freely.
type tClient struct {
	t    *testing.T
	conn net.Conn
	ctrl chan *Message
	data chan []byte
}

// newTClient dials socketPath, starts the demux reader, and registers cleanup.
func newTClient(t *testing.T, socketPath string) *tClient {
	t.Helper()
	c := &tClient{
		t:    t,
		conn: dialMust(t, socketPath),
		ctrl: make(chan *Message, 1024),
		data: make(chan []byte, 1024),
	}
	go c.readLoop()
	return c
}

// readLoop reads frames forever, routing FrameControl payloads (decoded to a
// Message) to ctrl and FramePaneData bodies (decoded and COPIED) to data. On any
// read error it closes both channels so waiters observe the disconnect.
func (c *tClient) readLoop() {
	for {
		kind, payload, err := ReadFrame(c.conn)
		if err != nil {
			close(c.ctrl)
			close(c.data)
			return
		}
		switch kind {
		case FrameControl:
			var msg Message
			if err := json.Unmarshal(payload, &msg); err != nil {
				continue // skip undecodable control frame
			}
			c.ctrl <- &msg
		case FramePaneOutput:
			_, _, body := DecodePaneOutput(payload)
			cp := make([]byte, len(body))
			copy(cp, body)
			c.data <- cp
		}
	}
}

// send writes a control envelope to the daemon.
func (c *tClient) send(msg *Message) {
	c.t.Helper()
	if err := WriteControl(c.conn, msg); err != nil {
		c.t.Fatalf("send control %q: %v", msg.Type, err)
	}
}

// sendInput writes keyboard input as a BINARY pane-data frame. Input is
// connection-scoped: the daemon routes it to paneID within the workspace this
// connection is attached to.
func (c *tClient) sendInput(paneID int, data []byte) {
	c.t.Helper()
	if err := WritePaneData(c.conn, uint32(paneID), data); err != nil {
		c.t.Fatalf("sendInput pane %d: %v", paneID, err)
	}
}

// waitCtrl returns the next control message whose Type equals typ, skipping
// non-matching control frames. It fails the test after a 5s deadline or if the
// connection closes first.
func (c *tClient) waitCtrl(typ string) *Message {
	c.t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case msg, ok := <-c.ctrl:
			if !ok {
				c.t.Fatalf("connection closed while waiting for control %q", typ)
			}
			if msg.Type == typ {
				return msg
			}
		case <-deadline:
			c.t.Fatalf("timeout waiting for control %q", typ)
		}
	}
}

// waitData accumulates pane-output bytes until substr appears, returning the
// full accumulation. It fails the test after a 5s deadline or if the connection
// closes first. The returned bytes let callers assert ordering of substrings.
func (c *tClient) waitData(substr string) []byte {
	c.t.Helper()
	deadline := time.After(5 * time.Second)
	var acc []byte
	for {
		select {
		case b, ok := <-c.data:
			if !ok {
				c.t.Fatalf("connection closed while waiting for data %q (got %q)", substr, acc)
			}
			acc = append(acc, b...)
			if bytes.Contains(acc, []byte(substr)) {
				return acc
			}
		case <-deadline:
			c.t.Fatalf("timeout waiting for data %q (got %q)", substr, acc)
		}
	}
}

// TestIntegrationFullPaneLifecycle drives the complete frozen vocabulary over a
// real socket and real PTY: create-workspace, attach, create-pane (`cat`),
// binary input echo, connection-scoped resize, and close-workspace.
func TestIntegrationFullPaneLifecycle(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)

	// create-workspace => workspace-created with a non-empty id.
	c.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "integration"})
	created := c.waitCtrl(TypeWorkspaceCreated)
	if created.CID != 1 {
		t.Fatalf("workspace-created CID = %d, want 1", created.CID)
	}
	wsID := created.WorkspaceID
	if wsID == "" {
		t.Fatal("workspace-created WorkspaceID is empty")
	}

	// attach => composition reply with empty panes.
	c.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	comp := c.waitCtrl(TypeComposition)
	if comp.CID != 2 {
		t.Fatalf("composition CID = %d, want 2", comp.CID)
	}
	if len(comp.Panes) != 0 {
		t.Fatalf("composition Panes = %d, want 0 for fresh workspace", len(comp.Panes))
	}

	// create-pane `cat` (connection-scoped: no workspaceId) => pane-created ACK
	// with a positive workspace-local id, plus a pane-added broadcast (cid=0).
	c.send(&Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"cat"}})
	paneCreated := c.waitCtrl(TypePaneCreated)
	if paneCreated.CID != 3 {
		t.Fatalf("pane-created CID = %d, want 3", paneCreated.CID)
	}
	paneID := paneCreated.PaneID
	if paneID <= 0 {
		t.Fatalf("pane-created PaneID = %d, want positive", paneID)
	}
	added := c.waitCtrl(TypePaneAdded)
	if added.CID != 0 {
		t.Fatalf("pane-added CID = %d, want 0 (unsolicited event)", added.CID)
	}
	if added.PaneID != paneID {
		t.Fatalf("pane-added PaneID = %d, want %d", added.PaneID, paneID)
	}

	// Binary keyboard input => `cat` echoes it back as pane output.
	c.sendInput(paneID, []byte("hello-integration\n"))
	c.waitData("hello-integration")

	// Connection-scoped resize (no workspaceId) must not disrupt the stream.
	c.send(&Message{Type: TypeResize, CID: 4, PaneID: paneID, Cols: 120, Rows: 40})
	c.sendInput(paneID, []byte("after-resize\n"))
	c.waitData("after-resize")

	// close-workspace => broadcastAll(workspace-list) where wsID is absent.
	c.send(&Message{Type: TypeCloseWorkspace, CID: 5, WorkspaceID: wsID})
	deadline := time.After(5 * time.Second)
	for {
		select {
		case list, ok := <-c.ctrl:
			if !ok {
				t.Fatal("connection closed while waiting for workspace-list after close-workspace")
			}
			if list.Type != TypeWorkspaceList {
				continue
			}
			for _, ws := range list.Workspaces {
				if ws.WorkspaceID == wsID {
					// Still contains wsID; keep draining for the post-close broadcast.
					goto next
				}
			}
			return // success: wsID is absent from the workspace-list
		case <-deadline:
			t.Fatalf("timeout: did not receive workspace-list without wsID %q after close-workspace", wsID)
		}
	next:
	}
}

// TestIntegrationAttachUnknownThenRecover proves an attach to an unknown
// workspace fails cleanly and the same connection can recover: list the
// cold-start default, attach it, and spawn a working pane.
func TestIntegrationAttachUnknownThenRecover(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	c := newTClient(t, socketPath)

	// attach a stale id => error unknown-workspace.
	c.send(&Message{Type: TypeAttach, CID: 1, WorkspaceID: "stale-id"})
	errMsg := c.waitCtrl(TypeError)
	if errMsg.CID != 1 {
		t.Fatalf("error CID = %d, want 1", errMsg.CID)
	}
	if errMsg.Code != CodeUnknownWorkspace {
		t.Fatalf("error Code = %q, want %q", errMsg.Code, CodeUnknownWorkspace)
	}

	// list-workspaces still shows the cold-start default.
	c.send(&Message{Type: TypeListWorkspaces, CID: 2})
	list := c.waitCtrl(TypeWorkspaceList)
	if len(list.Workspaces) == 0 {
		t.Fatal("list-workspaces returned no workspaces after error")
	}
	defaultID := list.Workspaces[0].WorkspaceID

	// attach the default => composition, confirming recovery.
	c.send(&Message{Type: TypeAttach, CID: 3, WorkspaceID: defaultID})
	c.waitCtrl(TypeComposition)

	// create-pane `echo recovered` => pane-created and live output 'recovered'.
	c.send(&Message{Type: TypeCreatePane, CID: 4, Cmd: []string{"echo", "recovered"}})
	c.waitCtrl(TypePaneCreated)
	c.waitData("recovered")
}

// TestIntegrationLayoutPersistenceOnAttach verifies that save-layout persists a
// layout blob for a given breakpoint, that a re-attaching client with the same
// breakpoint receives that blob in the composition Layout field, and that
// attaching with a different (unsaved) breakpoint returns an empty Layout.
func TestIntegrationLayoutPersistenceOnAttach(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	a := newTClient(t, socketPath)

	// Create and attach to a workspace.
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "layout-test"})
	wsID := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)

	// Save a layout blob for the "desktop" breakpoint.
	const blob = `{"panels":[{"id":"main"}]}`
	a.send(&Message{Type: TypeSaveLayout, CID: 3, WorkspaceID: wsID, Breakpoint: "desktop", Layout: blob})
	ok := a.waitCtrl(TypeOK)
	if ok.CID != 3 {
		t.Fatalf("save-layout ok CID = %d, want 3", ok.CID)
	}

	// A fresh client attaching with breakpoint="desktop" must see the blob in
	// the composition reply.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 10, WorkspaceID: wsID, Breakpoint: "desktop"})
	comp := b.waitCtrl(TypeComposition)
	if comp.Layout != blob {
		t.Fatalf("composition Layout (desktop) = %q, want %q", comp.Layout, blob)
	}

	// A fresh client attaching with breakpoint="mobile" (nothing saved) must
	// see an empty layout.
	c := newTClient(t, socketPath)
	c.send(&Message{Type: TypeAttach, CID: 20, WorkspaceID: wsID, Breakpoint: "mobile"})
	comp2 := c.waitCtrl(TypeComposition)
	if comp2.Layout != "" {
		t.Fatalf("composition Layout (mobile) = %q, want \"\" (no layout saved for mobile)", comp2.Layout)
	}
}

// TestIntegrationRenamePaneBroadcasts verifies rename-pane:
//   - returns TypeOK to the sender,
//   - broadcasts TypePaneRenamed (with correct PaneID/Name) to other subscribers,
//   - the new title appears in a subsequent fresh-attach composition.
func TestIntegrationRenamePaneBroadcasts(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Client A creates a workspace, attaches, and spawns a long-lived pane.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "rename-test"})
	wsID := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)
	a.send(&Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"cat"}})
	paneID := a.waitCtrl(TypePaneCreated).PaneID
	a.waitCtrl(TypePaneAdded)

	// Client B attaches to the same workspace before the rename, so it will
	// receive the broadcast.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 10, WorkspaceID: wsID})
	b.waitCtrl(TypeComposition)

	// Client A renames the pane.
	a.send(&Message{Type: TypeRenamePane, CID: 4, PaneID: paneID, Name: "mytitle"})
	ok := a.waitCtrl(TypeOK)
	if ok.CID != 4 {
		t.Fatalf("rename-pane ok CID = %d, want 4", ok.CID)
	}

	// Client B must receive the pane-renamed broadcast.
	renamed := b.waitCtrl(TypePaneRenamed)
	if renamed.PaneID != paneID {
		t.Fatalf("pane-renamed PaneID = %d, want %d", renamed.PaneID, paneID)
	}
	if renamed.Name != "mytitle" {
		t.Fatalf("pane-renamed Name = %q, want %q", renamed.Name, "mytitle")
	}

	// A fresh client C must see the updated title in the composition reply.
	c := newTClient(t, socketPath)
	c.send(&Message{Type: TypeAttach, CID: 20, WorkspaceID: wsID})
	comp := c.waitCtrl(TypeComposition)
	if len(comp.Panes) == 0 {
		t.Fatal("composition has no panes for fresh attach after rename")
	}
	var found bool
	for _, p := range comp.Panes {
		if p.PaneID == paneID {
			found = true
			if p.Title != "mytitle" {
				t.Fatalf("composition Pane %d Title = %q, want %q", paneID, p.Title, "mytitle")
			}
		}
	}
	if !found {
		t.Fatalf("pane %d not found in composition panes %+v", paneID, comp.Panes)
	}
}

// TestIntegrationFullReplay verifies that attaching delivers the full scrollback
// replay and that replay bytes arrive before live output.
func TestIntegrationFullReplay(t *testing.T) {
	srv, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "delta-noff"})
	wsID := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)
	a.send(&Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"cat"}})
	paneID := a.waitCtrl(TypePaneCreated).PaneID
	a.waitCtrl(TypePaneAdded)

	// Write data that will become replay for the next attaching client.
	a.sendInput(paneID, []byte("noffset-replay\n"))
	a.waitData("noffset-replay")
	time.Sleep(200 * time.Millisecond)

	// Confirm the pane buffer has accumulated bytes.
	p, ok := srv.Registry().Pane(wsID, paneID)
	if !ok {
		t.Fatal("pane not found in registry")
	}
	if p.Seq() == 0 {
		t.Fatal("expected non-zero Seq after writing data")
	}

	// Attach B with no offsets → full replay.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 10, WorkspaceID: wsID})
	comp := b.waitCtrl(TypeComposition)

	if len(comp.Panes) != 1 {
		t.Fatalf("composition Panes = %d, want 1", len(comp.Panes))
	}

	// Drive a live line; "noffset-replay" must appear before it (replay ordering).
	a.sendInput(paneID, []byte("noffset-live\n"))
	acc := b.waitData("noffset-live")
	if !bytes.Contains(acc, []byte("noffset-replay")) {
		t.Fatalf("no-offset attach: replay missing from stream, got %q", acc)
	}
	si := bytes.Index(acc, []byte("noffset-replay"))
	li := bytes.Index(acc, []byte("noffset-live"))
	if si > li {
		t.Fatalf("replay ordering violated: noffset-replay at %d after noffset-live at %d", si, li)
	}
}



// TestIntegrationReplayBeforeLiveOnAttach proves a freshly attaching client
// receives the composition for pre-existing panes (NOT a pane-added) and that
// scrollback replay is delivered BEFORE any subsequent live output.
func TestIntegrationReplayBeforeLiveOnAttach(t *testing.T) {
	_, socketPath, _, cancel := startTestServer(t)
	defer cancel()

	// Client A creates a workspace and a long-lived `cat` pane, then drives a
	// scrollback line into it. `cat` never exits, so the workspace is not
	// auto-reaped before B attaches.
	a := newTClient(t, socketPath)
	a.send(&Message{Type: TypeCreateWorkspace, CID: 1, Name: "replay"})
	wsID := a.waitCtrl(TypeWorkspaceCreated).WorkspaceID
	a.send(&Message{Type: TypeAttach, CID: 2, WorkspaceID: wsID})
	a.waitCtrl(TypeComposition)
	a.send(&Message{Type: TypeCreatePane, CID: 3, Cmd: []string{"cat"}})
	paneID := a.waitCtrl(TypePaneCreated).PaneID
	a.waitCtrl(TypePaneAdded)

	a.sendInput(paneID, []byte("scrollback-line\n"))
	a.waitData("scrollback-line") // ensure it has reached the scrollback buffer
	time.Sleep(200 * time.Millisecond)

	// Client B attaches fresh: composition must report the pre-existing pane.
	b := newTClient(t, socketPath)
	b.send(&Message{Type: TypeAttach, CID: 9, WorkspaceID: wsID})
	comp := b.waitCtrl(TypeComposition)
	if len(comp.Panes) != 1 {
		t.Fatalf("composition Panes = %d, want 1 pre-existing pane", len(comp.Panes))
	}
	if comp.Panes[0].PaneID != paneID {
		t.Fatalf("composition Panes[0].PaneID = %d, want %d", comp.Panes[0].PaneID, paneID)
	}

	// Now drive a live line through A. B must observe the replayed scrollback
	// BEFORE the new live output.
	a.sendInput(paneID, []byte("live-line\n"))
	acc := b.waitData("live-line")
	si := bytes.Index(acc, []byte("scrollback-line"))
	li := bytes.Index(acc, []byte("live-line"))
	if si < 0 {
		t.Fatalf("replayed scrollback-line missing from B's stream: %q", acc)
	}
	if si > li {
		t.Fatalf("replay ordering violated: scrollback-line at %d after live-line at %d", si, li)
	}
}
