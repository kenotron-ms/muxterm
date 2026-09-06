package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand/v2"
	"net"
	"sort"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/transport"
)

// HostState is the relay-level connection state for one host as seen by ONE
// browser. It exists only between the local server and the browser; no daemon
// ever sees it, which is why the whole remote feature needs no change to the
// frozen internal/sessiond/protocol.go.
type HostState string

const (
	// HostConnected means this browser has a live daemon connection there.
	HostConnected HostState = "connected"
	// HostReconnecting means the link dropped after having worked. The
	// browser ghosts that host's workspaces; it never removes them, because
	// the panes are still alive on the far side.
	HostReconnecting HostState = "reconnecting"
	// HostUnreachable means the first dial failed and no retry loop is
	// running. The user sees the raw transport error and a Retry button.
	HostUnreachable HostState = "unreachable"
	// HostNeverConnected is a registry member with no session yet, and the
	// state a host returns to on an explicit disconnect.
	HostNeverConnected HostState = "never-connected"
)

// ProbeReport is the transport-neutral shape of "is muxterm usable there".
//
// internal/server deliberately does not import internal/transport/ssh (or
// internal/deploy): cmd/muxterm adapts the concrete transport to
// RemoteTransport below. That indirection is what keeps the transport boundary
// the design asks for from collapsing the first time a second transport
// arrives.
type ProbeReport struct {
	// State is "present" | "login-shell-only" | "absent" | "unknown".
	State string
	// Path is the resolved remote muxterm path, empty when absent.
	Path string
	// User is the login the probe authenticated as, for the connect trace.
	User string
}

// RemoteTransport is the slice of transport.Transport that internal/server
// needs, plus the two operations the Remotes API exposes that
// transport.Transport expresses only as a typed error (probe state, install).
type RemoteTransport interface {
	Name() string
	Dial(ctx context.Context, h transport.HostRef) (net.Conn, error)
	Discover(ctx context.Context) ([]transport.HostRef, error)
	Probe(ctx context.Context, h transport.HostRef) (ProbeReport, error)
	// Install gets muxterm onto the far side ("Install & connect").
	Install(ctx context.Context, h transport.HostRef) error
}

// RemoteRegistry is the PROCESS-wide record of which hosts the user has asked
// to reach, and the last thing anybody observed about each.
//
// It deliberately holds no live daemon connection. Design D5 forbids sharing
// one (PTY sizing authority is keyed on daemon-connection pointer identity),
// so connections belong to the browser that will use them -- see hostSession.
// Per-browser is also the honest answer for the UI: the dropbar and the
// ghosting describe THIS tab's view of that host.
type RemoteRegistry struct {
	mu        sync.RWMutex
	tr        RemoteTransport
	members   map[string]transport.HostRef // key = HostRef.ID
	lastState map[string]HostState
	lastErr   map[string]string
	lastProbe map[string]ProbeReport
	subs      map[*Client]struct{}
}

// NewRemoteRegistry returns an empty registry over tr. A nil tr is valid and
// makes the whole feature inert: nothing can be discovered, probed or
// installed, and the registry simply stays empty.
func NewRemoteRegistry(tr RemoteTransport) *RemoteRegistry {
	return &RemoteRegistry{
		tr:        tr,
		members:   make(map[string]transport.HostRef),
		lastState: make(map[string]HostState),
		lastErr:   make(map[string]string),
		lastProbe: make(map[string]ProbeReport),
		subs:      make(map[*Client]struct{}),
	}
}

// Transport returns the registry's transport, or nil when the process was
// wired without one.
func (r *RemoteRegistry) Transport() RemoteTransport {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.tr
}

