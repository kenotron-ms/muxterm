package sessiond

type hookSessionBackup struct {
	sessions map[string]sessionRecord
	events   map[string]string
}

// takeFinishedSession removes one hook record so projectAll cannot resurrect a
// manually cleared row on the next daemon start. The caller has already
// observed a terminal Fleet row and verified that neither the registry nor
// the spool identifies a live process. The registry may still say "working"
// when the process died after this daemon started, so its declared state
// cannot be used as a second deletion gate here.
func (s *hookReportStore) takeFinishedSession(sessionID string) (hookSessionBackup, error) {
	backup := hookSessionBackup{sessions: map[string]sessionRecord{}, events: map[string]string{}}
	reg, err := s.loadRegistry()
	if err != nil {
		return backup, err
	}
	for alias, record := range reg.Sessions {
		if record.Row.SessionID != sessionID {
			continue
		}
		backup.sessions[alias] = record
		delete(reg.Sessions, alias)
	}
	if len(backup.sessions) == 0 {
		return backup, nil
	}
	for event, id := range reg.Events {
		if id == sessionID {
			backup.events[event] = id
			delete(reg.Events, event)
		}
	}
	return backup, s.saveRegistry(reg)
}

func (s *hookReportStore) restoreFinishedSession(backup hookSessionBackup) error {
	if len(backup.sessions) == 0 {
		return nil
	}
	reg, err := s.loadRegistry()
	if err != nil {
		return err
	}
	for alias, record := range backup.sessions {
		reg.Sessions[alias] = record
	}
	for event, id := range backup.events {
		reg.Events[event] = id
	}
	return s.saveRegistry(reg)
}
