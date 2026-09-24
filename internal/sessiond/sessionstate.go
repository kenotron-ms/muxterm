package sessiond

import "encoding/json"

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

// TodoItem is one task exactly as its producer declared it.
type TodoItem struct {
	Text   string `json:"text"`
	Status string `json:"status"`
}

// TodoProgress is a session's progress through its own declared task list. It
// carries both summary numbers and the complete declared list.
// Items are optional for compatibility with snapshots written before the full
// list joined the protocol.
type TodoProgress struct {
	// Done is how many items are completed; Total is how many exist. Rendered
	// as "3/10". Total is never 0 in a published record -- a producer that
	// would emit 0/0 omits the whole object instead.
	Done  int `json:"done"`
	Total int `json:"total"`

	// Current is the in-progress item's text, in the producer's present-tense
	// form ("Cutting the release"). Empty when nothing is in progress, which
	// is a real state: a list that is all-pending or all-complete has an
	// honest fraction and no current item.
	Current string     `json:"current,omitempty"`
	Items   []TodoItem `json:"items,omitempty"`
}

// SessionState is one row of the home view: everything known about a single
// agent session. A terminal is an optional attachment.
//
// Every field is DECLARED by the session's own producer -- nothing here is
// inferred from PTY state, because the daemon's existing activity classifier
// cannot distinguish "thinking" from "waiting for you", which is precisely why
// this declared channel exists.
type SessionState struct {
	// Identity. SessionID is the producer's own session id. Zero PaneID and an
	// empty WorkspaceID mean the session has no muxterm terminal attachment;
	// MarshalJSON emits those sentinels as null on the wire.
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
	// ExecutionID and TurnID carry native causal identity into lifecycle
	// notices. They are observations from hook reports, never inferred from
	// terminal activity or prose.
	ExecutionID string `json:"executionId,omitempty"`
	TurnID      string `json:"turnId,omitempty"`

	// Project is the session's working directory. Absolute path; the browser
	// shortens it for display.
	Project string `json:"project,omitempty"`

	// Name is a short human-readable title, conventionally derived from the
	// session's first prompt. This is the closest thing to a task title that
	// exists, and it costs nothing because a human typed it.
	Name string `json:"name"`

	// Label is a 1-3 word name for the work, short enough to fit a pane tab
	// whole -- "auth redirect", not the whole first line Name carries. The
	// producer derives it once, from its first prompt, and then never changes
	// it: a tab whose name moves is a tab you cannot find twice.
	//
	// Optional, and its absence is meaningful. Empty means this producer
	// offered nothing better than the label the daemon already derived from
	// the pane's launch argv at spawn (autolabel.go), so consumers keep what
	// they have rather than clearing it.
	Label string `json:"label,omitempty"`

	// Mode is ModeInteractive or ModeAutonomous. See the mode constants above.
	Mode string `json:"mode"`

	// State is one of the SessionState* constants.
	State string `json:"state"`

	// WaitingFor is one of the WaitingFor* constants. Empty unless blocked.
	WaitingFor string `json:"waitingFor,omitempty"`

	// Doing is a short human-readable line describing current activity, e.g.
	// "editing cmd/muxterm/pane_cmd.go". Refreshed cheaply from recent events.
	Doing string `json:"doing,omitempty"`

	// Summary is the lane's own raw final assistant message exactly as supplied
	// by its turn-end hook. It is separate from Doing so a detailed result can survive
	// without turning the fleet's one-line activity label into a transcript.
	Summary string `json:"summary,omitempty"`

	// DoneMeans is the session's own declared definition of finished -- the
	// stop condition an autonomous loop is running toward. Normally present
	// only when Mode == ModeAutonomous.
	DoneMeans string `json:"doneMeans,omitempty"`

	// GoalID and Origin are the two fields on this row that a producer does
	// NOT declare. They are stamped by the daemon during the pane join
	// (sessionstore.go stampPane) out of muxterm's own launch record, and
	// anything a producer writes into them is discarded -- a session cannot be
	// authoritative about the command line it was started with.
	//
	// GoalID identifies the stop condition this lane was LAUNCHED with, as a
	// digest of the condition text (lane_provenance.go GoalID). It answers two
	// questions DoneMeans cannot. First, correlation: two lanes running the
	// same condition in two workspaces share an id, so a batch is recognisable
	// as a batch. Second, survival: DoneMeans is declared by the session and
	// goes away the moment a human takes over a finished goal lane and it
	// stops calling itself autonomous -- GoalID is read from the pane's argv
	// and does not, so "which goal was this lane for?" stays answerable after
	// the conversation has moved on.
	//
	// It names the CONDITION, not the run: two runs of one condition share an
	// id. Empty for any lane not launched as a goal lane.
	GoalID string `json:"goalId,omitempty"`

	// Origin is which door this lane came through: browser, agent, cli, or
	// trigger:<trigger id> (the LaneOrigin* constants). Before this existed, a
	// lane a human spawned and a lane an automation fired at 3am were the same
	// row, and "which of these did I ask for?" could not be answered from the
	// fleet at all.
	//
	// Empty is a real value: a pane restored after a daemon restart came
	// through no door in this process's lifetime, and guessing would put a
	// wrong answer on the one question the field exists for.
	Origin string `json:"origin,omitempty"`

	// Todo is structured progress through the session's own task list, when it
	// keeps one. Nil means it does not, which is NOT the same as "no progress":
	// consumers must fall back to Doing rather than render an empty 0/0, or a
	// session that simply does not track todos reads as a stalled one.
	//
	// This is the only field on the row that is not a guess. Doing is
	// re-templated on every tool call and describes the last thing touched;
	// Todo changes only when the session itself revises its plan, which makes
	// it both cheaper to carry and far more stable to look at.
	Todo *TodoProgress `json:"todo,omitempty"`

	// Knows lists distinct artifact paths this session has read. A session
	// that has read very little and then failed was starved, not merely
	// unlucky, and that distinction is invisible without this.
	Knows []string `json:"knows,omitempty"`

	// PR is a pull request number associated with this session, if any.
	//
	// It is a PROPERTY of the row, not a group. "Ready for review" used to be
	// a group of its own promoted by this field; it was removed because having
	// a PR says nothing about whether the session wants you, which is the only
	// question the groups answer.
	PR int `json:"pr,omitempty"`

	// UpdatedAt is a Unix timestamp (seconds) of the last state change.
	UpdatedAt int64 `json:"updatedAt"`

	// Reporting is launch/report delivery health, not harness run state.
	Reporting         string `json:"reporting,omitempty"`
	ReportingCoverage string `json:"reportingCoverage,omitempty"`
	ReportingError    string `json:"reportingError,omitempty"`
	LastReportAt      int64  `json:"lastReportAt,omitempty"`
}

