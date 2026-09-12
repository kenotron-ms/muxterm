// Package missioncontrol owns the durable, metadata-only compatibility-floor
// catalog. It never reads, imports, copies, or executes a transcript.
package missioncontrol

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

const schemaVersion = 1

type Thread struct {
	ID                string     `json:"id"`
	Kind              string     `json:"kind"`
	MachineID         string     `json:"machine_id,omitempty"`
	WorkspaceUUID     string     `json:"workspace_uuid,omitempty"`
	DisplayName       string     `json:"display_name"`
	Lifecycle         string     `json:"lifecycle"`
	TranscriptRef     string     `json:"transcript_ref,omitempty"`
	RuntimeSessionID  string     `json:"runtime_session_id,omitempty"`
	RuntimeGeneration uint64     `json:"runtime_generation,omitempty"`
	StorageCWD        string     `json:"storage_cwd,omitempty"`
	StatusPath        string     `json:"status_path,omitempty"`
	InstructionPath   string     `json:"instruction_path,omitempty"`
	LastEventSeq      uint64     `json:"last_event_seq,omitempty"`
	CreatedAt         time.Time  `json:"created_at"`
	ArchivedAt        *time.Time `json:"archived_at,omitempty"`
}

// Admission is the durable request receipt. A persisted request without a
// dispatch receipt is intentionally uncertain after restart and is never
// replayed automatically.
type Admission struct {
	RequestID         string    `json:"request_id"`
	ThreadID          string    `json:"thread_id"`
	RuntimeGeneration uint64    `json:"runtime_generation"`
	PayloadSHA256     string    `json:"payload_sha256"`
	TurnID            string    `json:"turn_id,omitempty"`
	DispatchState     string    `json:"dispatch_state"`
	CreatedAt         time.Time `json:"created_at"`
}

type Binding struct {
	MachineID         string    `json:"machine_id"`
	WorkspaceUUID     string    `json:"workspace_uuid"`
	ThreadID          string    `json:"thread_id"`
	HostID            string    `json:"host_id"`
	DaemonIncarnation string    `json:"daemon_incarnation"`
	LiveWorkspaceID   string    `json:"live_workspace_id"`
	LastObservedAt    time.Time `json:"last_observed_at"`
}

type ownership struct {
	OwnerID   string    `json:"owner_id"`
	CreatedAt time.Time `json:"created_at"`
}

type catalog struct {
	SchemaVersion int                  `json:"schema_version"`
	Ownership     ownership            `json:"ownership"`
	Migrations    []json.RawMessage    `json:"migrations"`
	Threads       map[string]Thread    `json:"threads"`
	Bindings      map[string]Binding   `json:"bindings"`
	Admissions    map[string]Admission `json:"admissions,omitempty"`
}

// Store retains an exclusive owner lock until Close. Its only mutable data is
// catalog metadata; TranscriptRef is opaque and is never opened by this
// package.
type Store struct {
	mu     sync.Mutex
	path   string
	lock   *os.File
	closed bool
	data   catalog
}

func DefaultPath() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(base, "muxterm", "missioncontrol", "catalog.json")
}

func Open(path string) (*Store, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("missioncontrol: create catalog dir: %w", err)
	}
	lock, err := os.OpenFile(path+".lock", os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("missioncontrol: catalog owner lock unavailable: %w", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("missioncontrol: catalog owner lock unavailable: %w", err)
	}
	fail := func(err error) (*Store, error) {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		_ = lock.Close()
		return nil, err
	}
	s := &Store{path: path, lock: lock}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		now := time.Now().UTC()
		lobby := Thread{ID: uuid.New().String(), Kind: "lobby", DisplayName: "Lobby", Lifecycle: "active", CreatedAt: now}
		s.data = catalog{
			SchemaVersion: schemaVersion,
			Ownership:     ownership{OwnerID: uuid.New().String(), CreatedAt: now},
			Migrations:    []json.RawMessage{},
			Threads:       map[string]Thread{lobby.ID: lobby},
			Bindings:      map[string]Binding{},
			Admissions:    map[string]Admission{},
		}
		if err := s.publishLocked(s.data); err != nil {
			return fail(err)
		}
		return s, nil
	}
	if err != nil {
		return fail(fmt.Errorf("missioncontrol: read catalog: %w", err))
	}
	if err := json.Unmarshal(raw, &s.data); err != nil {
		return fail(fmt.Errorf("missioncontrol: parse catalog: %w", err))
	}
	if err := validateCatalog(s.data); err != nil {
		return fail(err)
	}
	if s.markUncertainAdmissionsLocked() {
		if err := s.publishLocked(s.data); err != nil {
			return fail(err)
		}
	}
	return s, nil
}

