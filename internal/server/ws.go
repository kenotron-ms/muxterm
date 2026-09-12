package server

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/kenotron-ms/muxterm/internal/cos"
	"github.com/kenotron-ms/muxterm/internal/missioncontrol"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
	"github.com/kenotron-ms/muxterm/internal/transport"
)

// Client represents a connected WebSocket client. Each browser WebSocket is
// backed by its own DaemonConn; the Client relays the frozen sessiond.Message
// vocabulary in both directions, holding no terminal state of its own.
//
// The cid carried on each message lives in two independent domains: the
// browser<->serve cid is owned by the browser and echoed back by serve, while
// the serve<->daemon cid is owned by the DaemonConn internally. serve never
// rewrites browser cids onto daemon requests.
type Client struct {
	hub     *Hub
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	writeMu sync.Mutex
	// missionControlRequests isolates metadata lookups from terminal input while
	// retaining a bounded, per-client ordering for slow sidecar/identity work.
	missionControlRequests chan []byte
	// Mission Control selection belongs to this authenticated connection, never
	// to terminal navigation. Subscriptions deliberately outlive selection so a
	// late result remains visible in its originating thread.
	missionControlMu            sync.Mutex
	missionControlSelection     missionControlSelection
	missionControlSubscriptions map[string]missionControlSubscription

	// sessMu guards sessions and unsubscribeRemotes. sessions holds this
	// browser's daemon links keyed by transport.HostRef.ID; the empty key is
	// the LOCAL daemon, which is a hostSession like any other. It is empty
	// until the hub attaches the client.
	//
	// One connection per browser per host, never pooled (design D5): PTY
	// sizing authority is keyed on daemon-connection pointer identity.
	sessMu             sync.Mutex
	sessions           map[string]*hostSession
	unsubscribeRemotes func()

	// closeTickets retains browser-local target identity for opaque confirmation
	// tickets. It is touched only by this Client's readPump; the ticket remains
	// the sole daemon authorization input.
	closeTickets map[string]closeTicket

	// writeTextFn/writeBinaryFn perform the actual frame writes. Production
	// wires them to the real WebSocket writers in newClient; tests inject
	// capturing closures.
	writeTextFn   func([]byte) error
	writeBinaryFn func([]byte) error

	// wsMu guards workspaceID and attachedHost, the workspace this client is
	// currently attached to and the host it lives on. They are set together on
	// a successful TypeAttach and read by daemon event relay handlers (e.g.
	// OnPaneAdded) that need to stamp WorkspaceID onto events the daemon
	// itself does not carry a workspace id on, since a client is only ever
	// attached to a single workspace at a time.
	//
	// workspaceID is stored NAMESPACED (it is browser-facing); attachedHost is
	// the bare HostRef.ID, "" for local. attachedHost is also the pane-id
	// namespace: pane ids never carry a host qualifier (design A.3), so the
	// attached session is what disambiguates them.
	//
	// breakpoint is the responsive layout key the browser sent with that
	// attach. It is remembered for one reason: an attach re-issued by the
	// server (hostSession.reattach, after a remote host's link comes back) has
	// no browser message to read it off, and the daemon answers a blank
	// breakpoint with a BLANK layout -- which would silently flatten the user's
	// saved arrangement on every reconnect.
	wsMu         sync.Mutex
	workspaceID  string
	attachedHost string
	breakpoint   string

	// subMu guards the browser's subscription opt-ins. They are recorded here
	// so that every session started AFTERWARDS can re-assert them on connect
	// (design A.5) -- without that, a host connected after page load silently
	// produces no preview tiles and no session rows.
	subMu              sync.Mutex
	previewWanted      bool
	sessionStateWanted bool

	// mergeMu guards the whole-state merge caches. workspace-list and
	// session-state are complete-set REPLACEMENTS that the browser applies
	// wholesale, so with N sessions each pushing its own full set, forwarding
	// them raw would make every host clobber the last. The edge is the merge
	// point (design A.4). Ids in both caches are ALREADY namespaced.
	mergeMu  sync.Mutex
	wsByHost map[string][]sessiond.WorkspaceInfo
	ssByHost map[string][]sessiond.SessionState

	// cosMu guards cosSub, this connection's opt-in subscription to the
	// server-owned chief-of-staff event stream (cos.go). nil means "never
	// subscribed": a connection that never sends cos-subscribe receives no
	// cos-event and costs nothing. Every subscription is an independent,
	// droppable view of the ONE shared broker, so a turn submitted in any tab
	// streams to all of them without this layer fanning anything out.
	cosMu  sync.Mutex
	cosSub *cos.Subscription

	// attachSeq enforces the frozen "composition FIRST" ordering guarantee
	// across the goroutine boundary between the daemon connection's read loop
	// (which delivers the composition reply via request/reply correlation on
	// one goroutine, then immediately continues its loop and dispatches the
	// following replay pane-data frames via OnPaneOutput on that SAME
	// goroutine) and this Client's own handleTextInput goroutine (which
	// receives the composition reply and must forward it to the browser/app
	// WebSocket). Without this lock, OnPaneOutput's writeBinary calls for
	// replay frames race ahead of handleTextInput's sendMessage(composition)
	// call and reach the wire first, since a buffered-channel handoff to the
	// pending request does not yield the daemon read-loop goroutine. Held by
	// handleTextInput for the full Attach()+sendMessage(composition) sequence,
	// and by OnPaneOutput around every binary relay, so pane-data can never be
	// written to the WebSocket while a composition send is in flight.
	attachSeq sync.Mutex

	// appVoiceAllowed is derived from the original authenticated WebSocket
	// upgrade request. App voice claims never accept a later frame as proof that
	// this socket was opened by the same origin.
	appVoiceAllowed bool
	appVoicePanes   map[string]map[int]bool
}

const (
	closeRelayFailureCode    = "close-relay-failed"
	closeRelayFailureMessage = "Close request could not be completed; try again."
)

// setAttached records the workspace this client is currently attached to, the
// host it lives on, and the breakpoint it asked for. workspaceID is the
// NAMESPACED id, because that is what the browser was told.
func (c *Client) setAttached(host, workspaceID, breakpoint string) {
	c.wsMu.Lock()
	c.attachedHost = host
	c.workspaceID = workspaceID
	c.breakpoint = breakpoint
	c.wsMu.Unlock()
}

// attachedTo reports the BARE, daemon-local workspace id this client is
// attached to on host, plus the breakpoint that attach carried, and whether it
// is attached there at all.
//
// It is how a session re-establishes the browser's attachment on a fresh
// connection. The bare id is the point: the attach travels to a daemon, and no
// daemon may ever see a namespaced id (rule P6). The host check makes the local
// daemon and every OTHER host answer false -- for local, because
// hostSession.run (the only caller's caller) never runs for it, and for another
// host, because its attachment belongs to a different session's connection.
func (c *Client) attachedTo(host string) (workspaceID, breakpoint string, ok bool) {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	if host == "" || c.attachedHost != host || c.workspaceID == "" {
		return "", "", false
	}
	qualifier, local := splitID(c.workspaceID)
	if qualifier != host || local == "" {
		return "", "", false
	}
	return local, c.breakpoint, true
}

