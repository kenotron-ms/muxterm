package missioncontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/cos"
)

const (
	defaultTextWorkerCap = 4
	maxJournalEvents     = 512
	maxJournalBytes      = 2 << 20
)

var ErrWorkerCap = errors.New("missioncontrol: text worker capacity reached")

// Runtime is one independently rooted sidecar. Browser contexts are never
// parents of it: Router owns the process lifetime until safe eviction/Close.
type Runtime struct {
	Thread     Thread
	Supervisor *cos.Supervisor
	ownerLock  *os.File
	store      *Store

	opMu sync.Mutex // serializes sidecar snapshot/control against new admission
	mu   sync.Mutex

	listeners       map[uint64]chan RuntimeEvent
	listenerID      uint64
	submissions     map[string]submission
	approvals       map[string]string // approval id -> originating turn id
	journal         []RuntimeEvent
	journalSize     int
	journalGap      bool
	replyBoundaries map[string]snapshotBoundary
	lastUsed        time.Time
	lastEventSeq    uint64
	closed          bool
	closeOnce       sync.Once
}

// snapshotBoundary is copied on the ordered sidecar reader immediately before
// the snapshot reply wakes Runtime.Snapshot. It is deliberately independent of
// later reader events: the caller must never use a post-reply journal/sequence
// with pre-reply canonical history.
type snapshotBoundary struct {
	threadSeq               uint64
	journal                 []RuntimeEvent
	replaySuppressedTurnIDs []string
	gap                     bool
	queue                   cos.QueueState
}

type submission struct {
	clientRef string
	prompt    string
	requestID string
}

// RuntimeEvent is assigned before the sidecar broker fan-out. It has a
// thread-local durable sequence and cannot be reattributed from focus.
type RuntimeEvent struct {
	EventID   string          `json:"event_id"`
	ThreadSeq uint64          `json:"thread_seq"`
	Raw       json.RawMessage `json:"event"`
}

type TurnState struct {
	TurnID string `json:"turn_id"`
	Status string `json:"status"` // active|queued
}

type Snapshot struct {
	History        json.RawMessage `json:"history"`
	Active         *TurnState      `json:"active,omitempty"`
	Pending        []TurnState     `json:"pending"`
	ThreadSeq      uint64          `json:"thread_seq"`
	CoveredTurnIDs []string        `json:"covered_turn_ids"`
	// ReplaySuppressedTurnIDs identifies persisted terminal turns present in
	// the ordered event cut but not necessarily identity-bound in history
	// (for example structurally ambiguous canonical groups). Consumers must
	// consume their event identity/sequence but not render them again.
	ReplaySuppressedTurnIDs []string        `json:"replay_suppressed_turn_ids,omitempty"`
	ReplayEvents            []RuntimeEvent  `json:"replay_events"`
	Gap                     bool            `json:"gap"`
	Todo                    json.RawMessage `json:"todo,omitempty"`
	Goal                    json.RawMessage `json:"goal,omitempty"`
	Context                 json.RawMessage `json:"context,omitempty"`
}

type Router struct {
	store            *Store
	ctx              context.Context
	cancel           context.CancelFunc
	cap              int
	contextMaxTokens int
	mu               sync.Mutex
	runtimes         map[string]*Runtime
	closing          map[string]struct{}
	closed           bool
}

func NewRouter(store *Store, cap int, contextMaxTokens int) *Router {
	if cap <= 0 {
		cap = defaultTextWorkerCap
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Router{store: store, ctx: ctx, cancel: cancel, cap: cap, contextMaxTokens: contextMaxTokens, runtimes: make(map[string]*Runtime), closing: make(map[string]struct{})}
}

func runtimeDirectory(sessionID string) string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(base, "muxterm", "missioncontrol", "runtimes", sessionID)
}

func RuntimeOwnerLockPath(sessionID string) string {
	return filepath.Join(runtimeDirectory(sessionID), "owner.lock")
}

func storageCWD() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("missioncontrol: resolve storage cwd: %w", err)
	}
	return filepath.Abs(cwd)
}

