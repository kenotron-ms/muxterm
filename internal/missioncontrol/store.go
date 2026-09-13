// Package missioncontrol retains only the read-only compatibility seam used to
// select the one persistent Mission Control conversation.
package missioncontrol

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/cos"
)

const schemaVersion = 2
const maxCatalogBytes = 4 << 20

// SingleConversationOrigin is the immutable root selected from existing
// metadata. It is not a catalog handle and offers no mutation operations.
type SingleConversationOrigin struct {
	ID         string
	SessionID  string
	StorageCWD string
	Existing   bool
}

type persistedOrigin struct {
	SessionID  string `json:"session_id"`
	StorageCWD string `json:"storage_cwd"`
}

type persistedLobby struct {
	ID               string           `json:"id"`
	Kind             string           `json:"kind"`
	RuntimeSessionID string           `json:"runtime_session_id"`
	StorageCWD       string           `json:"storage_cwd"`
	LobbyOrigin      *persistedOrigin `json:"lobby_origin"`
}

type persistedCatalog struct {
	SchemaVersion int                       `json:"schema_version"`
	Threads       map[string]persistedLobby `json:"threads"`
}

func DefaultPath() string {
	base := os.Getenv("XDG_DATA_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "share")
	}
	return filepath.Join(base, "muxterm", "missioncontrol", "catalog.json")
}

// ReadSingleConversationOrigin reads and validates existing metadata only. It
// does not create a catalog, a directory, or a lock. For an existing catalog it
// returns an exclusive lock held by the caller for the active relay lifetime.
func ReadSingleConversationOrigin(path string) (SingleConversationOrigin, *os.File, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return SingleConversationOrigin{}, nil, nil
	}
	if err != nil {
		return SingleConversationOrigin{}, nil, fmt.Errorf("missioncontrol: inspect catalog: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maxCatalogBytes {
		return SingleConversationOrigin{}, nil, errors.New("missioncontrol: catalog is unsafe for read-only selection")
	}
	lock, err := os.OpenFile(path+".lock", os.O_RDWR, 0)
	if err != nil {
		return SingleConversationOrigin{}, nil, fmt.Errorf("missioncontrol: catalog owner lock unavailable: %w", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return SingleConversationOrigin{}, nil, fmt.Errorf("missioncontrol: catalog owner lock unavailable: %w", err)
	}
	fail := func(err error) (SingleConversationOrigin, *os.File, error) {
		_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
		_ = lock.Close()
		return SingleConversationOrigin{}, nil, err
	}
	file, err := os.Open(path) //nolint:gosec // exact checked catalog path
	if err != nil {
		return fail(fmt.Errorf("missioncontrol: read catalog: %w", err))
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, maxCatalogBytes+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(raw) > maxCatalogBytes {
		return fail(errors.New("missioncontrol: catalog cannot be read safely"))
	}
	var catalog persistedCatalog
	if err := json.Unmarshal(raw, &catalog); err != nil {
		return fail(fmt.Errorf("missioncontrol: parse catalog: %w", err))
	}
	if catalog.SchemaVersion != schemaVersion || catalog.Threads == nil {
		return fail(errors.New("missioncontrol: catalog schema is unsupported; refusing root replacement"))
	}
	var lobby *persistedLobby
	for id, thread := range catalog.Threads {
		if thread.Kind != "lobby" {
			continue
		}
		if lobby != nil || id != thread.ID || !validUUID(thread.ID) {
			return fail(errors.New("missioncontrol: catalog Lobby is ambiguous or invalid"))
		}
		copy := thread
		lobby = &copy
	}
	if lobby == nil {
		return fail(errors.New("missioncontrol: catalog has no Lobby; refusing root replacement"))
	}
	if lobby.LobbyOrigin != nil {
		if lobby.RuntimeSessionID != lobby.LobbyOrigin.SessionID || lobby.StorageCWD != lobby.LobbyOrigin.StorageCWD ||
			!validSession(lobby.LobbyOrigin.SessionID) || !filepath.IsAbs(lobby.LobbyOrigin.StorageCWD) {
			return fail(errors.New("missioncontrol: persisted Lobby origin is invalid"))
		}
		return SingleConversationOrigin{ID: lobby.ID, SessionID: lobby.LobbyOrigin.SessionID, StorageCWD: lobby.LobbyOrigin.StorageCWD, Existing: true}, lock, nil
	}
	if lobby.RuntimeSessionID != "" || lobby.StorageCWD != "" {
		if !validSession(lobby.RuntimeSessionID) || !filepath.IsAbs(lobby.StorageCWD) {
			return fail(errors.New("missioncontrol: persisted Lobby runtime is invalid"))
		}
		return SingleConversationOrigin{ID: lobby.ID, SessionID: lobby.RuntimeSessionID, StorageCWD: lobby.StorageCWD, Existing: true}, lock, nil
	}
	return SingleConversationOrigin{ID: lobby.ID}, lock, nil
}

func validUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed != uuid.Nil
}

func validSession(value string) bool {
	return validUUID(value) || cos.IsValidSessionID(value)
}