// getWorkspaceID returns the namespaced workspace this client is currently
// attached to, or "" if it has not attached yet.
func (c *Client) getWorkspaceID() string {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	return c.workspaceID
}

// getAttachedHost returns the HostRef.ID of the session this client is
// attached to. "" is the local daemon AND the value before any attach, which
// is why a browser with no remotes takes the local branch everywhere.
func (c *Client) getAttachedHost() string {
	c.wsMu.Lock()
	defer c.wsMu.Unlock()
	return c.attachedHost
}

// setPreviewWanted / setSessionStateWanted record the browser's opt-ins;
// subscriptions reads them back for a session that connects later (A.5).
func (c *Client) setPreviewWanted(v bool) {
	c.subMu.Lock()
	c.previewWanted = v
	c.subMu.Unlock()
}

func (c *Client) setSessionStateWanted(v bool) {
	c.subMu.Lock()
	c.sessionStateWanted = v
	c.subMu.Unlock()
}

func (c *Client) subscriptions() (preview, sessionState bool) {
	c.subMu.Lock()
	defer c.subMu.Unlock()
	return c.previewWanted, c.sessionStateWanted
}

func validCloseTarget(target sessiond.CloseTarget) bool {
	if target.WorkspaceID == "" {
		return false
	}
	switch target.Kind {
	case sessiond.CloseTargetPane:
		return target.PaneID > 0
	case sessiond.CloseTargetWorkspace:
		return target.PaneID == 0
	default:
		return false
	}
}

// closeTicket is the browser-local memory of one opaque confirmation ticket:
// the target to echo back and the host whose session issued it.
//
// The target's WorkspaceID is NAMESPACED, because every use of it is
// browser-facing. host is what routes the eventual close-confirm, since the
// ticket string itself is daemon-random and says nothing about where it came
// from. Ticket strings are daemon-random, so a cross-host collision is
// theoretically possible and resolves last-writer-wins: accepted, and recorded
// here rather than defended against.
type closeTicket struct {
	target sessiond.CloseTarget
	host   string
}

func (c *Client) rememberCloseTicket(host string, outcome sessiond.CloseOutcome) {
	target := sessiond.CloseTarget{
		Kind:        outcome.TargetKind,
		WorkspaceID: outcome.WorkspaceID,
		PaneID:      outcome.PaneID,
	}
	if outcome.Status != sessiond.CloseStatusConfirmationRequired ||
		outcome.Ticket == "" || !validCloseTarget(target) {
		return
	}

	if c.closeTickets == nil {
		c.closeTickets = make(map[string]closeTicket)
	}
	if _, exists := c.closeTickets[outcome.Ticket]; !exists &&
		len(c.closeTickets) >= sessiond.CloseTicketCapacity {
		for ticket := range c.closeTickets {
			delete(c.closeTickets, ticket)
			break
		}
	}
	c.closeTickets[outcome.Ticket] = closeTicket{target: target, host: host}
}

func (c *Client) closeTargetForTicket(ticket string) (sessiond.CloseTarget, bool) {
	t, ok := c.closeTickets[ticket]
	return t.target, ok
}

func (c *Client) forgetCloseTicket(ticket string) {
	delete(c.closeTickets, ticket)
}

func closeOutcomeWithFallbackTarget(outcome sessiond.CloseOutcome, fallback sessiond.CloseTarget) sessiond.CloseOutcome {
	if outcome.TargetKind == "" && validCloseTarget(fallback) {
		outcome.TargetKind = fallback.Kind
		outcome.WorkspaceID = fallback.WorkspaceID
		outcome.PaneID = fallback.PaneID
	}
	return outcome
}

func closeRelayFailure(target sessiond.CloseTarget) sessiond.CloseOutcome {
	return sessiond.CloseOutcome{
		Status:      sessiond.CloseStatusFailed,
		TargetKind:  target.Kind,
		WorkspaceID: target.WorkspaceID,
		PaneID:      target.PaneID,
		FailureCode: closeRelayFailureCode,
		Error:       closeRelayFailureMessage,
	}
}

// newClient creates a new Client with a cancellable context and real WebSocket
// writers.
func newClient(hub *Hub, conn *websocket.Conn) *Client {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		hub:                    hub,
		conn:                   conn,
		ctx:                    ctx,
		cancel:                 cancel,
		sessions:               make(map[string]*hostSession),
		closeTickets:           make(map[string]closeTicket),
		missionControlRequests: make(chan []byte, missionControlRequestQueueSize),
		wsByHost:               make(map[string][]sessiond.WorkspaceInfo),
		ssByHost:               make(map[string][]sessiond.SessionState),
		appVoicePanes:          make(map[string]map[int]bool),
	}
	c.writeTextFn = func(data []byte) error {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
		defer wcancel()
		return c.conn.Write(wctx, websocket.MessageText, data)
	}
	c.writeBinaryFn = func(data []byte) error {
		c.writeMu.Lock()
		defer c.writeMu.Unlock()
		wctx, wcancel := context.WithTimeout(c.ctx, 5*time.Second)
		defer wcancel()
		return c.conn.Write(wctx, websocket.MessageBinary, data)
	}
	go c.missionControlWorker()
	return c
}

// writeBinary writes a binary frame via the client's binary writer.
func (c *Client) writeBinary(data []byte) error { return c.writeBinaryFn(data) }

// writeText writes a text frame via the client's text writer.
func (c *Client) writeText(data []byte) error { return c.writeTextFn(data) }

