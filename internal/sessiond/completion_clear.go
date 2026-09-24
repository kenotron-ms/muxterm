package sessiond

// takeFinished removes every completion that projects as sessionID, but only
// when its lifecycle is clearable. Failed completions stay first-class Fleet
// alarms and cannot be removed through the finished-lane operation.
func (s *completionStore) takeFinished(sessionID string) []CompletionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	var taken []CompletionRecord
	kept := s.records[:0]
	for _, record := range s.records {
		projectedID := record.SessionID
		if projectedID == "" {
			projectedID = "completion:" + record.ID
		}
		if projectedID == sessionID && record.FleetState() != SessionStateFailed {
			taken = append(taken, record)
			continue
		}
		kept = append(kept, record)
	}
	if len(taken) == 0 {
		return nil
	}
	s.records = kept
	s.persistLocked()
	return taken
}

func (s *completionStore) restore(records []CompletionRecord) {
	if len(records) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range records {
		if s.indexOfLocked(record.ID) < 0 {
			s.records = append(s.records, record)
		}
	}
	s.sortLocked()
	s.persistLocked()
}
