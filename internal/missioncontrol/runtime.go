package missioncontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/cos"
)

// Runtime is one independent sidecar root and its supervisor. It owns no
// browser selection state; callers may subscribe after they select another
// thread so late results keep their originating identity.
type Runtime struct {
	Thread     Thread
	Supervisor *cos.Supervisor
	ownerLock  *os.File
	store      *Store

	mu          sync.Mutex
	listeners   map[uint64]chan RuntimeEvent
	listenerID  uint64
	submissions map[string]submission
}

type submission struct {
	clientRef string
	prompt    string
	requestID string
}

// RuntimeEvent is sequenced once at the originating root and then fanned out
// to all late subscribers. It is never attributed from terminal navigation.
type RuntimeEvent struct {
	EventID   string
	ThreadSeq uint64
	Raw       json.RawMessage
}

// Router owns all in-process threaded roots. The catalog lock makes another
// server fail closed, while unique persisted session IDs prevent roots from
// sharing a SessionStore transcript.
type Router struct {
	store    *Store
	mu       sync.Mutex
	runtimes map[string]*Runtime
	closed   bool
}

func NewRouter(store *Store) *Router {
	return &Router{store: store, runtimes: make(map[string]*Runtime)}
}

func runtimeDirectory(sessionID string) string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(base, "muxterm", "missioncontrol", "runtimes", sessionID)
}

// RuntimeOwnerLockPath is keyed by the persisted runtime UUID and shared with
// the CLI second-writer guard.
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

// Ensure starts the particular thread's root, never a shared COS root.
func (r *Router) Ensure(ctx context.Context, threadID string) (*Runtime, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, errors.New("missioncontrol: runtime router is closed")
	}
	if runtime := r.runtimes[threadID]; runtime != nil {
		if runtime.Supervisor.Status().LastError == "" {
			return runtime, nil
		}
		// A threaded supervisor never auto-restarts. This explicit Ensure is
		// reached only by a new select, so rotate before recreating a root and
		// make old connection drafts fail their generation fence.
		r.closeRuntime(runtime)
		delete(r.runtimes, threadID)
		if _, err := r.store.RotateRuntimeGeneration(threadID); err != nil {
			return nil, err
		}
	}
	cwd, err := storageCWD()
	if err != nil {
		return nil, err
	}
	// Paths are persisted with the UUID root before it starts and then held fixed.
	thread, err := r.store.EnsureRuntime(threadID, cwd)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(thread.StatusPath), 0o700); err != nil {
		return nil, fmt.Errorf("missioncontrol: create runtime directory: %w", err)
	}
	ownerLock, err := os.OpenFile(RuntimeOwnerLockPath(thread.RuntimeSessionID), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("missioncontrol: open runtime owner lock: %w", err)
	}
	if err := syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = ownerLock.Close()
		return nil, fmt.Errorf("missioncontrol: runtime %s already has an owner: %w", thread.RuntimeSessionID, err)
	}
	sup := cos.New(cos.Config{
		SessionID:           thread.RuntimeSessionID,
		Cwd:                 thread.StorageCWD,
		StatePath:           thread.StatusPath,
		InstructionPath:     thread.InstructionPath,
		ThreadedTextPreview: true,
		ThreadKind:          thread.Kind,
		OwnerLockFile:       ownerLock,
	})
	if err := sup.Start(ctx); err != nil {
		_ = syscall.Flock(int(ownerLock.Fd()), syscall.LOCK_UN)
		_ = ownerLock.Close()
		return nil, err
	}
	runtime := &Runtime{
		Thread: thread, Supervisor: sup, ownerLock: ownerLock, store: r.store,
		listeners:   make(map[uint64]chan RuntimeEvent),
		submissions: make(map[string]submission),
	}
	r.runtimes[threadID] = runtime
	go runtime.pump()
	return runtime, nil
}

func (r *Router) Runtime(threadID string) *Runtime {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runtimes[threadID]
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
	runtimes := r.runtimes
	r.runtimes = map[string]*Runtime{}
	r.mu.Unlock()
	for _, runtime := range runtimes {
		r.closeRuntime(runtime)
	}
}

func (r *Router) closeRuntime(runtime *Runtime) {
	_ = runtime.Supervisor.Close()
	if runtime.ownerLock != nil {
		_ = syscall.Flock(int(runtime.ownerLock.Fd()), syscall.LOCK_UN)
		_ = runtime.ownerLock.Close()
	}
}

// History comes from the sidecar SessionStore through its authenticated
// sidecar protocol; the catalog never copies transcript contents.
func (r *Runtime) History(ctx context.Context, limit int) (json.RawMessage, error) {
	if _, err := r.Supervisor.WaitReady(ctx); err != nil {
		return nil, err
	}
	return r.Supervisor.History(limit)
}

// Snapshot is an idle-only cut of canonical sidecar history. It carries the
// immutable local turn IDs known to be covered by the response; no prompt or
// content matching is used for attribution.
type Snapshot struct {
	History        json.RawMessage
	ThreadSeq      uint64
	CoveredTurnIDs []string
}