// --- connection heartbeat --------------------------------------------------
//
// Nothing kept a browser's WebSocket warm. A phone with the screen off, silent
// for a minute in the middle of a voice conversation, sends nothing and is sent
// nothing -- and an idle TCP connection crossing a carrier NAT, a home router,
// or a mobile radio that has gone to sleep is a connection that quietly stops
// existing at one end while both ends still believe in it. The browser then
// discovers the loss only when it next tries to write, which on a silent link
// is exactly when the user finally speaks.
//
// So the server pings.
//
// WHY THE SERVER AND NOT THE BROWSER. Three reasons, in order of weight:
//
//  1. The browser CANNOT send a WebSocket ping. The WHATWG WebSocket API
//     exposes no ping method at all, so a client-initiated heartbeat would have
//     to be an application-level message -- a new frame type in the frozen
//     sessiond vocabulary, on both sides, for something RFC 6455 already has.
//  2. A server ping costs a backgrounded client nothing. The browser answers
//     ping frames with pongs down in its network stack, below JavaScript, so
//     the round trip completes even when the page's timers are throttled or
//     frozen -- which on Android is precisely the state we are trying to
//     survive. A client-driven timer is the FIRST thing the platform stops.
//  3. It keeps every NAT binding and idle-timeout clock along the path warm
//     from the far end, which is the end that actually has to still be there.
//
// What server-initiated CANNOT catch, stated plainly: it does not prove the
// page's own event loop is still running. A WebView whose JavaScript is frozen
// still answers pings in the network stack, so the server would call that
// connection healthy while the UI is dead. A client-initiated heartbeat would
// catch exactly that and nothing else. That failure is the browser's own to
// notice, and the wake signals added in #94 (visibilitychange / focus / online)
// are what notice it.
//
// THE INTERVAL. 25 seconds. The constraint is that it must be comfortably
// shorter than the shortest idle timeout anywhere on the path. Measured, not
// assumed:
//
//   - The Caddy in front of this server imposes NO idle timeout on an upgraded
//     WebSocket. Its reverse_proxy `stream_timeout` defaults to "no timeout"
//     and is only armed when nonzero, and once the connection is hijacked for
//     the upgrade net/http's IdleTimeout (Caddy default 5m) no longer applies
//     to it. So the local proxy is not the clock we are racing.
//   - The clocks we ARE racing cannot be read from here: the edge proxy, the
//     carrier or Wi-Fi NAT, and the phone's radio. 25s is comfortably under
//     every common value in that class (nginx proxy_read_timeout 60s,
//     Cloudflare 100s, typical NAT UDP/TCP idle 60s+), and cheap: two control
//     frames per client per 25s is nothing next to terminal output.
//
// AN UNANSWERED PING MUST KILL THE CONNECTION. A heartbeat that keeps a dead
// connection looking alive is worse than no heartbeat, so Ping's pong wait is
// the liveness test, not a formality: after pingMaxMisses consecutive pings go
// unanswered the client is closed. c.close() cancels c.ctx, which unblocks
// readPump's Read, whose deferred hub.Remove performs the ordinary teardown --
// the SAME death path as any other dropped connection. The browser therefore
// sees an ordinary onclose and recovers on #94's reconnect ladder; there is no
// second recovery mechanism to keep in step with the first.
const (
	// pingInterval is the gap between heartbeat pings.
	pingInterval = 25 * time.Second
	// pingTimeout bounds the wait for one pong. Generous on purpose: a mobile
	// radio waking from idle can take seconds to deliver the first packet, and
	// mistaking that for death costs the user a reconnect.
	pingTimeout = 10 * time.Second
	// pingMaxMisses is how many CONSECUTIVE unanswered pings mean death.
	//
	// Two, not one. One miss would detect a dead link ~35s sooner, and with
	// #94's ladder re-dialling in 300ms a wrong guess is cheap in wall clock --
	// but it is not free: a reconnect re-runs attach, re-composes the
	// workspace, and flashes the overlay over whatever the user is doing. A
	// single dropped packet on a mobile link is common enough that one miss
	// would do that regularly. Two consecutive misses across a 35s window is
	// not a blip. Worst case to notice a genuinely dead connection is
	// therefore (25+10)*2 = 70s; the ALTERNATIVE, one miss, would make that 35s
	// at the cost of spurious reconnects, and is a one-constant change.
	pingMaxMisses = 2
)

// heartbeat pings the browser every pingInterval and closes the connection when
// the pongs stop coming. Runs until the client's context is cancelled.
//
// Ping must run concurrently with a reader -- it writes the ping frame itself
// but relies on readPump's Read to deliver the pong -- which is why this is
// started alongside readPump and not from inside it.
func (c *Client) heartbeat() {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	misses := 0
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
		}

		pctx, pcancel := context.WithTimeout(c.ctx, pingTimeout)
		err := c.conn.Ping(pctx)
		pcancel()

		if err == nil {
			misses = 0
			continue
		}
		// The connection is already being torn down by someone else; the
		// heartbeat has no verdict to add.
		if c.ctx.Err() != nil {
			return
		}

		misses++
		if misses < pingMaxMisses {
			log.Printf("ws heartbeat: ping unanswered (%d/%d): %v", misses, pingMaxMisses, err)
			continue
		}
		log.Printf("ws heartbeat: %d consecutive pings unanswered, closing connection: %v", misses, err)
		c.close()
		return
	}
}

// readPump loops reading messages from the connection.
// On exit it removes the client from the hub.
func (c *Client) readPump() {
	defer c.hub.Remove(c)

	for {
		msgType, data, err := c.conn.Read(c.ctx)
		if err != nil {
			return
		}

		switch msgType {
		case websocket.MessageBinary:
			c.handleBinaryInput(data)
		case websocket.MessageText:
			c.handleTextInput(data)
		}
	}
}

// handleBinaryInput decodes a binary frame and forwards the payload to the
// daemon as pane input. Binary framing is unchanged from the legacy protocol:
// [4-byte LE uint32 paneId][raw bytes].
func (c *Client) handleBinaryInput(data []byte) {
	paneID, payload, err := DecodeBinaryFrame(data)
	if err != nil {
		log.Printf("handleBinaryInput: decode error: %v", err)
		return
	}
	// The frame carries a bare, workspace-local pane id -- a 4-byte
	// little-endian uint32 that a host prefix does not fit into and the frozen
	// protocol forbids widening (design A.3). It therefore belongs to whichever
	// session this browser is currently attached to, which IS the pane-id
	// namespace. With no remotes that is always the local daemon.
	var dc DaemonConn
	if sess, ok := c.session(c.getAttachedHost()); ok {
		dc = sess.daemon()
	}
	if dc == nil {
		log.Printf("handleBinaryInput: no daemon connection")
		return
	}
	if err := dc.Input(paneID, payload); err != nil {
		log.Printf("handleBinaryInput: Input error: %v", err)
	}
}

// route resolves which host a browser message is for, strips the host
// qualifier from every id it carries, and returns the session to run the
// existing switch against. browserWSID is the ORIGINAL namespaced id, kept
// because every error and every reply must echo what the browser sent.
//
// This is the inbound half of the rewrite boundary (design A.2). Nothing below
// it ever sees a namespaced id, and no daemon ever does.
func (c *Client) route(msg *sessiond.Message) (sess *hostSession, browserWSID string, err error) {
	browserWSID = msg.WorkspaceID
	host := ""

	switch msg.Type {
	case sessiond.TypeCreateWorkspace:
		// The id here is a HOST SELECTOR ("ssh:boxb/"), not a workspace
		// reference: it names WHERE to create, and the daemon must never see
		// it (rule P6). Absent or empty means local.
		host, _ = splitID(msg.WorkspaceID)
		msg.WorkspaceID = ""

	case sessiond.TypeAttach,
		sessiond.TypeRenameWorkspace,
		sessiond.TypeCloseWorkspace,
		sessiond.TypeSaveLayout,
		sessiond.TypeCloseIntent:
		host, msg.WorkspaceID = splitID(msg.WorkspaceID)

	case sessiond.TypeCloseConfirm:
		// The ticket is opaque daemon-random state carrying no host, so the
		// host is whichever session produced the outcome that minted it.
		if t, ok := c.closeTickets[msg.Ticket]; ok {
			host = t.host
		}

	case sessiond.TypeListWorkspaces,
		sessiond.TypePreviewSubscribe,
		sessiond.TypeSessionStateSubscribe:
		// Fan-out types. They reach every session, but the LOCAL one drives
		// the browser's reply -- which is what keeps zero-remote behaviour
		// byte-for-byte unchanged.
		host = ""

	default:
		// create-pane, close-pane, rename-pane, resize, pane-focus (and any
		// unknown type, so its error still echoes correctly) follow the
		// attached session: their pane ids are bare and workspace-local, and
		// the attached session is their namespace (design A.3).
		host = c.getAttachedHost()
	}

	sess, ok := c.session(host)
	if !ok || sess.daemon() == nil {
		return nil, browserWSID, errHostNotConnected(host)
	}
	return sess, browserWSID, nil
}

