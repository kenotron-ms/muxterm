package sessiond

// The Server-level trigger API: what the protocol handlers and the MCP tools
// actually call.
//
// EVERYTHING IS VALIDATED AT CREATE TIME, in front of whoever asked. A trigger
// is the one object in this daemon that acts with nobody watching, so the
// moment a human or an agent is present is the moment to refuse a bad one. A
// trigger that turns out at 3am to name a harness that does not exist, or a
// path with more directories than the kernel will watch, has failed in the one
// place where failing is expensive and invisible.

import (
	"fmt"
	"time"
	"unicode"
	"unicode/utf8"
)

// maxTriggerNameBytes caps a trigger name, on the same reasoning as
// maxWorkspaceNameBytes: the name is echoed into logs and into every listing.
const maxTriggerNameBytes = 128

// CheckWorkspaceName rejects a name that is not a single short line of text.
//
// Nothing here is defending against quoting -- argv is a slice, exec'd without
// a shell. What it defends is everything that DISPLAYS the name: a newline in a
// workspace name splits a log line in two and can forge a second one, and a
// control character walks the cursor around any terminal that renders the list.
func CheckWorkspaceName(name string) error {
	return checkOneLineName(name, "workspace name", MaxWorkspaceNameBytes)
}

// MaxWorkspaceNameBytes caps a workspace name. Generous for anything a human or
// a chief of staff would write ("backend auth refresh"), small enough that a
// name cannot be used as a payload: it is echoed into the daemon registry,
// every browser's workspace dock, and the daemon's logs.
const MaxWorkspaceNameBytes = 128

func checkOneLineName(name, what string, limit int) error {
	if name == "" {
		return fmt.Errorf("%s is required", what)
	}
	if len(name) > limit {
		return fmt.Errorf("%s is %d bytes; the limit is %d", what, len(name), limit)
	}
	if !utf8.ValidString(name) {
		return fmt.Errorf("%s is not valid UTF-8", what)
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return fmt.Errorf("%s contains a control character (%q); a name is one line of plain text", what, r)
		}
	}
	return nil
}

// CreateTrigger validates and stores a trigger, arming it immediately.
func (s *Server) CreateTrigger(t Trigger) (TriggerView, error) {
	if err := checkOneLineName(t.Name, "trigger name", maxTriggerNameBytes); err != nil {
		return TriggerView{}, err
	}
	if err := CheckWorkspaceName(t.Workspace); err != nil {
		return TriggerView{}, err
	}
	// Building the argv now is the cheapest way to reject an unlaunchable
	// harness, a prompt that is really a slash command, or a goal on a harness
	// with no goal mode. The result is DISCARDED: it is rebuilt at fire time so
	// a trigger inherits argv fixes rather than freezing today's version. See
	// lane_argv.go.
	if _, err := LaneArgv(t.Harness, t.Prompt, t.Goal); err != nil {
		return TriggerView{}, err
	}
	if t.MaxRuns < 0 {
		return TriggerView{}, fmt.Errorf("max_runs cannot be negative (0 means unlimited)")
	}

	switch t.Kind {
	case TriggerKindSchedule:
		if t.Schedule == "" {
			return TriggerView{}, fmt.Errorf("schedule is required for a %q trigger", TriggerKindSchedule)
		}
		if _, err := triggerCronParser(t.Schedule); err != nil {
			return TriggerView{}, fmt.Errorf("schedule %q is not a valid cron expression: %w "+
				"(five fields like `0 9 * * 1-5`, or a descriptor like `@every 30m`, `@hourly`, `@daily`)",
				t.Schedule, err)
		}
		t.Path = ""
	case TriggerKindWatch:
		if t.Path == "" {
			return TriggerView{}, fmt.Errorf("path is required for a %q trigger", TriggerKindWatch)
		}
		// Walked NOW, so a tree too large to watch is refused while a human is
		// looking at the error rather than silently half-watched at 3am. See
		// triggerWatchDirs.
		if _, err := triggerWatchDirs(t.Path); err != nil {
			return TriggerView{}, err
		}
		t.Schedule = ""
	case "":
		return TriggerView{}, fmt.Errorf("kind is required (%q or %q)", TriggerKindSchedule, TriggerKindWatch)
	default:
		return TriggerView{}, fmt.Errorf("unknown trigger kind %q (%q or %q)",
			t.Kind, TriggerKindSchedule, TriggerKindWatch)
	}

	stored, err := s.triggers.Add(t)
	if err != nil {
		return TriggerView{}, err
	}
	// Arm without waiting for the next tick, so a trigger created at 08:59:59
	// with `0 9 * * *` is armed before nine.
	now := time.Now()
	s.engine.arm(now)
	if stored.Kind == TriggerKindWatch && stored.Enabled {
		s.engine.ensureWatcher(stored)
	}
	return s.engine.view(stored, now), nil
}

// ListTriggers returns every trigger with its derived fields.
func (s *Server) ListTriggers() []TriggerView {
	now := time.Now()
	all := s.triggers.All()
	out := make([]TriggerView, 0, len(all))
	for _, t := range all {
		out = append(out, s.engine.view(t, now))
	}
	return out
}

// SetTriggerEnabled turns a trigger on or off.
//
// THE STOP BUTTON. Immediate in both directions: the engine re-reads the store
// every tick, disable tears down any fsnotify watch on the next pass, and a
// watch edge already in flight is dropped when fireWatch re-checks Enabled.
//
// It never touches lanes already spawned. Stopping a trigger is not the same
// gesture as killing the work it started, and conflating them would make "stop
// firing" destructive -- which is the last thing it should be, since it is the
// control a worried human reaches for fastest.
func (s *Server) SetTriggerEnabled(id string, enabled bool) (TriggerView, error) {
	t, ok := s.triggers.Update(id, func(t *Trigger) {
		t.Enabled = enabled
		if enabled {
			// Re-enabling clears the self-disable reason AND the failure
			// streak. A human turning it back on is a statement that the
			// failures were understood; keeping the count would disable it
			// again on the next single failure.
			t.DisabledReason = ""
			t.ConsecutiveFailures = 0
		}
	})
	if !ok {
		return TriggerView{}, fmt.Errorf("no trigger with id %q", id)
	}
	now := time.Now()
	if enabled {
		s.engine.arm(now)
		if t.Kind == TriggerKindWatch {
			s.engine.ensureWatcher(t)
		}
	} else {
		s.engine.disarm(id)
	}
	return s.engine.view(t, now), nil
}

// DeleteTrigger removes a trigger and tears down its watches.
func (s *Server) DeleteTrigger(id string) error {
	if !s.triggers.Delete(id) {
		return fmt.Errorf("no trigger with id %q", id)
	}
	s.engine.disarm(id)
	return nil
}

// disarm drops a trigger's armed time and stops its watcher.
func (e *triggerEngine) disarm(id string) {
	e.mu.Lock()
	delete(e.next, id)
	e.mu.Unlock()
	e.stopWatcher(id)
}

// view projects a stored trigger into what a caller sees.
func (e *triggerEngine) view(t Trigger, now time.Time) TriggerView {
	next, schedErr := e.nextFireFor(t, now)
	running, _ := e.laneRunning(t)
	return TriggerView{
		Trigger:       t,
		NextFireAt:    next,
		ScheduleError: schedErr,
		Running:       running,
	}
}