// Hosts returns every member, sorted by ID so the browser's host groups keep a
// stable order between calls and the sidebar does not reshuffle.
func (r *RemoteRegistry) Hosts() []transport.HostRef {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	out := make([]transport.HostRef, 0, len(r.members))
	for _, h := range r.members {
		out = append(out, h)
	}
	r.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Get returns the member named by id.
func (r *RemoteRegistry) Get(id string) (transport.HostRef, bool) {
	if r == nil {
		return transport.HostRef{}, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	h, ok := r.members[id]
	return h, ok
}

// Add admits a host and starts a session for it on every attached browser.
//
// It rejects an ID containing "/" (rule P3): that single check is what makes
// splitID total, and the door is the only place it can be enforced once.
// Adding an already-present host is a no-op for membership and idempotent for
// sessions, which is what makes POST /api/remotes/{id}/connect safe to repeat.
func (r *RemoteRegistry) Add(h transport.HostRef) error {
	if r == nil {
		return errors.New("server: no remote registry configured")
	}
	if err := validHostID(h.ID); err != nil {
		return err
	}

	r.mu.Lock()
	r.members[h.ID] = h
	if _, seen := r.lastState[h.ID]; !seen {
		r.lastState[h.ID] = HostNeverConnected
	}
	subs := r.subscribers()
	r.mu.Unlock()

	for _, c := range subs {
		c.startHostSession(h)
	}
	return nil
}

// Remove drops membership and tears the host's session down on every browser.
// Returns false when id was never a member.
func (r *RemoteRegistry) Remove(id string) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	_, ok := r.members[id]
	delete(r.members, id)
	delete(r.lastState, id)
	delete(r.lastErr, id)
	delete(r.lastProbe, id)
	subs := r.subscribers()
	r.mu.Unlock()

	for _, c := range subs {
		c.stopHostSession(id)
	}
	return ok
}

// Note records the last state and error observed for id. Sessions report here
// so GET /api/remotes can answer without holding a connection of its own.
// Last writer wins: with several browsers open the answer is "somebody's most
// recent view", which is the honest thing a process-wide summary can say.
func (r *RemoteRegistry) Note(id string, st HostState, errText string) {
	if r == nil || id == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastState[id] = st
	if errText == "" {
		delete(r.lastErr, id)
	} else {
		r.lastErr[id] = errText
	}
}

// NoteProbe records the last probe report observed for id.
//
// Separate from Note because a probe and a connection state are observed by
// different things at different times: GET /api/remotes?probe=1 fills this
// cache, and a bare GET is then answered from it without paying N ssh round
// trips (design C.1).
func (r *RemoteRegistry) NoteProbe(id string, p ProbeReport) {
	if r == nil || id == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastProbe[id] = p
}

// Observed returns the last state, error text and probe report recorded for
// id. A host nobody has reported on yet is never-connected with an unknown
// probe, which is the honest answer for a host that has only been discovered.
//
// It answers for NON-members too: a probe that fails during
// POST /api/remotes/{id}/connect records unreachable + the raw transport error
// without the host ever joining the registry, and that error is exactly what
// the settings row has to show.
func (r *RemoteRegistry) Observed(id string) (HostState, string, ProbeReport) {
	if r == nil || id == "" {
		return HostNeverConnected, "", ProbeReport{}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	st, ok := r.lastState[id]
	if !ok {
		st = HostNeverConnected
	}
	return st, r.lastErr[id], r.lastProbe[id]
}

// Subscribe registers c for membership-change fan-out and returns the
// unsubscribe. A browser that goes away must call it, or the registry pins a
// dead Client forever.
func (r *RemoteRegistry) Subscribe(c *Client) func() {
	if r == nil {
		return func() {}
	}
	r.mu.Lock()
	r.subs[c] = struct{}{}
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.subs, c)
		r.mu.Unlock()
	}
}

// subscribers snapshots the subscriber set. Callers MUST fan out after
// releasing r.mu: a Client callback reaches back into this registry (Note),
// and holding the lock across it would deadlock.
func (r *RemoteRegistry) subscribers() []*Client {
	out := make([]*Client, 0, len(r.subs))
	for c := range r.subs {
		out = append(out, c)
	}
	return out
}

// Reconnect ladder. min(1s * 2^attempt, 30s) plus up to 500ms of jitter --
// the same ladder web/src/ws.ts:19-21 already uses, so the product has ONE
// reconnect vocabulary instead of two that drift.
const (
	hostBackoffMin    = 1 * time.Second
	hostBackoffMax    = 30 * time.Second
	hostBackoffJitter = 500 * time.Millisecond
)

// backoffFor returns the delay before retry number attempt (0-based). The
// doubling is a bounded loop rather than a shift so a long-lived reconnecting
// session cannot overflow its way back down to a hot loop.
func backoffFor(attempt int) time.Duration {
	d := hostBackoffMin
	for i := 0; i < attempt && d < hostBackoffMax; i++ {
		d *= 2
	}
	if d > hostBackoffMax {
		d = hostBackoffMax
	}
	return d + rand.N(hostBackoffJitter)
}

