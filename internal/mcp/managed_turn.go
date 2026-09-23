package mcp

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

const managedTurnVersion = 1

type ManagedTurn struct {
	V            int       `json:"v"`
	SessionID    string    `json:"sessionId"`
	ClientRef    string    `json:"clientRef"`
	Prompt       string    `json:"prompt"`
	Cursor       string    `json:"cursor,omitempty"`
	Status       string    `json:"status"`
	Harness      string    `json:"harness"`
	NativeID     string    `json:"nativeId"`
	AdmittedAt   time.Time `json:"admittedAt"`
	DispatchedAt time.Time `json:"dispatchedAt,omitempty"`
	FinishedAt   time.Time `json:"finishedAt,omitempty"`
	Error        string    `json:"error,omitempty"`
}

// AcquireManagedWriter proves this process is the only muxterm-owned writer for
// the session. The kernel releases the advisory lock if the process is killed,
// so an interrupted dispatch cannot strand a permanent ownership marker.
func AcquireManagedWriter(sessionID string) (func(), error) {
	dir := managedTurnDir(sessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "writer.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, errors.New("session already has a muxterm-owned writer")
	}
	return func() {
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}

func managedTurnDir(sessionID string) string {
	sum := sha256.Sum256([]byte(sessionID))
	return filepath.Join(sessiond.HookReportRoot(), "managed-turns", hex.EncodeToString(sum[:]))
}

func managedTurnPath(sessionID, clientRef string) string {
	sum := sha256.Sum256([]byte(clientRef))
	return filepath.Join(managedTurnDir(sessionID), hex.EncodeToString(sum[:])+".json")
}

func managedTurnJournal(sessionID string) string {
	return filepath.Join(managedTurnDir(sessionID), "events.jsonl")
}

func AdmitManagedTurn(row sessiond.SessionState, nativeID, prompt, clientRef, cursor string) (ManagedTurn, bool, error) {
	prompt, clientRef = strings.TrimSpace(prompt), strings.TrimSpace(clientRef)
	if prompt == "" || clientRef == "" {
		return ManagedTurn{}, false, errors.New("prompt and client reference are required")
	}
	if row.SessionID == "" || row.Harness == "" || nativeID == "" {
		return ManagedTurn{}, false, errors.New("session lacks managed native identity")
	}
	path := managedTurnPath(row.SessionID, clientRef)
	if body, err := os.ReadFile(path); err == nil {
		var prior ManagedTurn
		if json.Unmarshal(body, &prior) != nil || prior.V != managedTurnVersion || prior.ClientRef != clientRef {
			return ManagedTurn{}, false, errors.New("stored managed turn is invalid")
		}
		if prior.Prompt != prompt {
			return ManagedTurn{}, false, errors.New("client reference was already used for a different prompt")
		}
		return prior, true, nil
	}
	if cursor != "" {
		journal, err := LoadTranscriptJournal(row.SessionID)
		if err != nil {
			return ManagedTurn{}, false, fmt.Errorf("verify transcript cursor: %w", err)
		}
		if journal.Cursor != cursor {
			return ManagedTurn{}, false, fmt.Errorf("stale transcript cursor: have %s", journal.Cursor)
		}
	}
	turn := ManagedTurn{V: managedTurnVersion, SessionID: row.SessionID, ClientRef: clientRef,
		Prompt: prompt, Cursor: cursor, Status: "admitted", Harness: row.Harness,
		NativeID: nativeID, AdmittedAt: time.Now().UTC()}
	if err := storeManagedTurn(turn); err != nil {
		return ManagedTurn{}, false, err
	}
	return turn, false, nil
}

func UpdateManagedTurn(turn ManagedTurn, status, detail string) (ManagedTurn, error) {
	turn.Status, turn.Error = status, detail
	now := time.Now().UTC()
	if status == "dispatching" {
		turn.DispatchedAt = now
	} else {
		turn.FinishedAt = now
	}
	return turn, storeManagedTurn(turn)
}

// ReconcileManagedTurn turns an orphaned dispatch intent into an explicit
// uncertain outcome. It never retries the prompt: native acceptance may have
// happened before the former dispatcher disappeared.
func ReconcileManagedTurn(turn ManagedTurn) ManagedTurn {
	if turn.Status != "dispatching" {
		return turn
	}
	release, err := AcquireManagedWriter(turn.SessionID)
	if err != nil {
		return turn
	}
	release()
	recovered, err := UpdateManagedTurn(turn, "uncertain", "former dispatcher released ownership without recording a native outcome; prompt was not retried")
	if err != nil {
		return turn
	}
	return recovered
}

func storeManagedTurn(turn ManagedTurn) error {
	dir := managedTurnDir(turn.SessionID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create managed turn store: %w", err)
	}
	body, err := json.Marshal(turn)
	if err != nil {
		return err
	}
	if err := atomicfile.Write(managedTurnPath(turn.SessionID, turn.ClientRef), body, 0o600); err != nil {
		return fmt.Errorf("store managed turn: %w", err)
	}
	f, err := os.OpenFile(managedTurnJournal(turn.SessionID), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open managed turn journal: %w", err)
	}
	w := bufio.NewWriter(f)
	_, writeErr := w.Write(append(body, '\n'))
	if writeErr == nil {
		writeErr = w.Flush()
	}
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return fmt.Errorf("append managed turn journal: %w", writeErr)
	}
	return closeErr
}
