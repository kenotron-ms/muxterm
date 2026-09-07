package mcp

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// Fleet access: the structured session-state feed the browser's home view
// already renders, made available to agents and to the shell.
//
// WHY THESE ARE GLOBAL AND create_pane / send_input ARE NOT. An MCP connection
// is attached to exactly one workspace at a time, and pane input and pane
// creation are both resolved against that attachment server-side
// (sessiond/server.go: `c.srv.reg.Pane(c.attached, paneID)`). Session state is
// not: the daemon fans TypeSessionState out to every opted-in connection
// carrying the CURRENT FULL SET across EVERY workspace (protocol.go:124,
// server.go publishSessionState). That single property is what makes a fleet
// view possible from a connection parked in one workspace, and it is the crux
// of this whole file -- without it, "what needs me?" would have to walk and
// attach to every workspace in turn, discarding buffered output at each step.
//
// The rows themselves are DECLARED by each session's own producer, never
// inferred from PTY state, which is why doneMeans and knows can exist at all:
// no amount of screen-scraping recovers a stop condition or a read-file list.

// fleetFirstSnapshotWait bounds how long a first call blocks for the daemon's
// first push.
//
// Subscribing re-arms the daemon's change gate (sessionstore.go rearmLocked),
// so the very next tick republishes the current set unconditionally -- even
// when that set is empty. The tick is 1s, so this is roughly two ticks of
// slack. It is a CEILING, not a sleep: the common case returns as soon as the
// frame lands.
const fleetFirstSnapshotWait = 2500 * time.Millisecond

// errSessionStateUnsupported is returned when the daemon answers the subscribe
// request but declines the feature. Named separately from the timeout case
// because they mean different things: this one is a daemon that heard the
// request and said no.
func errSessionStateUnsupported() error {
	return fmt.Errorf("this sessiond does not support session-state " +
		"(it answered session-state-subscribe with ok=false), so there is no fleet to report; " +
		"restart the daemon on a build that has it")
}

// wrapSubscribeErr explains a failed subscribe in terms of the two things that
// actually go wrong, rather than leaking a bare timeout.
func wrapSubscribeErr(err error) error {
	return fmt.Errorf("subscribing to session state: %w "+
		"(a sessiond too old to know session-state-subscribe never replies, which surfaces as this timeout)", err)
}

// Fleet returns the latest session-state snapshot, subscribing lazily on the
// first call.
//
// On that first call the cache is empty until the daemon's next push, so this
// waits up to fleetFirstSnapshotWait for one and then returns whatever it has.
// An EMPTY FLEET IS A LEGITIMATE ANSWER -- a machine with no agent sessions
// running is a normal state of the world, not an error -- so the timeout
// returns an empty slice rather than failing. The alternative, erroring on
// "no rows yet", would teach a caller to retry through a condition that is
// simply true.
func (c *Client) Fleet() ([]sessiond.SessionState, error) {
	c.mu.Lock()
	subscribed := c.fleetSubscribed
	c.mu.Unlock()

	if !subscribed {
		supported, err := c.conn.SessionStateSubscribeAck(true)
		if err != nil {
			return nil, wrapSubscribeErr(err)
		}
		if !supported {
			return nil, errSessionStateUnsupported()
		}
		c.mu.Lock()
		c.fleetSubscribed = true
		c.mu.Unlock()
	}

	select {
	case <-c.fleetReady:
	case <-time.After(fleetFirstSnapshotWait):
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]sessiond.SessionState(nil), c.fleet...), nil
}

// FleetOnce is the one-shot equivalent of Client.Fleet for a raw sessiond
// connection: subscribe, wait for one push, return it. It exists for the CLI,
// which dials a bare sessiond.Client per invocation and has no long-lived cache
// to keep warm.
//
// The connection's read loop is already running by the time a CLI caller gets
// here (dialDaemon starts it), which is fine: dispatchEvent re-reads the
// handler table under its own mutex on every event, so installing a handler
// after Run is race-free.
func FleetOnce(conn *sessiond.Client) ([]sessiond.SessionState, error) {
	got := make(chan []sessiond.SessionState, 1)
	conn.SetHandlers(sessiond.Handlers{
		OnSessionState: func(msg *sessiond.Message) {
			select {
			case got <- msg.Sessions:
			default: // first frame is the whole truth; later ones are redundant here
			}
		},
	})

	supported, err := conn.SessionStateSubscribeAck(true)
	if err != nil {
		return nil, wrapSubscribeErr(err)
	}
	if !supported {
		return nil, errSessionStateUnsupported()
	}

	select {
	case rows := <-got:
		return rows, nil
	case <-time.After(fleetFirstSnapshotWait):
		// Same reasoning as Client.Fleet: an empty fleet is an answer.
		return nil, nil
	}
}

