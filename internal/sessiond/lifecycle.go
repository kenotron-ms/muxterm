package sessiond

// Lifecycle markers: the durable FACTS a lane leaves behind, and the only
// thing the Operator's completion notices are ever allowed to speak from.
//
// Two objects, deliberately never given the same name, because conflating them
// is exactly how a notice ends up looking like a human typed it:
//
//   - A lifecycle MARKER is the durable authoritative fact, written by this
//     daemon. Terminal markers already exist -- they are CompletionRecords,
//     written on pane exit (completion.go). Live markers are new, and they are
//     AttentionRecords, written by the transition watcher in
//     lifecycle_watch.go.
//   - An Operator TURN is the rendered synthetic entry in the Mission Control
//     conversation, GENERATED from a marker by the notice pump in
//     internal/server/lifecycle_notices.go. A turn is never a marker.
//
// WHY LIVE MARKERS HAVE TO EXIST AT ALL. A `/goal` lane does not exit when it
// reaches a verdict: goallane.go runs `amplifier run "/goal ..."` and then
// EXECS into `amplifier resume`, in the same pane and the same OS process
// session. The pane never closes, so handlePaneExit never runs, so no
// CompletionRecord is ever written for the single most common "finished"
// case this feature exists to report. Watching for the declared-state
// TRANSITION is the only way to see it. The same is true of `blocked`, which
// is not a terminal state at all and can never wait for an exit.
//
// SINGLE WRITER. sessiond writes both stores and nothing else does, which is
// the same rule internal/server/prs_store.go already states about
// completions.json ("sessiond owns completions.json"). The server side reads
// these files and keeps its own separate delivery ledger; it never writes
// here. That is what keeps two processes off one file.
//
// LOCAL MACHINE ONLY. Both stores live under this host's XDG data dir and
// describe this host's panes. A remote daemon has its own, and nothing in V1
// reads across the transport -- see the notice pump's local-only note.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Lifecycle notice kinds. These five words are the whole human-facing
// vocabulary, and each one means exactly one evidence tier:
//
//	finished   -- the session DECLARED done. Nothing else earns this word.
//	failed     -- the session declared failed, or declared nothing and its
//	              process exited non-zero.
//	stopped    -- the session declared stopped: it ended deliberately without
//	              reaching a verdict.
//	unverified -- a clean exit with no declaration at all. Something ran and
//	              left. This covers the crash-before-declaring case AND the
//	              case where the harness never had a reporting hook wired up;
//	              the honest sentence is the same either way.
//	blocked    -- a live session is waiting for a human.
//
// The conservative direction is always "not finished". A clean exit code is
// not a claim that any work was done, and this vocabulary exists to stop a
// notice from re-introducing that bug one layer above completionOutcome.
const (
	NoticeFinished   = "finished"
	NoticeFailed     = "failed"
	NoticeStopped    = "stopped"
	NoticeUnverified = "unverified"
	NoticeBlocked    = "blocked"
)

// NoticeKind maps a completion outcome onto the notice vocabulary.
//
// It is a rename, not a re-derivation: the outcome was already decided by
// completionOutcome against the declaration and the exit code, and this must
// never second-guess it by reading prose.
func NoticeKind(outcome string) string {
	switch outcome {
	case CompletionCompleted:
		return NoticeFinished
	case CompletionFailed:
		return NoticeFailed
	case CompletionStopped:
		return NoticeStopped
	default:
		return NoticeUnverified
	}
}

// validNoticeKind reports whether kind is one of the five words.
func validNoticeKind(kind string) bool {
	switch kind {
	case NoticeFinished, NoticeFailed, NoticeStopped, NoticeUnverified, NoticeBlocked:
		return true
	}
	return false
}

// attentionRecordVersion is the schema version written into every record,
// following completionRecordVersion's rule exactly: a record declaring a
// higher version was written by a newer daemon and is kept on disk but not
// published, because a reader that does not understand a shape should decline
// it rather than guess.
const attentionRecordVersion = 1

