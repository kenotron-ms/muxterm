package sessiond

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"os"
	"path/filepath"
	"strings"
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

	// completions is the durable log of lanes that have finished. It carries
	// its own lock (completion.go) rather than living under mu: it is written
	// from an exiting pane's readLoop goroutine and read from the
	// session-state ticker, and a file write must never be able to stall an
	// attach or a broadcast.
	completions *completionStore
}

// NewServer returns a Server bound to socketPath with a fresh Registry. It
// errors on an empty socket path.
func NewServer(socketPath string) (*Server, error) {
	if socketPath == "" {
		return nil, errors.New("sessiond: empty socket path")
	}
	s := &Server{
		reg:         NewRegistry(),
		socket:      socketPath,
		subs:        make(map[string]map[*conn]bool),
		conns:       make(map[*conn]bool),
		preview:     make(map[string]*previewState),
		sessions:    newSessionStore(),
		completions: newCompletionStore(CompletionsPath()),
	}
	return s, nil
}

// CompletionsPath returns the durable completion log's location.
//
// Resolution order mirrors SessionStateDir's, for the same reasons:
//
//   - $MUXTERM_COMPLETIONS_PATH   (explicit override, tests and odd deploys)
//   - $XDG_DATA_HOME/muxterm/completions.json
//   - $HOME/.local/share/muxterm/completions.json
//
// The XDG-derived default is what keeps a dev daemon's completions out of the
// real log without either side being told which world it is in.
func CompletionsPath() string {
	if override := os.Getenv("MUXTERM_COMPLETIONS_PATH"); override != "" {
		return override
	}
	return DefaultCompletionsPath()
}

// Registry exposes the server's Registry for tests and later phases.
func (s *Server) Registry() *Registry { return s.reg }

// ListenAndServe creates the socket (0600 inside a 0700 dir), guarantees a
// cold-start default workspace, and serves control connections until ctx is
// cancelled. It returns nil on a graceful (ctx-driven) shutdown and a non-nil
// error only for an unexpected accept/listen failure.
//
// It REFUSES to start when another daemon is already listening on the socket
// path (ClaimSocket returns ErrSocketOwned). This is the one guard that cannot
// be bypassed: every way of starting a daemon -- systemd, EnsureDaemon, a dev
// shim, or a bare `muxterm sessiond` typed by hand -- binds through here.
//
// It is the Unix-socket half only: everything from the cold-start workspace
// onward lives in Serve, which is listener-agnostic.
func (s *Server) ListenAndServe(ctx context.Context) error {
	dir := filepath.Dir(s.socket)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	// Ask before unlinking. ClaimSocket removes the name ONLY when nothing is
	// listening behind it; when a live daemon owns it, this returns an error
	// naming the path and the daemon refuses to start. See ClaimSocket for
	// what binding over a live daemon actually costs.
	if err := ClaimSocket(s.socket); err != nil {
		return err
	}

	ln, err := net.Listen("unix", s.socket)
	if err != nil {
		return err
	}
	if err := os.Chmod(s.socket, 0o600); err != nil {
		_ = ln.Close()
		return err
	}

	return s.Serve(ctx, ln)
}

