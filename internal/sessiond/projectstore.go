package sessiond

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// The durable session -> project assignment.
//
// WHY THIS IS NOT A FIELD IN THE SESSION SNAPSHOT, which is the first thing
// anybody will ask: the session-state spool is PRODUCER-OWNED. A snapshot is
// written by an Amplifier hook, by `muxterm session report`, by anything that
// follows docs/session-state-protocol.md -- and collect() DELETES the ones it
// will not publish (sessionstore.go). A producer knows its own pid and nothing
// about muxterm's containment model, and a file the daemon reclaims cannot
// carry a durable decision a human made. So the assignment lives here, keyed by
// session id, in a daemon-owned file that survives a restart, and is STAMPED
// onto the row on the way out -- exactly as PaneID, WorkspaceID, GoalID and
// Origin already are (sessionstore.go stampPane).
//
// THE ABSENCE OF A RECORD IS NOT A NULL. It means Inbox. That is the entire
// reason this store is cheap: an unfiled session costs zero bytes on disk, a
// fresh installation needs no seeding, and there is no migration to write when
// real projects arrive -- the file simply starts containing entries. Every read
// goes through Resolve, which is total and never returns an empty id.

// projectAssignmentsVersion is the schema version of the on-disk document.
// A file declaring a HIGHER version was written by a newer daemon; its entries
// are left strictly alone rather than half-understood, and every session falls
// back to the Inbox for this daemon's lifetime. Downgrading must not silently
// re-file somebody's work.
const projectAssignmentsVersion = 1

// projectAssignments maps session ids to the project that owns them.
//
// Its own mutex rather than Server.mu, following triggerStore and
// completionStore for the same reason: it is written from a control-protocol
// handler and read from the session-state ticker, and a file write must never
// be able to stall an attach or a broadcast.
type projectAssignments struct {
	mu   sync.Mutex
	path string
	// bySession holds ONLY non-default assignments. A session in the Inbox has
	// no entry, which is what keeps the file empty on a machine where nobody
	// has filed anything and makes "unassigned" free rather than stored.
	bySession      map[string]ProjectID
	writeErrLogged bool
	// frozen is set when the file on disk was written by a newer daemon. The
	// store then serves the Inbox for everything and refuses to write, so a
	// downgrade cannot destroy assignments it does not understand.
	frozen bool
}

// projectAssignmentsFile is the on-disk document.
type projectAssignmentsFile struct {
	V int `json:"v"`
	// Assignments is session id -> project id. A map rather than a list
	// because the only two operations are "what owns this session" and "this
	// session now belongs there", and both are single-key.
	Assignments map[string]ProjectID `json:"assignments"`
}

// ProjectAssignmentsPath returns the durable assignment store's location.
//
// Resolution order mirrors TriggersPath and CompletionsPath, for the same
// reasons: an explicit override for tests and odd deploys, then the
// XDG-derived default that keeps a dev daemon's filing out of the real
// installation's without either side being told which world it is in.
func ProjectAssignmentsPath() string {
	if override := os.Getenv("MUXTERM_PROJECT_ASSIGNMENTS_PATH"); override != "" {
		return override
	}
	return filepath.Join(snapshotDir(), "project-assignments.json")
}

// newProjectAssignments loads the store at path, tolerating every absence.
//
// A missing, unreadable or malformed file yields an EMPTY store rather than a
// failure to start, following newTriggerStore. The failure direction is safe
// here in a way it is not for triggers: losing an assignment files a session
// back into the Inbox, which is a visible, correctable inconvenience, whereas
// refusing to start the daemon over a corrupt sidecar would take every
// terminal on the machine down with it.
func newProjectAssignments(path string) *projectAssignments {
	s := &projectAssignments{path: path, bySession: map[string]ProjectID{}}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var doc projectAssignmentsFile
	if err := json.Unmarshal(data, &doc); err != nil {
		log.Printf("sessiond: project assignment store %s is unreadable (%v); "+
			"every session falls back to the %s", path, err, InboxProjectName)
		return s
	}
	if doc.V > projectAssignmentsVersion {
		log.Printf("sessiond: project assignment store %s declares schema v%d "+
			"(this daemon understands v%d); leaving it untouched and filing every session "+
			"in the %s", path, doc.V, projectAssignmentsVersion, InboxProjectName)
		s.frozen = true
		return s
	}
	for sessionID, projectID := range doc.Assignments {
		// A blank key or a blank value is not an assignment; it is a null
		// trying to get in through the decoder. Dropping it here is what keeps
		// the in-memory map free of the state the whole design forbids.
		if sessionID == "" || projectID.IsZero() {
			continue
		}
		s.bySession[sessionID] = projectID
	}
	return s
}

