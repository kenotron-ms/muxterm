package sessiond

// Trigger tests.
//
// The safety properties get the most coverage on purpose: this is the one
// feature in muxterm that starts work with nobody watching, so "it skipped when
// it should have skipped" matters more than "it fired when it should have
// fired". Firing is easy to notice being wrong; refusing is not.

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// newTestTriggerEngine returns an engine with a real store on a temp path and
// no Server behind it. Every test that needs firing to actually spawn uses a
// full server instead; these cover the decisions, which is where the safety
// lives.
func newTestTriggerEngine(t *testing.T) *triggerEngine {
	t.Helper()
	store := newTriggerStore(filepath.Join(t.TempDir(), "triggers.json"))
	return newTriggerEngine(nil, store)
}

func TestTriggerStoreRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), "triggers.json")
	s := newTriggerStore(path)
	stored, err := s.Add(Trigger{
		Name: "Nightly Review", Kind: TriggerKindSchedule, Schedule: "0 3 * * *",
		Workspace: "review", Harness: HarnessAmplifier, Goal: "reviewed", Enabled: true,
	})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}
	if stored.ID != "nightly-review-"+strconv.FormatInt(stored.CreatedAt, 10) {
		t.Fatalf("id %q is not derived from the name: a bare uuid is unfindable in a list "+
			"at the moment someone wants to turn it off", stored.ID)
	}
	s.RecordFire(stored.ID, TriggerFire{At: 100, Outcome: FireSkippedOverlap, Detail: "still working"}, nil)

	// A second store over the same path is a restart.
	reloaded := newTriggerStore(path)
	all := reloaded.All()
	if len(all) != 1 {
		t.Fatalf("after restart: got %d triggers, want 1", len(all))
	}
	if all[0].Schedule != "0 3 * * *" || !all[0].Enabled {
		t.Fatalf("after restart: trigger did not survive intact: %+v", all[0])
	}
	if len(all[0].History) != 1 || all[0].History[0].Outcome != FireSkippedOverlap {
		t.Fatalf("after restart: the fire log did not survive; that log is the only thing that "+
			"distinguishes a skip from a trigger that never ran: %+v", all[0].History)
	}
}

func TestTriggerStoreRejectsFutureVersions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "triggers.json")
	doc := `{"v":1,"triggers":[{"v":99,"id":"from-the-future","name":"x","kind":"schedule",` +
		`"schedule":"@every 1s","workspace":"w","harness":"amplifier","prompt":"p","enabled":true}]}`
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := len(newTriggerStore(path).All()); got != 0 {
		t.Fatalf("a trigger declaring a newer schema version was loaded (%d); guessing at a shape "+
			"we do not understand means firing something unattended that nobody asked for", got)
	}
}

func TestTriggerStoreSurvivesGarbage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "triggers.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := len(newTriggerStore(path).All()); got != 0 {
		t.Fatalf("got %d triggers from a malformed file, want 0 and no panic", got)
	}
}

func TestTriggerHistoryIsBounded(t *testing.T) {
	s := newTriggerStore(filepath.Join(t.TempDir(), "triggers.json"))
	stored, _ := s.Add(Trigger{Name: "n", Kind: TriggerKindSchedule, Schedule: "@every 1s",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true})
	for i := 0; i < triggerHistoryPerTrigger*3; i++ {
		s.RecordFire(stored.ID, TriggerFire{At: int64(i), Outcome: FireFired}, nil)
	}
	got, _ := s.Get(stored.ID)
	if len(got.History) != triggerHistoryPerTrigger {
		t.Fatalf("history is %d entries, want it capped at %d: a trigger firing every minute "+
			"must not be able to fill a disk", len(got.History), triggerHistoryPerTrigger)
	}
	if got.History[len(got.History)-1].At != int64(triggerHistoryPerTrigger*3-1) {
		t.Fatal("the cap dropped the NEWEST entries; the recent outcomes are the ones that matter")
	}
}

// --- schedules -------------------------------------------------------------