// Serve guarantees a cold-start default workspace, starts the daemon's
// background loops, and accepts control connections off ln until ctx is
// cancelled. It returns nil on a graceful (ctx-driven) shutdown and a non-nil
// error only for an unexpected accept failure. Serve takes ownership of ln and
// closes it when ctx is done.
//
// Serve carries no socket assumptions from the framing side: the listener is
// supplied by the caller, which is what lets a sessiond eventually serve
// something other than its Unix socket.
//
// It is NOT yet safe to pass a non-Unix listener. On Linux peerAllowed
// type-asserts every accepted connection to *net.UnixConn and rejects whatever
// fails, so a TCP listener would have each connection closed in the accept loop
// below -- no error, no log, a Serve that returns nothing and serves nothing.
// Worse, peerAllowed is an unconditional true on non-Linux, so the same code
// would appear to work there and fail only on Linux.
//
// Serve is therefore correct only with a Unix listener until the per-listener
// identity policy lands (see docs/designs/2026-09-05-remote-sessiond-design.md,
// D2b). The listener parameter exists so that step is a change to auth policy
// rather than another change to this function.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
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

	// Claude Code sessions in the home view. OPT-IN: this is the only place the
	// daemon executes another vendor's binary, so it happens because an
	// operator asked for it, never because `claude` was on PATH. Not started at
	// all when the switch is off, so the disabled cost is one getenv.
	if claudeAdapterEnabled() {
		go s.claudeAdapterLoop(ctx)
	}

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
//
// THIS IS THE ONLY PATH THAT DESTROYS STRUCTURE WITHOUT ANYONE ASKING, and for
// a one-pane workspace -- which is exactly what spawn-lane creates -- it takes
// the workspace with the pane. The exit code and runtime are broadcast to
// whoever happens to be subscribed and then discarded, so a lane that died
// three seconds after birth and a lane that ran its goal loop to completion
// leave the identical trace: none. Log it. A vanished lane is otherwise
// unattributable after the fact, and "did something close it, or did it exit?"
// is the first question asked every time.
//
// A lane's completion record is written HERE, between removing the pane from
// the registry and announcing that it closed. That ordering is the feature:
// the record is durable before any client is told the pane is gone and before
// ReapIfEmpty can consider the workspace, so a finished lane's result cannot
// be destroyed by its own cleanup.
//
// The early return on !ok is also load-bearing, and it is what keeps this from
// firing on closes a human asked for. close-pane, close-workspace, and the
// close-intent transaction all remove from the registry FIRST and then kill
// the process; the exit that follows finds the pane already gone and stops
// here. So records are written for process-driven exits only -- a lane that
// ended on its own -- and closing something by hand stays exactly as
// undramatic as it is today.
func (s *Server) handlePaneExit(wsID string, paneID int, exitCode int, runtimeMs int64) {
	pane, remaining, ok := s.reg.RemovePane(wsID, paneID)
	if !ok {
		return
	}
	log.Printf("sessiond: pane %s/%d removed: process exited code=%d runtime=%dms remaining=%d",
		wsID, paneID, exitCode, runtimeMs, remaining)
	held := s.recordPaneCompletion(wsID, pane, exitCode, runtimeMs, remaining == 0)
	code := exitCode
	s.broadcast(wsID, &Message{
		Type: TypePaneClosed, WorkspaceID: wsID, PaneID: paneID,
		ProcessExitCode: &code, RuntimeMs: runtimeMs,
	})
	if remaining == 0 {
		if removed, _ := s.reg.ReapIfEmpty(wsID); removed {
			log.Printf("sessiond: workspace %s reaped: last pane (%d) exited, nobody closed it", wsID, paneID)
			s.broadcastWorkspaceList()
			return
		}
	}
	if held {
		// The workspace survived a reap it would previously have lost. Every
		// client needs the replacement list to learn it is FINISHED rather
		// than merely empty -- without this the sidebar would show a bare
		// zero-pane workspace, which is the old silence with extra steps.
		s.broadcastWorkspaceList()
	}
}

// recordPaneCompletion captures a finished lane and reports whether the
// workspace is now being held open for it.
//
// It answers two questions in order, and the first one is a gate: did this
// pane host an agent session at all? Only a pane with a session declaration
// spooled against its root pid is a lane. A shell somebody typed `exit` into
// is not a result, and turning every shell exit into a workspace that refuses
// to close would be a worse bug than the one this fixes.
//
// holdWorkspace is passed rather than decided here: the workspace is held only
// when this was its LAST pane, because the hold exists to stop a reap, and a
// workspace with other panes in it is not being reaped. The record is written
// either way.
func (s *Server) recordPaneCompletion(wsID string, pane *Pane, exitCode int, runtimeMs int64, holdWorkspace bool) bool {
	if pane == nil {
		return false
	}
	declared, hosted := s.sessions.lastDeclarationFor(pane.activitySnapshot().pid)
	if !hosted {
		return false
	}

	info := pane.Info()
	screen, scanned := paneFinalOutput(pane)
	record := CompletionRecord{
		WorkspaceID:   wsID,
		WorkspaceName: s.reg.workspaceName(wsID),
		PaneID:        pane.LocalID,
		PaneTitle:     info.Title,
		SessionID:     declared.SessionID,
		Harness:       declared.Harness,
		Project:       declared.Project,
		Name:          declared.Name,
		Label:         declared.Label,
		Mode:          declared.Mode,
		DoneMeans:     declared.DoneMeans,
		Doing:         declared.Doing,
		DeclaredState: terminalDeclaration(declared.State),
		ExitCode:      exitCode,
		RuntimeMs:     runtimeMs,
		EndedAt:       time.Now().Unix(),
		Output:        tailBytes(screen, completionOutputBytes),
	}
	record.Outcome = completionOutcome(record.DeclaredState, exitCode)
	// A declared PR is the producer's own claim and outranks anything read off
	// a screen. Nothing shipped declares one today, which is why the scan
	// exists at all -- see completionPRFrom.
	record.PR = declared.PR
	if record.PR == 0 {
		record.PR, record.PRURL = completionPRFrom(scanned)
	}

	stored := s.completions.Append(record)
	if !holdWorkspace {
		return false
	}
	return s.reg.MarkCompleted(wsID, completionMarkFor(stored))
}

