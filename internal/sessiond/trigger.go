package sessiond

// Triggers: the durable record of work that starts without a human.
//
// A trigger has exactly one action -- it SPAWNS A LANE -- and that is the whole
// design. See docs/designs/2026-09-09-triggers.md for why, at length; the short
// version is that a lane already carries a lifecycle, a declared state, a
// durable CompletionRecord, a fleet row and a teardown gesture, so a trigger
// that spawns one inherits all five and has to invent none of them.
//
// WHERE THIS LIVES, AND WHY. The store is a JSON document in snapshotDir() --
// $XDG_DATA_HOME/muxterm -- beside completions.json, written with the same
// tmp+rename discipline. That is not a coincidence and it is not a new pattern:
// completion.go argues the case (durable, XDG-derived so a dev daemon cannot
// corrupt the real one, one bounded document rather than a directory to scan)
// and every word of it applies here unchanged.
//
// WHAT IS PERSISTED IS THE TRIGGER *AND ITS HISTORY*. Storing the schedule
// alone would be enough to keep firing across a restart, and would answer none
// of the questions a human actually asks: did it fire, did it do anything, was
// it skipped, why is it off. amplifier-drumbeat's sharpest recorded lesson is
// that a crashed run and a healthy run that decided nothing was worth doing
// were byte-identical from outside; the fire log exists so that "never fired",
// "fired and produced nothing" and "skipped because the last one was still
// working" are three different, readable facts.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// triggerRecordVersion is the schema version written into every trigger. A
// trigger declaring a higher version was written by a newer daemon and is kept
// on disk but never fired, on the same reasoning as completionRecordVersion: a
// reader that does not understand a shape should decline it, not guess. For a
// trigger specifically, guessing means spawning the wrong lane unattended.
const triggerRecordVersion = 1

// Trigger kinds.
const (
	// TriggerKindSchedule fires on a cron expression. See triggerSchedule.
	TriggerKindSchedule = "schedule"
	// TriggerKindWatch fires when a watched path changes. See triggerWatch.
	TriggerKindWatch = "watch"
)

// Fire outcomes. Every fire ATTEMPT records one of these, including the ones
// that did not spawn anything -- that is the point of the log.
const (
	// FireFired: a lane was spawned. WorkspaceID and PaneID name it.
	FireFired = "fired"
	// FireSkippedOverlap: the previous lane from this trigger was still
	// working. The single most important safeguard here, and the easiest to
	// leave out -- loom has the check and records nothing when it trips.
	FireSkippedOverlap = "skipped-overlap"
	// FireSkippedCap: the global concurrent-trigger-lane cap was reached.
	FireSkippedCap = "skipped-cap"
	// FireSkippedMaxRuns: this trigger has run max_runs times.
	FireSkippedMaxRuns = "skipped-max-runs"
	// FireError: the spawn itself failed. Distinct from a lane that ran and
	// failed, which is a completion record, not a fire record.
	FireError = "error"
	// FireDisabled: the trigger disabled itself. Recorded as a fire-log entry
	// rather than only a field so the REASON sits in the timeline next to the
	// failures that caused it.
	FireDisabled = "disabled"
)

// Bounds. Every one of these is a number a human may have to justify at 3am,
// so each carries the reason it is that number.