// attentionCapacity bounds the store, for completionCapacity's reason: an
// unbounded log written by a daemon that watches every session transition is a
// disk-filling bug waiting for a busy machine.
const attentionCapacity = 200

// AttentionRecord is one live lifecycle transition a session declared about
// itself while its pane was still alive.
//
// JSON field names are a persisted format. Add fields, never rename them.
type AttentionRecord struct {
	V  int    `json:"v"`
	ID string `json:"id"`

	// SessionID is the declaring session. Unlike a CompletionRecord -- which
	// can describe a pane that never hosted a declaring session -- an
	// AttentionRecord cannot exist without one, because a transition is by
	// definition something a session said about itself.
	SessionID   string `json:"sessionId"`
	ExecutionID string `json:"executionId,omitempty"`
	TurnID      string `json:"turnId,omitempty"`

	// Kind is one of the five notice words. `unverified` is impossible here:
	// it means "exited with no declaration", and this record only ever comes
	// from a declaration.
	Kind string `json:"kind"`

	// FromState is the state this session was in on the previous observation,
	// kept so the transition is auditable rather than merely asserted.
	FromState string `json:"fromState,omitempty"`

	// DeclaredWaitingFor mirrors the live SessionState.WaitingFor for a
	// `blocked` record. It is the single most valuable thing a blocked notice
	// can say, so it is captured at observation time rather than looked up
	// later against a session that may have moved on.
	DeclaredWaitingFor string `json:"declaredWaitingFor,omitempty"`

	// Where and who, copied at observation time for the same reason
	// CompletionRecord copies them: by the time anyone reads this, the pane
	// may be gone and the names unresolvable.
	WorkspaceID   string `json:"workspaceId,omitempty"`
	WorkspaceName string `json:"workspaceName,omitempty"`
	PaneID        int    `json:"paneId,omitempty"`
	Harness       string `json:"harness,omitempty"`
	Project       string `json:"project,omitempty"`
	Name          string `json:"name,omitempty"`
	Label         string `json:"label,omitempty"`
	Mode          string `json:"mode,omitempty"`
	DoneMeans     string `json:"doneMeans,omitempty"`
	Doing         string `json:"doing,omitempty"`

	ObservedAt int64 `json:"observedAt"`

	// Resolved marks a record whose condition went away before anyone acted on
	// it -- a lane that un-blocked by itself. The record is KEPT (it is
	// history) but the notice pump skips it, because telling a human that
	// something needs them when it no longer does is worse than silence.
	Resolved bool `json:"resolved,omitempty"`
}

// LaneName is what a notice calls this lane. Same fallback ladder as
// CompletionRecord.LaneName: every rung is an identifier a human can act on.
func (r AttentionRecord) LaneName() string {
	for _, candidate := range []string{r.WorkspaceName, r.Label, r.Name} {
		if strings.TrimSpace(candidate) != "" {
			return strings.TrimSpace(candidate)
		}
	}
	if r.WorkspaceID != "" {
		return fmt.Sprintf("%s pane %d", r.WorkspaceID, r.PaneID)
	}
	return r.SessionID
}

// AttentionPath returns the durable live-marker log's location.
//
// Resolution order mirrors CompletionsPath's, for its reasons: an explicit
// override for tests and odd deploys, then the XDG data dir, which is what
// keeps a dev daemon's markers out of the real ones without either side being
// told which world it is in.
func AttentionPath() string {
	if override := os.Getenv("MUXTERM_ATTENTION_PATH"); override != "" {
		return override
	}
	return filepath.Join(snapshotDir(), "attention.json")
}

// attentionFile is the on-disk document.
type attentionFile struct {
	V       int               `json:"v"`
	Records []AttentionRecord `json:"records"`
}

// attentionStore holds every live marker, in memory and on disk. Its own
// mutex, for completionStore's reason: it is written from the session-state
// ticker and read from request handlers, and a file write must never stall
// either.
type attentionStore struct {
	mu             sync.Mutex
	path           string
	records        []AttentionRecord
	writeErrLogged bool
}

