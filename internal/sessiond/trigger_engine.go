package sessiond

// The trigger engine: one goroutine that decides when to fire, and refuses to
// more often than it agrees.
//
// EVERY FIRE DECISION HAPPENS ON THIS ONE GOROUTINE. Schedules are compared
// against the clock here; file-watch bursts arrive here already debounced, as a
// single trigger id on a channel. Nothing else calls attemptFire. That is what
// makes the safety checks in section 6 of the design actually hold: an overlap
// check that two goroutines could race past is not an overlap check.
//
// The tick is 1s. It costs a map walk and a few time comparisons, and it buys
// `@every 5s` working as written and a disable taking effect within a second
// rather than at some next scheduled boundary.

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/robfig/cron/v3"
)

// triggerTick is how often schedules are compared against the clock.
const triggerTick = time.Second

// triggerCronParser parses a trigger's Schedule field.
//
// cron.ParseStandard is robfig/cron's STANDARD 5-field parser plus descriptors:
// it accepts `0 9 * * 1-5`, `*/15 * * * *`, `@every 30s`, `@hourly`, `@daily`,
// and a `CRON_TZ=America/Los_Angeles ` prefix.
//
// The PARSER is used and the library's Cron scheduler is not, deliberately.
// robfig's scheduler will happily run a func on a timer, and that is the easy
// 10% of this feature; it has nowhere to express "skip because the last lane is
// still working, and write down that you skipped". Owning the loop is what
// makes the fire log possible.
//
// TIMEZONE: ParseStandard resolves against time.Local unless the expression
// carries CRON_TZ=. A human who writes `0 9 * * *` means 9am where they are.
// DST is then whatever time.Location arithmetic says, which is what a cron user
// already expects: a 02:30 daily fire does not happen on a spring-forward day,
// and Next advances strictly so fall-back does not fire twice.
var triggerCronParser = cron.ParseStandard

// triggerEngine owns the scheduling loop, the file watchers, and the store.
type triggerEngine struct {
	srv   *Server
	store *triggerStore

	// sessions is this engine's OWN session-state collector.
	//
	// Not the Server's: sessionStore.collect documents that its warnedVersions
	// map is unguarded and touched solely by the session-state ticker
	// goroutine. A second instance, read only from the engine goroutine,
	// honours that constraint instead of quietly breaking it. It is consulted
	// only when a fire is being decided, so it costs nothing on an idle tick.
	sessions *sessionStore

	// fireCh carries debounced watch events from watcher goroutines to the one
	// goroutine allowed to fire. Buffered and dropped-on-full: a watch fire is
	// an edge, and a second edge arriving while the first is unprocessed means
	// the same thing as one.
	fireCh chan string

	mu sync.Mutex
	// next is the computed next fire time per schedule trigger. In memory,
	// never persisted -- see TriggerView.NextFireAt for why a stored one would
	// be a lie after a restart.
	next map[string]time.Time
	// watchers is the live fsnotify watcher per watch trigger.
	watchers map[string]*triggerWatcher
	// running reports whether Start's loop is live, so tests can drive
	// individual passes without one.
	running bool
}

func newTriggerEngine(srv *Server, store *triggerStore) *triggerEngine {
	return &triggerEngine{
		srv:      srv,
		store:    store,
		sessions: newSessionStore(),
		fireCh:   make(chan string, 16),
		next:     make(map[string]time.Time),
		watchers: make(map[string]*triggerWatcher),
	}
}

// Start runs the engine until ctx is cancelled.
//
// ARMING IS RELATIVE TO NOW, AND THAT IS THE MISSED-FIRE POLICY. Every enabled
// schedule's next fire is computed from the moment the daemon starts, so an
// occurrence that fell in a window when muxterm was down is MISSED, not run
// late. Catching up would mean an `@every 5m` trigger that was down for eight
// hours owing 96 lanes at startup, each of which costs money. At most one
// occurrence is lost. This is stated in the create_trigger tool description as
// well as here, because silently doing one while the user assumes the other is
// the actual failure mode.
func (e *triggerEngine) Start(ctx context.Context) {
	e.mu.Lock()
	e.running = true
	e.mu.Unlock()

	e.reconcileAfterRestart()
	e.arm(time.Now())
	e.syncWatchers()

	ticker := time.NewTicker(triggerTick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			e.closeWatchers()
			return
		case id := <-e.fireCh:
			e.fireWatch(id)
		case now := <-ticker.C:
			e.tick(now)
		}
	}
}

