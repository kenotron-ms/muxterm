package sessiond

// Lane completion records: what survives a lane after its pane is gone.
//
// The problem this solves is narrow and was observed in production. An agent
// lane runs to completion in a pane, its process exits, handlePaneExit closes
// the pane, ReapIfEmpty removes the now-empty workspace, and the whole result
// -- the verdict, the PR it opened, its final report -- disappears before any
// human sees it. Success and crash look identical from outside: both are a
// workspace that is no longer there.
//
// A completion record is the durable artifact written at the moment of exit,
// by the pane lifecycle itself. It is deliberately NOT something an agent has
// to remember to report: the record is produced whether the lane succeeded,
// crashed on its first turn, or was killed, because the thing that writes it
// is the exit path, not the agent.
//
// WHERE IT LIVES, AND WHY. snapshotDir() -- $XDG_DATA_HOME/muxterm, the same
// directory as restore-snapshot.json. Two reasons, and the alternative is
// worse in both:
//
//   - It is the only DURABLE location muxterm already owns. The session-state
//     spool (SessionStateDir, under $XDG_RUNTIME_DIR) is tmpfs, and worse, it
//     is actively reclaimed: sessionstore.collect deletes an ending whose pane
//     has gone, which is precisely the case a completion record exists to
//     preserve. Writing the record there would hand it to the code that
//     deletes it.
//   - It is XDG-derived, so a dev instance with its own XDG_DATA_HOME cannot
//     see or corrupt the real one -- the same isolation property
//     restore-snapshot.json already relies on.
//
// The file is a single bounded document rather than a directory of files: one
// atomic tmp+rename per write, one read at startup, no directory scan, and a
// hard ceiling on how much history can accumulate. Everything muxterm persists
// is already shaped this way.

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// completionRecordVersion is the schema version written into every record. A
// record declaring a higher version was written by a newer daemon and is kept
// on disk but not published, on the same reasoning as sessionSnapshotVersion:
// a reader that does not understand a shape should decline it, not guess.
const completionRecordVersion = 1

// completionCapacity bounds the store. A completion record is a few kilobytes
// (its largest field is a capped output tail), and this is history rather than
// live state, so the ceiling is generous but real: an unbounded log written by
// the daemon on every pane exit is a disk-filling bug waiting for a machine
// that runs a lot of lanes.
const completionCapacity = 200

// completionOutputBytes bounds the captured final output. The visible screen
// of a large terminal is roughly 200x60 -- about 12KB -- and the tail is what
// conveys a result; the top of a screen that scrolled is not more informative
// for being longer.
const completionOutputBytes = 8 << 10

// completionSummaryBytes bounds the one-line-ish summary that rides on the
// workspace list to the sidebar. The full output stays in the record.
const completionSummaryBytes = 240

// Completion outcomes. These are NOT the session lifecycle states: a lifecycle
// state is what a session DECLARED about itself, and an outcome is what the
// daemon is willing to assert having watched the process exit.
//
// The distinction is the entire trustworthiness of this feature. A lane that
// crashed during startup and a lane that finished its work both end with a
// pane whose process is gone. Only a session that declared `done` before
// exiting earns CompletionCompleted. Everything else is reported as what it
// actually is, and the conservative direction is always "not finished".
const (
	// CompletionCompleted: the session declared `done`. It reached its own
	// stop condition and said so.
	CompletionCompleted = "completed"
	// CompletionFailed: the session declared `failed`, or it declared nothing
	// and its process exited non-zero. A startup crash lands here.
	CompletionFailed = "failed"
	// CompletionStopped: the session declared `stopped` -- it ended its turn
	// without reaching a verdict.
	CompletionStopped = "stopped"
	// CompletionUnknown: the process exited cleanly but no session ever
	// declared an ending. Something ran and left without a verdict. This is
	// deliberately not CompletionCompleted; a clean exit code is not a claim
	// that any work was finished.
	CompletionUnknown = "unknown"
)

