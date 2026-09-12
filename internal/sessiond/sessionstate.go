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

// Lifecycle values identify the producer transition that produced a
// declaration. Unlike State, this is optional provenance: State remains the
// durable five-value wire enum.
const (
	LifecycleInitialized  = "initialized"
	LifecycleRunning      = "running"
	LifecycleResumed      = "resumed"
	LifecycleTurnComplete = "turn-complete"
	LifecycleCompleted    = "completed"
	LifecycleFailed       = "failed"
	LifecycleCancelled    = "cancelled"
	LifecycleUnknown      = "unknown"
	LifecycleLost         = "lost"
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

// ValidLifecycle reports whether l is an optional producer lifecycle
// provenance value. LifecycleLost is collector-generated when a proven pane
// generation outlives a non-terminal producer report.
func ValidLifecycle(l string) bool {
	switch l {
	case "", LifecycleInitialized, LifecycleRunning, LifecycleResumed,
		LifecycleTurnComplete, LifecycleCompleted, LifecycleFailed,
		LifecycleCancelled, LifecycleUnknown, LifecycleLost:
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

// TodoProgress is a session's progress through its own declared task list.
//
// Counts, not the list. The card needs a fraction and one line of text, and
// carrying fifty items to render "3/10" would put the whole plan of every lane
// on the wire on every change for nothing. A consumer wanting the items reads
// the session's own transcript.
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
	Current string `json:"current,omitempty"`
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

	// Lifecycle is optional producer provenance for this declaration. It does
	// not replace State's pinned five-value contract. LifecycleLost is only
	// synthesized by the collector for a proven orphaned generation.
	Lifecycle string `json:"lifecycle,omitempty"`

	// WaitingFor is one of the WaitingFor* constants. Empty unless blocked.
	WaitingFor string `json:"waitingFor,omitempty"`

	// Doing is a short human-readable line describing current activity, e.g.
	// "editing cmd/muxterm/pane_cmd.go". Refreshed cheaply from recent events.
	Doing string `json:"doing,omitempty"`

	// DoneMeans is the session's own declared definition of finished -- the
	// stop condition an autonomous loop is running toward. Normally present
	// only when Mode == ModeAutonomous.
	DoneMeans string `json:"doneMeans,omitempty"`

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