// Ensure deliberately accepts no browser context. A disconnect only cancels
// the caller's wait; admitted queue work remains attached to Router.ctx.
func (r *Router) Ensure(threadID string) (*Runtime, error) {
	for {
		r.mu.Lock()
		if r.closed {
			r.mu.Unlock()
			return nil, errors.New("missioncontrol: runtime router is closed")
		}
		if _, closing := r.closing[threadID]; closing {
			r.mu.Unlock()
			return nil, errors.New("missioncontrol: runtime is closing")
		}
		if runtime := r.runtimes[threadID]; runtime != nil {
			if runtime.Supervisor.Status().LastError == "" {
				r.mu.Unlock()
				runtime.touch()
				return runtime, nil
			}
			// A fatal threaded supervisor cannot continue any queued work. Its
			// admissions remain unknown, but explicit reselection is permitted to
			// create a new generation; it never replays the old queue.
			r.detachRuntimeLocked(threadID)
			r.mu.Unlock()
			r.closeRuntime(runtime)
			r.finishClose(threadID)
			continue
		}
		if len(r.runtimes) >= r.cap {
			candidate := r.evictOneLocked()
			if candidate == nil {
				r.mu.Unlock()
				return nil, ErrWorkerCap
			}
			r.mu.Unlock()
			r.closeRuntime(candidate)
			r.finishClose(candidate.Identity().ID)
			continue
		}
		cwd, err := storageCWD()
		if err != nil {
			r.mu.Unlock()
			return nil, err
		}
		thread, err := r.store.EnsureRuntime(threadID, cwd)
		if err != nil {
			r.mu.Unlock()
			return nil, err
		}
		thread, err = r.store.BeginRuntime(threadID)
		if err != nil {
			r.mu.Unlock()
			return nil, err
		}
		if err := os.MkdirAll(filepath.Dir(thread.StatusPath), 0o700); err != nil {
			r.mu.Unlock()
			return nil, fmt.Errorf("missioncontrol: create runtime directory: %w", err)
		}
		ownerLock, err := os.OpenFile(RuntimeOwnerLockPath(thread.RuntimeSessionID), os.O_RDWR|os.O_CREATE, 0o600)
		if err != nil {
			r.mu.Unlock()
			return nil, fmt.Errorf("missioncontrol: open runtime owner lock: %w", err)
		}
		if err := syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			_ = ownerLock.Close()
			r.mu.Unlock()
			return nil, fmt.Errorf("missioncontrol: runtime %s already has an owner: %w", thread.RuntimeSessionID, err)
		}
		runtime := &Runtime{
			Thread: thread, ownerLock: ownerLock, store: r.store, lastUsed: time.Now(),
				lastEventSeq: thread.LastEventSeq,
			listeners: make(map[uint64]chan RuntimeEvent), submissions: make(map[string]submission),
			approvals: make(map[string]string), replyBoundaries: make(map[string]snapshotBoundary),
		}
		runtime.Supervisor = cos.New(cos.Config{
			SessionID: thread.RuntimeSessionID, Cwd: thread.StorageCWD,
			StatePath: thread.StatusPath, InstructionPath: thread.InstructionPath,
			ThreadedTextPreview: true, ThreadKind: thread.Kind, OwnerLockFile: ownerLock,
			ThreadJournalPath:      thread.JournalPath,
			ThreadContextMaxTokens: r.contextMaxTokens,
			EventObserver:          runtime.onSidecarEvent,
			BeforeReply:            runtime.captureReplyBoundary,
		})
		if err := runtime.Supervisor.Start(r.ctx); err != nil {
			_ = syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_UN)
			_ = ownerLock.Close()
			r.mu.Unlock()
			return nil, err
		}
		r.runtimes[threadID] = runtime
		r.mu.Unlock()
		return runtime, nil
	}
}

func (r *Router) Runtime(threadID string) *Runtime {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runtimes[threadID]
}

