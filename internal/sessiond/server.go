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

// Connection kinds carried by Message.ClientKind on attach and recorded in
// conn.kind. Only ClientKindInteractive is eligible for pane focus/PTY-size
// authority; the two programmatic kinds are excluded by the existing
// interactive-only gates on TypeResize, TypePaneFocus, and pane-data input,
// so a script or an agent can never steal sizing authority from the human
// looking at the pane.
const (
	ClientKindInteractive = "interactive" // browser / human
	ClientKindAgent       = "agent"       // MCP / automation, long-lived
	ClientKindCLI         = "cli"         // muxterm <subcommand>, one-shot; also skips attach replay
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

	// preview is the sidebar preview ticker's per-workspace change-gating
	// state, keyed by workspace id. Guarded by mu, pruned each tick to the
	// live workspace set. See the preview section at the end of this file.
	preview map[string]*previewState

	// sessions is the home view's session-state change gate. Guarded by mu
	// (its only mutators, rearm and changed, are both called under it). See
	// the session-state section at the end of this file.
	sessions *sessionStore
}

// NewServer returns a Server bound to socketPath with a fresh Registry. It
// errors on an empty socket path.
func NewServer(socketPath string) (*Server, error) {
	if socketPath == "" {
		return nil, errors.New("sessiond: empty socket path")
	}
	s := &Server{
		reg:      NewRegistry(),
		socket:   socketPath,
		subs:     make(map[string]map[*conn]bool),
		conns:    make(map[*conn]bool),
		preview:  make(map[string]*previewState),
		sessions: newSessionStore(),
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

	// Sidebar preview tiles. Costs nothing until a connection opts in, and
	// stops on the same ctx cancellation that closes the listener.
	go s.previewLoop(ctx)

	// Home-view session state. Same shape, same guarantees: zero cost until a
	// connection opts in, stopped by the same ctx cancellation.
	go s.sessionStateLoop(ctx)

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
			// Clear this conn's authority from every pane in the workspace it
			// was subscribed to, so a dead conn never blocks a future
			// legitimate claim (design's "Authoritative client disconnects"
			// error-handling case).
			for _, paneID := range s.reg.PaneIDs(wsID) {
				if p, ok := s.reg.Pane(wsID, paneID); ok {
					p.ClearAuthorityIfOwner(c)
				}
			}
		}
	}
	c.attached = ""
}

