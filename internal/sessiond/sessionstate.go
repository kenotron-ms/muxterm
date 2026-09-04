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
// This contract is HARNESS-AGNOSTIC. It began life shaped around Amplifier,
// but nothing below names a specific coding-agent CLI: any producer that can
// write a JSON file can appear in the home view. The on-disk producer contract
// is documented in docs/session-state-protocol.md, and the shipped producers
// are the Amplifier hook (modules/hooks-muxterm-session), the `muxterm session
// report` verb, and the opt-in Claude Code adapter.
//
// Vocabulary note: the six nouns in play are workspace, pane, terminal,
// session, project, and artifact. A "task" is not an object -- it is the
// session's first prompt. Do not introduce new nouns.

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

// Session run modes. This distinction is load-bearing for the whole feature,
// and it answers exactly one question:
//
//		Does going quiet mean "broke" or "resting"?
//
//	  - ModeInteractive: the session ends its turn and waits for a human. That is
//	    its CONTRACT, not a fault. A quiet interactive session must NEVER be
//	    surfaced as an alarm.
//	  - ModeAutonomous: the session runs a loop toward a stop condition of its
//	    own. A quiet autonomous session means the loop BROKE, and that IS the
//	    alarm worth showing.
//
// These names are deliberately harness-neutral. They were once spelled
// goal|plain, after Amplifier's /goal command, which only names the
// distinction correctly if you already know what /goal is. Claude Code has
// background and foreground sessions; a job CLI has batch runs and attended
// runs. The distinction is universal; the Amplifier spelling was not.
//
// Getting this wrong makes every idle session look like an emergency, users
// learn to ignore the indicator, and the home view becomes worthless.
const (
	ModeInteractive = "interactive"
	ModeAutonomous  = "autonomous"
)

// Harness identifiers: which coding-agent CLI is running this session.
//
// These are the SAME strings as the agent catalog's names (agent_catalog.go),
// which is deliberate -- muxterm has one vocabulary for "which agent CLI is
// this", not two that can drift apart. agent_catalog.go is defined in terms of
// these constants so the compiler enforces it.
//
// The field is OPEN, not an enum: any producer may declare any harness string
// (see docs/session-state-protocol.md). A value not listed here is rendered
// with a neutral badge, never dropped -- refusing to display a session because
// muxterm has not heard of its runner would make the fleet view a liar about
// the fleet.
const (
	HarnessAmplifier = "amplifier"
	HarnessClaude    = "claude"
	HarnessCodex     = "codex"
	HarnessOpenCode  = "opencode"
)

// ValidState reports whether s is one of the five lifecycle states.
func ValidState(s string) bool {
	switch s {
	case SessionStateWorking, SessionStateBlocked, SessionStateDone,
		SessionStateFailed, SessionStateStopped:
		return true
	}
	return false
}

// ValidMode reports whether m is one of the two run modes.
func ValidMode(m string) bool {
	return m == ModeInteractive || m == ModeAutonomous
}

// ValidWaitingFor reports whether w is one of the blocked reasons. The empty
// string is valid: it means "not blocked", which is most sessions most of the
// time.
func ValidWaitingFor(w string) bool {
	switch w {
	case "", WaitingForPermission, WaitingForInput, WaitingForSandbox,
		WaitingForWorker, WaitingForDialog:
		return true
	}
	return false
}

// SessionState is one row of the home view: everything known about a single
// agent session running in a muxterm pane.
//
// Every field is DECLARED by the session's own producer -- nothing here is
// inferred from PTY state, because the daemon's existing activity classifier
// cannot distinguish "thinking" from "waiting for you", which is precisely why
// this declared channel exists.
type SessionState struct {
	// Identity. SessionID is the producer's own session id; PaneID and
	// WorkspaceID locate its terminal in muxterm.
	SessionID   string `json:"sessionId"`
	PaneID      int    `json:"paneId"`
	WorkspaceID string `json:"workspaceId"`

	// Harness names the coding-agent CLI running this session -- one of the
	// Harness* constants, or any other string a producer chooses to declare.
	// Empty means the producer declared nothing, which is allowed: the row
	// still renders, just without a badge.
	//
	// This is what turns the home view from an Amplifier feature into a fleet
	// view: an Amplifier lane and a Claude Code session sit in the same list,
	// each labelled with what is actually running it.
	Harness string `json:"harness,omitempty"`

	// Project is the session's working directory. Absolute path; the browser
	// shortens it for display.
	Project string `json:"project,omitempty"`

	// Name is a short human-readable title, conventionally derived from the
	// session's first prompt. This is the closest thing to a task title that
	// exists, and it costs nothing because a human typed it.
	Name string `json:"name"`

	// Mode is ModeInteractive or ModeAutonomous. See the mode constants above.
	Mode string `json:"mode"`

	// State is one of the SessionState* constants.
	State string `json:"state"`

	// WaitingFor is one of the WaitingFor* constants. Empty unless blocked.
	WaitingFor string `json:"waitingFor,omitempty"`

	// Doing is a short human-readable line describing current activity, e.g.
	// "editing cmd/muxterm/pane_cmd.go". Refreshed cheaply from recent events.
	Doing string `json:"doing,omitempty"`

	// DoneMeans is the session's own declared definition of finished -- the
	// stop condition an autonomous loop is running toward. Normally present
	// only when Mode == ModeAutonomous.
	DoneMeans string `json:"doneMeans,omitempty"`

	// Knows lists distinct artifact paths this session has read. A session
	// that has read very little and then failed was starved, not merely
	// unlucky, and that distinction is invisible without this.
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
// An interactive session that has simply ended its turn does NOT need input in
// the sense this view means -- it is resting, which is its normal condition.
// Only a blocked session genuinely wants a human.
func (s SessionState) NeedsInput() bool {
	return s.State == SessionStateBlocked
}
