package sessiond

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
)

// Server owns the daemon's Unix control socket, the workspace Registry, and the
// set of attached subscribers per workspace. It accepts control connections,
// dispatches frozen-protocol requests, and fans out replay-before-live data on
// attach.
type Server struct {
	reg    *Registry
	socket string

	mu   sync.Mutex
	subs map[string]map[*conn]bool // workspaceId -> set of attached connections
	conns map[*conn]bool            // all live connections
}

// NewServer returns a Server bound to socketPath with a fresh Registry. It
// errors on an empty socket path.
func NewServer(socketPath string) (*Server, error) {
	if socketPath == "" {
		return nil, errors.New("sessiond: empty socket path")
	}
	return &Server{
		reg:    NewRegistry(),
		socket: socketPath,
		subs:   make(map[string]map[*conn]bool),
		conns:  make(map[*conn]bool),
	}, nil
}

// Registry exposes the server's Registry for tests and later phases.
func (s *Server) Registry() *Registry { return s.reg }

// ListenAndServe creates the socket (0600 inside a 0700 dir), guarantees a
// cold-start default workspace, and serves control connections until ctx is
// cancelled. It returns nil on a graceful (ctx-driven) shutdown and a non-nil
// error only for an unexpected accept/listen failure.
func (s *Server) ListenAndServe(ctx context.Context) error {
	dir := filepath.Dir(s.socket)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	_ = os.Remove(s.socket)

	ln, err := net.Listen("unix", s.socket)
	if err != nil {
		return err
	}
	if err := os.Chmod(s.socket, 0o600); err != nil {
		_ = ln.Close()
		return err
	}

	// Cold-start: ensure the first attach always lands somewhere.
	s.reg.EnsureDefault()

	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		nc, err := ln.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil // graceful shutdown
			default:
				return err
			}
		}
		if !s.peerAllowed(nc) {
			_ = nc.Close()
			continue
		}
		c := newConn(s, nc)
		s.mu.Lock()
		s.conns[c] = true
		s.mu.Unlock()
		go c.serve()
	}
}

// unsubscribe removes c from every workspace subscriber set (deleting now-empty
// sets) and clears its attached marker.
func (s *Server) unsubscribe(c *conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unsubscribeLocked(c)
}

// unsubscribeLocked is unsubscribe's body for callers already holding s.mu.
func (s *Server) unsubscribeLocked(c *conn) {
	for wsID, set := range s.subs {
		if set[c] {
			delete(set, c)
			if len(set) == 0 {
				delete(s.subs, wsID)
			}
		}
	}
	c.attached = ""
}

// attachConn implements the FROZEN attach ordering under s.mu:
//  1. composition reply FIRST (always sent, nil panes when empty),
//  2. per-pane replay data frames enqueued BEFORE the conn is marked live,
//  3. mark live so later broadcasts land strictly AFTER replay frames.
//
// offsets carries the client's last-known absolute seq per pane so only the
// delta since that position is replayed. An absent or zero entry means full
// replay from the oldest retained byte.
func (s *Server) attachConn(c *conn, wsID string, cid uint64, breakpoint string, offsets []PaneOffset) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Build a fast-lookup map: paneID → client's last-known seq.
	want := make(map[int]uint64, len(offsets))
	for _, o := range offsets {
		want[o.PaneID] = o.Seq
	}

	// Iterate panes in deterministic order, computing the per-pane replay
	// delta and building the PaneInfo slice with the anchor Seq in one pass.
	paneIDs := s.reg.PaneIDs(wsID)
	paneInfos := make([]PaneInfo, 0, len(paneIDs))
	type replayItem struct {
		paneID uint32
		data   []byte
	}
	replays := make([]replayItem, 0, len(paneIDs))

	for _, paneID := range paneIDs {
		p, ok := s.reg.Pane(wsID, paneID)
		if !ok {
			continue
		}
		info := p.Info()
		data, start := p.ReplayFrom(want[paneID])
		info.Seq = start
		paneInfos = append(paneInfos, info)
		if len(data) > 0 {
			replays = append(replays, replayItem{uint32(paneID), data})
		}
	}

	// (1) composition reply first.
	c.sub.enqueueControl(&Message{
		Type:        TypeComposition,
		CID:         cid,
		WorkspaceID: wsID,
		Panes:       paneInfos,
		Layout:      s.reg.Layout(wsID, breakpoint),
	})

	// (2) replay frames before going live.
	for _, r := range replays {
		c.sub.enqueuePaneData(r.paneID, r.data)
	}

	// Re-attach: drop any prior workspace subscription first so this conn never
	// keeps receiving a previously-attached workspace's output after switching.
	s.unsubscribeLocked(c)

	// (3) go live.
	set, ok := s.subs[wsID]
	if !ok {
		set = make(map[*conn]bool)
		s.subs[wsID] = set
	}
	set[c] = true
	c.attached = wsID
}

