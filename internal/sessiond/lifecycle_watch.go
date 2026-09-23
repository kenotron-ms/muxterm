package sessiond

// The live lifecycle transition watcher.
//
// Everything else in the daemon that looks at session state is LEVEL
// triggered: sessionstore.collect reads whole-state declarations and
// publishSessionState fans out the current set, gated by one aggregate hash.
// That is enough to paint a home view and nothing else -- an aggregate hash
// can say "something differs", never "this session just went from working to
// done".
//
// A completion notice needs the EDGE. This file is the only place in the
// daemon that remembers what a session said last tick in order to notice what
// changed, and it exists because the two states worth telling a human about
// are both invisible to the exit path:
//
//   - `blocked` is not terminal at all. A lane waiting for a permission prompt
//     will never exit to announce it.
//   - a `/goal` lane that reaches `done` EXECS into `amplifier resume` in the
//     same pane (goallane.go), so its pane never closes and handlePaneExit --
//     which writes every CompletionRecord -- never runs for it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not fire on `working`, on a todo
// count changing, on a `doing` line changing, or on anything else that is
// merely progress. The five notice words are the whole vocabulary; there is no
// "still running" marker, by design.

import (
	"os"
	"strings"
	"time"
)

// lifecycleNoticesEnv is the operator's switch for Operator lifecycle notices,
// and it gates BOTH halves: this watcher in the daemon, and the notice pump in
// the browser server. One name and one parser for two processes, so an
// operator cannot half-enable the feature by setting a different spelling in
// one unit.
//
// An environment variable rather than a config-file key because
// reason: config.toml is the BROWSER's config, reloaded live and editable from
// the UI, and "may this system write turns into my Operator conversation" is
// not a preference a web page should be able to flip.
//
// Enabled by default: the same terminal states that update fleet cards must
// also reach Operator. An explicit false value disables both halves.
const lifecycleNoticesEnv = "MUXTERM_OPERATOR_LIFECYCLE_NOTICES"

// LifecycleNoticesEnabled is shared by the daemon and browser server.
func LifecycleNoticesEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(lifecycleNoticesEnv))) {
	case "0", "false", "no", "off":
		return false
	}
	return true
}

// lifecycleSeen is the previous observation of one session: the minimum needed
// to recognise an edge, and nothing more. Keeping whole SessionStates here
// would quietly turn the watcher into a second copy of the fleet.
type lifecycleSeen struct {
	state string
	mode  string
}

// lifecycleWatcher turns a stream of whole-state observations into durable
// markers. Touched only from the session-state ticker goroutine, which is why
// it needs no lock of its own; the store it writes to has one.
type lifecycleWatcher struct {
	store *attentionStore
	prev  map[string]lifecycleSeen
}

func newLifecycleWatcher(store *attentionStore) *lifecycleWatcher {
	return &lifecycleWatcher{store: store, prev: map[string]lifecycleSeen{}}
}

// observe diffs one tick's live rows against the previous tick and writes a
// marker for every transition worth telling a human about.
//
// rows must be the LIVE spool rows, before mergeCompletionRows folds in
// finished lanes. A completion row is a projection of a marker that already
// exists; feeding it back in here would manufacture a transition out of the
// daemon's own memory.
func (w *lifecycleWatcher) observe(rows []SessionState) {
	now := time.Now().Unix()
	seen := make(map[string]lifecycleSeen, len(rows))

	for _, row := range rows {
		if row.SessionID == "" {
			continue
		}
		cur := lifecycleSeen{state: row.State, mode: row.Mode}
		seen[row.SessionID] = cur

		prev, known := w.prev[row.SessionID]
		if !known {
			// FIRST SIGHTING IS A BASELINE, NEVER AN EVENT. This is what stops
			// a daemon restart from announcing every lane that was already
			// sitting in a terminal or blocked state when it started -- the
			// watcher has no evidence those transitions happened now, and a
			// retroactive announcement is indistinguishable from a real one to
			// the human reading it. It is the same rule the notice ledger
			// applies on the delivery side, enforced here as well so neither
			// half depends on the other being careful.
			continue
		}
		if prev.state == row.State {
			continue
		}

		// A lane that un-blocked itself no longer needs anyone. Resolve before
		// considering the new state, so a blocked->done transition both
		// retires the stale attention marker and records the finish.
		if prev.state == SessionStateBlocked && row.State != SessionStateBlocked {
			w.store.ResolveBlocked(row.SessionID)
		}

		kind := lifecycleKindFor(row)
		if kind == "" {
			continue
		}
		w.store.Append(AttentionRecord{
			SessionID:          row.SessionID,
			ExecutionID:        row.ExecutionID,
			TurnID:             row.TurnID,
			Kind:               kind,
			FromState:          prev.state,
			DeclaredWaitingFor: row.WaitingFor,
			WorkspaceID:        row.WorkspaceID,
			PaneID:             row.PaneID,
			Harness:            row.Harness,
			Project:            row.Project,
			Name:               row.Name,
			Label:              row.Label,
			Mode:               row.Mode,
			DoneMeans:          row.DoneMeans,
			Doing:              row.Doing,
			ObservedAt:         now,
		})
	}

	// A session that stopped declaring entirely -- its process is gone, its
	// spool tombstone reclaimed. Any outstanding "needs you" for it is stale:
	// nobody can go and unblock a lane that no longer exists, and if it ended
	// with a verdict the exit path has already written the CompletionRecord
	// that says so.
	for id := range w.prev {
		if _, still := seen[id]; !still {
			w.store.ResolveBlocked(id)
		}
	}
	w.prev = seen
}

// lifecycleKindFor decides which of the five words a row's new state earns, or
// "" for a transition that must stay silent.
//
// Managed sessions are turn-oriented: each stopped/failed/blocked edge is a
// causal event Operator must deliver even when the session is interactive.
// `done` remains autonomous-only because interactive rest never proves a goal
// verdict.
//
// `unverified` is deliberately absent: it means "exited having declared
// nothing", which is a fact about an exit, not about a declaration, so it can
// only ever come from a CompletionRecord.
func lifecycleKindFor(row SessionState) string {
	switch row.State {
	case SessionStateDone:
		if row.Mode != ModeAutonomous {
			return ""
		}
		return NoticeFinished
	case SessionStateFailed:
		return NoticeFailed
	case SessionStateStopped:
		// An autonomous lane that ended its turn without a verdict. This is
		// NeedsInput()'s second clause, verbatim.
		return NoticeStopped
	case SessionStateBlocked:
		return NoticeBlocked
	}
	return ""
}