// handleTextInput unmarshals a frozen sessiond.Message from the browser and
// relays it to the daemon, re-emitting the reply with the browser's cid echoed.
func (c *Client) handleTextInput(data []byte) {
	// Chief-of-staff frames are SERVE-LOCAL: they are answered here and never
	// relayed to sessiond, so they are routed off before the sessiond decode
	// and, deliberately, before the "no daemon connection" guard below. The
	// CoS is server-owned and reaches muxterm through the MCP server, not
	// through this client's daemon socket.
	var probe struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &probe); err == nil {
		if isAppVoiceMessage(probe.Type) {
			c.hub.mu.RLock()
			appVoice := c.hub.appVoice
			c.hub.mu.RUnlock()
			if appVoice != nil {
				appVoice.handleFrame(c, data)
			}
			return
		}
		if isCosMessage(probe.Type) {
			c.handleCosMessage(data)
			return
		}
		if isMissionControlMessage(probe.Type) {
			c.enqueueMissionControlMessage(data)
			return
		}
	}

	var msg sessiond.Message
	if err := json.Unmarshal(data, &msg); err != nil {
		c.sendError(0, "", fmt.Errorf("invalid JSON: %w", err))
		return
	}

	// One routing step before the switch: pick the session, strip the host
	// qualifier off every id the message carries, and keep the browser's
	// original id for the echo. With no remotes configured route always yields
	// the local session and strips nothing, so everything below is unchanged.
	sess, browserWSID, err := c.route(&msg)
	if err != nil {
		c.sendError(msg.CID, browserWSID, err)
		return
	}
	host := sess.host.ID
	dc := sess.daemon()
	if dc == nil {
		c.sendError(msg.CID, browserWSID, errHostNotConnected(host))
		return
	}

	switch msg.Type {
	case sessiond.TypeAttach:
		// attachSeq must be held for the entire Attach()+sendMessage sequence:
		// it also gates OnPaneOutput's binary relay (see installHandlers), so
		// no replay pane-data frame can reach the WebSocket before the
		// composition reply that announces its pane, preserving the frozen
		// "composition FIRST" wire ordering across the goroutine boundary.
		c.attachSeq.Lock()
		comp, err := dc.Attach(msg.WorkspaceID, msg.Breakpoint, "interactive")
		if err != nil {
			c.attachSeq.Unlock()
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		attachedID := nsID(host, comp.WorkspaceID)
		c.setAttached(host, attachedID, msg.Breakpoint)
		c.rememberAppVoicePanes(attachedID, comp.Panes)
		c.sendMessage(&sessiond.Message{
			Type:        sessiond.TypeComposition,
			CID:         msg.CID,
			WorkspaceID: attachedID,
			Panes:       comp.Panes,
			Layout:      comp.Layout,
		})
		c.attachSeq.Unlock()

	case sessiond.TypeListWorkspaces:
		// Fan-out (design A.4): every session refreshes its cache in parallel
		// under one deadline and ONE merged reply carries the union. A remote
		// that fails keeps its last-known list; a LOCAL failure is still
		// reported verbatim, which is exactly what a browser sees today.
		if err := c.refreshWorkspaceLists(); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		c.emitWorkspaceList(msg.CID)

	case sessiond.TypeCreateWorkspace:
		id, err := dc.CreateWorkspace(msg.Name)
		if err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:        sessiond.TypeWorkspaceCreated,
			CID:         msg.CID,
			WorkspaceID: nsID(host, id),
			Name:        msg.Name,
			ClientRef:   msg.ClientRef,
		})

	case sessiond.TypeRenameWorkspace:
		if err := dc.RenameWorkspace(msg.WorkspaceID, msg.Name); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		if wsList, err := dc.ListWorkspaces(); err == nil {
			c.setWorkspaces(host, wsList)
			c.emitWorkspaceList(0)
		}

	case sessiond.TypeCloseWorkspace:
		if err := dc.CloseWorkspace(msg.WorkspaceID); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		if wsList, err := dc.ListWorkspaces(); err == nil {
			c.setWorkspaces(host, wsList)
			c.emitWorkspaceList(0)
		}

	case sessiond.TypeCloseIntent:
		target := sessiond.CloseTarget{
			Kind:        sessiond.CloseTargetKind(msg.TargetKind),
			WorkspaceID: msg.WorkspaceID,
			PaneID:      msg.PaneID,
		}
		outcome, err := dc.CloseIntent(target)
		if err != nil {
			// The relay-failure outcome is browser-facing, so it echoes the
			// id the browser sent, not the stripped one.
			browserTarget := target
			browserTarget.WorkspaceID = browserWSID
			c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, closeRelayFailure(browserTarget)))
			return
		}
		outcome.WorkspaceID = nsID(host, outcome.WorkspaceID)
		c.rememberCloseTicket(host, outcome)
		c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, outcome))

	case sessiond.TypeCloseConfirm:
		// The remembered target is already namespaced; every use of it below
		// goes straight to the browser.
		target, knownTarget := c.closeTargetForTicket(msg.Ticket)
		outcome, err := dc.CloseConfirm(msg.Ticket)
		if err != nil {
			c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, closeRelayFailure(target)))
			return
		}
		c.forgetCloseTicket(msg.Ticket)
		outcome.WorkspaceID = nsID(host, outcome.WorkspaceID)
		if knownTarget {
			outcome = closeOutcomeWithFallbackTarget(outcome, target)
		}
		c.rememberCloseTicket(host, outcome)
		c.sendMessage(sessiond.CloseOutcomeMessage(msg.CID, outcome))

	case sessiond.TypeCreatePane:
		paneID, err := dc.CreatePane(msg.Cmd, msg.Placement, msg.ReferencePaneID, msg.ClientRef)
		if err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type:   sessiond.TypePaneCreated,
			CID:    msg.CID,
			PaneID: paneID,
		})

	case sessiond.TypeResize:
		// Fire-and-forget: the daemon sends no reply.
		if err := dc.Resize(msg.PaneID, msg.Cols, msg.Rows); err != nil {
			log.Printf("handleTextInput: resize error: %v", err)
		}

	case sessiond.TypePaneFocus:
		// Fire-and-forget: the daemon sends no reply.
		if err := dc.PaneFocus(uint32(msg.PaneID), msg.Cols, msg.Rows); err != nil {
			log.Printf("handleTextInput: pane-focus error: %v", err)
		}

	case sessiond.TypeRenamePane:
		if err := dc.RenamePane(msg.PaneID, msg.Name); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeClosePane:
		if err := dc.ClosePane(msg.PaneID); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		// The daemon broadcasts pane-closed to all subscribers; the ok
		// here is just an ack back to the requesting client.
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypeSaveLayout:
		if err := dc.SaveLayout(msg.WorkspaceID, msg.Breakpoint, msg.Layout); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		c.sendMessage(&sessiond.Message{Type: sessiond.TypeOK, CID: msg.CID})

	case sessiond.TypePreviewSubscribe:
		// Per-connection opt-in for sidebar preview tiles. An error here means
		// the daemon is older than this browser and does not know the message
		// type; relaying it lets the browser fall back to its non-preview
		// cards immediately instead of waiting for tiles that never arrive.
		//
		// Recorded on the Client first so a host connected later re-asserts
		// it (A.5), then fanned out; only the LOCAL daemon's answer reaches
		// the browser, so zero-remote behaviour is unchanged.
		c.setPreviewWanted(msg.OK)
		c.broadcastSubscribe(host, func(conn DaemonConn) error { return conn.PreviewSubscribe(msg.OK) })
		if err := dc.PreviewSubscribe(msg.OK); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type: sessiond.TypePreviewSubscribeResult,
			CID:  msg.CID,
			OK:   true,
		})

	case sessiond.TypeSessionStateSubscribe:
		// Per-connection opt-in for home-view session state, with the same
		// old-daemon contract as preview-subscribe above: an error means this
		// daemon predates the feature, and relaying it lets the browser stop
		// waiting for rows that are never coming.
		c.setSessionStateWanted(msg.OK)
		c.broadcastSubscribe(host, func(conn DaemonConn) error { return conn.SessionStateSubscribe(msg.OK) })
		if err := dc.SessionStateSubscribe(msg.OK); err != nil {
			c.sendError(msg.CID, browserWSID, err)
			return
		}
		c.sendMessage(&sessiond.Message{
			Type: sessiond.TypeSessionStateSubscribeResult,
			CID:  msg.CID,
			OK:   true,
		})

	default:
		c.sendError(msg.CID, browserWSID, fmt.Errorf("unknown action: %s", msg.Type))
	}
}