func TestTriggerScheduleFormatsAccepted(t *testing.T) {
	for _, spec := range []string{
		"0 9 * * 1-5",
		"*/15 * * * *",
		"@every 30s",
		"@hourly",
		"@daily",
		"CRON_TZ=America/Los_Angeles 0 9 * * *",
	} {
		if _, err := triggerCronParser(spec); err != nil {
			t.Errorf("schedule %q should parse (one field, both idioms a human reaches for): %v", spec, err)
		}
	}
	for _, spec := range []string{"", "not a cron", "0 9 * *", "@every", "99 99 * * *"} {
		if _, err := triggerCronParser(spec); err == nil {
			t.Errorf("schedule %q parsed; a schedule that cannot fire must be refused at create time", spec)
		}
	}
}

func TestTriggerScheduleUsesLocalTimeByDefault(t *testing.T) {
	sched, err := triggerCronParser("0 9 * * *")
	if err != nil {
		t.Fatal(err)
	}
	// Midnight local. The next 09:00 must be nine hours later IN LOCAL TIME --
	// a human who writes `0 9 * * *` means 9am where they are, not 9am UTC.
	base := time.Date(2026, 3, 2, 0, 0, 0, 0, time.Local)
	next := sched.Next(base)
	if next.Hour() != 9 || next.Location() != time.Local {
		t.Fatalf("next fire is %s; want 09:00 local", next)
	}
}

