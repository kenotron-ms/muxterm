// Package missioncontrol owns the durable, metadata-only compatibility-floor
// catalog. It never reads, imports, copies, or executes a transcript.
package missioncontrol

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// schemaVersion 2 adds bounded summary/attention metadata. Version 1 is
// preview-only: Open refuses it without mutating the original catalog.
const schemaVersion = 2

const (
	maxSummaries        = 20
	maxSummaryChars     = 1200
	maxAttentionRecords = 100
)

type Summary struct {
	ID                string    `json:"id"`
	ThreadID          string    `json:"thread_id"`
	RuntimeSessionID  string    `json:"runtime_session_id"`
	RuntimeGeneration uint64    `json:"runtime_generation"`
	TurnID            string    `json:"turn_id"`
	ObservedAt        time.Time `json:"observed_at"`
	Kind              string    `json:"kind"` // extract|summary
	Text              string    `json:"text"`
}

type Attention struct {
	ID                string     `json:"id"`
	SourceKey         string     `json:"source_key"`
	ThreadID          string     `json:"thread_id"`
	RuntimeGeneration uint64     `json:"runtime_generation"`
	TurnID            string     `json:"turn_id,omitempty"`
	Kind              string     `json:"kind"` // terminal|error|approval|pending
	ObservedAt        time.Time  `json:"observed_at"`
	AcknowledgedAt    *time.Time `json:"acknowledged_at,omitempty"`
}

// MigrationPreview is deliberately metadata-only. It is safe to run against a
// v1 catalog because it never opens Store or publishes any replacement bytes.
type PreviewOptions struct {
	Operation       string
	CatalogPath     string
	LegacySessionID string
	LegacyStoreDir  string
}

type PreviewFile struct {
	Name           string `json:"name"`
	Bytes          int64  `json:"bytes"`
	ChecksumSHA256 string `json:"checksum_sha256"`
}

type LegacySourcePreview struct {
	SessionID string        `json:"session_id,omitempty"`
	StoreDir  string        `json:"store_dir,omitempty"`
	Files     []PreviewFile `json:"files,omitempty"`
}

// MigrationPreview contains no transcript/event/metadata content. All file
// accounting is a streaming SHA-256 and byte count of a closed allowlist.
type MigrationPreview struct {
	Operation         string              `json:"operation"`
	Scope             string              `json:"scope"`
	Status            string              `json:"status"`
	CatalogPath       string              `json:"catalog_path"`
	CatalogExists     bool                `json:"catalog_exists"`
	CatalogChecksum   string              `json:"catalog_checksum_sha256,omitempty"`
	CatalogSchema     int                 `json:"catalog_schema,omitempty"`
	ThreadCount       int                 `json:"thread_count"`
	RuntimeRefCount   int                 `json:"runtime_ref_count"`
	UnknownAdmissions int                 `json:"unknown_admissions"`
	Legacy            LegacySourcePreview `json:"legacy"`
	OperationalReady  bool                `json:"operational_ready"`
	Blockers          []string            `json:"blockers"`
	Disposition       string              `json:"disposition"`
}

const maxPreviewFiles = 128