// hostSession is ONE browser's link to ONE host: its daemon connection, its
// state machine, and its backoff loop. Never shared between browsers (D5).
//
// The LOCAL daemon is a hostSession too, with the zero HostRef (ID ""). That
// is the whole trick behind the zero-remote guarantee: there is one code path,
// and nsID("", id) == id makes it produce today's bytes.
type hostSession struct {
	host   transport.HostRef
	client *Client

	mu   sync.Mutex
	conn DaemonConn // nil unless state == connected
	// state, attempt, lastErr and retryAt are exactly what a host-state frame
	// reports; since is when the current state began, so the browser can
	// render "Disconnected 12s ago" without the server ticking a frame a
	// second.
	state   HostState
	attempt int
	lastErr string
	retryAt time.Time
	since   time.Time
	// everUp separates "never worked" from "was working": the first stops
	// after one failure and shows the raw error, the second retries forever.
	// This distinction is the load-bearing one in the whole state machine.
	everUp bool
	cancel context.CancelFunc
}

// isLocal reports whether this session is the local daemon. Local is unmarked
// (ux D2): it emits no host-state, joins no registry, and never reconnects.
func (s *hostSession) isLocal() bool { return s.host.ID == "" }

// daemon returns the live connection, or nil while dialing/reconnecting.
func (s *hostSession) daemon() DaemonConn {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn
}

func (s *hostSession) stateOf() HostState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *hostSession) everConnected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.everUp
}

// close cancels the session's loop and closes its connection.
func (s *hostSession) close() {
	s.mu.Lock()
	conn := s.conn
	s.conn = nil
	cancel := s.cancel
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if conn != nil {
		_ = conn.Close()
	}
}

// enter records a state transition and emits the host-state frame for it.
// delay is the time until the next dial, meaningful only when reconnecting.
func (s *hostSession) enter(st HostState, errText string, delay time.Duration) {
	now := time.Now()

	s.mu.Lock()
	s.state = st
	s.lastErr = errText
	s.since = now
	if delay > 0 {
		s.retryAt = now.Add(delay)
	} else {
		s.retryAt = time.Time{}
	}
	attempt := s.attempt
	s.mu.Unlock()

	s.client.remoteRegistry().Note(s.host.ID, st, errText)

	m := hostStateMessage{
		Type:   typeHostState,
		Host:   s.host.ID,
		Name:   s.host.DisplayName,
		Target: s.host.Addr,
		State:  st,
		Since:  now.UnixMilli(),
		Error:  errText,
	}
	if st == HostReconnecting {
		m.Attempt = attempt
		m.RetryInMs = delay.Milliseconds()
	}
	s.client.emitHostState(m)
}

// nextDelay counts one failure and returns how long to wait before retrying.
func (s *hostSession) nextDelay() time.Duration {
	s.mu.Lock()
	s.attempt++
	attempt := s.attempt
	s.mu.Unlock()
	return backoffFor(attempt - 1)
}

// adopt installs a freshly dialed connection and marks the session up.
func (s *hostSession) adopt(conn DaemonConn) {
	s.mu.Lock()
	s.conn = conn
	s.state = HostConnected
	s.attempt = 0
	s.lastErr = ""
	s.retryAt = time.Time{}
	s.since = time.Now()
	s.everUp = true
	s.mu.Unlock()
}

// run drives the state machine described in the design:
//
//	never-connected --dial ok--> connected
//	never-connected --dial err--> unreachable          STOP, show the raw error
//	connected       --read loop exits--> reconnecting
//	reconnecting    --backoff elapsed--> dial          retries FOREVER
//
// It is the goroutine for exactly one remote host and exits only when ctx is
// cancelled (browser gone, explicit disconnect) or the host is declared
// unreachable.
func (s *hostSession) run(ctx context.Context) {
	for {
		conn, err := s.client.hub.Dial(ctx, s.host)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if !s.everConnected() {
				// A host that has NEVER worked stops after one failure. There
				// is nothing alive on the far side to reconnect to, and a
				// mistyped hostname must not spin forever in the background.
				s.enter(HostUnreachable, err.Error(), 0)
				return
			}
			// A host that WAS working retries indefinitely: its panes are
			// still running over there.
			delay := s.nextDelay()
			s.enter(HostReconnecting, err.Error(), delay)
			if !sleepCtx(ctx, delay) {
				return
			}
			continue
		}

		s.adopt(conn)
		// Handlers before Run: the read loop starts dispatching the moment it
		// is scheduled, and an event that arrives before SetHandlers is an
		// event nobody receives.
		s.installHandlers()

		done := make(chan struct{})
		go func() {
			_ = conn.Run()
			close(done)
		}()

		s.afterConnect(conn)

		select {
		case <-done:
		case <-ctx.Done():
			_ = conn.Close()
			return
		}

		// The link dropped. KEEP this host's cached workspace and session rows
		// (design A.4 retention rule): the sidebar ghosts them, it must not
		// lose them. Only an explicit disconnect deletes the cache.
		s.mu.Lock()
		s.conn = nil
		s.mu.Unlock()

		delay := s.nextDelay()
		s.enter(HostReconnecting, "", delay)
		if !sleepCtx(ctx, delay) {
			return
		}
	}
}