// CompletionRecord is one lane's durable result: everything a human needs to
// know that the lane ended and how, after its pane and workspace are gone.
//
// JSON field names are a persisted format. Add fields, never rename them.
type CompletionRecord struct {
	V  int    `json:"v"`
	ID string `json:"id"`

	// Where it ran. WorkspaceID and PaneID may name things that no longer
	// exist -- that is the point of the record -- so WorkspaceName and
	// PaneTitle are captured alongside them rather than looked up later.
	WorkspaceID   string `json:"workspaceId"`
	WorkspaceName string `json:"workspaceName,omitempty"`
	PaneID        int    `json:"paneId"`
	PaneTitle     string `json:"paneTitle,omitempty"`

	// Who ran. All copied from the session's own declaration when it made
	// one; all empty for a pane that never hosted a declaring session.
	SessionID string `json:"sessionId,omitempty"`
	Harness   string `json:"harness,omitempty"`
	Project   string `json:"project,omitempty"`
	Name      string `json:"name,omitempty"`
	Label     string `json:"label,omitempty"`
	Mode      string `json:"mode,omitempty"`
	DoneMeans string `json:"doneMeans,omitempty"`
	Doing     string `json:"doing,omitempty"`

	// How it ended. Outcome is the daemon's assertion; DeclaredState is the
	// raw thing the session said (empty when it said nothing), kept so the
	// derivation is auditable rather than merely asserted.
	Outcome       string `json:"outcome"`
	DeclaredState string `json:"declaredState,omitempty"`
	ExitCode      int    `json:"exitCode"`
	RuntimeMs     int64  `json:"runtimeMs,omitempty"`
	EndedAt       int64  `json:"endedAt"`

	// What it produced. PR is the whole reason the fleet's `pr` field can
	// finally be non-zero -- see completionPRFrom.
	PR     int    `json:"pr,omitempty"`
	PRURL  string `json:"prUrl,omitempty"`
	Output string `json:"output,omitempty"`

	// Acknowledged records that a human has dismissed this completion. The
	// record is KEPT once acknowledged (it is history), but it stops holding
	// its workspace open and stops appearing as a pending fleet row.
	Acknowledged bool `json:"acknowledged,omitempty"`
}

// Summary is the short human-readable line the sidebar shows and the fleet row
// carries in Doing. It leads with the outcome because that is the question,
// and names the PR when there is one because that is the artifact.
func (r CompletionRecord) Summary() string {
	var b strings.Builder
	switch r.Outcome {
	case CompletionCompleted:
		b.WriteString("finished")
	case CompletionFailed:
		b.WriteString("failed")
	case CompletionStopped:
		b.WriteString("stopped without a verdict")
	default:
		b.WriteString("exited without a verdict")
	}
	if r.ExitCode != 0 {
		fmt.Fprintf(&b, " (exit %d)", r.ExitCode)
	}
	if r.PR > 0 {
		fmt.Fprintf(&b, " - PR #%d", r.PR)
	}
	if tail := completionFirstLine(r.Output); tail != "" {
		b.WriteString(" - ")
		b.WriteString(tail)
	}
	return truncateRunes(b.String(), completionSummaryBytes)
}

// LaneName is what the notification calls this lane. Every fallback is a real
// identifier a user can act on; the last resort still names the pane, because
// "a lane finished" without saying which is the bug being fixed.
func (r CompletionRecord) LaneName() string {
	for _, candidate := range []string{r.WorkspaceName, r.Label, r.Name, r.PaneTitle} {
		if strings.TrimSpace(candidate) != "" {
			return strings.TrimSpace(candidate)
		}
	}
	return fmt.Sprintf("%s pane %d", r.WorkspaceID, r.PaneID)
}

// FleetState maps an outcome onto the five-state session vocabulary so a
// finished lane can appear in the fleet beside live ones.
//
// CompletionUnknown maps to `stopped`, not `failed`: stopped is the ABSENCE of
// a verdict, which is exactly what an undeclared clean exit is, and calling it
// failed would invent a verdict in the other direction. See SessionState's own
// comment on why Failed is a verdict and Stopped is not.
func (r CompletionRecord) FleetState() string {
	switch r.Outcome {
	case CompletionCompleted:
		return SessionStateDone
	case CompletionFailed:
		return SessionStateFailed
	default:
		return SessionStateStopped
	}
}

// completionOutcome derives the outcome from what the session declared and
// what the kernel reported, in that order of authority.
//
// declared is the session's own last state, or "" when no session ever wrote
// one for this pane. The rule is one-directional on purpose: a declaration can
// only ever be believed about ITSELF, and the absence of one can never be read
// as success.
func completionOutcome(declared string, exitCode int) string {
	switch declared {
	case SessionStateDone:
		return CompletionCompleted
	case SessionStateFailed:
		return CompletionFailed
	case SessionStateStopped:
		return CompletionStopped
	}
	// No terminal declaration. A session that was `working` when its process
	// died did not finish, whatever the exit code says.
	if exitCode != 0 {
		return CompletionFailed
	}
	return CompletionUnknown
}