// attachConn implements the FROZEN attach ordering under s.mu:
//  1. composition reply FIRST (always sent, nil panes when empty),
//  2. per-pane replay data frames enqueued BEFORE the conn is marked live,
//  3. mark live so later broadcasts land strictly AFTER replay frames.
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
		// A "cli" conn is a one-shot query client (muxterm read-screen and
		// friends). It must never trigger a full replay flood just to answer a
		// single request, so skip both the Replay() render and the pane-data
		// enqueue for it. TotalSeq stays 0, which is the honest "no replay
		// bytes will follow" value for this connection.
		if c.kind == ClientKindCLI {
			paneInfos = append(paneInfos, info)
			continue
		}
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
			s.broadcastWorkspaceList()
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
	kind     string // ClientKindInteractive | ClientKindAgent | ClientKindCLI; set in attach()

	// previewOn is this connection's sidebar-preview opt-in. Unlike attached
	// it is guarded by Server.mu, because the preview ticker goroutine reads
	// it while fanning tiles out. See setPreviewOn.
	previewOn bool

	// sessionStateOn is this connection's home-view session-state opt-in.
	// Guarded by Server.mu for the same reason as previewOn: its own ticker
	// goroutine reads it while fanning rows out. See setSessionStateOn.
	sessionStateOn bool
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
		c.srv.broadcastWorkspaceList()
	case TypeListWorkspaces:
		c.srv.replyWorkspaceList(c, msg.CID)
	case TypeRenameWorkspace:
		if c.srv.reg.RenameWorkspace(msg.WorkspaceID, msg.Name) {
			c.reply(&Message{Type: TypeOK, CID: msg.CID})
			c.srv.broadcastWorkspaceList()
		} else {
			c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		}
	case TypeCloseWorkspace:
		c.closeWorkspace(msg)
	case TypeCloseIntent:
		c.closeIntent(msg)
	case TypeCloseConfirm:
		c.closeConfirm(msg)
	case TypeAttach:
		c.attach(msg)
	case TypeCreatePane:
		c.createPane(msg)
	case TypeClosePane:
		c.closePane(msg)
	case TypeResize:
		// Agents (MCP/automation) never claim or hold PTY-sizing authority —
		// mirrors the same guard on TypePaneFocus. Silently ignored rather
		// than erroring the connection, consistent with how non-
		// authoritative resizes are already silently skipped below.
		if c.attached == "" || c.kind != "interactive" {
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
			// Non-VT pane (a RawBuffer pane, or one with a nil buf): return
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
	case TypeScrollbackPage:
		c.scrollbackPage(msg)
	case TypePreviewSubscribe:
		c.setPreviewOn(msg.OK)
		// OK is unconditionally true: it acknowledges that THIS daemon
		// understands preview-subscribe and applied it, which is precisely
		// what a new browser needs in order to distinguish a daemon that
		// supports previews from an older one that silently ignores an
		// unknown control type.
		c.reply(&Message{Type: TypePreviewSubscribeResult, CID: msg.CID, OK: true})
	case TypeSessionStateSubscribe:
		c.setSessionStateOn(msg.OK)
		// Unconditionally true, exactly as for preview-subscribe: the ack
		// asserts that THIS daemon understands session-state-subscribe and
		// applied it, which is what lets a new browser tell a daemon that
		// supports the home view from an older one that silently drops an
		// unknown control type.
		c.reply(&Message{Type: TypeSessionStateSubscribeResult, CID: msg.CID, OK: true})
	}
}

// scrollbackPage answers a TypeScrollbackPage request with one page of the
// target pane's server-side scrollback history, paging backward from
// msg.LineCursor (nil = the most recent page). It mirrors TypeScreenSnapshot's
// resolution and failure shape exactly: not attached -> CodeUnknownWorkspace,
// unknown pane -> CodePaneNotFound, and a pane that exists but is not VT-backed
// (a RawBuffer pane, or one with a nil buf) -> a well-formed near-empty result
// rather than an error. Limit is normalised here so an oversized request from
// any client is capped server-side.
func (c *conn) scrollbackPage(msg Message) {
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
		c.reply(&Message{Type: TypeScrollbackPageResult, CID: msg.CID, PaneID: msg.PaneID})
		return
	}
	limit := msg.Limit
	if limit <= 0 {
		limit = defaultScrollbackPageLimit
	}
	if limit > maxScrollbackPageLimit {
		limit = maxScrollbackPageLimit
	}
	lines, start, next := vb.ScrollbackPage(msg.LineCursor, limit)
	c.reply(&Message{
		Type:       TypeScrollbackPageResult,
		CID:        msg.CID,
		PaneID:     msg.PaneID,
		Lines:      lines,
		StartLine:  start,
		NextCursor: next,
	})
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
		"",         // cwd: no override for a live-created pane — today's forced-$HOME behavior
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
	c.srv.broadcast(wsID, &Message{Type: TypePaneClosed, WorkspaceID: wsID, PaneID: msg.PaneID})
}

// closeWorkspace removes a workspace and kills its panes, then emits
// workspace-closed followed by the authoritative workspace list. Panes are
// closed before the list snapshot so it reflects accurate pane counts. Exit
// handlers see the workspace already gone and emit no duplicate pane-closed
// events.
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
	c.srv.broadcastWorkspaceClosed(msg.WorkspaceID)
}