// broadcastSubscribe forwards a browser subscription to every session EXCEPT
// the one driving the reply. A remote that rejects it is logged, not surfaced:
// the browser's fallback decision belongs to the local daemon (design A.5).
func (c *Client) broadcastSubscribe(except string, apply func(DaemonConn) error) {
	for _, s := range c.sessionsSnapshot() {
		if s.host.ID == except {
			continue
		}
		conn := s.daemon()
		if conn == nil {
			continue
		}
		if err := apply(conn); err != nil {
			log.Printf("broadcastSubscribe %s: %v", s.host.ID, err)
		}
	}
}

// refreshWorkspaceLists re-reads every session's workspace list in parallel
// under one deadline and refreshes the merge cache.
//
// A session that fails keeps its last-known list -- workspaces ghost, they do
// not vanish. The one error returned is the LOCAL daemon's, because that is
// the failure a browser is shown today and the zero-remote path must not
// change.
func (c *Client) refreshWorkspaceLists() error {
	var (
		wg    sync.WaitGroup
		local *hostSession
	)

	for _, s := range c.sessionsSnapshot() {
		if s.isLocal() {
			local = s
			continue
		}
		conn := s.daemon()
		if conn == nil {
			continue
		}
		wg.Add(1)
		go func(s *hostSession, conn DaemonConn) {
			defer wg.Done()
			wsList, err := conn.ListWorkspaces()
			if err != nil {
				log.Printf("refreshWorkspaceLists %s: %v", s.host.ID, err)
				return
			}
			c.setWorkspaces(s.host.ID, wsList)
		}(s, conn)
	}

	// The local daemon is called on this goroutine, unbounded, exactly as it
	// is today: it owns the reply, and wrapping it in a deadline it never had
	// would be a behaviour change on the one path that must not change.
	var localErr error
	if local != nil {
		if conn := local.daemon(); conn != nil {
			wsList, err := conn.ListWorkspaces()
			if err != nil {
				localErr = err
			} else {
				c.setWorkspaces("", wsList)
			}
		}
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(workspaceListFanoutDeadline):
		// A stalled remote must not hold the browser's list-workspaces open.
		// Whatever answered is already in the cache and whatever did not keeps
		// its last-known list; the next push repairs it, because both merged
		// messages are whole-state documents.
		log.Printf("refreshWorkspaceLists: fan-out deadline exceeded")
	}
	return localErr
}

// workspaceListFanoutDeadline bounds one browser-initiated list-workspaces
// fan-out across every session.
const workspaceListFanoutDeadline = 5 * time.Second

// setWorkspaces replaces host's cached workspace list, stamping every id.
func (c *Client) setWorkspaces(host string, workspaces []sessiond.WorkspaceInfo) {
	stamped := stampWorkspaces(host, workspaces)
	c.mergeMu.Lock()
	if c.wsByHost == nil {
		c.wsByHost = make(map[string][]sessiond.WorkspaceInfo)
	}
	c.wsByHost[host] = stamped
	c.mergeMu.Unlock()
}

// setSessions replaces host's cached session-state set, stamping every row.
func (c *Client) setSessions(host string, sessions []sessiond.SessionState) {
	stamped := stampSessions(host, sessions)
	c.mergeMu.Lock()
	if c.ssByHost == nil {
		c.ssByHost = make(map[string][]sessiond.SessionState)
	}
	c.ssByHost[host] = stamped
	c.mergeMu.Unlock()
}

// forgetHost drops a host's cached slices and re-emits both merged documents.
//
// This is the EXPLICIT-disconnect half of the retention rule (design A.4): a
// transport drop keeps the cache so the sidebar can ghost the workspaces,
// while a disconnect deletes it so they vanish -- because that is what the
// user asked for.
func (c *Client) forgetHost(host string) {
	c.mergeMu.Lock()
	delete(c.wsByHost, host)
	delete(c.ssByHost, host)
	c.mergeMu.Unlock()
	c.emitWorkspaceList(0)
	c.emitSessionState()
}

// mergedHosts returns the cache keys in the browser's stable render order:
// local ("") first, then hosts sorted by id, so the sidebar does not reshuffle
// on every push.
func mergedHosts[T any](byHost map[string][]T) []string {
	out := make([]string, 0, len(byHost))
	for h := range byHost {
		if h != "" {
			out = append(out, h)
		}
	}
	sort.Strings(out)
	if _, ok := byHost[""]; ok {
		out = append([]string{""}, out...)
	}
	return out
}