// afterConnect performs the fixed post-connect sequence: re-assert the
// browser's subscriptions, refresh the merge cache, announce the host.
func (s *hostSession) afterConnect(conn DaemonConn) {
	c := s.client

	// A.5: subscriptions are recorded on the Client, and every session started
	// AFTERWARDS re-asserts them on connect. Without this a host connected
	// after page load silently produces no preview tiles and no session rows.
	// A remote that rejects the subscribe is logged, not surfaced: the
	// browser's fallback decision belongs to the local daemon.
	wantPreview, wantSessions := c.subscriptions()
	if wantPreview {
		if err := conn.PreviewSubscribe(true); err != nil {
			log.Printf("hostSession %s: preview-subscribe: %v", s.host.ID, err)
		}
	}
	if wantSessions {
		if err := conn.SessionStateSubscribe(true); err != nil {
			log.Printf("hostSession %s: session-state-subscribe: %v", s.host.ID, err)
		}
	}

	if workspaces, err := conn.ListWorkspaces(); err != nil {
		log.Printf("hostSession %s: ListWorkspaces: %v", s.host.ID, err)
	} else {
		c.setWorkspaces(s.host.ID, workspaces)
		c.emitWorkspaceList(0)
	}

	s.enter(HostConnected, "", 0)
}

// installHandlers wires this session's daemon events to the browser, with the
// host qualifier baked into every closure (design A.2, outbound half).
//
// Two classes:
//
//   - FAN-IN, accepted from every session with ids stamped: the workspace
//     list, session state, preview tiles, and workspace closed/renamed.
//   - ATTACHED-SESSION-ONLY, dropped when this is not the host the browser is
//     currently attached to: everything carrying a bare pane id.
//
// The drop is mandatory, not an optimization. A session for host A stays
// attached to A's workspace after the browser attaches to B -- protocol v1 has
// no detach -- and its pane-data frames carry workspace-local pane ids that
// would collide with B's in the browser's terminal registry.
func (s *hostSession) installHandlers() {
	c := s.client
	hostID := s.host.ID
	conn := s.daemon()
	if conn == nil {
		return
	}

	// attached reports whether this session owns the browser's current pane-id
	// namespace. For the local daemon with no remotes it is always true, so
	// every guard below is a branch not taken and the relayed bytes are
	// today's bytes.
	attached := func() bool { return c.getAttachedHost() == hostID }

	conn.SetHandlers(sessiond.Handlers{
		OnPaneOutput: func(paneID uint32, data []byte) {
			if !attached() {
				return
			}
			// Blocks while an Attach() reply is being forwarded to the
			// browser/app WebSocket (see attachSeq), so replay frames for the
			// pane just announced in that composition can never overtake it
			// on the wire.
			c.attachSeq.Lock()
			err := c.writeBinary(EncodeBinaryFrame(paneID, data))
			c.attachSeq.Unlock()
			if err != nil {
				log.Printf("attachClient: pane output write error: %v", err)
			}
		},
		OnPaneAdded: func(pane sessiond.PaneInfo) {
			if !attached() {
				return
			}
			c.sendMessage(&sessiond.Message{
				Type: sessiond.TypePaneAdded,
				// Already namespaced: the attached workspace id is stored
				// stamped, so state.ts keeps matching on it.
				WorkspaceID:     c.getWorkspaceID(),
				PaneID:          pane.PaneID,
				Cols:            pane.Cols,
				Rows:            pane.Rows,
				Title:           pane.Title,
				Placement:       pane.Placement,
				ReferencePaneID: pane.ReferencePaneID,
				ClientRef:       pane.ClientRef,
			})
		},
		OnPaneClosedWithWorkspace: func(workspaceID string, paneID int, processExitCode *int, runtimeMs int64) {
			if !attached() {
				return
			}
			c.sendMessage(&sessiond.Message{
				Type: sessiond.TypePaneClosed, WorkspaceID: nsID(hostID, workspaceID), PaneID: paneID,
				ProcessExitCode: processExitCode, RuntimeMs: runtimeMs,
			})
		},
		OnWorkspaceClosed: func(workspaceID string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceClosed, WorkspaceID: nsID(hostID, workspaceID)})
		},
		OnWorkspaceRenamed: func(workspaceID, name string) {
			c.sendMessage(&sessiond.Message{Type: sessiond.TypeWorkspaceRenamed, WorkspaceID: nsID(hostID, workspaceID), Name: name})
		},
		OnWorkspaceList: func(workspaces []sessiond.WorkspaceInfo) {
			// Whole-state document: merged at the edge, never forwarded raw,
			// or each host would clobber the last (design A.4).
			c.setWorkspaces(hostID, workspaces)
			c.emitWorkspaceList(0)
		},
		OnPaneRenamed: func(paneID int, name string) {
			if !attached() {
				return
			}
			c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneRenamed, PaneID: paneID, Name: name})
		},
		OnPaneResized: func(paneID uint32, cols, rows int) {
			if !attached() {
				return
			}
			c.sendMessage(&sessiond.Message{Type: sessiond.TypePaneResized, PaneID: int(paneID), Cols: cols, Rows: rows})
		},
		OnWorkspacePreview: func(msg *sessiond.Message) {
			// The tile names its own workspace (it is pushed for workspaces
			// this client is NOT attached to), so unlike OnPaneAdded the id
			// comes off the message rather than the attached workspace.
			c.sendMessage(&sessiond.Message{
				Type:        sessiond.TypeWorkspacePreview,
				WorkspaceID: nsID(hostID, msg.WorkspaceID),
				PaneID:      msg.PaneID,
				Title:       msg.Title,
				Cols:        msg.Cols,
				Rows:        msg.Rows,
				Lines:       msg.Lines,
			})
		},
		OnSessionState: func(msg *sessiond.Message) {
			// Every row names its own workspace and pane (the set spans
			// workspaces this client is not attached to). The other
			// whole-state document, so it merges rather than forwards.
			c.setSessions(hostID, msg.Sessions)
			c.emitSessionState()
		},
	})
}