// terminalDeclaration keeps only an ENDING a session actually declared.
//
// A `working` or `blocked` snapshot belonging to a process that is now gone is
// a crash artifact, not a statement about how the session finished, and
// carrying it into the record would let a lane that died mid-turn describe its
// own ending. Empty means "declared nothing", which completionOutcome then
// resolves from the exit code alone.
func terminalDeclaration(state string) string {
	if sessionStateIsTerminal(state) {
		return state
	}
	return ""
}

// paneFinalOutput returns the pane's last screen and a wider window to scan
// for artifacts.
//
// Two different jobs need two different amounts. The screen is what a human
// would have been looking at when the lane ended, and it is what the record
// shows. The scan window adds recent scrollback, because a `gh pr create` URL
// printed several tool calls before the end has usually scrolled off -- and
// that URL is the only first-hand evidence of the PR a lane opened.
func paneFinalOutput(pane *Pane) (screen string, scan string) {
	vb, ok := pane.buf.(*VTBuffer)
	if !ok {
		return "", ""
	}
	screen = vb.ScreenText()
	history, _, _ := vb.ScrollbackPage(nil, completionScanLines)
	if len(history) == 0 {
		return screen, screen
	}
	return screen, strings.Join(history, "\n") + "\n" + screen
}

// completionScanLines bounds the scrollback consulted for artifacts. Deep
// enough to cover the tail of an agent's last few turns, shallow enough that
// it is a bounded read on a pane's exit path.
const completionScanLines = 400

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

	// peerPid is the pid of the process on the other end of nc, from
	// SO_PEERCRED, or 0 when it could not be established (non-Linux, or a
	// connection that did not arrive over a Unix socket). Read-only after
	// newConn, so no lock: the kernel fills it in at connect time and the
	// peer of a socket never changes. It is the unforgeable half of the
	// self-close refusal -- see selfclose.go.
	peerPid int
}

// clientKind names the connection for a log line. conn.kind is only set by
// attach(), and the one-shot CLI verbs close a workspace without attaching, so
// the zero value is a real and common case: say so rather than logging an
// empty string that reads like a bug.
func (c *conn) clientKind() string {
	if c.kind == "" {
		return "unattached"
	}
	return c.kind
}

