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
	return row.State == SessionStateDone || (row.State == SessionStateStopped && row.Mode != ModeAutonomous)
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
	for _, row := range excludeOperatorSession(rows) {
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

	hook, err := s.hookReports.takeFinishedSession(sessionID)
	if err != nil {
		return "", fmt.Errorf("remove durable hook session: %w", err)
	}
	completions := s.completions.takeFinished(sessionID)
	snapshot := finishedSnapshotBackup{}
	if ValidSessionID(sessionID) {
		snapshot.path = filepath.Join(s.sessions.dir, sessionID+".json")
		if body, readErr := os.ReadFile(snapshot.path); readErr == nil {
			snapshot.body = body
			if removeErr := os.Remove(snapshot.path); removeErr != nil {
				s.completions.restore(completions)
				_ = s.hookReports.restoreFinishedSession(hook)
				return "", fmt.Errorf("remove session snapshot: %w", removeErr)
			}
		} else if !os.IsNotExist(readErr) {
			s.completions.restore(completions)
			_ = s.hookReports.restoreFinishedSession(hook)
			return "", fmt.Errorf("read session snapshot: %w", readErr)
		}
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