// closeIntent performs one daemon-owned activity assessment and close
// transaction. The browser only receives the correlated close-outcome; the
// structural broadcasts emitted for an actual registry mutation remain the
// authority for pane and workspace reconciliation.
func (c *conn) closeIntent(msg Message) {
	outcome := c.srv.reg.CloseIntent(CloseTarget{
		Kind:        CloseTargetKind(msg.TargetKind),
		WorkspaceID: msg.WorkspaceID,
		PaneID:      msg.PaneID,
	})
	c.reply(CloseOutcomeMessage(msg.CID, outcome))
	c.srv.broadcastCloseMutation(outcome)
}

// closeConfirm forwards only the opaque ticket to registry authority. The
// registry either destroys the exact warned snapshot or returns a refreshed,
// non-mutating close outcome.
func (c *conn) closeConfirm(msg Message) {
	outcome := c.srv.reg.ConfirmClose(msg.Ticket)
	c.reply(CloseOutcomeMessage(msg.CID, outcome))
	c.srv.broadcastCloseMutation(outcome)
}

// broadcastCloseMutation emits structural authority for transactions that
// removed an unchanged target and for idempotent absent targets. A close-outcome
// reports only request status; clients remove structure only from these
// broadcasts.
func (s *Server) broadcastCloseMutation(outcome CloseOutcome) {
	if !outcome.ClosedNow && !outcome.ReconcileAbsent {
		return
	}
	if outcome.ReconcileAbsent && outcome.ReconcileWorkspace {
		s.broadcastWorkspaceClosed(outcome.WorkspaceID)
		return
	}
	switch outcome.TargetKind {
	case CloseTargetPane:
		s.broadcast(outcome.WorkspaceID, &Message{
			Type:        TypePaneClosed,
			WorkspaceID: outcome.WorkspaceID,
			PaneID:      outcome.PaneID,
		})
	case CloseTargetWorkspace:
		s.broadcastWorkspaceClosed(outcome.WorkspaceID)
	}
}

// broadcastWorkspaceList serializes snapshot capture and publication under
// Server.mu. Every workspace-list broadcaster takes this path so an older
// Registry snapshot cannot enqueue after a newer workspace mutation.
func (s *Server) broadcastWorkspaceList() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.broadcastWorkspaceListLocked()
}

// replyWorkspaceList captures and queues a correlated workspace-list under the
// same publication lock as broadcasts. A list request therefore cannot enqueue
// an older snapshot after a close broadcast that already announced newer state.
func (s *Server) replyWorkspaceList(c *conn, cid uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c.sub.enqueueControl(&Message{
		Type:       TypeWorkspaceList,
		CID:        cid,
		Workspaces: s.reg.List(),
	})
}

// broadcastWorkspaceListLocked captures the Registry snapshot while Server.mu
// is held and then publishes it to every live connection. The established
// Server -> Registry lock order matches attach and unsubscribe paths.
func (s *Server) broadcastWorkspaceListLocked() {
	workspaces := s.reg.List()
	for c := range s.conns {
		c.sub.enqueueControl(&Message{Type: TypeWorkspaceList, Workspaces: workspaces})
	}
}

// broadcastWorkspaceClosed enqueues the lifecycle event and its authoritative
// replacement list under one Server.mu critical section. Capturing the list
// after acquiring Server.mu keeps this publication ordered against every other
// workspace snapshot.
func (s *Server) broadcastWorkspaceClosed(workspaceID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		c.sub.enqueueControl(&Message{Type: TypeWorkspaceClosed, WorkspaceID: workspaceID})
	}
	s.broadcastWorkspaceListLocked()
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

// ---------------------------------------------------------------------------
// Sidebar live preview (ADDITIVE). See
// docs/designs/2026-09-02-sidebar-live-preview-design.md.
//
// The daemon pushes a small monochrome text tile of each workspace's most
// active pane to connections that opted in, so a browser can show a live
// thumbnail of the workspaces it is NOT attached to (a connection is attached
// to exactly one workspace, so it has no other way to know). The attached
// workspace is rendered client-side from its own xterm buffers and needs
// nothing from here.
// ---------------------------------------------------------------------------