// Resolve returns the project that owns sessionID.
//
// TOTAL BY CONSTRUCTION: there is no session id, known or unknown, blank or
// malformed, for which this returns an empty project. A session with no record
// is in the Inbox; a session whose recorded project no longer exists is in the
// Inbox. The caller gets a container every time and never writes a fallback,
// which is what stops a null from being reintroduced one call site at a time.
func (s *projectAssignments) Resolve(sessionID string, known func(ProjectID) bool) ProjectID {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen {
		return InboxProjectID
	}
	return ResolveProjectID(string(s.bySession[sessionID]), known)
}

// Assign files a session into a project. This is the FILING GESTURE's one
// mutation -- there is no separate "unfile", "remove from project" or "clear"
// operation, because moving a session OUT of a project is moving it INTO the
// Inbox. One verb, both directions.
//
// Unlike Resolve, this is STRICT: an unknown project is an error rather than a
// silent fallback. A human picking a destination that does not exist has hit a
// bug, and quietly filing their session somewhere else would hide it.
func (s *projectAssignments) Assign(sessionID string, projectID ProjectID, known func(ProjectID) bool) error {
	if sessionID == "" {
		return fmt.Errorf("sessiond: cannot file a session with no id")
	}
	if projectID.IsZero() {
		return fmt.Errorf("%w: %q", ErrUnknownProject, projectID)
	}
	if known != nil && !known(projectID) {
		return fmt.Errorf("%w: %q", ErrUnknownProject, projectID)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen {
		return fmt.Errorf("sessiond: project assignments on disk were written by a newer daemon; refusing to overwrite them")
	}
	if projectID == InboxProjectID {
		// Filing INTO the Inbox deletes the record rather than storing one.
		// The Inbox is the default, so an explicit entry saying so would be
		// the same fact written twice -- and the version that can go stale.
		// This is also what makes the file empty again after a session is
		// moved back, instead of accumulating no-op rows forever.
		delete(s.bySession, sessionID)
	} else {
		s.bySession[sessionID] = projectID
	}
	s.persistLocked()
	return nil
}

// ReassignAll moves every session in one project to another.
//
// No caller in this slice: it exists because project DELETION will need it,
// and writing it now is what lets Delete stay a two-line function later
// instead of growing a re-filing loop that has to be got right under pressure.
// See invariant (d) in project.go.
func (s *projectAssignments) ReassignAll(from, to ProjectID) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen {
		return
	}
	changed := false
	for sessionID, id := range s.bySession {
		if id != from {
			continue
		}
		if to == InboxProjectID {
			delete(s.bySession, sessionID)
		} else {
			s.bySession[sessionID] = to
		}
		changed = true
	}
	if changed {
		s.persistLocked()
	}
}

// Forget drops a session's assignment, returning it to the Inbox.
//
// DELIBERATELY NOT CALLED FROM THE FINISHED-CLEAR PATH, and the reason is
// worth writing down because the opposite looks tidier. Clearing a finished
// session is UNDOABLE for a window (finished_clear.go): the undo restores the
// completion record, the spool snapshot and the hook registry entry together.
// An assignment dropped on clear would not come back with them, so undo would
// silently re-file the session into the Inbox -- a second, invisible effect of
// a button whose whole promise is that it can be taken back.
//
// Leaving the entry is harmless: it is keyed by session id, so it can only
// ever apply again to that same session. The file's size is bounded by the
// number of sessions a human has actually filed, not by how many have run.
func (s *projectAssignments) Forget(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen {
		return
	}
	if _, ok := s.bySession[sessionID]; !ok {
		return
	}
	delete(s.bySession, sessionID)
	s.persistLocked()
}

// persistLocked atomically rewrites the store, following persistLocked in
// trigger.go and completion.go so a reader never sees a half-written document.
//
// A write failure is logged once and otherwise swallowed, on triggerStore's
// reasoning: the in-memory map stays correct for this daemon's lifetime, and
// the worst outcome of losing it is that sessions appear in the Inbox again --
// which is the state the whole design treats as normal rather than as damage.
func (s *projectAssignments) persistLocked() {
	dir := filepath.Dir(s.path)
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		var data []byte
		data, err = json.Marshal(projectAssignmentsFile{
			V:           projectAssignmentsVersion,
			Assignments: s.bySession,
		})
		if err == nil {
			tmp := s.path + ".tmp"
			if err = os.WriteFile(tmp, data, 0o600); err == nil {
				if err = os.Rename(tmp, s.path); err != nil {
					os.Remove(tmp)
				}
			}
		}
	}
	if err != nil {
		if !s.writeErrLogged {
			s.writeErrLogged = true
			log.Printf("sessiond: could not persist project assignments %s: %v "+
				"(filing remains in memory for this daemon's lifetime; sessions return to the %s on restart)",
				s.path, err, InboxProjectName)
		}
		return
	}
	s.writeErrLogged = false
}