// Archive closes only this router's idle root and retains all immutable
// session/transcript references in the catalog.
func (r *Router) Archive(threadID string) (Thread, error) {
	r.mu.Lock()
	thread, _, found, err := r.store.Thread(threadID)
	if err != nil || !found {
		r.mu.Unlock()
		return Thread{}, errors.New("missioncontrol: unknown thread")
	}
	if thread.Kind == "lobby" {
		r.mu.Unlock()
		return Thread{}, errors.New("missioncontrol: the Lobby cannot be archived")
	}
	if _, closing := r.closing[threadID]; closing {
		r.mu.Unlock()
		return Thread{}, errors.New("missioncontrol: runtime is closing")
	}
	if runtime := r.runtimes[threadID]; runtime != nil {
		if !runtime.closeIfSafe() {
			r.mu.Unlock()
			return Thread{}, errors.New("missioncontrol: archive requires an idle persisted runtime with no approvals")
		}
		r.detachRuntimeLocked(threadID)
		r.mu.Unlock()
		r.closeRuntime(runtime)
		defer r.finishClose(threadID)
		return r.store.Archive(threadID)
	}
	r.mu.Unlock()
	return r.store.Archive(threadID)
}

// Reset closes only an idle safe root then rotates to a fresh session UUID.
func (r *Router) Reset(threadID string) (Thread, error) {
	r.mu.Lock()
	runtime := r.runtimes[threadID]
	if runtime == nil || !runtime.closeIfSafe() {
		r.mu.Unlock()
		return Thread{}, errors.New("missioncontrol: reset requires an idle persisted runtime with no approvals")
	}
	r.detachRuntimeLocked(threadID)
	r.mu.Unlock()
	r.closeRuntime(runtime)
	defer r.finishClose(threadID)
	return r.store.ResetRuntime(threadID)
}

func (r *Router) evictOneLocked() *Runtime {
	for {
		var candidate *Runtime
		for _, runtime := range r.runtimes {
			if runtime.SafeEvict() && (candidate == nil || runtime.lastUse().Before(candidate.lastUse())) {
				candidate = runtime
			}
		}
		if candidate == nil {
			return nil
		}
		if !candidate.closeIfSafe() {
			continue
		}
		r.detachRuntimeLocked(candidate.Identity().ID)
		return candidate
	}
}

func (r *Router) detachRuntimeLocked(threadID string) {
	delete(r.runtimes, threadID)
	r.closing[threadID] = struct{}{}
}

func (r *Router) finishClose(threadID string) {
	r.mu.Lock()
	delete(r.closing, threadID)
	r.mu.Unlock()
}

func (r *Router) Close() {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.cancel()
	runtimes := r.runtimes
	r.runtimes = map[string]*Runtime{}
	r.mu.Unlock()
	for _, runtime := range runtimes {
		r.closeRuntime(runtime)
	}
}

func (r *Router) closeRuntime(runtime *Runtime) {
	runtime.closeOnce.Do(func() {
		// Block new controls and detach every browser stream before Supervisor.Close
		// can synchronously publish queue-failure callbacks. publishLocked and
		// unsubscribe both hold mu, so no sender can race a closed listener.
		runtime.beginClose()

		_ = runtime.Supervisor.Close()
		if runtime.ownerLock != nil {
			_ = syscall.Flock(int(runtime.ownerLock.Fd()), syscall.LOCK_UN)
			_ = runtime.ownerLock.Close()
		}
	})
}

func (r *Runtime) touch() {
	r.mu.Lock()
	r.lastUsed = time.Now()
	r.mu.Unlock()
}

func (r *Runtime) lastUse() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.lastUsed
}

// Identity returns one lock-protected runtime snapshot. Event sequencing is
// kept separately under mu, so callers cannot race a live sequence update by
// copying Thread.
func (r *Runtime) Identity() Thread {
	r.mu.Lock()
	defer r.mu.Unlock()
	thread := r.Thread
	thread.LastEventSeq = r.lastEventSeq
	return thread
}