// MarshalJSON keeps the established internal scalar representation while
// making terminal attachment explicitly optional on the versioned wire. This
// is a compatibility bridge for producers and daemon code that still use zero
// values internally; consumers never receive a synthetic pane 0 or workspace.
func (s SessionState) MarshalJSON() ([]byte, error) {
	type wireSessionState SessionState
	var paneID *int
	var workspaceID *string
	if s.PaneID != 0 {
		paneID = &s.PaneID
	}
	if s.WorkspaceID != "" {
		workspaceID = &s.WorkspaceID
	}
	return json.Marshal(struct {
		wireSessionState
		PaneID      *int    `json:"paneId"`
		WorkspaceID *string `json:"workspaceId"`
	}{wireSessionState: wireSessionState(s), PaneID: paneID, WorkspaceID: workspaceID})
}

// NeedsInput reports whether this session belongs in the home view's
// "Needs input" group.
//
// Two ways in, and the second is the entire reason Mode exists on the wire:
//
//  1. Blocked -- sitting at a permission prompt, or having asked something.
//  2. An AUTONOMOUS session that is Stopped. Going quiet means "resting" for
//     an interactive session and "the loop broke" for an autonomous one. An
//     interactive session ending its turn rests at Stopped and must NEVER
//     surface here; an autonomous one reaching Stopped did not reach its own
//     stop condition and is waiting for somebody to decide what happens next.
//
// Failed is deliberately absent: it is a VERDICT, and a verdict can be read at
// leisure in "Completed". Stopped is the ABSENCE of one, which is what wants a
// human.
//
// This is the Go mirror of needsInput() in web/src/lib/session-state.ts, which
// is where the rule is actually CONSUMED -- grouping happens in the browser.
// Nothing in this package calls this today; it exists so the pinned contract
// states the rule in both languages. If you change one, change the other.
func (s SessionState) NeedsInput() bool {
	if s.State == SessionStateBlocked {
		return true
	}
	return s.Mode == ModeAutonomous && s.State == SessionStateStopped
}