// newAttentionStore loads the log at path, tolerating every kind of absence. A
// missing, unreadable, or malformed file yields an EMPTY store rather than a
// failure to start, exactly as newCompletionStore does.
func newAttentionStore(path string) *attentionStore {
	s := &attentionStore{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var doc attentionFile
	if err := json.Unmarshal(data, &doc); err != nil {
		return s
	}
	for _, r := range doc.Records {
		if r.V > attentionRecordVersion || r.ID == "" || r.SessionID == "" {
			continue
		}
		if !validNoticeKind(r.Kind) {
			continue
		}
		s.records = append(s.records, r)
	}
	s.sortLocked()
	return s
}

// Append records a transition and persists the log, returning the stored
// record with its assigned id.
func (s *attentionStore) Append(r AttentionRecord) AttentionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	r.V = attentionRecordVersion
	if r.ID == "" {
		r.ID = fmt.Sprintf("%s-%s-%d", r.SessionID, r.Kind, r.ObservedAt)
	}
	// Two transitions for the same session and kind inside one second would
	// otherwise collide, and an id that can repeat is an id that can mark the
	// wrong record delivered.
	for s.indexOfLocked(r.ID) >= 0 {
		r.ID += "x"
	}
	s.records = append(s.records, r)
	s.sortLocked()
	if len(s.records) > attentionCapacity {
		s.records = s.records[len(s.records)-attentionCapacity:]
	}
	s.persistLocked()
	return r
}

// Unresolved returns every record whose condition still stands, oldest first.
// This is what the notice pump reads.
func (s *attentionStore) Unresolved() []AttentionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]AttentionRecord, 0, len(s.records))
	for _, r := range s.records {
		if !r.Resolved {
			out = append(out, r)
		}
	}
	return out
}

// All returns every record, oldest first.
func (s *attentionStore) All() []AttentionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]AttentionRecord(nil), s.records...)
}

// ResolveBlocked marks this session's outstanding `blocked` records as no
// longer standing, and reports whether anything changed.
//
// Only `blocked` is resolvable. A lane that finished did not un-finish; a
// blocked lane that a human unblocked genuinely no longer needs them, and a
// notice that arrives after the fact is noise a human has to re-check.
func (s *attentionStore) ResolveBlocked(sessionID string) bool {
	if sessionID == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for i := range s.records {
		if s.records[i].SessionID == sessionID &&
			s.records[i].Kind == NoticeBlocked &&
			!s.records[i].Resolved {
			s.records[i].Resolved = true
			changed = true
		}
	}
	if changed {
		s.persistLocked()
	}
	return changed
}

func (s *attentionStore) indexOfLocked(id string) int {
	for i := range s.records {
		if s.records[i].ID == id {
			return i
		}
	}
	return -1
}

// sortLocked keeps the log in observation order so "newest" is the tail and
// the capacity trim drops the oldest. Ties break on id so the order is total.
func (s *attentionStore) sortLocked() {
	sort.SliceStable(s.records, func(i, j int) bool {
		if s.records[i].ObservedAt != s.records[j].ObservedAt {
			return s.records[i].ObservedAt < s.records[j].ObservedAt
		}
		return s.records[i].ID < s.records[j].ID
	})
}

// persistLocked atomically rewrites the log, following completionStore's
// tmp+rename discipline so a reader never sees a half-written document.
//
// A write failure is logged once and otherwise swallowed: this runs on the
// session-state ticker, and a daemon that stops ticking because a log could
// not be written would trade a reporting problem for a dead home view.
func (s *attentionStore) persistLocked() {
	dir := filepath.Dir(s.path)
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		var data []byte
		data, err = json.Marshal(attentionFile{V: attentionRecordVersion, Records: s.records})
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
			log.Printf("sessiond: could not persist attention log %s: %v (live lifecycle markers remain in memory for this daemon's lifetime)", s.path, err)
		}
		return
	}
	s.writeErrLogged = false
}