// emitWorkspaceList sends ONE workspace-list carrying the union across every
// session. It is a whole-state document, so re-emitting the union on any
// change is idempotent and a dropped frame is repaired by the next one.
//
// With only the local daemon in the cache the union IS the local list, in the
// daemon's own order, with the daemon's own bare ids -- byte-for-byte today's
// message.
func (c *Client) emitWorkspaceList(cid uint64) {
	c.mergeMu.Lock()
	total := 0
	for _, v := range c.wsByHost {
		total += len(v)
	}
	out := make([]sessiond.WorkspaceInfo, 0, total)
	for _, h := range mergedHosts(c.wsByHost) {
		out = append(out, c.wsByHost[h]...)
	}
	c.mergeMu.Unlock()

	c.sendMessage(&sessiond.Message{
		Type:       sessiond.TypeWorkspaceList,
		CID:        cid,
		Workspaces: out,
	})
}

// emitSessionState sends ONE session-state carrying the union across every
// session, with the same whole-state/idempotent contract as emitWorkspaceList.
func (c *Client) emitSessionState() {
	c.mergeMu.Lock()
	total := 0
	for _, v := range c.ssByHost {
		total += len(v)
	}
	out := make([]sessiond.SessionState, 0, total)
	for _, h := range mergedHosts(c.ssByHost) {
		out = append(out, c.ssByHost[h]...)
	}
	c.mergeMu.Unlock()

	c.sendMessage(&sessiond.Message{
		Type:     sessiond.TypeSessionState,
		Sessions: out,
	})
}

// sendMessage marshals a frozen sessiond.Message and writes it as a text frame.
func (c *Client) sendMessage(msg *sessiond.Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("sendMessage: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendMessage: write error: %v", err)
	}
}

// sendConfig writes the serve-owned resolved configuration as a text frame.
// This is a serve-local envelope ({"type":"config","config":cfg}), NOT a
// sessiond message.
func (c *Client) sendConfig(cfg any) {
	data, err := json.Marshal(map[string]any{"type": "config", "config": cfg})
	if err != nil {
		log.Printf("sendConfig: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendConfig: write error: %v", err)
	}
}

// sendError relays a TypeError envelope to the browser, echoing cid. A
// *sessiond.DaemonError preserves the machine-readable Code (and its
// human-readable text and workspace id) so the browser sees the original error.
func (c *Client) sendError(cid uint64, workspaceID string, err error) {
	m := &sessiond.Message{
		Type:        sessiond.TypeError,
		CID:         cid,
		WorkspaceID: workspaceID,
		Error:       err.Error(),
	}
	var de *sessiond.DaemonError
	if errors.As(err, &de) {
		m.Code = de.Code
		m.Error = de.Err
		if de.WorkspaceID != "" {
			m.WorkspaceID = de.WorkspaceID
		}
	}
	c.sendMessage(m)
}

// close cancels the client context and closes the connection.
func (c *Client) close() {
	c.cancel()
	if c.conn != nil {
		c.conn.CloseNow()
	}
}

// Hub manages WebSocket clients, dialing one DaemonConn per browser.
type Hub struct {
	clients        map[*Client]bool
	mu             sync.RWMutex
	dial           DialFunc
	resolvedConfig any             // muxterm-owned resolved config, shipped to clients on connect
	tunnels        *TunnelRegistry // shared tunnel registry for /t/{id}/ proxy
	// remotes is the process-wide record of which hosts the user asked to
	// reach. It holds no connection of its own -- those are per browser (D5).
	// nil when the process was wired without a remote transport, which makes
	// the whole feature inert.
	remotes *RemoteRegistry

	// cos owns the single, lazily-started chief-of-staff sidecar every
	// browser tab shares. One per hub, i.e. one per muxterm server -- the
	// conversation is server-owned, not per-browser, which is why it lives
	// beside resolvedConfig rather than on the Client. Nothing is spawned
	// until a browser sends cos-subscribe or cos-turn.
	cos *cosRelay

	// missionControl owns durable thread metadata. Router is present only when
	// both explicit text-preview gates are enabled.
	missionControl            *missioncontrol.Store
	missionControlRouter      *missioncontrol.Router
	missionControlTextPreview bool
	missionControlErr         error
	// missionControlVoiceBusy is installed by the server-owned voice
	// attachment controller. Reset/archive must not retire a runtime while it
	// still owns an immutable audio attachment.
	missionControlVoiceBusy func(threadID string) bool
	// appVoice owns the one browser-bound app voice lease. It must be fenced
	// from Hub.Remove before this connection can be replaced.
	appVoice *appVoiceService

	// attachFailures counts CONSECUTIVE attachClient failures across all
	// browsers, reset by the first success. Guarded by mu.
	//
	// It exists because attachClient fails in roughly zero milliseconds when
	// the daemon socket is missing: dial returns ENOENT immediately, Add
	// removes the client, the WebSocket closes, and the browser reconnects
	// about once a second forever. The user watches a "reconnecting" spinner
	// that is telling them a lie -- nothing is going to reconnect, because the
	// daemon is unreachable for a structural reason no amount of retrying
	// fixes. A hundred silent retries is worse than one honest error.
	attachFailures int
}

// attachFailureNoticeThreshold is how many consecutive attach failures are
// tolerated before the browser is told the truth instead of being left to
// spin.
//
// Small on purpose. A genuinely transient failure -- a daemon restarting under
// a self-update, say -- resolves within one or two attempts, so three is past
// the point where "it is still coming up" remains a credible explanation, but
// early enough that the user has waited about three seconds rather than
// minutes.
const attachFailureNoticeThreshold = 3

// Remotes returns the hub's remote host registry, or nil when there is none.
func (h *Hub) Remotes() *RemoteRegistry {
	if h == nil {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.remotes
}

// SetResolvedConfig stores the resolved configuration on the hub. The config is
// stored as any so the server package takes no dependency on config package's
// concrete type (only marshals to JSON when sending to clients).
func (h *Hub) SetResolvedConfig(cfg any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.resolvedConfig = cfg
}

// BroadcastConfig updates the hub's stored config and sends a {type:"config"}
// frame to every currently-connected client. Used after a PATCH /api/config
// write so all open browser tabs receive the updated configuration immediately.
func (h *Hub) BroadcastConfig(cfg any) {
	h.mu.Lock()
	h.resolvedConfig = cfg
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendConfig(cfg)
	}
}

// sendAIStatus writes the AI capability status as a text frame. Serve-local
// envelope ({"aiStatus":status}), NOT a sessiond message. Deliberately has no
// "type" field -- ws.ts routes flat sessiond messages by their top-level
// "type" string and this frame must never match that path (see sendConfig).
func (c *Client) sendAIStatus(status any) {
	data, err := json.Marshal(map[string]any{"aiStatus": status})
	if err != nil {
		log.Printf("sendAIStatus: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendAIStatus: write error: %v", err)
	}
}