// TestTriggerMissedFireIsMissedNotCaughtUp is the missed-fire policy, asserted.
//
// A trigger armed at startup computes its next fire from NOW. An occurrence
// that passed while muxterm was down is gone: it is never queued, never run
// late, and -- the part that matters -- a daemon that was off for eight hours
// does not owe 96 lanes when it comes back.
func TestTriggerMissedFireIsMissedNotCaughtUp(t *testing.T) {
	e := newTestTriggerEngine(t)
	stored, err := e.store.Add(Trigger{
		Name: "every minute", Kind: TriggerKindSchedule, Schedule: "@every 1m",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
		// Created (and last fired) eight hours ago: the daemon was down since.
		CreatedAt: time.Now().Add(-8 * time.Hour).Unix(),
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	e.arm(now)

	e.mu.Lock()
	due := e.next[stored.ID]
	e.mu.Unlock()

	if !due.After(now) {
		t.Fatalf("next fire is %s, which is not in the future: a trigger that was down for eight "+
			"hours must not be armed to fire immediately, let alone 480 times", due)
	}
	if due.Sub(now) > 90*time.Second {
		t.Fatalf("next fire is %s away; want roughly one interval from now", due.Sub(now))
	}
}

// --- overlap, caps, failure-disable ---------------------------------------

// TestTriggerOverlapSkipIsRecorded is THE safety proof. A skip that is not
// written down is indistinguishable from a trigger that never fired, which is
// exactly the ambiguity drumbeat recorded as its sharpest lesson -- and which
// loom, which has the check, still has.
func TestTriggerOverlapSkipIsRecorded(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	srv.triggers = newTriggerStore(filepath.Join(t.TempDir(), "triggers.json"))
	e := newTriggerEngine(srv, srv.triggers)

	// A trigger whose last lane is a pane that still exists and has declared
	// nothing: the state every lane is in for its first seconds of life.
	wsID := srv.reg.AddWorkspace("triggered", "")
	paneID := spawnIdlePane(t, srv, wsID)
	stored, err := e.store.Add(Trigger{
		Name: "overlapping", Kind: TriggerKindSchedule, Schedule: "@every 1s",
		Workspace: "triggered", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
		LastWorkspaceID: wsID, LastPaneID: paneID, LastFireAt: time.Now().Unix(), RunCount: 1,
	})
	if err != nil {
		t.Fatal(err)
	}

	running, why := e.laneRunning(stored)
	if !running {
		t.Fatal("a live pane that has declared no state must count as still running: " +
			"the conservative direction is always not to start another")
	}
	if why == "" {
		t.Fatal("the skip reason is empty; a recorded skip with no reason is barely a record")
	}

	e.attemptFire(stored.ID, "test")

	got, _ := e.store.Get(stored.ID)
	if got.RunCount != 1 {
		t.Fatalf("run count moved to %d: the fire was supposed to be SKIPPED, not run", got.RunCount)
	}
	if len(got.History) != 1 || got.History[0].Outcome != FireSkippedOverlap {
		t.Fatalf("history is %+v; want exactly one %s record", got.History, FireSkippedOverlap)
	}
	if got.History[0].Detail == "" {
		t.Fatal("the recorded skip carries no detail; 'skipped' without 'why' does not answer the question")
	}
}

func TestTriggerLaneRunningEndsAtCompletion(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	e := newTriggerEngine(srv, newTriggerStore(filepath.Join(t.TempDir(), "triggers.json")))

	wsID := srv.reg.AddWorkspace("triggered", "")
	paneID := spawnIdlePane(t, srv, wsID)
	tr := Trigger{LastWorkspaceID: wsID, LastPaneID: paneID, LastFireAt: 1000}

	if running, _ := e.laneRunning(tr); !running {
		t.Fatal("pane alive, no completion: should read as running")
	}
	// A completion record is the authoritative end of a lane, and it must win
	// over a pane that is still alive -- which is exactly what a finished /goal
	// loop resuming interactively in the same pane looks like.
	srv.completions.Append(CompletionRecord{
		WorkspaceID: wsID, PaneID: paneID, EndedAt: 2000, Outcome: CompletionCompleted,
	})
	if running, _ := e.laneRunning(tr); running {
		t.Fatal("a completion record for this lane exists and the lane still reads as running: " +
			"a goal lane whose pane outlives its work would wedge its trigger forever")
	}
}

func TestTriggerCompletionMatchIsTimeBounded(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	e := newTriggerEngine(srv, newTriggerStore(filepath.Join(t.TempDir(), "triggers.json")))

	// An OLDER record at the same coordinates. Workspace and pane ids are
	// recycled, most visibly across a restart, so without the time bound this
	// unrelated lane's verdict would be read as this trigger's result.
	srv.completions.Append(CompletionRecord{
		WorkspaceID: "w1", PaneID: 1, EndedAt: 500, Outcome: CompletionFailed,
	})
	tr := Trigger{LastWorkspaceID: "w1", LastPaneID: 1, LastFireAt: 1000}
	if _, found := e.completionFor(tr); found {
		t.Fatal("a completion that ended BEFORE this trigger fired was matched to it; " +
			"recycled ids would staple an unrelated lane's verdict onto this trigger")
	}
}

func TestTriggerDisablesItselfAfterConsecutiveFailures(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	e := newTriggerEngine(srv, newTriggerStore(filepath.Join(t.TempDir(), "triggers.json")))

	stored, err := e.store.Add(Trigger{
		Name: "doomed", Kind: TriggerKindSchedule, Schedule: "@every 1s",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= triggerFailureDisableThreshold; i++ {
		at := int64(1000 * i)
		e.store.Update(stored.ID, func(t *Trigger) {
			t.LastWorkspaceID = "w1"
			t.LastPaneID = i
			t.LastFireAt = at
			t.LastSettled = false
			t.RunCount++
		})
		srv.completions.Append(CompletionRecord{
			WorkspaceID: "w1", PaneID: i, EndedAt: at + 1, Outcome: CompletionFailed,
		})
		e.settle(stored.ID)
	}
	got, _ := e.store.Get(stored.ID)
	if got.Enabled {
		t.Fatalf("still enabled after %d consecutive failures: a trigger firing every five minutes "+
			"into a lane that dies on startup burns money for hours", triggerFailureDisableThreshold)
	}
	if got.DisabledReason == "" {
		t.Fatal("disabled with no reason recorded; the user has to be able to see WHY it stopped")
	}
	last := got.History[len(got.History)-1]
	if last.Outcome != FireDisabled || last.Detail == "" {
		t.Fatalf("the self-disable is not in the fire log (%+v); the reason belongs in the timeline "+
			"next to the failures that caused it", last)
	}
}

func TestTriggerSuccessResetsFailureStreak(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	e := newTriggerEngine(srv, newTriggerStore(filepath.Join(t.TempDir(), "triggers.json")))

	stored, _ := e.store.Add(Trigger{
		Name: "flaky", Kind: TriggerKindSchedule, Schedule: "@every 1s",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
		ConsecutiveFailures: triggerFailureDisableThreshold - 1,
		LastWorkspaceID:     "w1", LastPaneID: 7, LastFireAt: 1000,
	})
	srv.completions.Append(CompletionRecord{
		WorkspaceID: "w1", PaneID: 7, EndedAt: 1001, Outcome: CompletionCompleted,
	})
	e.settle(stored.ID)

	got, _ := e.store.Get(stored.ID)
	if got.ConsecutiveFailures != 0 {
		t.Fatalf("failure streak is %d after a success; a trigger that works most of the time "+
			"is a working trigger and must not be disabled by a transient error", got.ConsecutiveFailures)
	}
	if !got.Enabled {
		t.Fatal("a success disabled the trigger")
	}
}

func TestTriggerMaxRunsDisablesAndRecords(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	e := newTriggerEngine(srv, newTriggerStore(filepath.Join(t.TempDir(), "triggers.json")))

	stored, _ := e.store.Add(Trigger{
		Name: "twice", Kind: TriggerKindSchedule, Schedule: "@every 1s",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
		MaxRuns: 2, RunCount: 2,
	})
	e.attemptFire(stored.ID, "test")

	got, _ := e.store.Get(stored.ID)
	if got.Enabled {
		t.Fatal("still enabled past max_runs; a trigger that has done its work should turn itself " +
			"off rather than report skips forever")
	}
	if got.History[len(got.History)-1].Outcome != FireSkippedMaxRuns {
		t.Fatalf("history is %+v; want a %s record", got.History, FireSkippedMaxRuns)
	}
}

// TestTriggerDisabledDoesNotFire is the disable proof at the decision level.
func TestTriggerDisabledDoesNotFire(t *testing.T) {
	e := newTestTriggerEngine(t)
	stored, _ := e.store.Add(Trigger{
		Name: "off", Kind: TriggerKindSchedule, Schedule: "@every 1s",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: false,
	})
	e.attemptFire(stored.ID, "test")
	got, _ := e.store.Get(stored.ID)
	if got.RunCount != 0 || len(got.History) != 0 {
		t.Fatalf("a disabled trigger did something: runs=%d history=%+v", got.RunCount, got.History)
	}
}

// --- create-time validation ------------------------------------------------

func TestCreateTriggerRefusesBadInput(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	srv.triggers = newTriggerStore(filepath.Join(t.TempDir(), "triggers.json"))
	srv.engine = newTriggerEngine(srv, srv.triggers)

	base := func() Trigger {
		return Trigger{Name: "ok", Kind: TriggerKindSchedule, Schedule: "@every 1h",
			Workspace: "w", Harness: HarnessAmplifier, Prompt: "do a thing", Enabled: true}
	}
	cases := map[string]func(*Trigger){
		"unparseable schedule":  func(t *Trigger) { t.Schedule = "every tuesday-ish" },
		"missing schedule":      func(t *Trigger) { t.Schedule = "" },
		"unknown kind":          func(t *Trigger) { t.Kind = "webhook" },
		"unknown harness":       func(t *Trigger) { t.Harness = "codex" },
		"goal on claude":        func(t *Trigger) { t.Harness = HarnessClaude; t.Goal = "done" },
		"prompt is a command":   func(t *Trigger) { t.Prompt = "/clear" },
		"blank name":            func(t *Trigger) { t.Name = "" },
		"newline in workspace":  func(t *Trigger) { t.Workspace = "a\nb" },
		"negative max_runs":     func(t *Trigger) { t.MaxRuns = -1 },
		"watch without a path":  func(t *Trigger) { t.Kind = TriggerKindWatch; t.Schedule = "" },
		"watch on missing path": func(t *Trigger) { t.Kind = TriggerKindWatch; t.Path = "/no/such/dir" },
	}
	for name, mutate := range cases {
		tr := base()
		mutate(&tr)
		if _, err := srv.CreateTrigger(tr); err == nil {
			t.Errorf("%s: accepted; a trigger acts with nobody watching, so the moment someone "+
				"IS present is the moment to refuse a bad one", name)
		}
	}
	if got := len(srv.ListTriggers()); got != 0 {
		t.Fatalf("%d refused triggers were stored anyway", got)
	}
}

func TestSetTriggerEnabledClearsSelfDisable(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	srv.triggers = newTriggerStore(filepath.Join(t.TempDir(), "triggers.json"))
	srv.engine = newTriggerEngine(srv, srv.triggers)

	view, err := srv.CreateTrigger(Trigger{
		Name: "recovering", Kind: TriggerKindSchedule, Schedule: "@every 1h",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	srv.triggers.Update(view.ID, func(t *Trigger) {
		t.Enabled = false
		t.DisabledReason = "3 consecutive failed runs"
		t.ConsecutiveFailures = 3
	})
	back, err := srv.SetTriggerEnabled(view.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if back.DisabledReason != "" || back.ConsecutiveFailures != 0 {
		t.Fatalf("re-enabling left reason=%q failures=%d; a human turning it back on is a statement "+
			"that the failures were understood, and keeping the count disables it again on the next one",
			back.DisabledReason, back.ConsecutiveFailures)
	}
	if back.NextFireAt <= time.Now().Unix() {
		t.Fatal("re-enabling did not arm a future fire")
	}
}

func TestDeleteTriggerIsImmediate(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	srv.triggers = newTriggerStore(filepath.Join(t.TempDir(), "triggers.json"))
	srv.engine = newTriggerEngine(srv, srv.triggers)

	view, err := srv.CreateTrigger(Trigger{
		Name: "temporary", Kind: TriggerKindWatch, Path: t.TempDir(),
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.DeleteTrigger(view.ID); err != nil {
		t.Fatal(err)
	}
	if got := len(srv.ListTriggers()); got != 0 {
		t.Fatalf("%d triggers remain after delete", got)
	}
	srv.engine.mu.Lock()
	watchers := len(srv.engine.watchers)
	srv.engine.mu.Unlock()
	if watchers != 0 {
		t.Fatalf("%d filesystem watches survived the delete; delete must be effective immediately", watchers)
	}
	if err := srv.DeleteTrigger(view.ID); err == nil {
		t.Fatal("deleting a trigger twice succeeded; the second call should say it is not there")
	}
}

// --- file watching ---------------------------------------------------------

func TestTriggerWatchSkipsIgnoredDirsDuringTheWalk(t *testing.T) {
	root := t.TempDir()
	for _, d := range []string{"src", "src/deep", ".git", ".git/objects", "node_modules", "node_modules/pkg"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	dirs, err := triggerWatchDirs(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dirs {
		rel, _ := filepath.Rel(root, d)
		if rel == ".git" || rel == "node_modules" ||
			filepath.HasPrefix(rel, ".git/") || filepath.HasPrefix(rel, "node_modules/") {
			t.Errorf("%s is watched; ignored directories must be skipped during the WALK so they "+
				"never consume a watch descriptor", rel)
		}
	}
	if len(dirs) != 3 { // root, src, src/deep
		t.Fatalf("watching %d directories %v, want 3", len(dirs), dirs)
	}
}

func TestTriggerWatchRefusesTreesTooLargeToWatch(t *testing.T) {
	root := t.TempDir()
	for i := 0; i <= triggerWatchDirCap+1; i++ {
		if err := os.Mkdir(filepath.Join(root, "d"+strconv.Itoa(i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_, err := triggerWatchDirs(root)
	if err == nil {
		t.Fatal("a tree past the watch cap was accepted; half-watching is a trigger that silently " +
			"never fires for half its paths, and exhausting inotify breaks other software on the machine")
	}
	if !strings.Contains(err.Error(), "inotify") || !strings.Contains(err.Error(), "subdirectory") {
		t.Fatalf("the refusal does not explain itself or say what to do instead: %v", err)
	}
}

func TestTriggerWatchIgnoresEditorNoise(t *testing.T) {
	noisy := []string{
		"/repo/.git/index.lock", "/repo/node_modules/x/y.js", "/repo/4913",
		"/repo/file.swp", "/repo/file~", "/repo/.#file", "/repo/.DS_Store", "/repo/x.tmp",
	}
	for _, p := range noisy {
		if !triggerWatchIgnoreFile(p) {
			t.Errorf("%s is not ignored; one editor save would fire the trigger several times", p)
		}
	}
	for _, p := range []string{"/repo/main.go", "/repo/src/app.tsx", "/repo/README.md"} {
		if triggerWatchIgnoreFile(p) {
			t.Errorf("%s is ignored; that is a real change", p)
		}
	}
}

// TestTriggerWatchDebounceCoalescesABurst is the debounce proof: a burst of
// events becomes ONE fire, not one per event.
func TestTriggerWatchDebounceCoalescesABurst(t *testing.T) {
	root := t.TempDir()
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	e := newTriggerEngine(srv, newTriggerStore(filepath.Join(t.TempDir(), "triggers.json")))

	stored, err := e.store.Add(Trigger{
		Name: "on change", Kind: TriggerKindWatch, Path: root,
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	e.ensureWatcher(stored)
	defer e.closeWatchers()

	// A burst: fifty writes, the shape of a build or a `git checkout`.
	for i := 0; i < 50; i++ {
		if err := os.WriteFile(filepath.Join(root, "f"+strconv.Itoa(i)+".txt"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// Nothing may arrive before the quiet window elapses.
	select {
	case id := <-e.fireCh:
		t.Fatalf("trigger %s fired during the burst; the debounce is supposed to wait for quiet", id)
	case <-time.After(triggerWatchDebounce / 2):
	}

	select {
	case id := <-e.fireCh:
		if id != stored.ID {
			t.Fatalf("fired for %q, want %q", id, stored.ID)
		}
	case <-time.After(triggerWatchDebounce * 3):
		t.Fatal("the watch never fired after the burst went quiet")
	}
	// And exactly once: fifty writes are one change, not fifty lanes.
	select {
	case <-e.fireCh:
		t.Fatal("a second fire followed the burst; fifty writes must coalesce into ONE lane")
	case <-time.After(triggerWatchDebounce + 500*time.Millisecond):
	}
}

// --- helpers ---------------------------------------------------------------

func spawnIdlePane(t *testing.T, srv *Server, wsID string) int {
	t.Helper()
	id, ok := srv.reg.AllocPaneID(wsID)
	if !ok {
		t.Fatal("AllocPaneID")
	}
	p, err := NewPane(id, []string{"sleep", "60"}, 80, 24, nil,
		func(int, []byte) {}, func(int, int, int64) {}, func(int, *Message) {}, "")
	if err != nil {
		t.Fatalf("NewPane: %v", err)
	}
	t.Cleanup(p.Close)
	srv.reg.PutPane(wsID, p)
	return id
}

// TestTriggerForgetsLastLaneAcrossRestart is a regression test for a bug found
// by running the thing, not by reading it.
//
// Workspace and pane ids are RECYCLED across a restart. Live: a trigger's lane
// ran in w3 pane 1, the daemon restarted, the restore pass rebuilt workspaces
// in a different order, and w3 pane 1 came back as an unrelated lane belonging
// to a different trigger. The overlap check saw a live pane at those
// coordinates and skipped every subsequent fire -- wedged indefinitely by a
// stranger, with a skip reason that read perfectly plausibly.
func TestTriggerForgetsLastLaneAcrossRestart(t *testing.T) {
	srv, _, _, cancel := startTestServer(t)
	defer cancel()
	e := newTriggerEngine(srv, newTriggerStore(filepath.Join(t.TempDir(), "triggers.json")))

	// A lane that was running when the daemon went down: coordinates recorded,
	// unsettled, and no completion record will ever arrive for it.
	stored, err := e.store.Add(Trigger{
		Name: "survivor", Kind: TriggerKindSchedule, Schedule: "@every 1s",
		Workspace: "w", Harness: HarnessAmplifier, Prompt: "p", Enabled: true,
		LastWorkspaceID: "w3", LastPaneID: 1, LastFireAt: time.Now().Unix(), RunCount: 1,
		ConsecutiveFailures: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	// A DIFFERENT lane now occupies those exact coordinates.
	wsID := srv.reg.AddWorkspace("someone else's work", "")
	if wsID != "w3" {
		// Not the point of the test, but keep it honest about what it set up.
		t.Logf("registry handed out %s rather than w3; the pane below is still an unrelated one", wsID)
	}
	spawnIdlePane(t, srv, wsID)

	e.reconcileAfterRestart()

	got, _ := e.store.Get(stored.ID)
	if got.LastWorkspaceID != "" || got.LastPaneID != 0 {
		t.Fatalf("last-lane coordinates survived the restart (%s pane %d); a stranger at those ids "+
			"wedges this trigger forever, and no completion record will ever arrive to free it",
			got.LastWorkspaceID, got.LastPaneID)
	}
	if running, why := e.laneRunning(got); running {
		t.Fatalf("still reads as running after reconcile: %s", why)
	}
	if got.ConsecutiveFailures != 1 {
		t.Fatalf("failure streak changed to %d; an unaccounted run is neither a success nor a "+
			"failure and the daemon must not invent a verdict in either direction", got.ConsecutiveFailures)
	}
	last := got.History[len(got.History)-1]
	if last.Outcome != FireOrphaned || last.Detail == "" {
		t.Fatalf("the unaccounted run is not in the fire log (%+v); a run nobody can account for "+
			"and a run that produced nothing look identical unless one of them says so", last)
	}
}