const (
	// triggerCapacity bounds how many triggers can exist. A trigger is a few
	// hundred bytes and this is configuration rather than history, but an
	// unbounded list is an unbounded number of things that can fire.
	triggerCapacity = 100

	// triggerHistoryPerTrigger bounds the fire log per trigger. Twenty is
	// enough to see a pattern -- three fires, four skips, the disable -- and
	// small enough that a trigger firing every minute cannot fill a disk.
	triggerHistoryPerTrigger = 20

	// triggerMaxConcurrentLanes caps how many lanes spawned BY TRIGGERS may be
	// running at once, across every trigger. Triggers are not the only thing
	// spawning lanes on this machine and they must not be able to crowd out
	// the human; three is enough for a few independent automations and few
	// enough that a misconfiguration is survivable.
	triggerMaxConcurrentLanes = 3

	// triggerFailureDisableThreshold is how many CONSECUTIVE failed runs
	// disable a trigger.
	//
	// This is the guardrail both prior arts lack and both paid for -- drumbeat
	// watched an automation fail ten runs in a row. A trigger firing every five
	// minutes into a lane that dies on startup is a loop that burns money for
	// hours.
	//
	// Three rather than one: a transient provider error should not permanently
	// disable a working trigger. Any success resets the count to zero.
	triggerFailureDisableThreshold = 3
)

// TriggerFire is one fire attempt. Attempts that spawned nothing are recorded
// exactly as loudly as the ones that did.
//
// JSON field names are a persisted format. Add fields, never rename them.
type TriggerFire struct {
	At      int64  `json:"at"`
	Outcome string `json:"outcome"`
	Detail  string `json:"detail,omitempty"`
	// Where the lane went, when one was spawned.
	WorkspaceID string `json:"workspaceId,omitempty"`
	PaneID      int    `json:"paneId,omitempty"`
}