// BroadcastAIStatus sends an {"aiStatus":...} frame to every connected client
// so a key saved in one browser tab flips the capability in all others.
//
// It carries the ai.Status struct only -- which contains no secret by
// construction -- and, unlike BroadcastConfig, caches nothing on the hub: the
// status is cheap to recompute and the browser fetches it on load via
// GET /api/ai/status.
func (h *Hub) BroadcastAIStatus(status any) {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendAIStatus(status)
	}
}

// sendVoiceEnded writes the end of a voice session as a text frame. Same
// serve-local envelope as sendAIStatus ({"voiceEnded":...}, no "type" field,
// for the reason given there).
func (c *Client) sendVoiceEnded(sessionID, reason string) {
	data, err := json.Marshal(map[string]any{
		"voiceEnded": map[string]string{"session_id": sessionID, "reason": reason},
	})
	if err != nil {
		log.Printf("sendVoiceEnded: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendVoiceEnded: write error: %v", err)
	}
}

// BroadcastVoiceEnded tells every connected browser that a voice session has
// been torn down server-side.
//
// It exists for the spoken exit. When the realtime model hangs up on the
// user's request, the session ends in THIS process -- but the microphone
// light, the peer connection and the idle state are all in the page, and a
// browser left holding a session that no longer exists is the same failure
// as one that would not end.
//
// Broadcast rather than addressed because a voice session is a property of
// the machine, not of a tab: only one runs at a time, and every tab showing
// it needs to stop showing it. It carries a session id and a reason -- no
// credential, no transcript.
func (h *Hub) BroadcastVoiceEnded(sessionID, reason string) {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendVoiceEnded(sessionID, reason)
	}
}

// sendOpenArtifact writes a request to show one local file as a text frame.
// Same serve-local envelope as sendAIStatus and sendVoiceEnded
// ({"openArtifact":...}, no "type" field, for the reason given there).
func (c *Client) sendOpenArtifact(path string) {
	data, err := json.Marshal(map[string]any{
		"openArtifact": map[string]string{"path": path},
	})
	if err != nil {
		log.Printf("sendOpenArtifact: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendOpenArtifact: write error: %v", err)
	}
}

// BroadcastOpenArtifact asks every connected browser to show one local file in
// the artifact viewer, and returns how many were told.
//
// WHY THE SERVER PUSHES A VIEW AT ALL. Everything else on this socket is the
// server reporting what happened. This is the one thing that is a RELAYED
// HUMAN REQUEST: somebody asked the chief of staff to show them a document,
// and the only way to answer that is to put the document on their screen. It
// reaches here from POST /api/artifact/open, which the `view_file` MCP tool
// calls -- see internal/server/artifact_api.go.
//
// Broadcast rather than addressed, for BroadcastVoiceEnded's reason: a person
// with three tabs open on one machine is one person, and the server has no way
// to know which tab their eyes are on. Sending to the one that happens to have
// asked most recently would be a guess that is wrong whenever they moved.
//
// It carries a path and nothing else -- no bytes, no credential. The browser
// then reads the file through /api/artifact under its own session, which is
// what keeps this frame from being a way to hand a file to a client that could
// not already have asked for it.
//
// The COUNT is returned because zero is the interesting case: an agent that
// believes it just showed somebody something, with no browser open, has to be
// told so.
func (h *Hub) BroadcastOpenArtifact(path string) int {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()

	for _, c := range clients {
		c.sendOpenArtifact(path)
	}
	return len(clients)
}

// NewHub creates a new Hub that dials a fresh daemon connection per browser via
// dial. dial may be nil and supplied later via SetDialer. tunnels is nil until
// set by the caller (server.New sets it via hub.tunnels = tunnels).
func NewHub(dial DialFunc) *Hub {
	return &Hub{
		clients: make(map[*Client]bool),
		dial:    dial,
		cos:     newCosRelay(),
	}
}

// SetDialer installs (or replaces) the per-browser daemon dialer.
func (h *Hub) SetDialer(d DialFunc) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.dial = d
}

// Dial creates a new daemon connection to host using the hub's configured
// dialer. The zero HostRef is the local daemon. Returns an error if no dialer
// is set (server not fully initialized).
func (h *Hub) Dial(ctx context.Context, host transport.HostRef) (DaemonConn, error) {
	h.mu.Lock()
	dial := h.dial
	h.mu.Unlock()
	if dial == nil {
		return nil, fmt.Errorf("server: no sessiond dialer configured")
	}
	return dial(ctx, host)
}

// attachClient dials a daemon for the browser, installs relay handlers that
// forward daemon events to the browser, starts the connection's read loop, and
// seeds the browser with config and the workspace list.
func (h *Hub) attachClient(c *Client) error {
	h.mu.RLock()
	dial := h.dial
	cfg := h.resolvedConfig
	remotes := h.remotes
	h.mu.RUnlock()

	if dial == nil {
		return fmt.Errorf("attachClient: no dialer configured")
	}

	// The local daemon is a hostSession like any other, with the ZERO HostRef
	// (id ""). That is the whole trick behind the zero-remote guarantee: one
	// code path, and nsID("", id) == id makes it emit today's bytes.
	dc, err := dial(c.ctx, transport.HostRef{})
	if err != nil {
		return fmt.Errorf("attachClient: dial: %w", err)
	}
	local := c.adoptSession(transport.HostRef{}, dc)
	local.installHandlers()

	go func() {
		if err := dc.Run(); err != nil {
			// net.ErrClosed means hub.Remove closed the daemon connection while
			// dc.Run was blocked in ReadFrame — this is the normal teardown path
			// (readPump exited → hub.Remove → local session Close → dc.Run
			// unblocks). Don't log noise on every normal browser disconnect.
			//
			// Any other error means the daemon dropped unexpectedly (crash, EOF,
			// etc.) while the browser WebSocket may still be open. Remove the
			// client so the WebSocket is closed and the browser reconnects.
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("attachClient: daemon run exited: %v", err)
			h.Remove(c)
		}
	}()

	if cfg != nil {
		c.sendConfig(cfg)
	}

	workspaces, err := dc.ListWorkspaces()
	if err != nil {
		log.Printf("attachClient: ListWorkspaces error: %v", err)
	} else {
		c.setWorkspaces("", workspaces)
		c.emitWorkspaceList(0)
	}

	// Every host the user has asked to reach gets its OWN session for THIS
	// browser -- design D5 forbids sharing one, because PTY sizing authority
	// is keyed on daemon-connection pointer identity.
	//
	// With no remotes configured this subscribes to an empty registry and
	// starts nothing, so the browser has now seen exactly today's bytes and
	// will never receive a host-state frame.
	if remotes != nil {
		unsub := remotes.Subscribe(c)
		c.sessMu.Lock()
		c.unsubscribeRemotes = unsub
		c.sessMu.Unlock()

		// startHostSession announces each host with a host-state frame before
		// its first dial, so this loop is also design D's "one frame per
		// registry member immediately after attachClient": a fresh tab renders
		// its host groups without waiting for any dial to resolve.
		for _, host := range remotes.Hosts() {
			c.startHostSession(host)
		}
	}

	return nil
}

