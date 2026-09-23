package mcp

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	"github.com/kenotron-ms/muxterm/internal/atomicfile"
	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// TranscriptJournal is muxterm's durable, bounded projection of a native
// transcript. Native files remain authoritative for import; browser replay is
// served from this journal and therefore survives native-file removal.
type TranscriptJournal struct {
	V          int                              `json:"v"`
	SessionID  string                           `json:"sessionId"`
	Harness    string                           `json:"harness"`
	Path       string                           `json:"path,omitempty"`
	Cursor     string                           `json:"cursor"`
	ImportedAt time.Time                        `json:"importedAt"`
	Truncated  bool                             `json:"truncated,omitempty"`
	Archived   bool                             `json:"archived,omitempty"`
	Detached   bool                             `json:"detached,omitempty"`
	Error      string                           `json:"error,omitempty"`
	Turns      []sessiond.SessionTranscriptTurn `json:"turns"`
}

func journalPath(sessionID string) string {
	name := uuid.NewSHA1(uuid.NameSpaceOID, []byte(sessionID)).String() + ".json"
	return filepath.Join(sessiond.HookReportRoot(), "journals", name)
}

// LoadTranscriptJournal replays a previously committed import.
func LoadTranscriptJournal(sessionID string) (TranscriptJournal, error) {
	var j TranscriptJournal
	body, err := os.ReadFile(journalPath(sessionID))
	if err != nil {
		return j, err
	}
	if err := json.Unmarshal(body, &j); err != nil {
		return j, fmt.Errorf("parse transcript journal: %w", err)
	}
	if j.V != 1 || j.SessionID != sessionID {
		return j, fmt.Errorf("invalid transcript journal for %q", sessionID)
	}
	if j.Turns == nil {
		j.Turns = []sessiond.SessionTranscriptTurn{}
	}
	return j, nil
}

// ImportTranscriptJournal performs one bounded native read and atomically
// replaces the durable projection. It is called only by an explicit read/detail
// request; no timer or background native-state poll exists.
func ImportTranscriptJournal(reader TranscriptReader, row sessiond.SessionState, last int) (TranscriptJournal, error) {
	previous, _ := LoadTranscriptJournal(row.SessionID)
	tr, err := ReadTranscriptVia(reader, row, last)
	if err != nil {
		previous.V = 1
		previous.SessionID = row.SessionID
		previous.Harness = row.Harness
		previous.ImportedAt = time.Now().UTC()
		previous.Detached = row.PaneID == 0 || row.WorkspaceID == ""
		previous.Error = err.Error()
		if saveErr := saveTranscriptJournal(previous); saveErr != nil {
			return previous, fmt.Errorf("%v; recording transcript storage error: %w", err, saveErr)
		}
		return previous, err
	}
	return StoreTranscriptJournal(row, tr)
}

// StoreTranscriptJournal commits an already bounded native import. The CLI
// uses this after its local read; the browser path uses ImportTranscriptJournal.
func StoreTranscriptJournal(row sessiond.SessionState, tr Transcript) (TranscriptJournal, error) {
	previous, _ := LoadTranscriptJournal(row.SessionID)
	turns := make([]sessiond.SessionTranscriptTurn, 0, len(tr.Turns))
	for _, t := range tr.Turns {
		turns = append(turns, sessiond.SessionTranscriptTurn{Role: t.Role, Text: t.Text, TS: t.TS, Tool: t.Tool})
	}
	cursorBody, _ := json.Marshal(struct {
		Harness, Path string
		Truncated     bool
		Turns         []sessiond.SessionTranscriptTurn
	}{tr.Harness, tr.Path, tr.Truncated, turns})
	cursor := fmt.Sprintf("%x", sha256.Sum256(cursorBody))
	j := TranscriptJournal{V: 1, SessionID: row.SessionID, Harness: tr.Harness, Path: tr.Path,
		Cursor: cursor, ImportedAt: time.Now().UTC(), Truncated: tr.Truncated,
		Archived: previous.Archived,
		Detached: row.PaneID == 0 || row.WorkspaceID == "", Turns: turns}
	if err := saveTranscriptJournal(j); err != nil {
		return j, fmt.Errorf("store transcript journal: %w", err)
	}
	return j, nil
}

// SetTranscriptArchived changes only conversation visibility metadata. It
// never removes the journal or conflates a stopped execution with an archive.
func SetTranscriptArchived(sessionID string, archived bool) (TranscriptJournal, error) {
	j, err := LoadTranscriptJournal(sessionID)
	if err != nil {
		return j, err
	}
	previous := j.Archived
	j.Archived = archived
	if err := saveTranscriptJournal(j); err != nil {
		j.Archived = previous
		return j, fmt.Errorf("store transcript archive state: %w", err)
	}
	return j, nil
}

func saveTranscriptJournal(j TranscriptJournal) error {
	dir := filepath.Dir(journalPath(j.SessionID))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	body, err := json.Marshal(j)
	if err != nil {
		return err
	}
	return atomicfile.Write(journalPath(j.SessionID), body, 0o600)
}
