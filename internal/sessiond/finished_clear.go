package sessiond

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/google/uuid"
)

const finishedClearUndoWindow = 10 * time.Second

type finishedSnapshotBackup struct {
	path string
	body []byte
}

type finishedClearUndo struct {
	sessionID   string
	completions []CompletionRecord
	snapshot    finishedSnapshotBackup
	hook        hookSessionBackup
	expires     time.Time
}

func clearableFinished(row SessionState) bool {
	return sessionStateIsTerminal(row.State)
}

func (s *Server) clearFinished(sessionID string) (string, error) {
	s.finishedClearOpMu.Lock()
	defer s.finishedClearOpMu.Unlock()
	if sessionID == "" {
		return "", fmt.Errorf("session id is required")
	}
	rows, ok := s.sessions.collect(func() map[int]paneRef {
		return paneOwners(s.reg.snapshotView())
	})
	if !ok {
		return "", fmt.Errorf("fleet state is unavailable")
	}
	rows = mergeCompletionRows(rows, s.completions.Pending())
	found := false
	for _, row := range rows {
		if row.SessionID != sessionID {
			continue
		}
		found = true
		if !clearableFinished(row) {
			return "", fmt.Errorf("session %q is not finished", sessionID)
		}
		break
	}
	if !found {
		return "", fmt.Errorf("finished session %q was not found", sessionID)
	}
	// A terminal declaration alone is not proof that its process has exited.
	// Check both durable sources by session identity, never recycled pane IDs.
	live, err := s.finishedSessionProcessLive(sessionID)
	if err != nil {
		return "", err
	}
	if live {
		return "", fmt.Errorf("session %q still has a live process", sessionID)
	}

	hook, err := s.hookReports.takeFinishedSession(sessionID)
	if err != nil {
		return "", fmt.Errorf("remove durable hook session: %w", err)
	}
	completions := s.completions.takeFinished(sessionID)
	snapshot, err := s.takeFinishedSnapshot(sessionID)
	if err != nil {
		s.completions.restore(completions)
		_ = s.hookReports.restoreFinishedSession(hook)
		return "", err
	}
	if len(completions) == 0 && len(snapshot.body) == 0 && len(hook.sessions) == 0 {
		return "", fmt.Errorf("finished session %q had no removable record", sessionID)
	}

	token := uuid.NewString()
	undo := finishedClearUndo{sessionID: sessionID, completions: completions, snapshot: snapshot, hook: hook, expires: time.Now().Add(finishedClearUndoWindow)}
	s.finishedClearMu.Lock()
	s.finishedClearUndos[token] = undo
	s.finishedClearMu.Unlock()
	time.AfterFunc(finishedClearUndoWindow, func() {
		s.finishedClearMu.Lock()
		delete(s.finishedClearUndos, token)
		s.finishedClearMu.Unlock()
	})
	s.rearmSessionState()
	return token, nil
}

// takeFinishedSnapshot atomically moves the exact file being cleared out of
// the producer's path. Producers publish by rename, so a new report arriving
// after this move creates a new path that this operation never removes.
func (s *Server) takeFinishedSnapshot(sessionID string) (finishedSnapshotBackup, error) {
	backup := finishedSnapshotBackup{}
	if !ValidSessionID(sessionID) {
		return backup, nil
	}
	backup.path = filepath.Join(s.sessions.dir, sessionID+".json")
	staged := backup.path + "." + uuid.NewString() + ".clear"
	if err := os.Rename(backup.path, staged); err != nil {
		if os.IsNotExist(err) {
			return backup, nil
		}
		return backup, fmt.Errorf("stage session snapshot: %w", err)
	}
	restore := func() error {
		if _, err := os.Stat(backup.path); err != nil {
			if !os.IsNotExist(err) {
				return err
			}
			if linkErr := os.Link(staged, backup.path); linkErr != nil {
				return linkErr // keep the staged file if restoration failed
			}
		}
		return os.Remove(staged)
	}
	body, err := os.ReadFile(staged)
	if err != nil {
		if restoreErr := restore(); restoreErr != nil {
			return backup, fmt.Errorf("read staged snapshot: %w; restore failed: %v", err, restoreErr)
		}
		return backup, fmt.Errorf("read staged session snapshot: %w", err)
	}
	snap, ok := readSessionSnapshot(staged)
	if !ok || snap.SessionID != sessionID ||
		(processLive(snap.PID) && snapshotPIDMatches(snap)) {
		if restoreErr := restore(); restoreErr != nil {
			return backup, fmt.Errorf("session %q changed or is live; restore failed: %w", sessionID, restoreErr)
		}
		return backup, fmt.Errorf("session %q changed or still has a live process", sessionID)
	}
	if err := os.Remove(staged); err != nil {
		if restoreErr := restore(); restoreErr != nil {
			return backup, fmt.Errorf("remove staged snapshot: %w; restore failed: %v", err, restoreErr)
		}
		return backup, fmt.Errorf("remove staged session snapshot: %w", err)
	}
	backup.body = body
	return backup, nil
}

func (s *Server) finishedSessionProcessLive(sessionID string) (bool, error) {
	reg, err := s.hookReports.loadRegistry()
	if err != nil {
		return false, fmt.Errorf("verify hook session process: %w", err)
	}
	for _, record := range reg.Sessions {
		if record.Row.SessionID == sessionID && hookRecordProcessLive(record) {
			return true, nil
		}
	}
	if ValidSessionID(sessionID) {
		path := filepath.Join(s.sessions.dir, sessionID+".json")
		if _, err := os.Stat(path); err == nil {
			snap, ok := readSessionSnapshot(path)
			if !ok {
				return false, fmt.Errorf("cannot verify session snapshot %q", sessionID)
			}
			if processLive(snap.PID) && snapshotPIDMatches(snap) {
				return true, nil
			}
		} else if !os.IsNotExist(err) {
			return false, fmt.Errorf("stat session snapshot: %w", err)
		}
	}
	return false, nil
}

func (s *Server) undoFinishedClear(token string) (string, error) {
	s.finishedClearOpMu.Lock()
	defer s.finishedClearOpMu.Unlock()
	if token == "" {
		return "", fmt.Errorf("undo token is required")
	}
	s.finishedClearMu.Lock()
	undo, ok := s.finishedClearUndos[token]
	delete(s.finishedClearUndos, token)
	s.finishedClearMu.Unlock()
	if !ok || time.Now().After(undo.expires) {
		return "", fmt.Errorf("finished-session undo expired")
	}
	if len(undo.snapshot.body) > 0 {
		if err := os.MkdirAll(filepath.Dir(undo.snapshot.path), 0o700); err != nil {
			return "", fmt.Errorf("restore session snapshot directory: %w", err)
		}
		tmp := undo.snapshot.path + ".undo.tmp"
		if err := os.WriteFile(tmp, undo.snapshot.body, 0o600); err != nil {
			return "", fmt.Errorf("restore session snapshot: %w", err)
		}
		if err := os.Rename(tmp, undo.snapshot.path); err != nil {
			_ = os.Remove(tmp)
			return "", fmt.Errorf("publish restored session snapshot: %w", err)
		}
	}
	s.completions.restore(undo.completions)
	if err := s.hookReports.restoreFinishedSession(undo.hook); err != nil {
		return "", fmt.Errorf("restore durable hook session: %w", err)
	}
	s.rearmSessionState()
	return undo.sessionID, nil
}

func (s *Server) rearmSessionState() {
	s.mu.Lock()
	s.sessions.rearmLocked()
	s.mu.Unlock()
}