// Add registers a client in the hub and attaches its daemon connection. If
// attachment fails the client is immediately removed so the WebSocket is
// closed and the browser can reconnect rather than hanging in a broken state.
//
// After attachFailureNoticeThreshold CONSECUTIVE failures it stops letting the
// browser reconnect in silence and sends it a diagnosis first. That bound is
// the whole point: without it, a structurally-unreachable daemon presents as an
// endless spinner and nothing anywhere -- not the UI, not the log, not the
// browser console -- ever says what is actually wrong.
func (h *Hub) Add(c *Client) {
	h.mu.Lock()
	h.clients[c] = true
	h.mu.Unlock()

	err := h.attachClient(c)

	h.mu.Lock()
	if err == nil {
		h.attachFailures = 0
	} else {
		h.attachFailures++
	}
	failures := h.attachFailures
	h.mu.Unlock()

	if err == nil {
		return
	}

	// Log only at the threshold and every threshold-multiple after it. The
	// per-attempt log this replaces produced hundreds of identical lines a
	// minute, which buried the one line that mattered.
	if failures%attachFailureNoticeThreshold == 0 {
		log.Printf("Add: attachClient failed %d consecutive times: %v", failures, err)
	}

	if failures >= attachFailureNoticeThreshold {
		c.sendDaemonUnreachable(failures, err)
	}
	h.Remove(c)
}

// sendDaemonUnreachable tells the browser the daemon cannot be reached, and
// why, so the reconnect overlay can stop claiming a reconnection is in
// progress.
//
// It is sent immediately before the WebSocket is closed. The frame is written
// to the socket before the close, and browsers deliver queued messages ahead of
// the close event, so the surface has the diagnosis in hand by the time it
// learns the connection went away.
func (c *Client) sendDaemonUnreachable(attempts int, cause error) {
	detail := daemonUnreachableDetail(cause)
	data, err := json.Marshal(map[string]any{
		"type":     sessiond.TypeError,
		"code":     sessiond.CodeDaemonUnreachable,
		"error":    fmt.Sprintf("Cannot reach the muxterm session daemon (%d attempts).", attempts),
		"detail":   detail,
		"attempts": attempts,
	})
	if err != nil {
		log.Printf("sendDaemonUnreachable: marshal error: %v", err)
		return
	}
	if err := c.writeText(data); err != nil {
		log.Printf("sendDaemonUnreachable: write error: %v", err)
	}
}

// daemonUnreachableDetail turns a dial failure into something a human can act
// on. The stranded case gets its specific diagnosis and recovery command,
// because that is the failure whose symptom -- a socket path that simply does
// not exist while the daemon is demonstrably still running -- otherwise
// requires reading /proc/net/unix by hand to understand.
func daemonUnreachableDetail(cause error) string {
	sock, sockErr := sessiond.SocketPath()
	if sockErr == nil {
		if stranded, ok := sessiond.FindStrandedListener(sock); ok {
			return stranded.RecoveryHint()
		}
		return fmt.Sprintf("No daemon is listening on %s.\n\nStart one with: muxterm serve\nDiagnose with:  muxterm doctor\n\nUnderlying error: %v", sock, cause)
	}
	return fmt.Sprintf("Underlying error: %v", cause)
}

// Remove deletes a client from the hub, cancels every host session it holds
// (closing each daemon connection), and closes the client.
func (h *Hub) Remove(c *Client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; !ok {
		h.mu.Unlock()
		return
	}
	delete(h.clients, c)
	appVoice := h.appVoice
	h.mu.Unlock()
	// Do not call into the app service under Hub.mu: app operations also read
	// the catalog and client inventories.
	if appVoice != nil {
		appVoice.disconnect(c)
	}
	c.stopCos()
	c.stopMissionControl()
	c.teardownSessions()
	c.close()
}

// CloseCos shuts the chief-of-staff sidecar down if one was ever started, so
// muxterm does not orphan a python process on exit. Safe to call when no
// sidecar was launched.
func (h *Hub) CloseCos() { h.cos.close() }

// CloseMissionControl releases the catalog's process lock on every server exit.
// A request that had already obtained the store observes its closed state rather
// than writing concurrently with a later server instance.
func (h *Hub) CloseMissionControl() {
	h.mu.Lock()
	catalog := h.missionControl
	router := h.missionControlRouter
	h.missionControl = nil
	h.missionControlRouter = nil
	h.missionControlTextPreview = false
	h.missionControlErr = errors.New("mission control catalog is closed")
	h.mu.Unlock()
	if router != nil {
		router.Close()
	}
	if catalog == nil {
		return
	}
	if err := catalog.Close(); err != nil {
		log.Printf("missioncontrol: close catalog: %v", err)
	}
}

// ClientCount returns the number of connected clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// handleWSImpl handles the WebSocket upgrade and client lifecycle.
func (s *Server) handleWSImpl(w http.ResponseWriter, r *http.Request) {
	// Auth is now handled uniformly by AuthMiddleware at the mux level
	// (GET /ws is wrapped in server.go's New()) — no inline check needed
	// here anymore.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}

	conn.SetReadLimit(1 << 20) // 1MB

	client := newClient(s.hub, conn)
	// Preserve legacy WebSocket acceptance. This flag gates only the new app
	// voice frame family and is computed before accepting untrusted frames.
	client.appVoiceAllowed = s.appVoiceSameOrigin(r)
	s.hub.Add(client)
	go client.readPump()
	// Started beside readPump, not inside it: Ping waits for a pong that only
	// readPump's Read can deliver, so the two must run concurrently.
	go client.heartbeat()
}

// NewServerMsg marshals a single-key JSON object: {msgType: payload}.
func NewServerMsg(msgType string, payload interface{}) ([]byte, error) {
	m := map[string]interface{}{msgType: payload}
	return json.Marshal(m)
}

// EncodeBinaryFrame creates a binary frame: [4-byte LE uint32 pane_id][data].
func EncodeBinaryFrame(paneID uint32, data []byte) []byte {
	frame := make([]byte, 4+len(data))
	binary.LittleEndian.PutUint32(frame[:4], paneID)
	copy(frame[4:], data)
	return frame
}

// DecodeBinaryFrame extracts pane ID and data from a binary frame.
// Returns an error if the frame is shorter than 4 bytes.
func DecodeBinaryFrame(frame []byte) (uint32, []byte, error) {
	if len(frame) < 4 {
		return 0, nil, fmt.Errorf("binary frame too short: %d bytes, need at least 4", len(frame))
	}
	paneID := binary.LittleEndian.Uint32(frame[:4])
	return paneID, frame[4:], nil
}