// reconcileAfterRestart forgets last-lane coordinates that no longer mean
// anything, and says so in the fire log.
//
// WORKSPACE AND PANE IDS ARE RECYCLED ACROSS A RESTART. Observed live, and it
// is not a corner case: a trigger's lane ran in `w3 pane 1`; the daemon
// restarted; the restore pass rebuilt the workspaces in a different order and
// `w3 pane 1` came back as a COMPLETELY UNRELATED lane belonging to another
// trigger. The overlap check then found a live pane at those coordinates and
// skipped every subsequent fire -- a schedule trigger wedged indefinitely by a
// stranger, with a skip reason that read perfectly plausibly.
//
// completionFor is already safe here: it requires EndedAt >= LastFireAt, which
// is what mergeCompletionRows' warning about recycled ids demands. The
// pane-existence half of laneRunning had no such protection, and this is it.
//
// The direction is deliberate. A lane whose daemon died before writing a
// completion record will NEVER get one, so treating it as still-running is not
// conservative, it is permanent: the trigger never fires again and no amount of
// waiting fixes it. Forgetting fires at most one extra lane, once, and the
// overlap check protects everything after that. A recoverable wrong beats an
// unrecoverable one.
func (e *triggerEngine) reconcileAfterRestart() {
	for _, t := range e.store.All() {
		if t.LastWorkspaceID == "" || t.LastSettled {
			continue
		}
		if _, done := e.completionFor(t); done {
			// A durable verdict exists and survived the restart. settle() will
			// count it on the next tick; nothing to forget.
			continue
		}
		detail := fmt.Sprintf("daemon restarted while the lane in %s pane %d was running; "+
			"its outcome is unknown and those ids may now belong to something else",
			t.LastWorkspaceID, t.LastPaneID)
		e.store.RecordFire(t.ID, TriggerFire{
			At:      time.Now().Unix(),
			Outcome: FireOrphaned,
			Detail:  detail,
		}, func(t *Trigger) {
			// Neither a success nor a failure: the daemon has no verdict and
			// must not invent one in either direction. The failure streak is
			// left exactly as it was.
			t.LastSettled = true
			t.LastWorkspaceID = ""
			t.LastPaneID = 0
		})
		log.Printf("sessiond: trigger %q: %s", t.Name, detail)
	}
}

// arm computes the next fire for every enabled schedule trigger that has none.
func (e *triggerEngine) arm(now time.Time) {
	for _, t := range e.store.All() {
		if t.Kind != TriggerKindSchedule || !t.Enabled {
			continue
		}
		e.mu.Lock()
		if _, ok := e.next[t.ID]; !ok {
			if sched, err := triggerCronParser(t.Schedule); err == nil {
				e.next[t.ID] = sched.Next(now)
			}
		}
		e.mu.Unlock()
	}
}

// tick is one pass: settle finished lanes, drop state for triggers that are
// gone or off, arm new ones, and fire whatever is due.
func (e *triggerEngine) tick(now time.Time) {
	triggers := e.store.All()

	live := make(map[string]bool, len(triggers))
	for _, t := range triggers {
		live[t.ID] = true
	}
	e.prune(live)

	for _, t := range triggers {
		// Settle first, on every tick and not only at fire time. A trigger
		// that fires daily should not carry an unaccounted failure for
		// twenty-four hours, and list_triggers should not have to lie about
		// its run count until the next fire happens to update it.
		e.settle(t.ID)

		if !t.Enabled {
			// DISABLE IS IMMEDIATE. Dropping the armed time here means
			// re-enabling arms fresh from that moment rather than firing
			// instantly for a boundary that passed while it was off.
			e.mu.Lock()
			delete(e.next, t.ID)
			e.mu.Unlock()
			e.stopWatcher(t.ID)
			continue
		}

		switch t.Kind {
		case TriggerKindSchedule:
			e.tickSchedule(t, now)
		case TriggerKindWatch:
			e.ensureWatcher(t)
		}
	}
}