func (r *Runtime) SafeEvict() bool {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	if !r.Supervisor.Idle() || r.store.HasNonterminalAdmission(r.Thread.ID, r.Thread.RuntimeGeneration) {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.closed && len(r.approvals) == 0
}

// closeIfSafe claims an idle root before Router removes it. Holding opMu across
// the safety check and closed transition prevents a request that already holds
// a Runtime pointer from submitting between eviction selection and shutdown.
func (r *Runtime) closeIfSafe() bool {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	if !r.Supervisor.Idle() || r.store.HasNonterminalAdmission(r.Thread.ID, r.Thread.RuntimeGeneration) {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || len(r.approvals) != 0 {
		return false
	}
	r.closed = true
	r.closeListenersLocked()
	return true
}

func (r *Runtime) beginClose() {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	r.closeListenersLocked()
}

// closeListenersLocked closes every listener while holding the same mutex used
// by publishLocked and unsubscribe, so no send can target a closed channel.
func (r *Runtime) closeListenersLocked() {
	for id, listener := range r.listeners {
		delete(r.listeners, id)
		close(listener)
	}
}

func (r *Runtime) Submit(requestID, prompt, clientRef string) (*cos.Turn, error) {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return nil, errors.New("missioncontrol: runtime is closed")
	}
	if r.Thread.Kind == "lobby" {
		records, err := r.store.Summaries(maxSummaries)
		if err != nil {
			return nil, err
		}
		if err := r.Supervisor.SetLobbySummaries(records); err != nil {
			return nil, err
		}
	}
	turnID := r.Supervisor.ReserveTurnID()
	if _, err := r.store.MarkDispatched(requestID, r.Thread.ID, r.Thread.RuntimeGeneration, turnID); err != nil {
		return nil, err
	}
	turn := r.Supervisor.SubmitWithID(prompt, turnID)
	r.mu.Lock()
	r.submissions[turn.ID] = submission{clientRef: clientRef, prompt: prompt, requestID: requestID}
	r.lastUsed = time.Now()
	r.mu.Unlock()
	_, _ = r.store.RecordAttention("pending:"+r.Thread.ID+":"+fmt.Sprint(r.Thread.RuntimeGeneration)+":"+turn.ID, r.Thread.ID, r.Thread.RuntimeGeneration, turn.ID, "pending")
	return turn, nil
}

func (r *Runtime) Cancel(turnID string) error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return errors.New("missioncontrol: runtime is closed")
	}
	if turnID == "" {
		return errors.New("missioncontrol: cancel requires an exact turn ID")
	}
	return r.Supervisor.CancelSpecific(turnID)
}

func (r *Runtime) Approve(turnID, approvalID string, approved bool) error {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return errors.New("missioncontrol: runtime is closed")
	}
	r.mu.Lock()
	boundTurn, ok := r.approvals[approvalID]
	r.mu.Unlock()
	if !ok || boundTurn != turnID {
		return errors.New("missioncontrol: approval is not pending for this turn")
	}
	return r.Supervisor.Approve(approvalID, approved, "answered in Mission Control text preview")
}

func (r *Runtime) Subscribe(depth int) (<-chan RuntimeEvent, func()) {
	if depth <= 0 {
		depth = 512
	}
	ch := make(chan RuntimeEvent, depth)
	r.mu.Lock()
	if r.closed {
		close(ch)
		r.mu.Unlock()
		return ch, func() {}
	}
	r.listenerID++
	id := r.listenerID
	r.listeners[id] = ch
	r.mu.Unlock()
	var once sync.Once
	return ch, func() {
		once.Do(func() {
			r.mu.Lock()
			if current, ok := r.listeners[id]; ok {
				delete(r.listeners, id)
				close(current)
			}
			r.mu.Unlock()
		})
	}
}