func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.lock == nil {
		return nil
	}
	unlockErr := syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN)
	closeErr := s.lock.Close()
	s.lock = nil
	s.closed = true
	if unlockErr != nil {
		return unlockErr
	}
	if closeErr != nil {
		return closeErr
	}
	return nil
}

func bindingKey(machineID, workspaceUUID string) string {
	return machineID + "\x00" + workspaceUUID
}

func validUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}

func validateCatalog(data catalog) error {
	if data.SchemaVersion != schemaVersion {
		return fmt.Errorf("missioncontrol: catalog schema %d is unsupported; refusing writes", data.SchemaVersion)
	}
	if data.Threads == nil || data.Bindings == nil || !validUUID(data.Ownership.OwnerID) {
		return errors.New("missioncontrol: catalog is incomplete; refusing writes")
	}
	if data.Admissions == nil {
		data.Admissions = map[string]Admission{}
	}

	lobbies := 0
	for id, thread := range data.Threads {
		if id != thread.ID || !validUUID(id) || thread.CreatedAt.IsZero() {
			return errors.New("missioncontrol: catalog has an invalid thread record; refusing writes")
		}
		hasRuntime := thread.RuntimeSessionID != "" || thread.RuntimeGeneration != 0 ||
			thread.StorageCWD != "" || thread.StatusPath != "" || thread.InstructionPath != ""
		if hasRuntime && (!validUUID(thread.RuntimeSessionID) || thread.RuntimeGeneration == 0 ||
			!filepath.IsAbs(thread.StorageCWD) || thread.TranscriptRef == "" ||
			!filepath.IsAbs(thread.StatusPath) || !filepath.IsAbs(thread.InstructionPath)) {
			return errors.New("missioncontrol: catalog has an invalid runtime record; refusing writes")
		}
		switch thread.Kind {
		case "lobby":
			lobbies++
			if thread.MachineID != "" || thread.WorkspaceUUID != "" || thread.Lifecycle != "active" || thread.ArchivedAt != nil {
				return errors.New("missioncontrol: catalog has an invalid Lobby; refusing writes")
			}
		case "workspace":
			if !validUUID(thread.MachineID) || !validUUID(thread.WorkspaceUUID) {
				return errors.New("missioncontrol: catalog has an invalid workspace thread; refusing writes")
			}
			if thread.Lifecycle != "active" && thread.Lifecycle != "archived" {
				return errors.New("missioncontrol: catalog has an invalid thread lifecycle; refusing writes")
			}
			if (thread.Lifecycle == "active") != (thread.ArchivedAt == nil) {
				return errors.New("missioncontrol: catalog has an inconsistent archived thread; refusing writes")
			}
		default:
			return errors.New("missioncontrol: catalog has an unknown thread kind; refusing writes")
		}
	}
	for requestID, admission := range data.Admissions {
		if requestID != admission.RequestID || !validUUID(requestID) || !validUUID(admission.ThreadID) || admission.RuntimeGeneration == 0 ||
			len(admission.PayloadSHA256) != sha256.Size*2 || admission.CreatedAt.IsZero() ||
			(admission.DispatchState != "admitted" && admission.DispatchState != "dispatched" && admission.DispatchState != "unknown" && admission.DispatchState != "terminal") {
			return errors.New("missioncontrol: catalog has an invalid admission record; refusing writes")
		}
		if _, ok := data.Threads[admission.ThreadID]; !ok {
			return errors.New("missioncontrol: catalog has a dangling admission; refusing writes")
		}
	}
	if lobbies != 1 {
		return errors.New("missioncontrol: catalog must contain exactly one Lobby; refusing writes")
	}

	hosts := make(map[string]string)
	for key, binding := range data.Bindings {
		if key != bindingKey(binding.MachineID, binding.WorkspaceUUID) ||
			!validUUID(binding.MachineID) ||
			!validUUID(binding.WorkspaceUUID) ||
			!validUUID(binding.ThreadID) ||
			!validUUID(binding.DaemonIncarnation) ||
			binding.LiveWorkspaceID == "" {
			return errors.New("missioncontrol: catalog has an invalid binding; refusing writes")
		}
		if host, ok := hosts[binding.MachineID]; ok && host != binding.HostID {
			return errors.New("missioncontrol: catalog has an ambiguous machine identity; refusing writes")
		}
		hosts[binding.MachineID] = binding.HostID
		thread, ok := data.Threads[binding.ThreadID]
		if !ok || thread.Kind != "workspace" || thread.MachineID != binding.MachineID || thread.WorkspaceUUID != binding.WorkspaceUUID {
			return errors.New("missioncontrol: catalog has a dangling binding; refusing writes")
		}
	}
	return nil
}