const (
	// previewTick is how often the daemon LOOKS for changed workspaces. It is
	// deliberately faster than previewMinInterval so a change is noticed
	// promptly rather than landing at the start of a 500ms bucket.
	previewTick = 250 * time.Millisecond
	// previewMinInterval is the per-workspace floor between two rendered
	// tiles, capping even a flat-out `yes` at 2 Hz.
	previewMinInterval = 500 * time.Millisecond
	// previewCols/previewRows are the CANONICAL tile geometry. One tile is
	// rendered per workspace regardless of any client's sidebar width; each
	// client crops it to its own size. A crop of a bottom-left crop is still a
	// bottom-left crop, so per-client cropping is exact, not approximate.
	previewCols = 80
	previewRows = 24
)

// previewState is one workspace's change gate. All three fields exist to make
// an idle machine cost zero: lastSeq skips a pane that has produced no output,
// lastEmit bounds a busy one, and lastHash suppresses output that did not
// change the visible crop (a scrolling progress bar redrawing the same text).
// hasTile distinguishes "no tile yet" from "a tile whose hash happens to be 0".
type previewState struct {
	lastPane int
	lastSeq  uint64
	lastHash uint64
	hasTile  bool
	lastEmit time.Time
}

// setPreviewOn records this connection's sidebar-preview opt-in.
//
// Opt-in is mandatory, not a nicety: the fan-out walks s.conns, which includes
// ClientKindCLI and ClientKindAgent, and a one-shot CLI invocation must never
// receive preview tiles. It also makes an old client safe by construction — it
// never subscribes, so it never receives anything.
func (c *conn) setPreviewOn(on bool) {
	c.srv.mu.Lock()
	defer c.srv.mu.Unlock()
	c.previewOn = on
	if on {
		// Reset every workspace's change gate so the next tick re-renders all
		// of them for this newly-subscribed connection. Without this, a client
		// attaching to an already-running daemon would see empty cards until
		// each workspace happened to produce output on its own.
		clear(c.srv.preview)
	}
}

// previewLoop is the preview ticker goroutine, started by ListenAndServe and
// stopped by the same ctx cancellation that closes the listener.
func (s *Server) previewLoop(ctx context.Context) {
	ticker := time.NewTicker(previewTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			s.emitPreviews(now)
		}
	}
}

// emitPreviews renders and fans out one tick's worth of preview tiles.
//
// s.mu is never held while a tile renders: the gate check, the render, and the
// fan-out are three separate steps, so a slow tile can never stall an attach, a
// broadcast, or another connection's request. The gating state is advisory, so
// racing with a concurrent subscribe costs at most one redundant tile.
func (s *Server) emitPreviews(now time.Time) {
	if !s.previewWanted() {
		return // nobody subscribed: no snapshot, no render, no bytes
	}

	views := s.reg.snapshotView()
	live := make(map[string]bool, len(views))
	for _, ws := range views {
		live[ws.ID] = true

		p := pickPreviewPane(ws.Panes, ws.Layout)
		if p == nil {
			continue
		}
		_, seq := p.PreviewActivity()
		if !s.previewDue(ws.ID, p.LocalID, seq, now) {
			continue
		}
		// pickPreviewPane accepted only VT-backed panes, so this assertion
		// cannot fail.
		vb, ok := p.buf.(*VTBuffer)
		if !ok {
			continue
		}
		lines := vb.PreviewTile(previewCols, previewRows)
		s.publishPreview(ws.ID, seq, previewTileHash(p.LocalID, lines), &Message{
			Type:        TypeWorkspacePreview,
			WorkspaceID: ws.ID,
			PaneID:      p.LocalID,
			Title:       p.Info().Title,
			Cols:        previewCols,
			Rows:        previewRows,
			Lines:       lines,
		})
	}
	s.prunePreviewState(live)
}

// previewWanted reports whether any live connection has opted in.
func (s *Server) previewWanted() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		if c.previewOn {
			return true
		}
	}
	return false
}

