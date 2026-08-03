package authserver

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/go-oauth2/oauth2/v4"
	"github.com/go-oauth2/oauth2/v4/models"
)

// fileTokenStore is a mutex-guarded, file-persisted implementation of
// oauth2.TokenStore, sized for muxterm's actual load (a single OS account,
// occasional logins) — not a high-throughput token store.
//
// Atomic authorization-code consumption: GetByCode removes the code from
// the in-memory map in the SAME critical section as the read, before
// returning it. This means only the first of two concurrent GetByCode
// calls for the same code ever observes a non-nil result; the second sees
// "not found" and the upstream manager correctly rejects it as
// errors.ErrInvalidAuthorizeCode. RemoveByCode (called by the manager
// immediately after GetByCode, per go-oauth2/oauth2's own
// getAndDelAuthorizationCode) is therefore an idempotent no-op in the
// normal path — this is intentional, not a bug: it exists to satisfy the
// TokenStore interface and to safely no-op if ever called independently of
// GetByCode.
type fileTokenStore struct {
	mu     sync.Mutex
	path   string
	codes  map[string]*models.Token
	access map[string]*models.Token
}

type tokenFileFormat struct {
	Codes  map[string]*models.Token `json:"codes"`
	Access map[string]*models.Token `json:"access"`
}

// NewFileTokenStore returns a TokenStore backed by <dir>/tokens.json. The
// directory and file are created with owner-only permissions (0700/0600),
// mirroring internal/sessiond/server.go's socket-directory posture.
func NewFileTokenStore(dir string) (oauth2.TokenStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("tokenstore: mkdir: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("tokenstore: chmod dir: %w", err)
	}

	s := &fileTokenStore{
		path:   filepath.Join(dir, "tokens.json"),
		codes:  make(map[string]*models.Token),
		access: make(map[string]*models.Token),
	}
	if err := s.load(); err != nil {
		return nil, fmt.Errorf("tokenstore: load: %w", err)
	}
	return s, nil
}

func (s *fileTokenStore) load() error {
	data, err := os.ReadFile(s.path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var f tokenFileFormat
	if err := json.Unmarshal(data, &f); err != nil {
		// Corrupt file: start empty rather than failing startup — matches
		// internal/config's "malformed -> defaults" posture.
		return nil
	}
	if f.Codes != nil {
		s.codes = f.Codes
	}
	if f.Access != nil {
		s.access = f.Access
	}
	return nil
}

// saveLocked persists the current state. Caller MUST hold s.mu.
func (s *fileTokenStore) saveLocked() error {
	f := tokenFileFormat{Codes: s.codes, Access: s.access}
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s *fileTokenStore) Create(_ context.Context, info oauth2.TokenInfo) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tok, ok := info.(*models.Token)
	if !ok {
		// Defensive: go-oauth2/oauth2 always constructs models.NewToken()
		// internally, so this should be unreachable in practice.
		return fmt.Errorf("tokenstore: unsupported TokenInfo implementation %T", info)
	}

	if code := tok.GetCode(); code != "" {
		s.codes[code] = tok
	}
	if access := tok.GetAccess(); access != "" {
		s.access[access] = tok
	}
	return s.saveLocked()
}

func (s *fileTokenStore) RemoveByCode(_ context.Context, code string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.codes[code]; !ok {
		return nil // already consumed by GetByCode — see type doc comment
	}
	delete(s.codes, code)
	return s.saveLocked()
}

func (s *fileTokenStore) RemoveByAccess(_ context.Context, access string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.access[access]; !ok {
		return nil
	}
	delete(s.access, access)
	return s.saveLocked()
}

// RemoveByRefresh is a no-op: muxterm never issues refresh tokens (see
// design doc's deliberate no-refresh-token model). Implemented to satisfy
// the TokenStore interface.
func (s *fileTokenStore) RemoveByRefresh(_ context.Context, _ string) error {
	return nil
}

func (s *fileTokenStore) GetByCode(_ context.Context, code string) (oauth2.TokenInfo, error) {
	if code == "" {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	tok, ok := s.codes[code]
	if !ok {
		return nil, nil
	}
	// Atomic get-and-consume: delete now, in the same critical section as
	// the read, so a concurrent second reader never observes this code.
	delete(s.codes, code)
	if err := s.saveLocked(); err != nil {
		return nil, err
	}
	return tok, nil
}

func (s *fileTokenStore) GetByAccess(_ context.Context, access string) (oauth2.TokenInfo, error) {
	if access == "" {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tok, ok := s.access[access]
	if !ok {
		return nil, nil
	}
	return tok, nil
}

// GetByRefresh always returns nil: muxterm never issues refresh tokens.
func (s *fileTokenStore) GetByRefresh(_ context.Context, _ string) (oauth2.TokenInfo, error) {
	return nil, nil
}