// newConn wraps nc with a subscriber for serialized writes.
func newConn(s *Server, nc net.Conn) *conn {
	// A failure here is not an error: peerPID is unavailable off Linux and for
	// non-Unix peers by design, and every caller of peerPid treats 0 as
	// "cannot prove anything about this peer". See selfclose.go's LIMITS note.
	pid, _ := peerPID(nc)
	return &conn{srv: s, nc: nc, sub: newSubscriber(nc, 0), peerPid: pid}
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
	case TypeReadFile:
		c.readFile(msg)
	case TypeListDir:
		c.listDir(msg)
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

// readFile answers a TypeReadFile request with one bounded window of a file on
// THIS machine, as text.
//
// Unlike every other request on this connection it is NOT scoped to an attached
// workspace: a file has nothing to do with a workspace, and requiring an attach
// first would make the answer depend on unrelated state. It is the same
// exception fleet.go already makes for session state.
//
// Failures are reported with the stable fs-* codes rather than a generic error,
// because "no such file", "that is a directory", "permission denied", "too
// large" and "not text" each imply a different next move for the caller. The
// bounds are applied in ReadFileBounded, i.e. on this side, so no client can
// raise them.
func (c *conn) readFile(msg Message) {
	res, err := ReadFileBounded(msg.Path, msg.Offset, msg.Limit)
	if err != nil {
		c.replyFSError(msg.CID, err)
		return
	}
	c.reply(&Message{
		Type:         TypeReadFileResult,
		CID:          msg.CID,
		Path:         res.Path,
		ResolvedPath: res.ResolvedPath,
		Content:      res.Content,
		Offset:       &res.Offset,
		FileSize:     res.FileSize,
		NextOffset:   res.NextOffset,
		EOF:          res.EOF,
		Truncated:    res.Truncated,
	})
}

// listDir answers a TypeListDir request with a bounded, name-sorted listing of
// a directory on THIS machine. Workspace-independent for the same reason
// readFile is.
func (c *conn) listDir(msg Message) {
	res, err := ListDirBounded(msg.Path, msg.Limit)
	if err != nil {
		c.replyFSError(msg.CID, err)
		return
	}
	c.reply(&Message{
		Type:         TypeListDirResult,
		CID:          msg.CID,
		Path:         res.Path,
		ResolvedPath: res.ResolvedPath,
		Entries:      res.Entries,
		Truncated:    res.Truncated,
	})
}

// replyFSError puts a filesystem failure on the wire with its stable code
// intact. An error that is somehow not an *FSError still gets a reply rather
// than silence, because a caller waiting on a cid needs an answer more than it
// needs a perfectly categorised one.
func (c *conn) replyFSError(cid uint64, err error) {
	if fe, ok := err.(*FSError); ok {
		c.replyError(cid, fe.Code, fe.Msg)
		return
	}
	c.replyError(cid, CodeFSBadPath, err.Error())
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
	// A pane started from the home composer carries the user's first prompt in
	// its argv, which is the only description of this work that exists yet.
	// Labelling from it here, before the pane is ever published, is what stops
	// the tab from reading "Pane 7" while something slower is asked for a
	// better name. An argv that is not a recognised harness launch derives
	// nothing and stays untitled on purpose -- see autolabel.go.
	//
	// Written through the derived path, never SetTitle: this is a guess, and
	// marking it as such is what lets the session's own label refine it later
	// while still leaving a human's rename permanent (autoname.go).
	title := labelFromPrompt(promptFromArgv(msg.Cmd))
	if title != "" {
		p.setTitleDerived(title)
	}
	c.srv.reg.PutPane(wsID, p)
	c.reply(&Message{Type: TypePaneCreated, CID: msg.CID, PaneID: localID})
	c.srv.broadcast(wsID, &Message{
		Type:        TypePaneAdded,
		WorkspaceID: wsID,
		PaneID:      localID,
		Cols:        cols,
		Rows:        rows,
		// Carried on the event itself (omitted when empty) so a subscriber
		// paints the right tab from the broadcast it already handles, instead
		// of rendering the fallback and correcting it after a round trip.
		Title:           title,
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
	// Before the registry is touched: a session may not close the pane it is
	// running in. See selfclose.go.
	if detail, refused := c.refuseSelfClosePane(wsID, msg.PaneID); refused {
		c.replyError(msg.CID, CodeSelfClose, detail)
		return
	}
	p, _, ok := c.srv.reg.RemovePane(wsID, msg.PaneID)
	if !ok {
		// Pane already gone; send ok so the client doesn't hang.
		c.reply(&Message{Type: TypeOK, CID: msg.CID})
		return
	}
	// Logged so an explicit close is distinguishable from the exit reap in
	// handlePaneExit. The client kind is the whole point: it says whether a
	// human's browser, an agent's MCP tool, or a CLI invocation asked.
	log.Printf("sessiond: pane %s/%d closed on request by client kind=%s", wsID, msg.PaneID, c.clientKind())
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
	// Before the registry is touched: a session may not close the workspace it
	// is running in. See selfclose.go.
	if detail, refused := c.refuseSelfCloseWorkspace(msg.WorkspaceID); refused {
		c.replyError(msg.CID, CodeSelfClose, detail)
		return
	}
	panes, _, ok := c.srv.reg.CloseWorkspace(msg.WorkspaceID)
	if !ok {
		c.replyError(msg.CID, CodeUnknownWorkspace, "unknown workspace")
		return
	}
	log.Printf("sessiond: workspace %s closed on request by client kind=%s (%d pane(s) killed)",
		msg.WorkspaceID, c.clientKind(), len(panes))
	for _, p := range panes {
		p.Close()
	}
	c.srv.dismissCompletions(msg.WorkspaceID)
	c.reply(&Message{Type: TypeOK, CID: msg.CID})
	c.srv.broadcastWorkspaceClosed(msg.WorkspaceID)
}

// dismissCompletions marks a workspace's pending completions as seen.
//
// Closing a finished workspace IS the dismissal. No new gesture is invented
// for it: the workspace was held open so a human would notice it, and closing
// the thing you noticed is how you say you noticed it. The record itself is
// kept -- it is history, and history that deletes itself when acknowledged
// would answer "what happened to lane X yesterday" with silence.
func (s *Server) dismissCompletions(wsID string) {
	if s.completions.AcknowledgeWorkspace(wsID) {
		// Republish so the dismissed lane leaves the fleet on the next tick
		// even though its row content did not change.
		s.mu.Lock()
		s.sessions.rearmLocked()
		s.mu.Unlock()
	}
}

// closeIntent performs one daemon-owned activity assessment and close
// transaction. The browser only receives the correlated close-outcome; the
// structural broadcasts emitted for an actual registry mutation remain the
// authority for pane and workspace reconciliation.
func (c *conn) closeIntent(msg Message) {
	target := CloseTarget{
		Kind:        CloseTargetKind(msg.TargetKind),
		WorkspaceID: msg.WorkspaceID,
		PaneID:      msg.PaneID,
	}
	// Before any assessment, ticket, or mutation: a session may not close the
	// workspace or pane it is running in. Reported as a failed outcome rather
	// than a TypeError because this path's contract is that every request
	// answers with a close-outcome; a confirmation ticket must never be issued
	// for a target the caller occupies, since confirming it would still
	// destroy the caller. See selfclose.go.
	if detail, refused := c.refuseSelfCloseTarget(target); refused {
		outcome := failedCloseOutcome(target, CloseFailureSelfOccupied, detail)
		c.reply(CloseOutcomeMessage(msg.CID, outcome))
		return
	}
	outcome := c.srv.reg.CloseIntent(target)
	c.reply(CloseOutcomeMessage(msg.CID, outcome))
	c.srv.broadcastCloseMutation(outcome)
}

// closeConfirm forwards only the opaque ticket to registry authority. The
// registry either destroys the exact warned snapshot or returns a refreshed,
// non-mutating close outcome.
func (c *conn) closeConfirm(msg Message) {
	outcome := c.srv.reg.ConfirmClose(msg.Ticket)
	if outcome.ClosedNow {
		// The gated close path. Logged for the same reason as the ungated
		// verbs: so the reap in handlePaneExit is never mistaken for one of
		// these, or the reverse.
		log.Printf("sessiond: %s %s/%d closed on confirmed ticket by client kind=%s",
			outcome.TargetKind, outcome.WorkspaceID, outcome.PaneID, c.clientKind())
	}
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
		s.dismissCompletions(outcome.WorkspaceID)
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
		// This is the browser's close button, and therefore the dismissal
		// gesture for a held finished workspace.
		s.dismissCompletions(outcome.WorkspaceID)
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
		c.srv.sessions.rearmLocked()
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
	// The owners map is resolved lazily by collect: on a machine with no
	// snapshots at all, taking a full registry snapshot every second would be a
	// cost paid for nothing.
	rows, ok := s.sessions.collect(func() map[int]paneRef {
		return paneOwners(s.reg.snapshotView())
	})
	if !ok {
		// The spool could not be read this tick. Skip rather than publish an
		// empty set: every frame is a whole-state document, so asserting
		// emptiness here would blank the home view over a transient stat error.
		return
	}
	// Fold in the lanes that have finished but not been dismissed. This is
	// what makes the fleet a fleet: without it, a lane's row vanishes the
	// instant its pane does, so `done` and `failed` are states nothing ever
	// actually reaches -- a session simply disappears instead, and its PR
	// with it. The rows come from the durable log, so they survive a restart
	// of this daemon.
	rows = mergeCompletionRows(rows, s.completions.Pending())
	// The rows are already joined to their panes, which is the only thing
	// naming a tab or a workspace after its session needs. Done before the
	// publish, and outside every lock, so a tick that renames something emits
	// the rename alongside the row that caused it rather than a tick behind
	// it. It is a no-op on every tick that changes nothing -- see
	// applyDerivedNames. Completion rows are included deliberately: a held
	// workspace that never got a name should still be able to take the name
	// of the lane that finished in it, which is the difference between the
	// notification saying "w7" and saying what actually completed.
	s.applyDerivedNames(rows)
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
	if !s.sessions.changedLocked(rows) {
		return
	}
	for c := range s.conns {
		if c.sessionStateOn {
			c.sub.enqueuePreview(&Message{Type: TypeSessionState, Sessions: rows})
		}
	}
}