// completionPRPattern matches a GitHub pull-request URL in terminal output.
//
// This is how the fleet's `pr` field stops being permanently zero. Producers
// CAN declare a PR number (`muxterm session report --pr`), and that
// declaration wins when present -- but no shipped producer does, and requiring
// an agent to remember is exactly the reporting-by-good-intentions this
// feature exists to remove. A `gh pr create` prints its URL, so the pane's own
// final output is first-hand evidence rather than a promise.
//
// Deliberately strict: a full URL with a numeric id, not a bare "#123", which
// appears in prose constantly and would attach wrong numbers to lanes.
var completionPRPattern = regexp.MustCompile(`https?://[A-Za-z0-9.-]*github[A-Za-z0-9.-]*/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/([0-9]+)`)

// completionPRFrom extracts the pull request a lane produced.
//
// The LAST match in the output wins: a lane that discusses an existing PR and
// then opens its own should be attributed to the one it opened, and output is
// chronological.
func completionPRFrom(text string) (int, string) {
	matches := completionPRPattern.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return 0, ""
	}
	last := matches[len(matches)-1]
	n, err := strconv.Atoi(last[1])
	if err != nil || n <= 0 {
		return 0, ""
	}
	return n, strings.TrimRight(last[0], ".,);")
}

// dewrapGrid rejoins terminal HARD WRAPS so a URL that spilled onto the next
// row is one string again.
//
// THIS IS WHY A NARROW PANE USED TO LOSE ITS PULL REQUEST. A terminal grid has
// no concept of a long line: when `gh pr create` prints a 47-character URL into
// a 40-column pane, the emulator puts 40 characters on one row and the rest on
// the next. ScreenText renders the grid row by row and joins with "\n", so the
// scan saw
//
//	len=40  "https://github.com/kenotron-ms/muxterm/p"
//	len=7   "ull/112"
//
// and completionPRPattern -- which cannot match across a newline, and must not
// be loosened to, or it would start stitching unrelated lines into URLs --
// found nothing. The pull request was lost permanently: the pane closes, the
// grid goes with it, and no later pass can recover what was never recorded.
//
// The rule is the terminal's own: a row that is exactly the grid width was
// filled, so the next row continues it. A row shorter than the width ended
// because something printed a newline.
//
// It is a HEURISTIC, and the failure it can have is named: a line that happens
// to be exactly the width and genuinely ended there is joined to its
// successor. That is why this feeds the artifact SCAN only and never the
// screen a human is shown -- a wrong join can at worst fail to find a URL that
// two independent lines never contained, which is the behaviour being fixed,
// not a regression.
//
// cols <= 0 means the width is unknown; the lines are returned unchanged
// rather than guessed at.
func dewrapGrid(lines []string, cols int) string {
	if cols <= 0 || len(lines) == 0 {
		return strings.Join(lines, "\n")
	}
	out := make([]string, 0, len(lines))
	var cur strings.Builder
	open := false
	for _, line := range lines {
		cur.WriteString(line)
		if utf8.RuneCountInString(line) == cols {
			// Filled the row: the next one continues it.
			open = true
			continue
		}
		out = append(out, cur.String())
		cur.Reset()
		open = false
	}
	if open {
		out = append(out, cur.String())
	}
	return strings.Join(out, "\n")
}

// completionFirstLine returns the last non-blank line of captured output --
// the one a human's eye would land on, since a terminal's newest line is at
// the bottom.
func completionFirstLine(output string) string {
	lines := strings.Split(output, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	return ""
}

// truncateRunes clips s to at most n bytes without splitting a rune.
func truncateRunes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	end := n
	for end > 0 && !isRuneBoundary(s, end) {
		end--
	}
	return s[:end]
}

func isRuneBoundary(s string, i int) bool {
	if i <= 0 || i >= len(s) {
		return true
	}
	return s[i]&0xC0 != 0x80
}

// tailBytes keeps the last n bytes of s on a rune boundary. Terminal output is
// most informative at the end.
func tailBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	start := len(s) - n
	for start < len(s) && !isRuneBoundary(s, start) {
		start++
	}
	return s[start:]
}

// completionStore holds every completion record, in memory and on disk.
//
// It is its own mutex rather than sharing Server.mu: it is written from the
// pane-exit path (an arbitrary readLoop goroutine) and read from the
// session-state ticker, and neither should be able to stall an attach or a
// broadcast behind a file write.
type completionStore struct {
	mu      sync.Mutex
	path    string
	records []CompletionRecord
	// writeErrLogged suppresses repeat logging of a persistent write failure
	// (a full disk, a read-only home). The in-memory records remain correct
	// and the live notification still fires; only durability is lost, and
	// saying so once is enough.
	writeErrLogged bool
}

