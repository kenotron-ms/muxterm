package sandboxazure

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

var (
	ErrRecordNotFound = errors.New("direct Azure sandbox handle is unknown")
	ErrUnsafeStore    = errors.New("direct Azure sandbox store permissions are unsafe")
)

type OperationState string

const (
	OperationPending   OperationState = "pending"
	OperationAccepted  OperationState = "accepted"
	OperationSucceeded OperationState = "succeeded"
	OperationFailed    OperationState = "failed"
	OperationAmbiguous OperationState = "ambiguous"
)

type ReconcileState string

const (
	ReconcileClean       ReconcileState = "clean"
	ReconcileNeeded      ReconcileState = "reconcile-needed"
	ReconcileQuarantined ReconcileState = "quarantined"
)

// Record is private storage. ProviderID and SignerPrivateKey must never be
// returned from controller views, CLI output, browser data, or error text.
type Record struct {
	Schema             int               `json:"schema"`
	Handle             string            `json:"handle"`
	ProviderID         string            `json:"provider_id,omitempty"`
	ProfileName        string            `json:"profile_name"`
	ProfileChecksum    string            `json:"profile_checksum"`
	Generation         uint64            `json:"generation"`
	RequestID          string            `json:"request_id"`
	Operation          string            `json:"operation"`
	OperationState     OperationState    `json:"operation_state"`
	ExpectedGeneration uint64            `json:"expected_generation"`
	DesiredState       string            `json:"desired_state"`
	ObservedState      string            `json:"observed_state"`
	ReconcileState     ReconcileState    `json:"reconcile_state"`
	SignerPrivateKey   string            `json:"signer_private_key"`
	Operations         []OperationRecord `json:"operations"`
	CreatedAt          time.Time         `json:"created_at"`
	UpdatedAt          time.Time         `json:"updated_at"`
}

// OperationRecord makes idempotency durable across later lifecycle operations.
// It is private because it is implementation history, not browser state.
type OperationRecord struct {
	RequestID          string         `json:"request_id"`
	Kind               string         `json:"kind"`
	ExpectedGeneration uint64         `json:"expected_generation"`
	DesiredState       string         `json:"desired_state"`
	State              OperationState `json:"state"`
}

// View is the safe external representation. It intentionally omits private
// Azure identity and signer material.
type View struct {
	Handle             string         `json:"handle"`
	Profile            string         `json:"profile"`
	Generation         uint64         `json:"generation"`
	RequestID          string         `json:"request_id"`
	Operation          string         `json:"operation"`
	OperationState     OperationState `json:"operation_state"`
	ExpectedGeneration uint64         `json:"expected_generation"`
	DesiredState       string         `json:"desired_state"`
	ObservedState      string         `json:"observed_state"`
	ReconcileState     ReconcileState `json:"reconcile_state"`
	Attach             string         `json:"attach"`
}

func (r Record) View() View {
	return View{
		Handle: r.Handle, Profile: r.ProfileName, Generation: r.Generation,
		RequestID: r.RequestID, Operation: r.Operation, OperationState: r.OperationState,
		ExpectedGeneration: r.ExpectedGeneration,
		DesiredState:       r.DesiredState, ObservedState: r.ObservedState,
		ReconcileState: r.ReconcileState,
		Attach:         "unsupported: Azure Sandbox port transport has not established authenticated sessiond WebSocket framing",
	}
}

type Store struct {
	root string
}

func NewStore(root string) (*Store, error) {
	if !filepath.IsAbs(root) {
		return nil, ErrUnsafeStore
	}
	if err := checkPrivateAncestors(root); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("create direct Azure sandbox store: %w", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		return nil, fmt.Errorf("set direct Azure sandbox store permissions: %w", err)
	}
	if err := checkStoreRoot(root); err != nil {
		return nil, err
	}
	return &Store{root: root}, nil
}

// OpenStoreReadOnly returns an owner-local store without creating or changing
// any filesystem entry. The operation that reads the store validates the root
// immediately before use, avoiding a redundant pre-check that cannot protect a
// later filesystem operation. Lifecycle setup continues to use NewStore, which
// is allowed to provision the configured store root.
func OpenStoreReadOnly(root string) (*Store, error) {
	if !filepath.IsAbs(root) {
		return nil, ErrUnsafeStore
	}
	return &Store{root: root}, nil
}