// broadcast enqueues msg to every subscriber attached to wsID. Enqueue never
// blocks, so holding s.mu is safe.
func (s *Server) broadcast(wsID string, msg *Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.subs[wsID] {
		c.sub.enqueueControl(msg)
	}
}

// broadcastAll enqueues msg to every live connection. Enqueue never blocks,
// so holding s.mu is safe.
func (s *Server) broadcastAll(msg *Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		c.sub.enqueueControl(msg)
	}
}

// broadcastPaneData enqueues a pane-data frame to every subscriber attached to
// wsID.
func (s *Server) broadcastPaneData(wsID string, paneID int, data []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.subs[wsID] {
		c.sub.enqueuePaneData(uint32(paneID), data)
	}
}

// handlePaneExit removes an exited pane and emits the frozen close events. It is
// a no-op when the pane was already removed (e.g. via close-workspace) so no
// duplicate events are produced.
func (s *Server) handlePaneExit(wsID string, paneID int) {
	_, remaining, ok := s.reg.RemovePane(wsID, paneID)
	if !ok {
		return
	}
	s.broadcast(wsID, &Message{Type: TypePaneClosed, WorkspaceID: wsID, PaneID: paneID})
	if remaining == 0 {
		if removed, _ := s.reg.ReapIfEmpty(wsID); removed {
			s.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: s.reg.List()})
		}
	}
}

// conn is one control connection. attached holds the workspace this connection
// is attached to ("" when not attached); it is touched only by this conn's own
// read goroutine, so it needs no lock.
type conn struct {
	srv      *Server
	nc       net.Conn
	sub      *subscriber
	attached string
}

// newConn wraps nc with a subscriber for serialized writes.
func newConn(s *Server, nc net.Conn) *conn {
	return &conn{srv: s, nc: nc, sub: newSubscriber(nc, 0)}
}

// serve reads frames until the connection closes, dispatching control messages
// and bridging keyboard input to the attached workspace's panes.
func (c *conn) serve() {
	defer c.cleanup()
	for {
		kind, payload, err := ReadFrame(c.nc)
		if err != nil {
			return
		}
		switch kind {
		case FrameControl:
			var msg Message
			if err := json.Unmarshal(payload, &msg); err != nil {
				continue // skip undecodable control frame
			}
			c.handle(msg)
		case FramePaneData:
			paneID, data := DecodePaneData(payload)
			if c.attached == "" {
				continue
			}
			if p, ok := c.srv.reg.Pane(c.attached, int(paneID)); ok {
				_, _ = p.Write(data)
			}
		}
	}
}

// cleanup unsubscribes the connection, removes it from the live-connections
// set, and closes its subscriber (and socket).
func (c *conn) cleanup() {
	c.srv.unsubscribe(c)
	c.srv.mu.Lock()
	delete(c.srv.conns, c)
	c.srv.mu.Unlock()
	c.sub.Close()
}