// DefaultCompletionsPath returns the path to the durable completion log.
func DefaultCompletionsPath() string {
	return filepath.Join(snapshotDir(), "completions.json")
}

// completionsFile is the on-disk document.
type completionsFile struct {
	V       int                `json:"v"`
	Records []CompletionRecord `json:"records"`
}

// newCompletionStore loads the log at path, tolerating every kind of absence.
//
// A missing, unreadable, or malformed file yields an EMPTY store rather than a
// failure to start: losing completion history is a bad day, and refusing to
// run the terminal multiplexer over it is a worse one.
func newCompletionStore(path string) *completionStore {
	s := &completionStore{path: path}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var doc completionsFile
	if err := json.Unmarshal(data, &doc); err != nil {
		return s
	}
	for _, r := range doc.Records {
		if r.V > completionRecordVersion || r.ID == "" {
			continue
		}
		s.records = append(s.records, r)
	}
	s.sortLocked()
	return s
}

// Append records a completion and persists the log. It returns the stored
// record (with its assigned id) so the caller can broadcast it.
func (s *completionStore) Append(r CompletionRecord) CompletionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	r.V = completionRecordVersion
	if r.ID == "" {
		r.ID = fmt.Sprintf("%s-p%d-%d", r.WorkspaceID, r.PaneID, r.EndedAt)
	}
	// A second completion for the same workspace+pane in the same second
	// would otherwise collide. Panes do not restart that fast, but an id that
	// can repeat is an id that can acknowledge the wrong record.
	for s.indexOfLocked(r.ID) >= 0 {
		r.ID += "x"
	}
	s.records = append(s.records, r)
	s.sortLocked()
	if len(s.records) > completionCapacity {
		s.records = s.records[len(s.records)-completionCapacity:]
	}
	s.persistLocked()
	return r
}

// Pending returns the unacknowledged records, oldest first.
func (s *completionStore) Pending() []CompletionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]CompletionRecord, 0, len(s.records))
	for _, r := range s.records {
		if !r.Acknowledged {
			out = append(out, r)
		}
	}
	return out
}

// All returns every record, oldest first.
func (s *completionStore) All() []CompletionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]CompletionRecord(nil), s.records...)
}

// AcknowledgeWorkspace marks every pending record for wsID as dismissed and
// reports whether anything changed.
//
// Keyed by workspace rather than by record id because dismissal is a workspace
// gesture: the user closes the finished workspace, and that is them saying
// they have seen it. Nothing new has to be invented for them to dismiss with.
func (s *completionStore) AcknowledgeWorkspace(wsID string) bool {
	if wsID == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := false
	for i := range s.records {
		if s.records[i].WorkspaceID == wsID && !s.records[i].Acknowledged {
			s.records[i].Acknowledged = true
			changed = true
		}
	}
	if changed {
		s.persistLocked()
	}
	return changed
}

// PendingForWorkspace returns the newest unacknowledged record for wsID.
func (s *completionStore) PendingForWorkspace(wsID string) (CompletionRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := len(s.records) - 1; i >= 0; i-- {
		if s.records[i].WorkspaceID == wsID && !s.records[i].Acknowledged {
			return s.records[i], true
		}
	}
	return CompletionRecord{}, false
}

func (s *completionStore) indexOfLocked(id string) int {
	for i := range s.records {
		if s.records[i].ID == id {
			return i
		}
	}
	return -1
}

// sortLocked keeps the log in end-time order so "newest" is the tail and the
// capacity trim drops the oldest. Ties break on id so the order is total.
func (s *completionStore) sortLocked() {
	sort.SliceStable(s.records, func(i, j int) bool {
		if s.records[i].EndedAt != s.records[j].EndedAt {
			return s.records[i].EndedAt < s.records[j].EndedAt
		}
		return s.records[i].ID < s.records[j].ID
	})
}

// persistLocked atomically rewrites the log, following WriteSnapshot's
// tmp+rename discipline so a reader never sees a half-written document.
//
// A write failure is logged once and otherwise swallowed. The caller is the
// pane-exit path: refusing to close a pane because a log could not be written
// would trade a reporting problem for a terminal that will not let go.
func (s *completionStore) persistLocked() {
	dir := filepath.Dir(s.path)
	err := os.MkdirAll(dir, 0o700)
	if err == nil {
		var data []byte
		data, err = json.Marshal(completionsFile{V: completionRecordVersion, Records: s.records})
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
			logCompletionWriteFailure(s.path, err)
		}
		return
	}
	s.writeErrLogged = false
}