// typeHostState is the relay-level message type. It is deliberately NOT a
// sessiond message type: it never travels on a daemon socket.
const typeHostState = "host-state"

// hostStateMessage is the server->browser host-state frame (design D).
//
// There is no browser->server direction: a retry travels as
// POST /api/remotes/{id}/connect, which is one door, already idempotent and
// already authenticated. retryInMs is a DURATION, not a deadline -- the
// browser computes retryAt on receipt and counts down locally, so the server
// never ticks a frame per second.
type hostStateMessage struct {
	Type      string    `json:"type"`
	Host      string    `json:"host"`
	Name      string    `json:"name,omitempty"`
	Target    string    `json:"target,omitempty"`
	State     HostState `json:"state"`
	Since     int64     `json:"since"`
	Attempt   int       `json:"attempt,omitempty"`
	RetryInMs int64     `json:"retryInMs,omitempty"`
	Error     string    `json:"error,omitempty"`
}

// emitHostState sends one host-state frame to this browser.
//
// It is never sent for the local daemon: local is unmarked (ux D2), and that
// is precisely the mechanism behind the zero-remote gate. A user with no
// remotes receives ZERO host-state frames, so the browser's remotes store
// stays empty and every consumer short-circuits to today's render.
func (c *Client) emitHostState(m hostStateMessage) {
	if m.Host == "" {
		return
	}
	data, err := json.Marshal(m)
	if err != nil {
		log.Printf("emitHostState: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("emitHostState: write error: %v", err)
	}
}

// startHostSession begins (or keeps) this browser's link to h.
//
// Idempotent by design so POST /api/remotes/{id}/connect can be repeated: a
// live or reconnecting session is left strictly alone. A session that gave up
// (unreachable) is replaced, because that is what the Retry button means.
func (c *Client) startHostSession(h transport.HostRef) {
	if h.ID == "" {
		return // the local daemon is not a remote
	}

	var stale *hostSession

	c.sessMu.Lock()
	if c.sessions == nil {
		c.sessions = make(map[string]*hostSession)
	}
	if existing, ok := c.sessions[h.ID]; ok {
		if existing.stateOf() != HostUnreachable {
			c.sessMu.Unlock()
			return
		}
		stale = existing
	}
	ctx, cancel := context.WithCancel(c.ctx)
	s := &hostSession{
		host:   h,
		client: c,
		state:  HostNeverConnected,
		since:  time.Now(),
		cancel: cancel,
	}
	c.sessions[h.ID] = s
	c.sessMu.Unlock()

	if stale != nil {
		stale.close()
	}

	// Announce the host BEFORE the first dial (design D: "one frame per
	// registry member immediately after attachClient"). Without this a fresh
	// tab renders no host group at all until the dial resolves, and a Retry
	// click leaves the old error row on screen while the new attempt runs.
	//
	// It reports never-connected rather than the registry's last-known state
	// because state is per browser: THIS tab has no connection yet, and
	// claiming otherwise would show a live host whose keystrokes are being
	// dropped. It also deliberately does not Note(): one tab attaching must
	// not erase the unreachable error another tab recorded.
	c.emitHostState(hostStateMessage{
		Type:   typeHostState,
		Host:   h.ID,
		Name:   h.DisplayName,
		Target: h.Addr,
		State:  HostNeverConnected,
		Since:  s.since.UnixMilli(),
	})

	go s.run(ctx)
}

// stopHostSession tears this browser's link to id down on an EXPLICIT
// disconnect or host removal.
//
// This is the one case where a host's workspaces vanish from the browser
// rather than ghosting, because the user asked for that (design A.4 retention
// rule / ux D8).
func (c *Client) stopHostSession(id string) {
	if id == "" {
		return
	}
	c.sessMu.Lock()
	s, ok := c.sessions[id]
	delete(c.sessions, id)
	c.sessMu.Unlock()

	if ok {
		s.close()
	}
	c.forgetHost(id)

	m := hostStateMessage{
		Type:  typeHostState,
		Host:  id,
		State: HostNeverConnected,
		Since: time.Now().UnixMilli(),
	}
	if ok {
		m.Name = s.host.DisplayName
		m.Target = s.host.Addr
	}
	c.emitHostState(m)
}

// adoptSession registers conn as this browser's session for host. Used for the
// local daemon on attach, where the connection is dialed by the hub rather
// than by a backoff loop.
func (c *Client) adoptSession(host transport.HostRef, conn DaemonConn) *hostSession {
	s := &hostSession{
		host:   host,
		client: c,
		conn:   conn,
		state:  HostConnected,
		since:  time.Now(),
		everUp: true,
	}
	c.sessMu.Lock()
	if c.sessions == nil {
		c.sessions = make(map[string]*hostSession)
	}
	c.sessions[host.ID] = s
	c.sessMu.Unlock()
	return s
}

// session returns this browser's session for host ("" = local).
func (c *Client) session(host string) (*hostSession, bool) {
	c.sessMu.Lock()
	defer c.sessMu.Unlock()
	s, ok := c.sessions[host]
	return s, ok
}

// sessionsSnapshot returns every session, local first then hosts sorted by id,
// so fan-out and merge share one stable order.
func (c *Client) sessionsSnapshot() []*hostSession {
	c.sessMu.Lock()
	out := make([]*hostSession, 0, len(c.sessions))
	for _, s := range c.sessions {
		out = append(out, s)
	}
	c.sessMu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].host.ID < out[j].host.ID })
	return out
}

// teardownSessions cancels every session and closes every connection. Called
// when the browser goes away.
func (c *Client) teardownSessions() {
	c.sessMu.Lock()
	sessions := make([]*hostSession, 0, len(c.sessions))
	for id, s := range c.sessions {
		sessions = append(sessions, s)
		delete(c.sessions, id)
	}
	unsub := c.unsubscribeRemotes
	c.unsubscribeRemotes = nil
	c.sessMu.Unlock()

	if unsub != nil {
		unsub()
	}
	for _, s := range sessions {
		s.close()
	}
}

// remoteRegistry returns the process registry, or nil when there is none.
func (c *Client) remoteRegistry() *RemoteRegistry {
	if c.hub == nil {
		return nil
	}
	return c.hub.Remotes()
}

// errHostNotConnected is what a browser message gets when the session it
// routed to has no live daemon connection. The local ("") wording is today's
// text verbatim: a zero-remote browser must see exactly what it sees now.
func errHostNotConnected(host string) error {
	if host == "" {
		return errors.New("no daemon connection")
	}
	return fmt.Errorf("host %s is not connected", host)
}

// sleepCtx waits for d, reporting false when ctx ended first.
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