// handle dispatches one decoded control message.
func (c *conn) handle(msg Message) {
	switch msg.Type {
	case TypeCreateWorkspace:
		id := c.srv.reg.AddWorkspace(msg.Name, msg.ClientRef)
		c.reply(&Message{Type: TypeWorkspaceCreated, CID: msg.CID, WorkspaceID: id, Name: msg.Name, ClientRef: msg.ClientRef})
		c.srv.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: c.srv.reg.List()})
	case TypeListWorkspaces:
		c.reply(&Message{Type: TypeWorkspaceList, CID: msg.CID, Workspaces: c.srv.reg.List()})
	case TypeRenameWorkspace:
		if c.srv.reg.RenameWorkspace(msg.WorkspaceID, msg.Name) {
			c.reply(&Message{Type: TypeOK, CID: msg.CID})
			c.srv.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: c.srv.reg.List()})
		} else {
			c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		}
	case TypeCloseWorkspace:
		c.closeWorkspace(msg)
	case TypeAttach:
		c.attach(msg)
	case TypeCreatePane:
		c.createPane(msg)
	case TypeResize:
		if c.attached == "" {
			return
		}
		if p, ok := c.srv.reg.Pane(c.attached, msg.PaneID); ok {
			_ = p.Resize(msg.Cols, msg.Rows)
		}
	case TypeRenamePane:
		if c.attached != "" && c.srv.reg.RenamePane(c.attached, msg.PaneID, msg.Name) {
			c.reply(&Message{Type: TypeOK, CID: msg.CID})
			// Tell other attached clients so they update live.
			c.srv.broadcast(c.attached, &Message{Type: TypePaneRenamed, PaneID: msg.PaneID, Name: msg.Name})
		}
	case TypeSaveLayout:
		wsID := msg.WorkspaceID
		if wsID == "" {
			wsID = c.attached
		}
		if c.srv.reg.SaveLayout(wsID, msg.Breakpoint, msg.Layout) {
			c.reply(&Message{Type: TypeOK, CID: msg.CID})
		} else {
			c.replyError(msg.CID, CodeUnknownWorkspace, "cannot save layout")
		}
	}
}

// attach attaches this connection to the requested workspace, replying with the
// composition snapshot (or an error for an unknown workspace).
func (c *conn) attach(msg Message) {
	if !c.srv.reg.Has(msg.WorkspaceID) {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		return
	}
	c.srv.attachConn(c, msg.WorkspaceID, msg.CID, msg.Breakpoint, msg.Offsets)
}

// createPane spawns a pane in the connection's attached workspace, ACKs the
// actor with the assigned id, then broadcasts a pane-added event to all
// subscribers (pane-added covers only panes created AFTER attach).
func (c *conn) createPane(msg Message) {
	wsID := c.attached
	if wsID == "" || !c.srv.reg.Has(wsID) {
		c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
		return
	}
	localID, ok := c.srv.reg.AllocPaneID(wsID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
		return
	}
	cols, rows := sizeOrDefault(msg.Cols, msg.Rows)
	p, err := NewPane(
		localID,
		msg.Cmd,
		cols, rows,
		NewRawBuffer(0),
		func(id int, data []byte) { c.srv.broadcastPaneData(wsID, id, data) },
		func(id int) { c.srv.handlePaneExit(wsID, id) },
	)
	if err != nil {
		c.replyError(msg.CID, CodePaneSpawnFailed, err.Error())
		return
	}
	c.srv.reg.PutPane(wsID, p)
	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	c.srv.broadcast(wsID, &Message{Type: TypePaneAdded, WorkspaceID: wsID, PaneID: localID, Cols: cols, Rows: rows, ClientRef: msg.ClientRef})
}

// closeWorkspace removes a workspace and kills its panes, then broadcasts the
// updated workspace list to every connection. Panes are closed before
// broadcastAll so reg.List() reflects accurate pane counts. Exit handlers see
// the workspace already gone and emit no duplicate pane-closed events.
func (c *conn) closeWorkspace(msg Message) {
	panes, _, ok := c.srv.reg.CloseWorkspace(msg.WorkspaceID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		return
	}
	for _, p := range panes {
		p.Close()
	}
	c.reply(&Message{Type: TypeOK, CID: msg.CID})
	c.srv.broadcastAll(&Message{Type: TypeWorkspaceList, Workspaces: c.srv.reg.List()})
}

// reply enqueues a control reply to this connection.
func (c *conn) reply(msg *Message) { c.sub.enqueueControl(msg) }

// replyError enqueues a TypeError envelope echoing cid.
func (c *conn) replyError(cid uint64, code, detail string) {
	c.sub.enqueueControl(&Message{Type: TypeError, CID: cid, Code: code, Error: detail})
}

// sizeOrDefault returns the given dimensions, substituting the 80x24 default for
// any non-positive value.
func sizeOrDefault(cols, rows int) (int, int) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return cols, rows
}