// Snapshot is an ordered sidecar emission cut: the sidecar answers snapshot on
// its ordered stdin/stdout protocol; EventObserver journals every preceding
// event before that reply is delivered. New Submit calls hold opMu behind it.
func (r *Runtime) Snapshot(ctx context.Context, limit int) (Snapshot, error) {
	// A cold root is still preparing real modules. Bound only this caller's
	// wait by the browser context; the router retains ownership of the process.
	if _, err := r.Supervisor.WaitReady(ctx); err != nil {
		return Snapshot{}, err
	}
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return Snapshot{}, errors.New("missioncontrol: runtime is closed")
	}
	ev, err := r.Supervisor.Snapshot(limit)
	if err != nil {
		return Snapshot{}, err
	}
	r.mu.Lock()
	boundary, ok := r.replyBoundaries[ev.ReqID]
	delete(r.replyBoundaries, ev.ReqID)
	r.mu.Unlock()
	if !ok {
		return Snapshot{}, errors.New("missioncontrol: snapshot reply has no ordered runtime boundary")
	}
	var sidecar struct {
		History      json.RawMessage `json:"history"`
		ActiveTurnID string          `json:"active_turn_id"`
		Todo         json.RawMessage `json:"todo"`
		Goal         json.RawMessage `json:"goal"`
		Context      json.RawMessage `json:"context"`
	}
	if err := json.Unmarshal(ev.Snapshot, &sidecar); err != nil {
		return Snapshot{}, fmt.Errorf("missioncontrol: invalid sidecar snapshot: %w", err)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastUsed = time.Now()
	snapshot := Snapshot{
		History: sidecar.History, ThreadSeq: boundary.threadSeq,
		ReplayEvents: append([]RuntimeEvent(nil), boundary.journal...), Gap: boundary.gap,
		Todo: sidecar.Todo, Goal: sidecar.Goal,
		Context:                 sidecar.Context,
		Pending:                 make([]TurnState, 0, len(boundary.queue.PendingTurnIDs)),
		CoveredTurnIDs:          make([]string, 0),
		ReplaySuppressedTurnIDs: append([]string(nil), boundary.replaySuppressedTurnIDs...),
	}
	if sidecar.ActiveTurnID != "" {
		snapshot.Active = &TurnState{TurnID: sidecar.ActiveTurnID, Status: "active"}
	}
	for _, turnID := range boundary.queue.PendingTurnIDs {
		snapshot.Pending = append(snapshot.Pending, TurnState{TurnID: turnID, Status: "queued"})
	}
	if boundary.queue.ActiveTurnID != "" && sidecar.ActiveTurnID != "" && boundary.queue.ActiveTurnID != sidecar.ActiveTurnID {
		snapshot.Gap = true
	}
	var historyTurns []struct {
		TurnID string `json:"turn_id"`
	}
	if err := json.Unmarshal(sidecar.History, &historyTurns); err != nil {
		return Snapshot{}, fmt.Errorf("missioncontrol: invalid sidecar snapshot history: %w", err)
	}
	for _, turn := range historyTurns {
		if turn.TurnID != "" {
			snapshot.CoveredTurnIDs = append(snapshot.CoveredTurnIDs, turn.TurnID)
		}
	}
	r.pruneSnapshotJournalLocked(snapshot.CoveredTurnIDs, snapshot.ReplaySuppressedTurnIDs)
	return snapshot, nil
}

// captureReplyBoundary runs on Supervisor's single stdout reader. It must
// remain short and must not call back into Supervisor: QueueState was already
// copied before the callback. Snapshot's opMu makes at most one matching
// snapshot requester per runtime.
func (r *Runtime) captureReplyBoundary(event cos.Event, queue cos.QueueState) {
	if event.Ev != cos.EvSnapshot || event.ReqID == "" {
		return
	}
	r.mu.Lock()
	r.replyBoundaries[event.ReqID] = snapshotBoundary{
		threadSeq:               r.lastEventSeq,
		journal:                 append([]RuntimeEvent(nil), r.journal...),
		replaySuppressedTurnIDs: persistedTerminalTurnIDs(r.journal),
		gap:                     r.journalGap,
		queue:                   queue,
	}
	r.mu.Unlock()
}