func (e *triggerEngine) tickSchedule(t Trigger, now time.Time) {
	sched, err := triggerCronParser(t.Schedule)
	if err != nil {
		// A schedule that does not parse cannot fire. Reported through
		// TriggerView.ScheduleError rather than logged every second.
		return
	}
	e.mu.Lock()
	due, armed := e.next[t.ID]
	if !armed {
		e.next[t.ID] = sched.Next(now)
		e.mu.Unlock()
		return
	}
	if now.Before(due) {
		e.mu.Unlock()
		return
	}
	// Re-arm from NOW, not from the due time. Arming from `due` would replay
	// every boundary that passed while a slow fire attempt was in progress --
	// the catch-up stampede this design refuses, arriving through the back
	// door.
	e.next[t.ID] = sched.Next(now)
	e.mu.Unlock()

	e.attemptFire(t.ID, fmt.Sprintf("schedule %s", t.Schedule))
}

// fireWatch handles a debounced file-watch edge.
func (e *triggerEngine) fireWatch(id string) {
	t, ok := e.store.Get(id)
	if !ok || !t.Enabled || t.Kind != TriggerKindWatch {
		// Deleted or disabled between the debounce expiring and this being
		// read. Checking here is what makes disable take effect immediately
		// even for an edge already in flight.
		return
	}
	e.attemptFire(id, fmt.Sprintf("change under %s", t.Path))
}

// prune drops in-memory state for triggers that no longer exist.
func (e *triggerEngine) prune(live map[string]bool) {
	e.mu.Lock()
	for id := range e.next {
		if !live[id] {
			delete(e.next, id)
		}
	}
	stale := make([]string, 0)
	for id := range e.watchers {
		if !live[id] {
			stale = append(stale, id)
		}
	}
	e.mu.Unlock()
	for _, id := range stale {
		e.stopWatcher(id)
	}
}

// nextFireFor reports the armed next fire for a trigger, for TriggerView.
func (e *triggerEngine) nextFireFor(t Trigger, now time.Time) (int64, string) {
	if t.Kind != TriggerKindSchedule {
		return 0, ""
	}
	sched, err := triggerCronParser(t.Schedule)
	if err != nil {
		return 0, err.Error()
	}
	if !t.Enabled {
		return 0, ""
	}
	e.mu.Lock()
	due, armed := e.next[t.ID]
	running := e.running
	e.mu.Unlock()
	if armed {
		return due.Unix(), ""
	}
	if running {
		// Enabled, parseable, and the loop is live but has not armed it yet --
		// a trigger created since the last tick. Report what it WILL be rather
		// than an empty field that reads like "never".
		return sched.Next(now).Unix(), ""
	}
	return sched.Next(now).Unix(), ""
}

// settle folds the outcome of a trigger's last lane into its counters, once.
//
// This is where a run becomes a success or a failure, and it reads the
// completion log rather than asking the lane: a CompletionRecord is written by
// the pane-exit path whether the lane finished, crashed on its first turn, or
// was killed (completion.go), so a lane cannot fail to be counted by failing
// badly enough.
func (e *triggerEngine) settle(id string) {
	t, ok := e.store.Get(id)
	if !ok || t.LastSettled || t.LastWorkspaceID == "" {
		return
	}
	rec, done := e.completionFor(t)
	if !done {
		return
	}

	disableReason := ""
	updated, _ := e.store.Update(id, func(t *Trigger) {
		t.LastSettled = true
		switch rec.Outcome {
		case CompletionCompleted:
			// Any success resets the streak. A trigger that works most of the
			// time is a working trigger.
			t.ConsecutiveFailures = 0
		case CompletionFailed:
			t.ConsecutiveFailures++
		default:
			// stopped, or exited with no verdict. Neither a success to reset
			// the streak with nor a failure to count: asserting either would
			// invent a verdict the daemon does not have.
		}
		if t.MaxRuns > 0 && t.RunCount >= t.MaxRuns {
			t.Enabled = false
			disableReason = fmt.Sprintf("reached max_runs (%d)", t.MaxRuns)
			t.DisabledReason = disableReason
		} else if t.ConsecutiveFailures >= triggerFailureDisableThreshold {
			t.Enabled = false
			disableReason = fmt.Sprintf("%d consecutive failed runs (last: %s)",
				t.ConsecutiveFailures, rec.Summary())
			t.DisabledReason = disableReason
		}
	})
	if disableReason != "" {
		// Recorded in the fire log, not only in a field, so the reason sits in
		// the timeline next to the failures that caused it.
		e.store.RecordFire(id, TriggerFire{
			At:      time.Now().Unix(),
			Outcome: FireDisabled,
			Detail:  disableReason,
		}, nil)
		log.Printf("sessiond: trigger %q disabled itself: %s", updated.Name, disableReason)
	}
}