// fleetStates lists the five lifecycle states, in the schema order used by the
// tool description and the CLI help.
var fleetStates = []string{
	sessiond.SessionStateWorking,
	sessiond.SessionStateBlocked,
	sessiond.SessionStateDone,
	sessiond.SessionStateFailed,
	sessiond.SessionStateStopped,
}

// FilterFleet narrows rows by state and workspace id. An empty filter matches
// everything. The state match is exact -- see CheckStateFilter, which rejects a
// value that could never match before any work is done.
func FilterFleet(rows []sessiond.SessionState, state, workspaceID string) []sessiond.SessionState {
	out := make([]sessiond.SessionState, 0, len(rows))
	for _, r := range rows {
		if state != "" && r.State != state {
			continue
		}
		if workspaceID != "" && r.WorkspaceID != workspaceID {
			continue
		}
		out = append(out, r)
	}
	return out
}

// CheckStateFilter rejects a state filter that is not one of the five
// lifecycle states.
//
// Silently returning zero rows for a typo would be indistinguishable from a
// quiet fleet, and "no sessions are blocked" is precisely the answer a caller
// most wants to trust.
func CheckStateFilter(state string) error {
	if state == "" || sessiond.ValidState(state) {
		return nil
	}
	return fmt.Errorf("unknown state %q (valid: %s)", state, strings.Join(fleetStates, ", "))
}

// ResolveWorkspaceName returns the id of the workspace called name.
//
// It is the lookup half of ResolveOrCreateWorkspace and DELIBERATELY has no
// create half. A filter is a question about what exists; answering "no
// workspace by that name" by conjuring an empty one would turn a typo in a
// read-only query into a mutation of the dock.
func ResolveWorkspaceName(c *sessiond.Client, name string) (string, error) {
	if name == "" {
		return "", fmt.Errorf("workspace name is required")
	}
	workspaces, err := c.ListWorkspaces()
	if err != nil {
		return "", fmt.Errorf("listing workspaces: %w", err)
	}
	known := make([]string, 0, len(workspaces))
	for _, ws := range workspaces {
		if ws.Name == name {
			return ws.WorkspaceID, nil
		}
		known = append(known, ws.Name)
	}
	sort.Strings(known)
	return "", fmt.Errorf("no workspace is named %q (known: %s); "+
		"this filter never creates a workspace", name, strings.Join(known, ", "))
}

// FindSession returns the row for sessionID, and whether it was present.
func FindSession(rows []sessiond.SessionState, sessionID string) (sessiond.SessionState, bool) {
	for _, r := range rows {
		if r.SessionID == sessionID {
			return r, true
		}
	}
	return sessiond.SessionState{}, false
}

// unknownSessionErr names what a caller can do about a session id that is not
// in the snapshot, and lists what is, since the list is short.
func unknownSessionErr(sessionID string, rows []sessiond.SessionState) error {
	known := make([]string, 0, len(rows))
	for _, r := range rows {
		known = append(known, r.SessionID)
	}
	if len(known) == 0 {
		return fmt.Errorf("no session %q in the current fleet snapshot, which is empty", sessionID)
	}
	sort.Strings(known)
	return fmt.Errorf("no session %q in the current fleet snapshot (present: %s)",
		sessionID, strings.Join(known, ", "))
}

// fleetRowJSON projects one row into the MCP result shape.
//
// snake_case, because that is what every other MCP tool in this server emits;
// the CLI's --json keeps the row's own camelCase tags. The two conventions are
// deliberate and are not unified: an agent reading pane_id from create_pane and
// pane_id from fleet_status is reading one vocabulary, and so is a script
// piping paneId from spawn-lane and paneId from fleet into jq.
//
// EVERY FIELD IS EMITTED, including the empty ones. done_means and knows are
// the two facts that cannot be recovered from a terminal screen at any cost --
// a stop condition and a read-file list are declared, never displayed -- so
// dropping them to save bytes would remove the entire reason this tool exists.
// Emitting an empty done_means rather than omitting the key is also load-
// bearing: a /goal lane carries one and an interactive lane does not, and that
// asymmetry is only legible if the absence is shown rather than hidden.
func fleetRowJSON(r sessiond.SessionState) map[string]any {
	knows := r.Knows
	if knows == nil {
		knows = []string{}
	}
	return map[string]any{
		"session_id":   r.SessionID,
		"pane_id":      r.PaneID,
		"workspace_id": r.WorkspaceID,
		"harness":      r.Harness,
		"project":      r.Project,
		"name":         r.Name,
		"label":        r.Label,
		"mode":         r.Mode,
		"state":        r.State,
		"waiting_for":  r.WaitingFor,
		"doing":        r.Doing,
		"done_means":   r.DoneMeans,
		"knows":        knows,
		"pr":           r.PR,
		"updated_at":   r.UpdatedAt,
	}
}
