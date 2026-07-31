package sessiond

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Server owns the daemon's Unix control socket, the workspace Registry, and the
// set of attached subscribers per workspace. It accepts control connections,
// dispatches frozen-protocol requests, and fans out replay-before-live data on
// attach.
type Server struct {
	reg    *Registry
	socket string

	mu    sync.Mutex
	subs  map[string]map[*conn]bool // workspaceId -> set of attached connections
	conns map[*conn]bool            // all live connections
}

// NewServer returns a Server bound to socketPath with a fresh Registry. It
// errors on an empty socket path.
func NewServer(socketPath string) (*Server, error) {
	if socketPath == "" {
		return nil, errors.New("sessiond: empty socket path")
	}
	s := &Server{
		reg:    NewRegistry(),
		socket: socketPath,
		subs:   make(map[string]map[*conn]bool),
		conns:  make(map[*conn]bool),
	}
	return s, nil
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
func (s *Server) attachConn(c *conn, wsID string, cid uint64, breakpoint string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Always replay the full retained buffer — no delta tracking.
	// TotalSeq = len(replayBytes) so the client knows exactly how many bytes
	// to expect and can drain once they all arrive.
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
		data := p.Replay()
		info.TotalSeq = uint64(len(data))
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
func (s *Server) handlePaneExit(wsID string, paneID int, exitCode int, runtimeMs int64) {
	_, remaining, ok := s.reg.RemovePane(wsID, paneID)
	if !ok {
		return
	}
	code := exitCode
	s.broadcast(wsID, &Message{
		Type: TypePaneClosed, WorkspaceID: wsID, PaneID: paneID,
		ProcessExitCode: &code, RuntimeMs: runtimeMs,
	})
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
	kind     string // "interactive" (browser/human) | "agent" (MCP); set once in attach()
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
				// Only interactive (human) connections' keystrokes reclaim
				// authority — agent (MCP) input must never do so, per the
				// design's MCP-exclusion requirement. No resize, no
				// broadcast: this only updates the authority pointer so a
				// SUBSEQUENT resize/pane-focus from this conn is honored.
				if c.kind == "interactive" {
					p.TouchAuthority(c, time.Now())
				}
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
	case TypeClosePane:
		c.closePane(msg)
	case TypeResize:
		if c.attached == "" {
			return
		}
		if p, ok := c.srv.reg.Pane(c.attached, msg.PaneID); ok {
			// ClaimAuthority already promotes on nil authority, so a resize
			// from any conn on a never-focused pane bootstraps that conn as
			// authoritative — the solo-client/initial-creation degenerate
			// case from the design's Error Handling section.
			promoted := p.ClaimAuthority(c, time.Now())
			if p.IsAuthoritative(c) {
				before := p.Info()
				_ = p.Resize(msg.Cols, msg.Rows)
				after := p.Info()
				if promoted || before.Cols != after.Cols || before.Rows != after.Rows {
					c.broadcastPaneResizedExcept(after.Cols, after.Rows, msg.PaneID)
				}
			}
			// Non-authoritative resizes are silently skipped: no error, no
			// disconnect, no pty.Setsize call — matches the design's "Non-
			// authoritative resizes... never call pty.Setsize".
		}
	case TypePaneFocus:
		// Agents (MCP/automation) never claim focus authority; silently
		// ignore rather than erroring the connection, since a well-behaved
		// agent should never send this but a defensive no-op is safer.
		if c.attached == "" || c.kind != "interactive" {
			return
		}
		if p, ok := c.srv.reg.Pane(c.attached, msg.PaneID); ok {
			// Unlike TypeResize, pane-focus is inherently an authority-
			// claiming action, so apply the resize unconditionally after
			// claiming rather than gating on IsAuthoritative first.
			p.ClaimAuthority(c, time.Now())
			_ = p.Resize(msg.Cols, msg.Rows)
			info := p.Info()
			c.broadcastPaneResizedExcept(info.Cols, info.Rows, msg.PaneID)
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
	case TypeLayoutCommand:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		msg.CID = 0
		c.srv.broadcast(c.attached, &msg)
	case TypeGetLayout:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		layout := c.srv.reg.Layout(c.attached, "wide")
		panes := c.srv.reg.PaneInfos(c.attached)
		ascii := ASCIILayout(layout, panes, -1)
		c.reply(&Message{Type: TypeLayoutResult, CID: msg.CID, ASCII: ascii})
	case TypeCreateBrowserPane:
		c.createBrowserPane(msg)
	case TypeCloseBrowserPane:
		// No server-side engine: just remove the pane handle and broadcast
		// pane-closed. Reuse closePane (idempotent for unknown ids).
		c.closePane(msg)
	case TypeBrowserCommand, TypeBrowserResult:
		// Relay to every subscriber of the attached workspace. The command flows
		// to the client owning the pane; the result flows back to subscribers
		// (e.g. the MCP agent). cid is preserved for correlation.
		if c.attached == "" {
			return
		}
		relay := msg
		c.srv.broadcast(c.attached, &relay)
	case TypeBrowserURL, TypeBrowserLoad:
		// Client-to-server navigation notifications (URL committed / page load
		// complete). Relay to every subscriber of the attached workspace so MCP
		// agents can observe navigation without polling.
		if c.attached == "" {
			return
		}
		relay := msg
		c.srv.broadcast(c.attached, &relay)
	case TypeScreenSnapshot:
		if c.attached == "" {
			c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
			return
		}
		p, ok := c.srv.reg.Pane(c.attached, msg.PaneID)
		if !ok {
			c.replyError(msg.CID, CodePaneNotFound, "pane not found")
			return
		}
		vb, ok := p.buf.(*VTBuffer)
		if !ok {
			// Non-VT pane (browser pane with nil buf, or RawBuffer): return
			// empty text so the caller still gets a well-formed reply.
			c.reply(&Message{Type: TypeScreenSnapshotResult, CID: msg.CID, PaneID: msg.PaneID})
			return
		}
		row, col := vb.CursorPos()
		c.reply(&Message{
			Type:   TypeScreenSnapshotResult,
			CID:    msg.CID,
			PaneID: msg.PaneID,
			Text:   vb.ScreenText(),
			Cursor: &CursorPos{Row: row, Col: col},
		})
	}
}

// attach attaches this connection to the requested workspace, replying with the
// composition snapshot (or an error for an unknown workspace).
func (c *conn) attach(msg Message) {
	if !c.srv.reg.Has(msg.WorkspaceID) {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		return
	}
	c.kind = msg.ClientKind
	if c.kind == "" {
		// Backward-compat safety net: both real call sites (mcp/client.go,
		// server/ws.go) are updated in this same change to always send an
		// explicit ClientKind, so this default is not an expected runtime path.
		c.kind = "interactive"
	}
	c.srv.attachConn(c, msg.WorkspaceID, msg.CID, msg.Breakpoint)
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
	onPromptFn := func(id int, m *Message) {
		m.WorkspaceID = wsID
		m.PaneID = id
		c.srv.broadcast(wsID, m)
	}
	p, err := NewPane(
		localID,
		msg.Cmd,
		cols, rows,
		nil, // nil → NewPane installs VTBuffer. get_screen / TypeScreenSnapshot requires VTBuffer.
		// Emulator reply drain goroutine in NewPane forwards query responses back to the PTY
		// (see pane.go) so the emulator's internal io.Pipe never blocks emu.Write().
		func(id int, data []byte) { c.srv.broadcastPaneData(wsID, id, data) },
		func(id int, exitCode int, runtimeMs int64) { c.srv.handlePaneExit(wsID, id, exitCode, runtimeMs) },
		onPromptFn, // stored before readLoop starts — eliminates OSC 133 race
	)
	if err != nil {
		c.replyError(msg.CID, CodePaneSpawnFailed, err.Error())
		return
	}
	c.srv.reg.PutPane(wsID, p)
	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	c.srv.broadcast(wsID, &Message{
		Type:            TypePaneAdded,
		WorkspaceID:     wsID,
		PaneID:          localID,
		Cols:            cols,
		Rows:            rows,
		ClientRef:       msg.ClientRef,
		Placement:       msg.Placement,
		ReferencePaneID: msg.ReferencePaneID,
	})
}

// closePane kills the pane identified by msg.PaneID in the connection's
// attached workspace, then broadcasts the pane-closed event to all subscribers.
// It is a no-op for unknown pane IDs (idempotent).
func (c *conn) closePane(msg Message) {
	wsID := c.attached
	if wsID == "" {
		c.replyError(msg.CID, CodeUnknownWorkspace, "not attached to a workspace")
		return
	}
	p, _, ok := c.srv.reg.RemovePane(wsID, msg.PaneID)
	if !ok {
		// Pane already gone; send ok so the client doesn't hang.
		c.reply(&Message{Type: TypeOK, CID: msg.CID})
		return
	}
	p.Close()
	c.reply(&Message{Type: TypeOK, CID: msg.CID})
	c.srv.broadcast(wsID, &Message{Type: TypePaneClosed, PaneID: msg.PaneID})
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

// createBrowserPane allocates a client-rendered browser pane handle in the
// attached workspace. It replies with TypePaneCreated and broadcasts
// TypePaneAdded with SurfaceKind "browser". There is NO server-side engine —
// the webview lives on the client; the daemon only routes browser-command /
// browser-result for this pane id.
func (c *conn) createBrowserPane(msg Message) {
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
	// A browser pane carries no PTY. NewBrowserPane installs a nil buffer so the
	// registry tracks the handle without spawning a process.
	c.srv.reg.PutPane(wsID, NewBrowserPane(localID))

	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	c.srv.broadcast(wsID, &Message{
		Type:            TypePaneAdded,
		WorkspaceID:     wsID,
		PaneID:          localID,
		SurfaceKind:     "browser",
		Title:           "Browser",
		ClientRef:       msg.ClientRef,
		Placement:       msg.Placement,
		ReferencePaneID: msg.ReferencePaneID,
	})
}

// reply enqueues a control reply to this connection.
func (c *conn) reply(msg *Message) { c.sub.enqueueControl(msg) }

// replyError enqueues a TypeError envelope echoing cid.
func (c *conn) replyError(cid uint64, code, detail string) {
	c.sub.enqueueControl(&Message{Type: TypeError, CID: cid, Code: code, Error: detail})
}

// broadcastPaneResizedExcept sends a TypePaneResized event carrying the new
// canonical cols/rows for paneID to every OTHER conn attached to c's
// workspace (excluding c itself, which already knows its own new size).
func (c *conn) broadcastPaneResizedExcept(cols, rows, paneID int) {
	c.srv.mu.Lock()
	defer c.srv.mu.Unlock()
	for other := range c.srv.subs[c.attached] {
		if other == c {
			continue
		}
		other.sub.enqueueControl(&Message{Type: TypePaneResized, PaneID: paneID, Cols: cols, Rows: rows})
	}
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