// completionFor finds the completion record for a trigger's last lane.
//
// Matched on workspace+pane AND EndedAt >= the fire that spawned it. The
// timestamp bound is what makes workspace/pane matching safe here, and
// mergeCompletionRows' warning about recycled ids is exactly why it is
// required: without it, a record from an unrelated older lane that happened to
// occupy the same coordinates would be read as this trigger's result.
func (e *triggerEngine) completionFor(t Trigger) (CompletionRecord, bool) {
	if e.srv == nil || e.srv.completions == nil {
		return CompletionRecord{}, false
	}
	var best CompletionRecord
	found := false
	for _, r := range e.srv.completions.All() {
		if r.WorkspaceID != t.LastWorkspaceID || r.PaneID != t.LastPaneID {
			continue
		}
		if r.EndedAt < t.LastFireAt {
			continue
		}
		if !found || r.EndedAt > best.EndedAt {
			best = r
			found = true
		}
	}
	return best, found
}

// laneRunning reports whether a trigger's last lane is still working, and says
// why in words a fire record can carry.
//
// BOTH HALVES ARE REQUIRED, and each alone is wrong:
//
//   - Pane-existence alone is wrong now that a finished /goal loop resumes
//     interactively in the SAME pane (goallane.go). The pane outlives the work,
//     so a pane-only check would wedge the trigger forever after its first run.
//   - Declared state alone is wrong because a lane that has not yet declared
//     anything has no row at all -- which is the state every lane is in for the
//     first seconds of its life, i.e. exactly when the next fire is most likely
//     to arrive.
//
// An undeclared lane whose pane is alive therefore counts as STILL RUNNING. The
// conservative direction is always "do not start another".
func (e *triggerEngine) laneRunning(t Trigger) (bool, string) {
	if t.LastWorkspaceID == "" {
		return false, ""
	}
	// A completion record is the authoritative end of a lane: written by the
	// exit path, durable across restarts. If one exists, the lane is over
	// whatever anything else says.
	if _, done := e.completionFor(t); done {
		return false, ""
	}
	if e.srv == nil {
		return false, ""
	}
	if _, ok := e.srv.reg.Pane(t.LastWorkspaceID, t.LastPaneID); !ok {
		// No pane and no completion record: the daemon restarted since, or the
		// pane was closed by hand. Nothing is running.
		return false, ""
	}
	// The pane is alive. Ask what its session says about itself.
	rows, ok := e.sessions.collect(func() map[int]paneRef {
		return paneOwners(e.srv.reg.snapshotView())
	})
	if !ok {
		// The spool could not be read. Treat that as "still running": refusing
		// to fire because we could not check is the safe direction, and it
		// self-corrects on the next tick.
		return true, "could not read session state; declining to start a second lane"
	}
	for _, row := range rows {
		if row.WorkspaceID != t.LastWorkspaceID || row.PaneID != t.LastPaneID {
			continue
		}
		if sessionStateIsTerminal(row.State) {
			return false, ""
		}
		return true, fmt.Sprintf("previous lane is %s in %s pane %d",
			row.State, t.LastWorkspaceID, t.LastPaneID)
	}
	return true, fmt.Sprintf("previous lane in %s pane %d has not reported a state yet",
		t.LastWorkspaceID, t.LastPaneID)
}

// concurrentLanes counts trigger-spawned lanes currently running.
func (e *triggerEngine) concurrentLanes(exclude string) int {
	n := 0
	for _, t := range e.store.All() {
		if t.ID == exclude {
			continue
		}
		if running, _ := e.laneRunning(t); running {
			n++
		}
	}
	return n
}