// previewDue reports whether wsID's preview pane is worth rendering this tick,
// reserving the slot by advancing lastEmit. A pane that has produced no output
// since the last tile is skipped, and a workspace that rendered within
// previewMinInterval is skipped, so an idle machine does no work at all.
func (s *Server) previewDue(wsID string, paneID int, seq uint64, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.preview[wsID]
	if !ok {
		s.preview[wsID] = &previewState{lastPane: paneID, lastEmit: now}
		return seq != 0
	}

	// A changed pane always emits, even when the new pane is silent or its seq
	// happens to match the old one's. Now that the card follows the FOCUSED
	// pane rather than the busiest one, the pane it points at can change while
	// nothing is being written, and a seq-only gate would leave the card
	// showing the pane you just navigated away from.
	if st.lastPane != paneID {
		st.lastPane = paneID
		st.lastEmit = now
		return true
	}
	if seq == 0 {
		return false // pane has never written; there is nothing to show yet
	}
	if st.lastSeq == seq || now.Sub(st.lastEmit) < previewMinInterval {
		return false
	}
	st.lastEmit = now
	return true
}

// publishPreview commits the rendered tile's change gate and fans the frame out
// to every opted-in connection. lastSeq advances whether or not the tile
// changed, so an unchanged grid is not re-rendered on the next tick; the hash
// gate is what makes a pane whose visible crop did not change cost zero bytes.
//
// Frames go out via enqueuePreview, which DROPS on a full queue rather than
// disconnecting the client — see subscriber.go.
func (s *Server) publishPreview(wsID string, seq, hash uint64, msg *Message) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.preview[wsID]
	if !ok {
		// Pruned, or reset by a subscribe, while this tile was rendering.
		st = &previewState{}
		s.preview[wsID] = st
	}
	st.lastPane = msg.PaneID
	st.lastSeq = seq
	// No separate pane-change guard: previewTileHash mixes the pane id in, so
	// switching panes necessarily changes the hash and opens this gate. A flag
	// here would also always be false, since previewDue advanced lastPane
	// before returning true.
	if st.hasTile && st.lastHash == hash {
		return
	}
	st.lastHash = hash
	st.hasTile = true
	for c := range s.conns {
		if c.previewOn {
			c.sub.enqueuePreview(msg)
		}
	}
}

// prunePreviewState drops gating state for workspaces that no longer exist, so
// a long-lived daemon's map tracks the live workspace set rather than every
// workspace it has ever seen.
func (s *Server) prunePreviewState(live map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for wsID := range s.preview {
		if !live[wsID] {
			delete(s.preview, wsID)
		}
	}
}

// pickPreviewPane returns the pane a workspace's card should show.
//
// The card is a promise: it must show the pane you actually get when you click
// the workspace. That pane is the one dockview will restore, and dockview
// persists it in the saved layout, so the layout is the authority here.
//
// Falling back to "most recently written" without consulting it was wrong in a
// way that reads as random: a busy background pane hijacked the card while the
// click still landed on the focused pane. Most-recent survives only as a
// fallback for a workspace that has never saved a layout, or whose saved active
// pane is gone or non-VT.
//
// Ties in the fallback go to the lowest pane id (snapshotView returns panes
// sorted ascending and the comparison is strict, so the first of an exact tie
// wins). Non-VT panes are skipped rather than erroring, following the
// empty-not-error precedent of the TypeScreenSnapshot handler.
func pickPreviewPane(panes []*Pane, layouts map[string]string) *Pane {
	// "wide" is the desktop layout and the one the sidebar itself only exists
	// in; "narrow" is checked so a mobile-only session still resolves.
	for _, bp := range [...]string{"wide", "narrow"} {
		id, ok := ActivePaneFromLayout(layouts[bp])
		if !ok {
			continue
		}
		for _, p := range panes {
			if p == nil || p.LocalID != id {
				continue
			}
			if _, vt := p.buf.(*VTBuffer); vt {
				return p
			}
		}
	}
	return mostRecentlyWrittenPane(panes)
}