// Trigger is one automation: when to fire, and the lane to spawn when it does.
type Trigger struct {
	V    int    `json:"v"`
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`

	// WHEN. Exactly one of these is set, per Kind.
	//
	// Schedule is a standard 5-field cron expression, and also accepts the
	// robfig descriptors (@every 30s, @hourly, @daily) and a CRON_TZ= prefix.
	// One field, both idioms a human reaches for -- which is why there is no
	// separate interval type to document, validate and get wrong.
	Schedule string `json:"schedule,omitempty"`
	// Path is the watched root for a watch trigger. Watches are recursive.
	Path string `json:"path,omitempty"`

	// WHAT. Precisely spawn_lane's arguments, because the action IS spawn_lane.
	Workspace string `json:"workspace"`
	Harness   string `json:"harness"`
	Prompt    string `json:"prompt,omitempty"`
	Goal      string `json:"goal,omitempty"`

	Enabled bool `json:"enabled"`
	// DisabledReason survives being re-enabled and is cleared then, so a
	// trigger a human turned back on does not still claim it failed itself off.
	DisabledReason string `json:"disabledReason,omitempty"`
	// MaxRuns caps total successful fires; 0 means unlimited.
	MaxRuns int `json:"maxRuns,omitempty"`

	CreatedAt  int64 `json:"createdAt"`
	LastFireAt int64 `json:"lastFireAt,omitempty"`
	RunCount   int   `json:"runCount,omitempty"`
	// ConsecutiveFailures drives the failure-disable. Reset by any success.
	ConsecutiveFailures int `json:"consecutiveFailures,omitempty"`

	// The last lane this trigger spawned, kept so overlap prevention has
	// something to ask about. Cleared once that lane has been settled.
	LastWorkspaceID string `json:"lastWorkspaceId,omitempty"`
	LastPaneID      int    `json:"lastPaneId,omitempty"`
	// LastSettled marks whether the outcome of the last lane has already been
	// folded into RunCount/ConsecutiveFailures, so a completion is counted once
	// however many times the settle pass runs.
	LastSettled bool `json:"lastSettled,omitempty"`

	History []TriggerFire `json:"history,omitempty"`
}

// TriggerView is a trigger as reported to a caller: the stored fields plus the
// two derived ones a human actually asks for.
//
// NextFireAt is computed, never stored. A stored "next fire" would be a lie
// after any restart -- which is exactly when a user most wants to know whether
// their trigger is still live -- and it is the field that answers "is this
// thing going to happen".
type TriggerView struct {
	Trigger
	NextFireAt int64 `json:"nextFireAt,omitempty"`
	// ScheduleError explains a schedule that no longer parses. A trigger
	// written by a newer daemon, or hand-edited, must say so rather than
	// silently never firing.
	ScheduleError string `json:"scheduleError,omitempty"`
	// Running reports whether this trigger's last lane is still working. It is
	// the reason a fire would be skipped right now, surfaced before the skip
	// happens rather than after.
	Running bool `json:"running,omitempty"`
}

// triggerStore holds every trigger, in memory and on disk.
//
// Its own mutex rather than Server.mu, following completionStore for the same
// reason: it is written from the scheduler goroutine and the watcher goroutine
// and read from MCP request handlers, and a file write must never be able to
// stall an attach or a broadcast.
type triggerStore struct {
	mu             sync.Mutex
	path           string
	triggers       []Trigger
	writeErrLogged bool
}

// triggersFile is the on-disk document.
type triggersFile struct {
	V        int       `json:"v"`
	Triggers []Trigger `json:"triggers"`
}

// TriggersPath returns the durable trigger store's location.
//
// Resolution order mirrors CompletionsPath's, for the same reasons: an explicit
// override for tests and odd deploys, then the XDG-derived default that keeps a
// dev daemon's triggers out of the real ones without either side being told
// which world it is in. For triggers that isolation is not a nicety -- a test
// daemon inheriting the user's real triggers would spawn real lanes.
func TriggersPath() string {
	if override := os.Getenv("MUXTERM_TRIGGERS_PATH"); override != "" {
		return override
	}
	return filepath.Join(snapshotDir(), "triggers.json")
}

// newTriggerStore loads the store at path, tolerating every kind of absence.
//
// A missing, unreadable or malformed file yields an EMPTY store rather than a
// failure to start, on completionStore's reasoning. The asymmetry is
// deliberate and it is the safe direction: losing triggers means nothing fires,
// which is a bad day; guessing at a malformed trigger means firing something
// unattended that nobody asked for.
func newTriggerStore(path string) *triggerStore {
	s := &triggerStore{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var doc triggersFile
	if err := json.Unmarshal(data, &doc); err != nil {
		log.Printf("sessiond: trigger store %s is unreadable (%v); starting with no triggers", path, err)
		return s
	}
	for _, t := range doc.Triggers {
		if t.ID == "" {
			continue
		}
		if t.V > triggerRecordVersion {
			log.Printf("sessiond: trigger %q declares version %d (this daemon understands %d); "+
				"keeping it on disk but never firing it", t.ID, t.V, triggerRecordVersion)
			continue
		}
		s.triggers = append(s.triggers, t)
	}
	s.sortLocked()
	return s
}

// All returns every trigger, ordered by creation.
func (s *triggerStore) All() []Trigger {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Trigger(nil), s.triggers...)
}

// Get returns the trigger with id.
func (s *triggerStore) Get(id string) (Trigger, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if i := s.indexOfLocked(id); i >= 0 {
		return s.triggers[i], true
	}
	return Trigger{}, false
}

// Add stores a new trigger and returns it with its assigned id.
func (s *triggerStore) Add(t Trigger) (Trigger, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.triggers) >= triggerCapacity {
		return Trigger{}, fmt.Errorf("too many triggers: %d is the limit, delete one first", triggerCapacity)
	}
	t.V = triggerRecordVersion
	if t.CreatedAt == 0 {
		t.CreatedAt = time.Now().Unix()
	}
	if t.ID == "" {
		t.ID = triggerID(t.Name, t.CreatedAt)
	}
	for s.indexOfLocked(t.ID) >= 0 {
		t.ID += "x"
	}
	s.triggers = append(s.triggers, t)
	s.sortLocked()
	s.persistLocked()
	return t, nil
}

// Delete removes a trigger and reports whether it existed.
func (s *triggerStore) Delete(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.indexOfLocked(id)
	if i < 0 {
		return false
	}
	s.triggers = append(s.triggers[:i], s.triggers[i+1:]...)
	s.persistLocked()
	return true
}

// Update applies mutate to the trigger with id and persists the result. It is
// the ONLY way a stored trigger changes: read-modify-write through here means a
// concurrent fire and a concurrent disable cannot lose one another's edit.
func (s *triggerStore) Update(id string, mutate func(*Trigger)) (Trigger, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.indexOfLocked(id)
	if i < 0 {
		return Trigger{}, false
	}
	mutate(&s.triggers[i])
	s.persistLocked()
	return s.triggers[i], true
}

// RecordFire appends a fire record and applies the state change that goes with
// it, in ONE persisted step.
//
// One call rather than a fire-log append plus a separate counter update,
// because the two must not be able to disagree. A recorded fire whose run count
// did not move, or a run count that moved with nothing in the log to explain
// it, is the exact ambiguity this whole feature exists to remove.
func (s *triggerStore) RecordFire(id string, fire TriggerFire, mutate func(*Trigger)) (Trigger, bool) {
	return s.Update(id, func(t *Trigger) {
		if mutate != nil {
			mutate(t)
		}
		t.History = append(t.History, fire)
		if len(t.History) > triggerHistoryPerTrigger {
			t.History = t.History[len(t.History)-triggerHistoryPerTrigger:]
		}
	})
}

func (s *triggerStore) indexOfLocked(id string) int {
	for i := range s.triggers {
		if s.triggers[i].ID == id {
			return i
		}
	}
	return -1
}

// sortLocked keeps the list in creation order so listing is stable across
// restarts. Ties break on id so the order is total.
func (s *triggerStore) sortLocked() {
	sort.SliceStable(s.triggers, func(i, j int) bool {
		if s.triggers[i].CreatedAt != s.triggers[j].CreatedAt {
			return s.triggers[i].CreatedAt < s.triggers[j].CreatedAt
		}
		return s.triggers[i].ID < s.triggers[j].ID
	})
}

// persistLocked atomically rewrites the store, following persistLocked in
// completion.go and WriteSnapshot's tmp+rename discipline so a reader never
// sees a half-written document.
//
// A write failure is logged once and otherwise swallowed: the caller may be the
// scheduler goroutine mid-fire, and refusing to fire because a log could not be
// written trades a durability problem for an automation that stops working.
// The in-memory triggers remain correct for this daemon's lifetime.
func (s *triggerStore) persistLocked() {
	dir := filepath.Dir(s.path)
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		var data []byte
		data, err = json.Marshal(triggersFile{V: triggerRecordVersion, Triggers: s.triggers})
		if err == nil {
			tmp := s.path + ".tmp"
			if err = os.WriteFile(tmp, data, 0o600); err == nil {
				if err = os.Rename(tmp, s.path); err != nil {
					os.Remove(tmp)
				}
			}
		}
	}
	if err != nil {
		if !s.writeErrLogged {
			s.writeErrLogged = true
			log.Printf("sessiond: could not persist trigger store %s: %v "+
				"(triggers remain in memory for this daemon's lifetime and are lost on restart)", s.path, err)
		}
		return
	}
	s.writeErrLogged = false
}

// triggerID mints a readable, stable id from the trigger's name.
//
// Readable because a human types it into set_trigger_enabled at the moment they
// want something to stop, and "nightly-review-1757..." is findable in a list
// where a bare uuid is not.
func triggerID(name string, createdAt int64) string {
	slug := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		case r == ' ', r == '-', r == '_', r == '/':
			return '-'
		}
		return -1
	}, name)
	slug = strings.Trim(slug, "-")
	for strings.Contains(slug, "--") {
		slug = strings.ReplaceAll(slug, "--", "-")
	}
	if slug == "" {
		slug = "trigger"
	}
	if len(slug) > 32 {
		slug = strings.Trim(slug[:32], "-")
	}
	return fmt.Sprintf("%s-%d", slug, createdAt)
}