// PreviewMigration is strictly read-only: it never opens Store, takes no
// catalog lock, parses no legacy transcript/event content, and writes nothing.
// LegacyStoreDir is the exact user-supplied session directory; this API never
// guesses a project slug, cwd, or home-relative SessionStore location.
func PreviewMigration(options PreviewOptions) (MigrationPreview, error) {
	preview := MigrationPreview{
		Operation: options.Operation, CatalogPath: options.CatalogPath,
		Scope: "catalog_only", Status: "BLOCKED",
		Blockers: []string{}, Disposition: "preview only; originals retained; no apply or rollback exists",
	}
	if options.Operation != "migration" && options.Operation != "rollback" {
		return preview, errors.New("missioncontrol: preview operation must be migration or rollback")
	}
	if !filepath.IsAbs(options.CatalogPath) {
		return preview, errors.New("missioncontrol: preview catalog path must be absolute")
	}
	if options.LegacySessionID == "" {
		preview.Blockers = append(preview.Blockers, "legacy_session_id_required")
	}
	if options.LegacyStoreDir == "" {
		preview.Blockers = append(preview.Blockers, "legacy_store_dir_required")
	}
	if options.LegacySessionID != "" && options.LegacyStoreDir != "" {
		if err := previewLegacySource(&preview, options.LegacySessionID, options.LegacyStoreDir); err != nil {
			preview.Blockers = append(preview.Blockers, err.Error())
		} else {
			preview.Scope = "catalog_and_explicit_legacy_source"
		}
	} else if options.LegacySessionID != "" || options.LegacyStoreDir != "" {
		preview.Scope = "incomplete_explicit_legacy_source"
	}

	path := options.CatalogPath
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if options.Operation == "rollback" {
			preview.Blockers = append(preview.Blockers, "catalog_missing")
		}
		preview.Disposition = previewDisposition(options.Operation, false)
		preview.OperationalReady = len(preview.Blockers) == 0 && options.Operation == "migration"
		if preview.OperationalReady {
			preview.Status = "READY"
		}
		return preview, nil
	}
	if err != nil {
		return preview, fmt.Errorf("missioncontrol: read migration preview: %w", err)
	}
	preview.CatalogExists = true
	sum := sha256.Sum256(raw)
	preview.CatalogChecksum = fmt.Sprintf("%x", sum[:])
	var header struct {
		SchemaVersion int                        `json:"schema_version"`
		Threads       map[string]json.RawMessage `json:"threads"`
		Admissions    map[string]json.RawMessage `json:"admissions"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		preview.Blockers = append(preview.Blockers, "catalog_schema_unparseable")
		preview.Disposition = "refused_writes; catalog bytes are unparseable; original preserved"
		return preview, nil
	}
	preview.CatalogSchema = header.SchemaVersion
	preview.ThreadCount = len(header.Threads)
	for _, rawThread := range header.Threads {
		var runtime struct {
			RuntimeSessionID string            `json:"runtime_session_id"`
			Retired          []json.RawMessage `json:"retired_runtimes"`
		}
		if json.Unmarshal(rawThread, &runtime) == nil {
			if runtime.RuntimeSessionID != "" {
				preview.RuntimeRefCount++
			}
			preview.RuntimeRefCount += len(runtime.Retired)
		}
	}
	for _, rawAdmission := range header.Admissions {
		var admission struct {
			DispatchState string `json:"dispatch_state"`
		}
		if json.Unmarshal(rawAdmission, &admission) != nil ||
			(admission.DispatchState != "terminal" && admission.DispatchState != "not_dispatched") {
			preview.UnknownAdmissions++
		}
	}
	if header.SchemaVersion == schemaVersion {
		preview.Disposition = previewDisposition(options.Operation, true)
	} else if header.SchemaVersion == 1 {
		preview.Blockers = append(preview.Blockers, "catalog_schema_v1_unconverted")
		preview.Disposition = "refused_writes; v1 catalog is unconverted and original bytes are preserved"
	} else {
		preview.Blockers = append(preview.Blockers, "catalog_schema_unsupported")
		preview.Disposition = "refused_writes; unknown catalog schema and original bytes are preserved"
	}
	if preview.UnknownAdmissions > 0 {
		preview.Blockers = append(preview.Blockers, "unresolved_uncertain_admissions")
	}
	if options.Operation == "rollback" {
		// Quiescence cannot be proved from an intentionally read-only preview.
		preview.Blockers = append(preview.Blockers, "quiescence_not_attested")
	}
	preview.OperationalReady = len(preview.Blockers) == 0
	if preview.OperationalReady {
		preview.Status = "READY"
	}
	return preview, nil
}

func previewDisposition(operation string, catalogExists bool) string {
	if operation == "migration" {
		if catalogExists {
			return "migration preview: retain mixed legacy unchanged; new roots empty; retain existing and retired root refs; no transcript copying"
		}
		return "migration preview: retain explicit legacy source unchanged; new roots would be empty; no transcript copying"
	}
	return "rollback preview: disable admission first; retain all new and retired root refs read-only; no flattening; require quiescence and resolved uncertain admissions"
}

func previewLegacySource(preview *MigrationPreview, sessionID, storeDir string) error {
	if strings.TrimSpace(sessionID) == "" || sessionID != strings.TrimSpace(sessionID) ||
		strings.ContainsAny(sessionID, `/\`) || sessionID == "." || sessionID == ".." {
		return errors.New("legacy_session_id_invalid")
	}
	if !filepath.IsAbs(storeDir) {
		return errors.New("legacy_store_dir_must_be_absolute")
	}
	clean := filepath.Clean(storeDir)
	info, err := os.Lstat(clean)
	if errors.Is(err, os.ErrNotExist) {
		return errors.New("legacy_store_dir_missing")
	}
	if err != nil {
		return errors.New("legacy_store_dir_unreadable")
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("legacy_store_dir_symlink_refused")
	}
	if !info.IsDir() {
		return errors.New("legacy_store_dir_not_directory")
	}
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil || resolved != clean {
		return errors.New("legacy_store_dir_symlink_escape_refused")
	}
	if filepath.Base(clean) != sessionID {
		return errors.New("legacy_store_dir_session_id_mismatch")
	}
	entries, err := os.ReadDir(clean)
	if err != nil {
		return errors.New("legacy_store_dir_unreadable")
	}
	if len(entries) > maxPreviewFiles {
		return errors.New("legacy_store_dir_enumeration_limit")
	}
	preview.Legacy.SessionID = sessionID
	preview.Legacy.StoreDir = clean
	for _, entry := range entries {
		if !allowedLegacyPreviewFile(entry.Name()) {
			continue
		}
		path := filepath.Join(clean, entry.Name())
		info, err := os.Lstat(path)
		if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
			return errors.New("legacy_source_file_unsafe")
		}
		checksum, bytes, err := streamChecksum(path)
		if err != nil {
			return errors.New("legacy_source_file_unreadable")
		}
		preview.Legacy.Files = append(preview.Legacy.Files, PreviewFile{
			Name: entry.Name(), Bytes: bytes, ChecksumSHA256: checksum,
		})
	}
	sort.Slice(preview.Legacy.Files, func(i, j int) bool { return preview.Legacy.Files[i].Name < preview.Legacy.Files[j].Name })
	return nil
}

func allowedLegacyPreviewFile(name string) bool {
	switch name {
	case "transcript.jsonl", "metadata.json", "events.jsonl", "transcript.jsonl.backup":
		return true
	default:
		return strings.Contains(name, ".bak-cos-clear-")
	}
}

func streamChecksum(path string) (string, int64, error) {
	file, err := os.Open(path) //nolint:gosec // path passed exact legacy allowlist checks above
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	bytes, err := io.Copy(hash, file)
	if err != nil {
		return "", 0, err
	}
	return fmt.Sprintf("%x", hash.Sum(nil)), bytes, nil
}

type Thread struct {
	ID                 string             `json:"id"`
	Kind               string             `json:"kind"`
	MachineID          string             `json:"machine_id,omitempty"`
	WorkspaceUUID      string             `json:"workspace_uuid,omitempty"`
	DisplayName        string             `json:"display_name"`
	Lifecycle          string             `json:"lifecycle"`
	TranscriptRef      string             `json:"transcript_ref,omitempty"`
	RuntimeSessionID   string             `json:"runtime_session_id,omitempty"`
	RuntimeGeneration  uint64             `json:"runtime_generation,omitempty"`
	RuntimeIncarnation string             `json:"runtime_incarnation,omitempty"`
	StorageCWD         string             `json:"storage_cwd,omitempty"`
	StatusPath         string             `json:"status_path,omitempty"`
	InstructionPath    string             `json:"instruction_path,omitempty"`
	JournalPath        string             `json:"journal_path,omitempty"`
	LastEventSeq       uint64             `json:"last_event_seq,omitempty"`
	CreatedAt          time.Time          `json:"created_at"`
	ArchivedAt         *time.Time         `json:"archived_at,omitempty"`
	RetiredRuntimes    []RuntimeReference `json:"retired_runtimes,omitempty"`
}

// RuntimeReference preserves an old root's canonical SessionStore reference
// across reset. It is catalog metadata only; this package never opens it.
type RuntimeReference struct {
	RuntimeSessionID   string `json:"runtime_session_id"`
	RuntimeGeneration  uint64 `json:"runtime_generation"`
	RuntimeIncarnation string `json:"runtime_incarnation"`
	TranscriptRef      string `json:"transcript_ref"`
	StorageCWD         string `json:"storage_cwd"`
	StatusPath         string `json:"status_path"`
	InstructionPath    string `json:"instruction_path"`
	JournalPath        string `json:"journal_path"`
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
	Refusal           string    `json:"refusal,omitempty"`
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
	Summaries     []Summary            `json:"summaries,omitempty"`
	Attention     map[string]Attention `json:"attention,omitempty"`
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
			Summaries:     []Summary{},
			Attention:     map[string]Attention{},
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
	if data.Attention == nil {
		data.Attention = map[string]Attention{}
	}

	lobbies := 0
	for id, thread := range data.Threads {
		if id != thread.ID || !validUUID(id) || thread.CreatedAt.IsZero() {
			return errors.New("missioncontrol: catalog has an invalid thread record; refusing writes")
		}
		hasRuntime := thread.RuntimeSessionID != "" || thread.RuntimeGeneration != 0 ||
			thread.StorageCWD != "" || thread.StatusPath != "" || thread.InstructionPath != "" || thread.JournalPath != ""
		if hasRuntime && (!validUUID(thread.RuntimeSessionID) || thread.RuntimeGeneration == 0 ||
			!filepath.IsAbs(thread.StorageCWD) || thread.TranscriptRef == "" ||
			!filepath.IsAbs(thread.StatusPath) || !filepath.IsAbs(thread.InstructionPath) || !filepath.IsAbs(thread.JournalPath)) {
			return errors.New("missioncontrol: catalog has an invalid runtime record; refusing writes")
		}
		if thread.RuntimeIncarnation != "" && !validUUID(thread.RuntimeIncarnation) {
			return errors.New("missioncontrol: catalog has an invalid runtime incarnation; refusing writes")
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
			(admission.DispatchState != "admitted" && admission.DispatchState != "dispatched" && admission.DispatchState != "not_dispatched" && admission.DispatchState != "unknown" && admission.DispatchState != "terminal") {
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

// Summaries returns bounded provenance-bearing terminal extracts. It never
// opens SessionStore data or resolves live targets.
func (s *Store) Summaries(limit int) ([]Summary, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("missioncontrol: catalog is closed")
	}
	if limit <= 0 || limit > maxSummaries {
		limit = maxSummaries
	}
	start := len(s.data.Summaries) - limit
	if start < 0 {
		start = 0
	}
	out := append([]Summary(nil), s.data.Summaries[start:]...)
	return out, nil
}

func (s *Store) RecordSummary(threadID, runtimeSessionID string, generation uint64, turnID, text string) error {
	text = strings.TrimSpace(text)
	if text == "" || len(text) > maxSummaryChars || !validUUID(threadID) || !validUUID(runtimeSessionID) || generation == 0 || turnID == "" {
		return errors.New("missioncontrol: invalid bounded summary")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok || thread.RuntimeSessionID != runtimeSessionID || thread.RuntimeGeneration != generation {
		return errors.New("missioncontrol: summary runtime is stale")
	}
	for _, known := range s.data.Summaries {
		if known.ThreadID == threadID && known.RuntimeGeneration == generation && known.TurnID == turnID {
			return nil
		}
	}
	next := s.cloneLocked()
	next.Summaries = append(next.Summaries, Summary{
		ID: uuid.New().String(), ThreadID: threadID, RuntimeSessionID: runtimeSessionID,
		RuntimeGeneration: generation, TurnID: turnID, ObservedAt: time.Now().UTC(),
		Kind: "extract", Text: text,
	})
	if len(next.Summaries) > maxSummaries {
		next.Summaries = append([]Summary(nil), next.Summaries[len(next.Summaries)-maxSummaries:]...)
	}
	if err := s.publishLocked(next); err != nil {
		return err
	}
	s.data = next
	return nil
}

func (s *Store) RecordAttention(sourceKey, threadID string, generation uint64, turnID, kind string) (Attention, error) {
	if sourceKey == "" || !validUUID(threadID) || generation == 0 || (kind != "terminal" && kind != "error" && kind != "approval" && kind != "pending") {
		return Attention{}, errors.New("missioncontrol: invalid attention")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Attention{}, errors.New("missioncontrol: catalog is closed")
	}
	next := s.cloneLocked()
	if next.Attention == nil {
		next.Attention = map[string]Attention{}
	}
	changed := false
	// A terminal/error state supersedes obsolete pending and approval work for
	// this exact immutable root/turn. One catalog publish performs both the
	// removal and terminal insertion; Attention() never shows a stale queued
	// item after completion.
	if kind == "terminal" || kind == "error" {
		for key, current := range next.Attention {
			if current.ThreadID == threadID && current.RuntimeGeneration == generation &&
				current.TurnID == turnID && (current.Kind == "pending" || current.Kind == "approval") {
				delete(next.Attention, key)
				changed = true
			}
		}
	}
	if known, ok := next.Attention[sourceKey]; ok {
		if changed {
			if err := s.publishLocked(next); err != nil {
				return Attention{}, err
			}
			s.data = next
		}
		return known, nil
	}
	attention := Attention{ID: uuid.New().String(), SourceKey: sourceKey, ThreadID: threadID, RuntimeGeneration: generation, TurnID: turnID, Kind: kind, ObservedAt: time.Now().UTC()}
	next.Attention[sourceKey] = attention
	changed = true
	if len(next.Attention) > maxAttentionRecords {
		var oldestKey string
		var oldest time.Time
		for key, record := range next.Attention {
			if oldestKey == "" || record.ObservedAt.Before(oldest) {
				oldestKey, oldest = key, record.ObservedAt
			}
		}
		delete(next.Attention, oldestKey)
	}
	if changed {
		if err := s.publishLocked(next); err != nil {
			return Attention{}, err
		}
		s.data = next
	}
	return attention, nil
}

func (s *Store) Attention() ([]Attention, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("missioncontrol: catalog is closed")
	}
	type target struct {
		thread     string
		generation uint64
		turn       string
	}
	completed := make(map[target]bool)
	for _, item := range s.data.Attention {
		if item.Kind == "terminal" || item.Kind == "error" {
			completed[target{item.ThreadID, item.RuntimeGeneration, item.TurnID}] = true
		}
	}
	out := make([]Attention, 0, len(s.data.Attention))
	for _, attention := range s.data.Attention {
		// Older catalogs may retain pre-terminal records. Project current
		// attention without rewriting their retained historical metadata.
		if (attention.Kind == "pending" || attention.Kind == "approval") &&
			completed[target{attention.ThreadID, attention.RuntimeGeneration, attention.TurnID}] {
			continue
		}
		if attention.AcknowledgedAt == nil {
			out = append(out, attention)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ObservedAt.Before(out[j].ObservedAt) })
	return out, nil
}

func (s *Store) AcknowledgeAttention(id string) (Attention, error) {
	if !validUUID(id) {
		return Attention{}, errors.New("missioncontrol: attention id must be UUID")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Attention{}, errors.New("missioncontrol: catalog is closed")
	}
	var key string
	var record Attention
	for candidateKey, candidate := range s.data.Attention {
		if candidate.ID == id {
			key, record = candidateKey, candidate
			break
		}
	}
	if key == "" {
		return Attention{}, errors.New("missioncontrol: attention is unknown")
	}
	if record.AcknowledgedAt != nil {
		return record, nil
	}
	now := time.Now().UTC()
	record.AcknowledgedAt = &now
	next := s.cloneLocked()
	next.Attention[key] = record
	if err := s.publishLocked(next); err != nil {
		return Attention{}, err
	}
	s.data = next
	return record, nil
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
	thread.RuntimeIncarnation = ""
	thread.StorageCWD = storageCWD
	runtimeDir := runtimeDirectory(thread.RuntimeSessionID)
	thread.StatusPath = filepath.Join(runtimeDir, "status.json")
	thread.InstructionPath = filepath.Join(runtimeDir, "instruction.txt")
	thread.JournalPath = filepath.Join(runtimeDir, "turns.jsonl")
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
	thread.RuntimeIncarnation = ""
	next := s.cloneLocked()
	next.Threads[threadID] = thread
	if err := s.publishLocked(next); err != nil {
		return Thread{}, err
	}
	s.data = next
	return thread, nil
}

// BeginRuntime records a real new Python process incarnation. A process after
// any prior launched incarnation rotates its generation before it can accept
// a stale draft or control request. A fresh reset has no incarnation yet and
// already owns its explicitly incremented generation.
func (s *Store) BeginRuntime(threadID string) (Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok || !validUUID(thread.RuntimeSessionID) || thread.RuntimeGeneration == 0 {
		return Thread{}, errors.New("missioncontrol: thread has no valid runtime")
	}
	if thread.RuntimeIncarnation != "" {
		thread.RuntimeGeneration++
	}
	thread.RuntimeIncarnation = uuid.New().String()
	next := s.cloneLocked()
	next.Threads[threadID] = thread
	if err := s.publishLocked(next); err != nil {
		return Thread{}, err
	}
	s.data = next
	return thread, nil
}

// ResetRuntime retires the old canonical root reference and creates a fresh
// UUID/session-store key. The old transcript remains intact and is never
// copied into the new root.
func (s *Store) ResetRuntime(threadID string) (Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Thread{}, errors.New("missioncontrol: catalog is closed")
	}
	thread, ok := s.data.Threads[threadID]
	if !ok || !validUUID(thread.RuntimeSessionID) || thread.RuntimeGeneration == 0 {
		return Thread{}, errors.New("missioncontrol: thread has no valid runtime to reset")
	}
	thread.RetiredRuntimes = append(thread.RetiredRuntimes, RuntimeReference{
		RuntimeSessionID: thread.RuntimeSessionID, RuntimeGeneration: thread.RuntimeGeneration,
		RuntimeIncarnation: thread.RuntimeIncarnation,
		TranscriptRef:      thread.TranscriptRef, StorageCWD: thread.StorageCWD,
		StatusPath: thread.StatusPath, InstructionPath: thread.InstructionPath, JournalPath: thread.JournalPath,
	})
	thread.RuntimeGeneration++
	thread.RuntimeIncarnation = ""
	thread.RuntimeSessionID = uuid.New().String()
	thread.TranscriptRef = "amplifier-session:" + thread.RuntimeSessionID
	runtimeDir := runtimeDirectory(thread.RuntimeSessionID)
	thread.StatusPath = filepath.Join(runtimeDir, "status.json")
	thread.InstructionPath = filepath.Join(runtimeDir, "instruction.txt")
	thread.JournalPath = filepath.Join(runtimeDir, "turns.jsonl")
	thread.LastEventSeq = 0
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

// MarkNotDispatched records a post-admission safety fence failure. It is not
// replayable and deliberately has no turn ID: the supplied reservation was
// never enqueued into the sidecar queue.
func (s *Store) MarkNotDispatched(requestID, threadID string, runtimeGeneration uint64, refusal string) (Admission, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return Admission{}, errors.New("missioncontrol: catalog is closed")
	}
	admission, ok := s.data.Admissions[requestID]
	if !ok || admission.ThreadID != threadID || admission.RuntimeGeneration != runtimeGeneration {
		return Admission{}, errors.New("missioncontrol: admission does not belong to this runtime")
	}
	if admission.DispatchState != "admitted" {
		return admission, nil
	}
	admission.DispatchState = "not_dispatched"
	admission.Refusal = refusal
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
	if requestID == "" || admission.DispatchState == "terminal" || admission.DispatchState == "not_dispatched" {
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
		if admission.DispatchState == "terminal" || admission.DispatchState == "unknown" || admission.DispatchState == "not_dispatched" {
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

func (s *Store) HasNonterminalAdmission(threadID string, runtimeGeneration uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, admission := range s.data.Admissions {
		if admission.ThreadID == threadID && admission.RuntimeGeneration == runtimeGeneration &&
			admission.DispatchState != "terminal" && admission.DispatchState != "not_dispatched" {
			return true
		}
	}
	return false
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
	next.Summaries = append([]Summary(nil), s.data.Summaries...)
	next.Attention = make(map[string]Attention, len(s.data.Attention))
	for key, attention := range s.data.Attention {
		next.Attention[key] = attention
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