func (r *Runtime) SubscribeSnapshot(ctx context.Context, limit int) (Snapshot, <-chan RuntimeEvent, func(), error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.Supervisor.Idle() {
		return Snapshot{}, nil, nil, ErrThreadBusySnapshot
	}
	history, err := r.History(ctx, limit)
	if err != nil {
		return Snapshot{}, nil, nil, err
	}
	if !r.Supervisor.Idle() {
		return Snapshot{}, nil, nil, ErrThreadBusySnapshot
	}
	snapshot, err := r.snapshotLocked(history)
	if err != nil {
		return Snapshot{}, nil, nil, err
	}
	r.listenerID++
	id := r.listenerID
	events := make(chan RuntimeEvent, 512)
	r.listeners[id] = events
	cancel := func() {
		r.mu.Lock()
		if current, ok := r.listeners[id]; ok {
			delete(r.listeners, id)
			close(current)
		}
		r.mu.Unlock()
	}
	return snapshot, events, cancel, nil
}

// Snapshot does not alter subscription authority. It is refused while the
// root has active or queued work, so historical results are never reconciled
// with an active event stream in this initial preview.
func (r *Runtime) Snapshot(ctx context.Context, limit int) (Snapshot, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.Supervisor.Idle() {
		return Snapshot{}, ErrThreadBusySnapshot
	}
	history, err := r.History(ctx, limit)
	if err != nil {
		return Snapshot{}, err
	}
	if !r.Supervisor.Idle() {
		return Snapshot{}, ErrThreadBusySnapshot
	}
	return r.snapshotLocked(history)
}

var ErrThreadBusySnapshot = errors.New("missioncontrol: thread_busy_snapshot")

func (r *Runtime) snapshotLocked(history json.RawMessage) (Snapshot, error) {
	var turns []struct {
		TurnID string `json:"turn_id"`
	}
	if err := json.Unmarshal(history, &turns); err != nil {
		// The sidecar promised a history array. Refuse this snapshot rather
		// than issuing a watermark whose coverage cannot be established.
		return Snapshot{}, fmt.Errorf("missioncontrol: invalid sidecar history: %w", err)
	}
	covered := make([]string, 0, len(turns))
	for _, turn := range turns {
		if turn.TurnID != "" {
			covered = append(covered, turn.TurnID)
		}
	}
	return Snapshot{History: history, ThreadSeq: r.Thread.LastEventSeq, CoveredTurnIDs: covered}, nil
}

// Submit records rendering correlation before the sidecar can emit turn_start.
func (r *Runtime) Submit(requestID, prompt, clientRef string) (*cos.Turn, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	turn := r.Supervisor.Submit(prompt)
	if _, err := r.store.MarkDispatched(requestID, r.Thread.ID, r.Thread.RuntimeGeneration, turn.ID); err != nil {
		return turn, err
	}
	r.submissions[turn.ID] = submission{clientRef: clientRef, prompt: prompt, requestID: requestID}
	raw, err := json.Marshal(map[string]string{
		"ev": "turn_submitted", "turn_id": turn.ID, "prompt": prompt, "client_ref": clientRef,
	})
	if err == nil {
		r.publishLocked(raw)
	}
	return turn, nil
}

// Subscribe remains valid when this connection selects another thread. A
// bounded slow listener loses only its own progress frames; it cannot block
// the sidecar reader or another thread.
func (r *Runtime) Subscribe(depth int) (<-chan RuntimeEvent, func()) {
	if depth <= 0 {
		depth = 512
	}
	r.mu.Lock()
	r.listenerID++
	id := r.listenerID
	ch := make(chan RuntimeEvent, depth)
	r.listeners[id] = ch
	r.mu.Unlock()
	return ch, func() {
		r.mu.Lock()
		if current, ok := r.listeners[id]; ok {
			delete(r.listeners, id)
			close(current)
		}
		r.mu.Unlock()
	}
}

func (r *Runtime) pump() {
	sub := r.Supervisor.Subscribe(512)
	defer sub.Close()
	for event := range sub.C() {
		raw := event.Raw
		if len(raw) == 0 {
			raw, _ = json.Marshal(event)
		}
		if event.TurnID != "" && (event.Ev == cos.EvTurnStart || event.Ev == cos.EvError) {
			raw = r.decorate(raw, event.TurnID)
		}
		r.mu.Lock()
		r.publishLocked(raw)
		if event.Ev == cos.EvTurnEnd || event.Ev == cos.EvCancelled || event.Ev == cos.EvTurnCancelled {
			_ = r.store.MarkTerminal(r.Thread.ID, r.Thread.RuntimeGeneration, event.TurnID, event.Persisted)
		}
		r.mu.Unlock()
	}
}

func (r *Runtime) publishLocked(raw json.RawMessage) {
	seq, err := r.store.NextEventSeq(r.Thread.ID)
	if err != nil {
		return
	}
	out := RuntimeEvent{EventID: uuidString(), ThreadSeq: seq, Raw: raw}
	r.Thread.LastEventSeq = seq
	for _, listener := range r.listeners {
		select {
		case listener <- out:
		default:
		}
	}
}

func (r *Runtime) decorate(raw json.RawMessage, turnID string) json.RawMessage {
	r.mu.Lock()
	sub, ok := r.submissions[turnID]
	r.mu.Unlock()
	if !ok {
		return raw
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return raw
	}
	if sub.clientRef != "" {
		if encoded, err := json.Marshal(sub.clientRef); err == nil {
			fields["client_ref"] = encoded
		}
	}
	if sub.prompt != "" {
		if encoded, err := json.Marshal(sub.prompt); err == nil {
			fields["prompt"] = encoded
		}
	}
	out, err := json.Marshal(fields)
	if err != nil {
		return raw
	}
	return out
}

func uuidString() string {
	return uuid.New().String()
}