func (s *Store) Lobby() (Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, errors.New("missioncontrol: catalog is closed")
	}
	for _, thread := range s.data.Threads {
		if thread.Kind == "lobby" {
			return thread, nil
		}
	}
	return Thread{}, errors.New("missioncontrol: catalog has no Lobby")
}

// List returns durable catalog metadata only. It never opens transcript
// references or starts a worker.
func (s *Store) List() ([]Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("missioncontrol: catalog is closed")
	}
	out := make([]Thread, 0, len(s.data.Threads))
	for _, thread := range s.data.Threads {
		out = append(out, thread)
	}
	return out, nil
}

func (s *Store) Thread(threadID string) (Thread, Binding, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, Binding{}, false, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok {
		return Thread{}, Binding{}, false, nil
	}
	for _, binding := range s.data.Bindings {
		if binding.ThreadID == threadID {
			return thread, binding, true, nil
		}
	}
	return thread, Binding{}, true, nil
}

// EnsureRuntime persists immutable root identity before a sidecar is started.
// The unique UUID session ID is the canonical SessionStore key; transcript_ref
// records that fact without reading or duplicating the transcript.
func (s *Store) EnsureRuntime(threadID, storageCWD string) (Thread, error) {
	if !filepath.IsAbs(storageCWD) {
		return Thread{}, errors.New("missioncontrol: runtime requires an absolute storage cwd")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok {
		return Thread{}, errors.New("missioncontrol: unknown thread")
	}
	if thread.Lifecycle != "active" {
		return Thread{}, errors.New("missioncontrol: thread is not active")
	}
	if thread.RuntimeSessionID != "" {
		if !validUUID(thread.RuntimeSessionID) || thread.RuntimeGeneration == 0 {
			return Thread{}, errors.New("missioncontrol: invalid persisted runtime")
		}
		return thread, nil
	}
	thread.RuntimeSessionID = uuid.New().String()
	thread.RuntimeGeneration = 1
	thread.StorageCWD = storageCWD
	runtimeDir := runtimeDirectory(thread.RuntimeSessionID)
	thread.StatusPath = filepath.Join(runtimeDir, "status.json")
	thread.InstructionPath = filepath.Join(runtimeDir, "instruction.txt")
	thread.TranscriptRef = "amplifier-session:" + thread.RuntimeSessionID
	next := s.cloneLocked()
	next.Threads[thread.ID] = thread
	if err := s.publishLocked(next); err != nil {
		return Thread{}, err
	}
	s.data = next
	return thread, nil
}

// RotateRuntimeGeneration is called only after an explicit reselect finds a
// threaded supervisor permanently failed. It preserves the canonical UUID
// SessionStore root but fences every old draft/turn request with a new
// persisted generation; it never replays an uncertain admission.
func (s *Store) RotateRuntimeGeneration(threadID string) (Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok || !validUUID(thread.RuntimeSessionID) || thread.RuntimeGeneration == 0 {
		return Thread{}, errors.New("missioncontrol: thread has no valid runtime to rotate")
	}
	thread.RuntimeGeneration++
	next := s.cloneLocked()
	next.Threads[threadID] = thread
	if err := s.publishLocked(next); err != nil {
		return Thread{}, err
	}
	s.data = next
	return thread, nil
}

// Admit persists an immutable request receipt before it is handed to a live
// queue. Reusing a UUID with another target or payload is refused.
func (s *Store) Admit(requestID, threadID string, runtimeGeneration uint64, payload []byte) (Admission, bool, error) {
	if !validUUID(requestID) || !validUUID(threadID) || runtimeGeneration == 0 {
		return Admission{}, false, errors.New("missioncontrol: admission requires UUID request/thread IDs and runtime generation")
	}
	sum := sha256.Sum256(payload)
	hash := fmt.Sprintf("%x", sum[:])
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Admission{}, false, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok || thread.RuntimeGeneration != runtimeGeneration {
		return Admission{}, false, errors.New("missioncontrol: unknown thread")
	}
	if old, ok := s.data.Admissions[requestID]; ok {
		if old.ThreadID != threadID || old.RuntimeGeneration != runtimeGeneration || old.PayloadSHA256 != hash {
			return Admission{}, false, errors.New("missioncontrol: request ID was already used for another payload or thread")
		}
		return old, true, nil
	}
	admission := Admission{RequestID: requestID, ThreadID: threadID, RuntimeGeneration: runtimeGeneration, PayloadSHA256: hash, DispatchState: "admitted", CreatedAt: time.Now().UTC()}
	next := s.cloneLocked()
	if next.Admissions == nil {
		next.Admissions = map[string]Admission{}
	}
	next.Admissions[requestID] = admission
	if err := s.publishLocked(next); err != nil {
		return Admission{}, false, err
	}
	s.data = next
	return admission, false, nil
}

func (s *Store) MarkDispatched(requestID, threadID string, runtimeGeneration uint64, turnID string) (Admission, error) {
	if strings.TrimSpace(turnID) == "" {
		return Admission{}, errors.New("missioncontrol: dispatch requires a turn ID")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Admission{}, errors.New("missioncontrol: catalog is closed")
	}
	admission, ok := s.data.Admissions[requestID]
	if !ok {
		return Admission{}, errors.New("missioncontrol: unknown admission")
	}
	if admission.ThreadID != threadID || admission.RuntimeGeneration != runtimeGeneration {
		return Admission{}, errors.New("missioncontrol: admission does not belong to this runtime")
	}
	if admission.DispatchState != "admitted" {
		return admission, nil
	}
	admission.TurnID = turnID
	admission.DispatchState = "dispatched"
	next := s.cloneLocked()
	next.Admissions[requestID] = admission
	if err := s.publishLocked(next); err != nil {
		return Admission{}, err
	}
	s.data = next
	return admission, nil
}

// MarkTerminal records only a terminal sidecar event. _run_turn saves the
// SessionStore before emitting its terminal event, so this is the earliest
// durable evidence this process has that a dispatch completed.
func (s *Store) MarkTerminal(threadID string, runtimeGeneration uint64, turnID string, persisted bool) error {
	if !persisted {
		return s.MarkUncertain(threadID, runtimeGeneration, turnID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("missioncontrol: catalog is closed")
	}
	var requestID string
	var admission Admission
	for id, candidate := range s.data.Admissions {
		if candidate.ThreadID == threadID && candidate.RuntimeGeneration == runtimeGeneration && candidate.TurnID == turnID {
			requestID, admission = id, candidate
			break
		}
	}
	if requestID == "" || admission.DispatchState == "terminal" {
		return nil
	}
	admission.DispatchState = "terminal"
	next := s.cloneLocked()
	next.Admissions[requestID] = admission
	if err := s.publishLocked(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

// MarkUncertain preserves the conservative result of a terminal sidecar event
// whose transcript save failed. It is scoped by the root identity because
// queue-local turn IDs repeat across independent supervisors.
func (s *Store) MarkUncertain(threadID string, runtimeGeneration uint64, turnID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("missioncontrol: catalog is closed")
	}
	for requestID, admission := range s.data.Admissions {
		if admission.ThreadID != threadID || admission.RuntimeGeneration != runtimeGeneration || admission.TurnID != turnID {
			continue
		}
		if admission.DispatchState == "terminal" || admission.DispatchState == "unknown" {
			return nil
		}
		admission.DispatchState = "unknown"
		next := s.cloneLocked()
		next.Admissions[requestID] = admission
		if err := s.publishLocked(next); err != nil {
			return err
		}
		s.data = next
		return nil
	}
	return nil
}

func (s *Store) markUncertainAdmissionsLocked() bool {
	changed := false
	for id, admission := range s.data.Admissions {
		if admission.DispatchState == "terminal" || admission.DispatchState == "unknown" {
			continue
		}
		admission.DispatchState = "unknown"
		s.data.Admissions[id] = admission
		changed = true
	}
	return changed
}

// NextEventSeq reserves the next thread-local event sequence before an event
// reaches browser subscribers. Persisting the fence avoids assigning a later
// event a smaller sequence after a server restart.
func (s *Store) NextEventSeq(threadID string) (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return 0, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok {
		return 0, errors.New("missioncontrol: unknown thread")
	}
	thread.LastEventSeq++
	next := s.cloneLocked()
	next.Threads[threadID] = thread
	if err := s.publishLocked(next); err != nil {
		return 0, err
	}
	s.data = next
	return thread.LastEventSeq, nil
}

func (s *Store) validateMachineHostLocked(machineID, hostID string) error {
	for _, known := range s.data.Bindings {
		if known.MachineID == machineID && known.HostID != hostID {
			return fmt.Errorf("missioncontrol: machine identity %s is already observed through %q; refusing cloned-machine ambiguity", machineID, known.HostID)
		}
	}
	return nil
}

func (s *Store) Lookup(machineID, hostID, workspaceUUID string) (Thread, Binding, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, Binding{}, false, errors.New("missioncontrol: catalog is closed")
	}
	if err := s.validateMachineHostLocked(machineID, hostID); err != nil {
		return Thread{}, Binding{}, false, err
	}
	binding, ok := s.data.Bindings[bindingKey(machineID, workspaceUUID)]
	if !ok {
		return Thread{}, Binding{}, false, nil
	}
	thread, ok := s.data.Threads[binding.ThreadID]
	if !ok {
		return Thread{}, Binding{}, false, errors.New("missioncontrol: catalog has a dangling binding")
	}
	return thread, binding, true, nil
}

// Archive changes only catalog metadata. It neither opens transcript references
// nor sends a control request to sessiond, a lane, or a sidecar.
func (s *Store) Archive(threadID string) (Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok {
		return Thread{}, errors.New("missioncontrol: unknown thread")
	}
	if thread.Kind == "lobby" {
		return Thread{}, errors.New("missioncontrol: the Lobby cannot be archived")
	}
	if thread.Lifecycle == "archived" {
		return thread, nil
	}
	now := time.Now().UTC()
	thread.Lifecycle = "archived"
	thread.ArchivedAt = &now
	next := s.cloneLocked()
	next.Threads[threadID] = thread
	if err := s.publishLocked(next); err != nil {
		return Thread{}, err
	}
	s.data = next
	return thread, nil
}

// BindWorkspace creates a workspace thread only after an explicit, validated
// binding request. Repeating the exact stable binding is idempotent; an
// observed machine UUID on another host is a cloned-machine conflict, not a
// request to attach old history to a new machine.
func (s *Store) BindWorkspace(machineID, daemonIncarnation, hostID, liveWorkspaceID, workspaceUUID, displayName string) (Thread, Binding, error) {
	if !validUUID(machineID) || !validUUID(daemonIncarnation) || !validUUID(workspaceUUID) {
		return Thread{}, Binding{}, errors.New("missioncontrol: binding requires machine, daemon incarnation, and workspace UUIDs")
	}
	if liveWorkspaceID == "" {
		return Thread{}, Binding{}, errors.New("missioncontrol: binding requires a live workspace address")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, Binding{}, errors.New("missioncontrol: catalog is closed")
	}
	key := bindingKey(machineID, workspaceUUID)
	if err := s.validateMachineHostLocked(machineID, hostID); err != nil {
		return Thread{}, Binding{}, err
	}
	if binding, ok := s.data.Bindings[key]; ok {
		thread := s.data.Threads[binding.ThreadID]
		if binding.DaemonIncarnation == daemonIncarnation &&
			binding.LiveWorkspaceID == liveWorkspaceID &&
			thread.Lifecycle == "active" && thread.DisplayName == displayName {
			return thread, binding, nil
		}
		next := s.cloneLocked()
		thread = next.Threads[binding.ThreadID]
		binding.DaemonIncarnation = daemonIncarnation
		binding.LiveWorkspaceID = liveWorkspaceID
		binding.LastObservedAt = time.Now().UTC()
		next.Bindings[key] = binding
		if thread.Lifecycle == "archived" {
			thread.Lifecycle = "active"
			thread.ArchivedAt = nil
		}
		thread.DisplayName = displayName
		next.Threads[thread.ID] = thread
		if err := s.publishLocked(next); err != nil {
			return Thread{}, Binding{}, err
		}
		s.data = next
		return thread, binding, nil
	}
	now := time.Now().UTC()
	thread := Thread{ID: uuid.New().String(), Kind: "workspace", MachineID: machineID, WorkspaceUUID: workspaceUUID, DisplayName: displayName, Lifecycle: "active", CreatedAt: now}
	binding := Binding{MachineID: machineID, WorkspaceUUID: workspaceUUID, ThreadID: thread.ID, HostID: hostID, DaemonIncarnation: daemonIncarnation, LiveWorkspaceID: liveWorkspaceID, LastObservedAt: now}
	next := s.cloneLocked()
	next.Threads[thread.ID] = thread
	next.Bindings[key] = binding
	if err := s.publishLocked(next); err != nil {
		return Thread{}, Binding{}, err
	}
	s.data = next
	return thread, binding, nil
}

func (s *Store) cloneLocked() catalog {
	next := s.data
	next.Migrations = append([]json.RawMessage(nil), s.data.Migrations...)
	next.Threads = make(map[string]Thread, len(s.data.Threads))
	for key, thread := range s.data.Threads {
		next.Threads[key] = thread
	}
	next.Bindings = make(map[string]Binding, len(s.data.Bindings))
	for key, binding := range s.data.Bindings {
		next.Bindings[key] = binding
	}
	next.Admissions = make(map[string]Admission, len(s.data.Admissions))
	for key, admission := range s.data.Admissions {
		next.Admissions[key] = admission
	}
	return next
}

func (s *Store) publishLocked(data catalog) error {
	encoded, err := json.Marshal(data)
	if err != nil {
		return fmt.Errorf("missioncontrol: encode catalog: %w", err)
	}
	if err := atomicfile.Write(s.path, encoded, 0o600); err != nil {
		return fmt.Errorf("missioncontrol: publish catalog: %w", err)
	}
	return nil
}