// completionRows projects pending records into fleet rows.
//
// This is what puts a finished lane in fleet_status and the dashboard next to
// the running ones, with its verdict and its PR, after the pane that produced
// it is gone. Rows are synthesized from the durable log, so they survive a
// daemon restart -- which is the difference between a fleet view and a list of
// things that happen to be running right now.
func completionRows(records []CompletionRecord) []SessionState {
	out := make([]SessionState, 0, len(records))
	for _, r := range records {
		sessionID := r.SessionID
		if sessionID == "" {
			// A pane that hosted no declaring session still gets a row, keyed
			// by the record so it is stable across ticks and restarts.
			sessionID = "completion:" + r.ID
		}
		out = append(out, SessionState{
			SessionID:   sessionID,
			PaneID:      r.PaneID,
			WorkspaceID: r.WorkspaceID,
			Harness:     r.Harness,
			Project:     r.Project,
			Name:        r.Name,
			Label:       r.Label,
			Mode:        r.Mode,
			State:       r.FleetState(),
			Doing:       r.Summary(),
			DoneMeans:   r.DoneMeans,
			PR:          r.PR,
			UpdatedAt:   r.EndedAt,
		})
	}
	return out
}

// mergeCompletionRows folds completion rows into the live set.
//
// Two distinct jobs, and the first is the one the fleet has been missing:
//
//  1. ENRICH. A row for the SAME SESSION keeps its own richer content but
//     adopts the record's PR when it has none of its own. This is what makes
//     `pr` non-zero for a lane that opened a pull request without ever
//     declaring one.
//  2. ADD. A record whose session has no row at all -- the normal case, since
//     the pane is gone and its spool tombstone was reclaimed -- becomes a row.
//
// Matching is on SESSION ID and nothing else. The tempting fallback --
// matching a record to whatever row now occupies its workspace and pane -- is
// a mis-attribution waiting to happen: workspace and pane ids are recycled,
// most visibly across a daemon restart, so that fallback can staple a finished
// lane's PR number onto an unrelated session that merely inherited its
// coordinates. A wrong PR on a live row is worse than a duplicate row, because
// it is believable.
//
// Live rows are never replaced. If a session somehow has both, the running
// thing is the truth about it now.
func mergeCompletionRows(rows []SessionState, records []CompletionRecord) []SessionState {
	if len(records) == 0 {
		return rows
	}
	bySession := make(map[string]int, len(rows))
	for i, row := range rows {
		if row.SessionID != "" {
			bySession[row.SessionID] = i
		}
	}

	out := rows
	for _, r := range records {
		if r.SessionID != "" {
			if i, ok := bySession[r.SessionID]; ok {
				if out[i].PR == 0 && r.PR > 0 {
					out[i].PR = r.PR
				}
				continue
			}
		}
		out = append(out, completionRows([]CompletionRecord{r})...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].WorkspaceID != out[j].WorkspaceID {
			return out[i].WorkspaceID < out[j].WorkspaceID
		}
		if out[i].PaneID != out[j].PaneID {
			return out[i].PaneID < out[j].PaneID
		}
		return out[i].SessionID < out[j].SessionID
	})
	return out
}

// completionMarkFor builds the workspace-list annotation for a record. It is
// what carries the notification to the sidebar without inventing a new
// message type: the workspace list is already a whole-state document every
// client receives.
func completionMarkFor(r CompletionRecord) *WorkspaceCompletion {
	return &WorkspaceCompletion{
		RecordID: r.ID,
		PaneID:   r.PaneID,
		Lane:     r.LaneName(),
		Outcome:  r.Outcome,
		ExitCode: r.ExitCode,
		EndedAt:  r.EndedAt,
		PR:       r.PR,
		PRURL:    r.PRURL,
		Summary:  r.Summary(),
		Output:   tailBytes(r.Output, completionSummaryBytes*4),
	}
}

// logCompletionWriteFailure reports a lost-durability event exactly once per
// store. Kept as its own function so the swallow above is a deliberate,
// named decision rather than an ignored error.
func logCompletionWriteFailure(path string, err error) {
	log.Printf("sessiond: could not persist completion log %s: %v (completions remain in memory for this daemon's lifetime)", path, err)
}