// mostRecentlyWrittenPane is the fallback when the saved layout cannot name a
// usable pane. See pickPreviewPane.
func mostRecentlyWrittenPane(panes []*Pane) *Pane {
	var best *Pane
	var bestAt time.Time
	for _, p := range panes {
		if p == nil {
			continue
		}
		if _, ok := p.buf.(*VTBuffer); !ok {
			continue
		}
		at, _ := p.PreviewActivity()
		if best == nil || at.After(bestAt) {
			best, bestAt = p, at
		}
	}
	return best
}

// --- Session state --------------------------------------------------------
//
// The home view's data path, modelled on the preview pipeline immediately
// above and sharing its guarantees: opt-in per connection, cross-workspace
// fan-out, change-gated, and droppable.
//
// It differs from preview in exactly one way, and the difference is the point.
// A preview tile is PULLED from state the daemon already owns (a pane's VT
// buffer). Session state cannot be pulled from anything the daemon can see:
// TIOCGPGRP reports the same foreground process group whether an agent is
// thinking or waiting at a permission prompt. So it is PUSHED by the sessions
// themselves, into a spool directory, and this loop's job is to read what they
// declared and say which pane each declaration belongs to.

// sessionStateTick is how often the daemon re-reads the spool directory.
//
// Four times slower than previewTick on purpose. A preview tile is animation
// and wants to feel live; session state changes at human pace -- a tool starts,
// an approval is requested, a turn ends -- and a second of latency on that is
// imperceptible. Reading a handful of small files once a second costs nothing,
// and costs literally nothing when no connection has opted in.
const sessionStateTick = 1 * time.Second

// setSessionStateOn records this connection's session-state opt-in.
//
// Opt-in is mandatory for the same reason it is for preview: the fan-out walks
// s.conns, which includes ClientKindCLI and ClientKindAgent, and a one-shot CLI
// invocation must never be sent home-view rows it did not ask for. It also
// makes an old client safe by construction -- it never subscribes, so it never
// receives anything.
func (c *conn) setSessionStateOn(on bool) {
	c.srv.mu.Lock()
	defer c.srv.mu.Unlock()
	c.sessionStateOn = on
	if on {
		// Re-arm the change gate so the next tick republishes the current set
		// for this newly-subscribed connection. Without this, a client
		// attaching to an already-running daemon would see nothing until some
		// session happened to change state on its own.
		c.srv.sessions.rearm()
	}
}

// sessionStateWanted reports whether any live connection has opted in.
func (s *Server) sessionStateWanted() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		if c.sessionStateOn {
			return true
		}
	}
	return false
}

// sessionStateLoop is the session-state ticker goroutine, started by
// ListenAndServe and stopped by the same ctx cancellation that closes the
// listener.
func (s *Server) sessionStateLoop(ctx context.Context) {
	ticker := time.NewTicker(sessionStateTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.emitSessionState()
		}
	}
}

// emitSessionState reads, joins, and fans out one tick's worth of session state.
//
// s.mu is never held across the slow part, following emitPreviews exactly: the
// want-check, the collection (filesystem reads and /proc ancestor walks), and
// the fan-out are three separate steps, so a slow disk can never stall an
// attach, a broadcast, or another connection's request.
func (s *Server) emitSessionState() {
	if !s.sessionStateWanted() {
		return // nobody subscribed: no directory read, no /proc walk, no bytes
	}
	rows := s.sessions.collect(paneOwners(s.reg.snapshotView()))
	s.publishSessionState(rows)
}

// publishSessionState commits the change gate and fans the set out to every
// opted-in connection.
//
// Frames go out via enqueuePreview, which DROPS on a full queue rather than
// disconnecting the client. That method's contract explicitly covers "any
// future advisory push" (subscriber.go), and this is one: a backgrounded
// browser tab must lose home-view rows, never its terminal session. Losing a
// frame is harmless because each frame is the whole current set, so the next
// tick repairs the view completely.
func (s *Server) publishSessionState(rows []SessionState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.sessions.changed(rows) {
		return
	}
	for c := range s.conns {
		if c.sessionStateOn {
			c.sub.enqueuePreview(&Message{Type: TypeSessionState, Sessions: rows})
		}
	}
}