func (s *Store) WithLock(fn func() error) error {
	if err := s.checkRoot(); err != nil {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(s.root, ".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open direct Azure sandbox lock: %w", err)
	}
	defer lock.Close() //nolint:errcheck
	if err := verifyOpenedFile(lock, filepath.Join(s.root, ".lock"), false); err != nil {
		return err
	}
	if err := lock.Chmod(0o600); err != nil {
		return fmt.Errorf("secure direct Azure sandbox lock: %w", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock direct Azure sandbox store: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck
	return fn()
}

func (s *Store) Load(handle string) (Record, error) {
	if _, err := uuid.Parse(handle); err != nil {
		return Record{}, ErrRecordNotFound
	}
	if err := s.checkRoot(); err != nil {
		return Record{}, err
	}
	path := s.path(handle)
	if err := checkPrivate(path, false); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Record{}, ErrRecordNotFound
		}
		return Record{}, err
	}
	file, err := os.Open(path)
	if err != nil {
		return Record{}, fmt.Errorf("read direct Azure sandbox record: %w", err)
	}
	defer file.Close() //nolint:errcheck
	if err := verifyOpenedFile(file, path, false); err != nil {
		return Record{}, err
	}
	data, err := io.ReadAll(io.LimitReader(file, 1<<20))
	if err != nil {
		return Record{}, fmt.Errorf("read direct Azure sandbox record: %w", err)
	}
	var r Record
	if err := json.Unmarshal(data, &r); err != nil {
		return Record{}, errors.New("direct Azure sandbox record is corrupt")
	}
	if r.Schema != 1 || r.Handle != handle || r.ProfileName == "" || r.ProfileChecksum == "" ||
		r.RequestID == "" || r.SignerPrivateKey == "" || len(r.Operations) == 0 {
		return Record{}, errors.New("direct Azure sandbox record is invalid")
	}
	return r, nil
}

func (s *Store) Save(r Record) error {
	if err := s.checkRoot(); err != nil {
		return err
	}
	if _, err := uuid.Parse(r.Handle); err != nil {
		return errors.New("direct Azure sandbox refuses invalid handle")
	}
	if _, err := uuid.Parse(r.RequestID); err != nil {
		return errors.New("direct Azure sandbox refuses invalid request id")
	}
	r.Schema = 1
	r.UpdatedAt = time.Now().UTC()
	data, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("encode direct Azure sandbox record: %w", err)
	}
	if err := atomicfile.Write(s.path(r.Handle), data, 0o600); err != nil {
		return fmt.Errorf("save direct Azure sandbox record: %w", err)
	}
	if err := s.checkRoot(); err != nil {
		return err
	}
	if err := checkPrivate(s.path(r.Handle), false); err != nil {
		return err
	}
	return nil
}

func (s *Store) List() ([]Record, error) {
	if err := s.checkRoot(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, fmt.Errorf("list direct Azure sandbox records: %w", err)
	}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		handle := strings.TrimSuffix(entry.Name(), ".json")
		r, err := s.Load(handle)
		if err != nil {
			return nil, err
		}
		records = append(records, r)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].CreatedAt.Before(records[j].CreatedAt) })
	return records, nil
}

func (s *Store) FindRequest(requestID string) (Record, error) {
	records, err := s.List()
	if err != nil {
		return Record{}, err
	}
	for _, r := range records {
		if r.RequestID == requestID || r.operation(requestID) != nil {
			return r, nil
		}
	}
	return Record{}, ErrRecordNotFound
}

func (r Record) operation(requestID string) *OperationRecord {
	for i := range r.Operations {
		if r.Operations[i].RequestID == requestID {
			return &r.Operations[i]
		}
	}
	return nil
}

func (s *Store) path(handle string) string { return filepath.Join(s.root, handle+".json") }

func (s *Store) checkRoot() error { return checkStoreRoot(s.root) }

// checkPrivateAncestors verifies every existing component. Root-owned
// non-writable ancestors are normal (/home, /), while a group/world-writable
// ancestor is accepted only when sticky (for example /tmp); sticky prevents a
// different principal from replacing our owned child name. Same-UID hostile
// code and privileged filesystem mutation remain outside this portable check.
func checkPrivateAncestors(path string) error {
	path = filepath.Clean(path)
	for parent := filepath.Dir(path); ; parent = filepath.Dir(parent) {
		info, err := os.Lstat(parent)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue
			}
			return ErrUnsafeStore
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return ErrUnsafeStore
		}
		if info.Mode().Perm()&0o022 != 0 && info.Mode()&os.ModeSticky == 0 {
			return ErrUnsafeStore
		}
		if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() && stat.Uid != 0 {
			return ErrUnsafeStore
		}
		if parent == string(filepath.Separator) {
			return nil
		}
	}
}

func checkStoreRoot(path string) error {
	if err := checkPrivateAncestors(path); err != nil {
		return err
	}
	return checkPrivate(path, true)
}

func checkPrivate(path string, dir bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 || (dir && !info.IsDir()) || (!dir && !info.Mode().IsRegular()) {
		return ErrUnsafeStore
	}
	if info.Mode().Perm()&0o077 != 0 {
		return ErrUnsafeStore
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Uid) != os.Getuid() {
		return ErrUnsafeStore
	}
	return nil
}

// verifyOpenedFile makes the pre-open Lstat check meaningful against a
// cross-principal rename race: the descriptor must still name the same regular
// non-symlink file after open. Go exposes no portable openat-style directory
// traversal; revalidation is the strongest cross-platform guard here.
func verifyOpenedFile(file *os.File, path string, dir bool) error {
	openInfo, err := file.Stat()
	if err != nil {
		return ErrUnsafeStore
	}
	if err := checkPrivate(path, dir); err != nil {
		return err
	}
	pathInfo, err := os.Lstat(path)
	if err != nil || !os.SameFile(openInfo, pathInfo) {
		return ErrUnsafeStore
	}
	return nil
}