func (r *Runtime) onSidecarEvent(event cos.Event) {
	if event.Ev == cos.EvHistory || event.Ev == cos.EvSnapshot || event.Ev == cos.EvConfig || event.Ev == cos.EvCleared {
		return
	}
	raw := event.Raw
	if len(raw) == 0 {
		raw, _ = json.Marshal(event)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if event.TurnID != "" && (event.Ev == cos.EvTurnStart || event.Ev == cos.EvError) {
		raw = r.decorateLocked(raw, event.TurnID)
	}
	if event.Ev == cos.EvApprovalRequest && event.RequestID != "" && event.TurnID != "" {
		r.approvals[event.RequestID] = event.TurnID
		_, _ = r.store.RecordAttention("approval:"+r.Thread.ID+":"+fmt.Sprint(r.Thread.RuntimeGeneration)+":"+event.RequestID, r.Thread.ID, r.Thread.RuntimeGeneration, event.TurnID, "approval")
	}
	if event.IsTerminal() {
		for approvalID, boundTurnID := range r.approvals {
			if boundTurnID == event.TurnID {
				delete(r.approvals, approvalID)
			}
		}
		_ = r.store.MarkTerminal(r.Thread.ID, r.Thread.RuntimeGeneration, event.TurnID, event.Persisted)
		kind := "terminal"
		if event.Ev == cos.EvError || event.Code != "" {
			kind = "error"
		}
		_, _ = r.store.RecordAttention(kind+":"+r.Thread.ID+":"+fmt.Sprint(r.Thread.RuntimeGeneration)+":"+event.TurnID, r.Thread.ID, r.Thread.RuntimeGeneration, event.TurnID, kind)
		if event.Persisted && event.Ev == cos.EvTurnEnd {
			if extract := boundedTerminalExtract(event.Response); extract != "" {
				_ = r.store.RecordSummary(r.Thread.ID, r.Thread.RuntimeSessionID, r.Thread.RuntimeGeneration, event.TurnID, extract)
			}
		}
		delete(r.submissions, event.TurnID)
	}
	r.publishLocked(raw)
}

func boundedTerminalExtract(value string) string {
	value = strings.TrimSpace(value)
	if len(value) > maxSummaryChars {
		value = value[:maxSummaryChars]
	}
	return value
}

func persistedTerminalTurnIDs(events []RuntimeEvent) []string {
	ids := make([]string, 0)
	seen := make(map[string]struct{})
	for _, runtimeEvent := range events {
		event, err := cos.ParseEvent(runtimeEvent.Raw)
		if err != nil || !event.IsTerminal() || !event.Persisted || event.TurnID == "" {
			continue
		}
		if _, duplicate := seen[event.TurnID]; duplicate {
			continue
		}
		seen[event.TurnID] = struct{}{}
		ids = append(ids, event.TurnID)
	}
	return ids
}

// pruneSnapshotJournalLocked reclaims only terminal turn events whose
// canonical/replay treatment was established by this completed snapshot cut.
// A completed-but-identity-ambiguous canonical group is deliberately
// suppressed rather than falsely added to covered_turn_ids.
func (r *Runtime) pruneSnapshotJournalLocked(covered, suppressed []string) {
	if len(covered) == 0 && len(suppressed) == 0 {
		return
	}
	coveredSet := make(map[string]struct{}, len(covered)+len(suppressed))
	for _, turnID := range covered {
		coveredSet[turnID] = struct{}{}
	}
	for _, turnID := range suppressed {
		coveredSet[turnID] = struct{}{}
	}
	kept := r.journal[:0]
	size := 0
	for _, event := range r.journal {
		var fields struct {
			TurnID string `json:"turn_id"`
		}
		if json.Unmarshal(event.Raw, &fields) == nil {
			if _, ok := coveredSet[fields.TurnID]; ok {
				continue
			}
		}
		kept = append(kept, event)
		size += len(event.Raw)
	}
	r.journal = kept
	r.journalSize = size
}

func (r *Runtime) publishLocked(raw json.RawMessage) {
	seq, err := r.store.NextEventSeq(r.Thread.ID)
	if err != nil {
		return
	}
	out := RuntimeEvent{EventID: uuid.New().String(), ThreadSeq: seq, Raw: raw}
	r.lastEventSeq = seq
	if r.journalGap || len(r.journal) >= maxJournalEvents || r.journalSize+len(raw) > maxJournalBytes {
		r.journalGap = true
	} else {
		r.journal = append(r.journal, out)
		r.journalSize += len(raw)
	}
	for _, listener := range r.listeners {
		select {
		case listener <- out:
		default:
			r.journalGap = true
		}
	}
}

func (r *Runtime) decorateLocked(raw json.RawMessage, turnID string) json.RawMessage {
	sub, ok := r.submissions[turnID]
	if !ok {
		return raw
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return raw
	}
	if sub.clientRef != "" {
		fields["client_ref"], _ = json.Marshal(sub.clientRef)
	}
	if sub.prompt != "" {
		fields["prompt"], _ = json.Marshal(sub.prompt)
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}

func sortedTurnIDs(values map[string]submission) []string {
	out := make([]string, 0, len(values))
	for id := range values {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}
