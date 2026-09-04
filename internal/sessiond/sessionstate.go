package sessiond

// Session state contract for the muxterm "home" view.
//
// This file is TYPES ONLY -- the wire contract shared by the daemon (which
// produces session state) and the browser (which renders it). It is committed
// to the base commit ahead of implementation so the backend and frontend can be
// built independently without either guessing the other's shape.
//
// The mirror of this file is web/src/lib/session-state.ts. If you change a
// field here, change it there in the same commit.
//
// Vocabulary note: the six nouns in play are workspace, pane, terminal,
// session, project, and artifact. A "task" is not an object -- it is the
// session's first prompt:submit event. Do not introduce new nouns.

// Session lifecycle states. These are adopted verbatim from Claude Code's
// agent view so the vocabulary matches what users already know.
const (
	SessionStateWorking = "working"
	SessionStateBlocked = "blocked"
	SessionStateDone    = "done"
	SessionStateFailed  = "failed"
	SessionStateStopped = "stopped"
)

// Reasons a session is blocked. Only meaningful when State == blocked.
// Also adopted from Claude Code's waitingFor enum.
const (
	WaitingForPermission = "permission prompt"
	WaitingForInput      = "input needed"
	WaitingForSandbox    = "sandbox request"
	WaitingForWorker     = "worker request"
	WaitingForDialog     = "dialog open"
)

// Session run modes. This distinction is load-bearing for the whole feature:
//
//   - ModePlain: the session ends its turn and waits for the user. That is its
//     CONTRACT, not a fault. A quiet plain session must NEVER be surfaced as
//     needing input.
//   - ModeGoal: the session runs an autonomous /goal loop toward a stop
//     condition. A quiet goal session means the loop BROKE, and that IS the
//     alarm worth showing.
//
// Mode is known at kickoff. Getting this wrong makes every idle session look
// like an emergency, users learn to ignore the indicator, and the home view
// becomes worthless.
const (
	ModePlain = "plain"
	ModeGoal  = "goal"
)

// SessionState is one row of the home view: everything known about a single
// Amplifier session running in a muxterm pane.
//
// Every field is a projection of that session's own events.jsonl, produced by
// the Amplifier hook in modules/hooks-muxterm-session and forwarded to the
// daemon. Nothing here is inferred from PTY state -- the daemon's existing
// activity classifier cannot distinguish "thinking" from "waiting for you",
// which is precisely why this declared channel exists.
type SessionState struct {
	// Identity. SessionID is the Amplifier session id; PaneID and WorkspaceID
	// locate its terminal in muxterm.
	SessionID   string `json:"sessionId"`
	PaneID      int    `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`

	// Project is the session's working directory -- an Amplifier "project" is
	// a folder. Absolute path; the browser shortens it for display.
	Project string `json:"project,omitempty"`

	// Name is derived from the session's FIRST prompt:submit event
	// (data.prompt), trimmed for display. This is the closest thing to a task
	// title that exists, and it costs nothing because the user typed it.
	Name string `json:"name"`

	// Mode is ModePlain or ModeGoal. See the mode constants above.
	Mode string `json:"mode"`

	// State is one of the SessionState* constants.
	State string `json:"state"`

	// WaitingFor is one of the WaitingFor* constants. Empty unless blocked.
	WaitingFor string `json:"waitingFor,omitempty"`

	// Doing is a short human-readable line describing current activity, e.g.
	// "editing cmd/muxterm/pane_cmd.go". Refreshed cheaply from recent events.
	Doing string `json:"doing,omitempty"`

	// DoneMeans is the /goal stop condition -- the session's own declared
	// definition of finished. Only present when Mode == ModeGoal.
	DoneMeans string `json:"doneMeans,omitempty"`

	// Knows lists distinct artifact:read paths this session has consumed.
	// A session that has read very little and then failed was starved, not
	// merely unlucky, and that distinction is invisible without this.
	Knows []string `json:"knows,omitempty"`

	// PR is a pull request number associated with this session, if any.
	// A non-zero PR promotes the session into the "Ready for review" group.
	PR int `json:"pr,omitempty"`

	// UpdatedAt is a Unix timestamp (seconds) of the last state change.
	UpdatedAt int64 `json:"updatedAt"`
}

// NeedsInput reports whether this session belongs in the home view's
// "Needs input" group.
//
// A plain session that has simply ended its turn does NOT need input in the
// sense this view means -- it is resting, which is its normal condition. Only a
// blocked session genuinely wants a human.
func (s SessionState) NeedsInput() bool {
	return s.State == SessionStateBlocked
}
