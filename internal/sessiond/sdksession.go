package sessiond

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
	"github.com/kenotron-ms/muxterm/internal/sdkclient"
)

// SDK-backed sessions: a session muxterm OWNS, rather than one it observes.
//
// HOW THIS DIFFERS FROM EVERY OTHER SESSION IN THE FLEET, which is the whole
// point of the file:
//
//   - A PTY-backed session is a process behind a terminal (pane.go). Its state
//     reaches muxterm either by inference (foreground process group, OSC 133,
//     screen text) or by a hook the harness was configured to call, which then
//     writes a snapshot into the session-state spool. The daemon re-reads that
//     spool every second and DELETES the snapshots it will not publish
//     (sessionstore.go). The spool lives under $XDG_RUNTIME_DIR, which is
//     tmpfs. Nothing in it survives a reboot, and a producer that stops
//     republishing loses its row.
//
//   - An SDK-backed session is a JSON-RPC thread this daemon started and holds
//     (internal/sdkclient). Its identity is a harness-minted thread id, not a
//     pid. Its turn boundaries arrive as `turn/started` / `turn/completed`
//     notifications, not as inference. And its record is written HERE, durably,
//     by this daemon -- so it is not a producer's republication and it cannot
//     be reclaimed by the collector.
//
// WHY A SEPARATE STORE RATHER THAN A FIELD ON THE SNAPSHOT: the identical
// reason projectstore.go gives for the project assignment. The spool is
// PRODUCER-OWNED and collector-reclaimed; a record the daemon must not lose
// cannot live in a file the daemon deletes. This store follows projectstore.go
// and triggerStore: own mutex, own file under snapshotDir(), atomic rewrite,
// merged onto the published rows on the way out.
//
// WHAT THIS FILE DOES NOW THAT #220 DID NOT. Two gaps in that slice are closed
// here, and they are the two that stood between a proof and something usable:
//
//   - RESUME. A record surviving a restart carried a thread id nothing used,
//     so a conversation that outlived the daemon could be listed and never
//     continued. Resume/resumeLocked call thread/resume against that id, and
//     Send calls it AUTOMATICALLY when the record is detached -- so continuing
//     a session after a restart is the same verb as continuing one before it.
//
//   - WATCHABILITY. item/agentMessage/delta was already arriving and was
//     dropped on the floor, which is why an SDK session's output could only be
//     read after the fact, as a summary. Deltas are now coalesced and
//     broadcast (onOutput) so a browser can watch the answer being written.
//
// STILL NOT DONE, named rather than implied: no approval routing (the sandbox
// stays read-only with approvalPolicy never, and loosening it without a human
// route is how a headless session silently gains write access), no migration
// of existing sessions, no second harness.

// sdkSessionsVersion is the schema version of the on-disk document. A file
// declaring a HIGHER version was written by a newer daemon: its entries are
// left strictly alone rather than half-understood, following
// projectAssignments.
const sdkSessionsVersion = 1

// SDKSessionsPath returns the durable SDK-session record store's location.
//
// Resolution order mirrors ProjectAssignmentsPath and TriggersPath, for the
// same reason: an explicit override for tests and odd deploys, then the
// XDG-derived default that keeps a dev daemon's records out of the real
// installation's without either side being told which world it is in.
func SDKSessionsPath() string {
	if override := os.Getenv("MUXTERM_SDK_SESSIONS_PATH"); override != "" {
		return override
	}
	return filepath.Join(snapshotDir(), "sdk-sessions.json")
}

// SDKSessionRecord is one durable SDK-backed session.
//
// Every field here is OBSERVED, not inferred. State changes only when the
// harness says a turn started or completed; LastTurnID is the id the harness
// returned when it accepted the turn. There is no field on this record that
// could be filled in by reading a screen.
type SDKSessionRecord struct {
	// SessionID is muxterm's id for the session. ThreadID is the harness's.
	// Both are kept: the first is what the fleet, the filing store and every
	// muxterm verb address; the second is what the harness can resume.
	SessionID string `json:"sessionId"`
	ThreadID  string `json:"threadId"`

	Harness string `json:"harness"`
	Cwd     string `json:"cwd"`
	Name    string `json:"name"`
	Label   string `json:"label"`

	// State is a muxterm lifecycle state (SessionState* in sessionstate.go),
	// translated from harness turn events at exactly one place -- applyTurn
	// below -- so the harness's vocabulary does not leak into the fleet.
	State string `json:"state"`

	// LastTurnID is the harness-minted id from the most recent accepted turn:
	// the receipt, kept. LastTurnStatus is the status the harness last
	// declared for it.
	LastTurnID     string `json:"lastTurnId,omitempty"`
	LastTurnStatus string `json:"lastTurnStatus,omitempty"`
	// TurnCount counts ACCEPTED turns -- ones the harness returned a receipt
	// for. A turn it refused is not counted, because it did not happen.
	TurnCount int `json:"turnCount"`

	// Summary is the harness's own last final assistant message, delivered by
	// the item/completed notification. It is a copy of what the harness said,
	// not a reading of what a terminal showed.
	Summary string `json:"summary,omitempty"`

	// ResumeCount counts how many times this record has been reattached to
	// its harness thread through thread/resume. Persisted, because it is the
	// durable evidence that a conversation outlived a daemon: a record with
	// resumeCount > 0 was continued, not restarted.
	ResumeCount int `json:"resumeCount,omitempty"`

	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`

	// Detached records that this daemon no longer holds a live app-server
	// connection for the session -- the normal state after a restart. The
	// record survives; the process does not. It is set on load rather than
	// persisted as true, so a running session is never mislabelled.
	Detached bool `json:"-"`
}

// sdkSessionStore is the durable record set plus the live clients for the
// sessions this daemon actually started.
//
// Its own mutex rather than Server.mu, for projectAssignments' reason: it is
// written from a control-protocol handler and from an SDK notification
// goroutine, and read from the session-state ticker. A file write must never be
// able to stall an attach or a broadcast.
type sdkSessionStore struct {
	mu      sync.Mutex
	path    string
	records map[string]*SDKSessionRecord
	// clients holds the live app-server connection per session id. It is
	// deliberately NOT persisted: a process cannot be serialized, and
	// pretending otherwise on load is what would make a restarted daemon lie
	// about which sessions it can still talk to.
	clients        map[string]*sdkclient.Client
	writeErrLogged bool
	frozen         bool
	// notify is called after any change that should reach the fleet
	// immediately rather than on the next tick.
	notify func()

	// resumeMu serializes reattachment. Resuming spawns a process and makes a
	// protocol round trip, so it must not be done under mu -- and two
	// concurrent sends against the same detached record must not each spawn
	// their own app server and leave one orphaned. One global lock rather
	// than one per session because resuming is rare and contention on it is
	// not a thing that happens.
	resumeMu sync.Mutex

	// onOutput publishes one coalesced run of assistant text. Set by the
	// server; nil in a store nobody is watching, which costs one nil check
	// per delta.
	onOutput func(SDKOutputChunk)
	// pending holds the deltas that have arrived since the last flush, per
	// session, and flushTimer is the single timer that will drain them.
	//
	// WHY COALESCE AT ALL. Deltas arrive per token. Publishing each one as
	// its own frame would push tens of advisory frames a second at every
	// browser, onto a queue that DROPS when full (subscriber.go) -- and a
	// dropped fragment is not a missing frame, it is a hole in the middle of
	// a sentence. Batching to flushEvery turns the same text into a handful
	// of frames and makes a drop far less likely; seq makes one visible when
	// it happens anyway.
	pending    map[string]*sdkPendingOutput
	flushTimer *time.Timer
	// outSeq counts published chunks PER SESSION. Per session rather than
	// store-wide because the number exists to let one consumer of one
	// session's text notice a hole in it; a counter shared with another
	// session's stream would report a gap every time the two interleaved.
	outSeq map[string]uint64
}

// SDKOutputChunk is one coalesced run of assistant text from an SDK session.
//
// Seq counts this session's chunks, from 1, for the lifetime of one daemon. It
// exists so a consumer can tell "nothing has arrived yet" from "a frame was
// dropped on the way here": these frames are advisory and droppable by design,
// and text that silently closes over a gap reads as though the assistant said
// something it did not.
type SDKOutputChunk struct {
	SessionID string
	ThreadID  string
	TurnID    string
	ItemID    string
	Text      string
	Seq       uint64
}

// sdkPendingOutput accumulates one session's unflushed deltas.
type sdkPendingOutput struct {
	threadID string
	turnID   string
	itemID   string
	text     strings.Builder
}

type sdkSessionsFile struct {
	V        int                 `json:"v"`
	Sessions []*SDKSessionRecord `json:"sessions"`
}

// newSDKSessionStore loads the store at path, tolerating every absence.
//
// A missing, unreadable or malformed file yields an EMPTY store rather than a
// failure to start, following newProjectAssignments and newTriggerStore:
// refusing to start the daemon over a corrupt sidecar would take every terminal
// on the machine down with it.
func newSDKSessionStore(path string) *sdkSessionStore {
	s := &sdkSessionStore{
		path:    path,
		records: map[string]*SDKSessionRecord{},
		clients: map[string]*sdkclient.Client{},
		pending: map[string]*sdkPendingOutput{},
		outSeq:  map[string]uint64{},
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return s
	}
	var doc sdkSessionsFile
	if err := json.Unmarshal(data, &doc); err != nil {
		log.Printf("sessiond: SDK session store %s is unreadable (%v); starting with no SDK sessions", path, err)
		return s
	}
	if doc.V > sdkSessionsVersion {
		log.Printf("sessiond: SDK session store %s declares schema v%d (this daemon understands v%d); "+
			"leaving it untouched and serving no SDK sessions", path, doc.V, sdkSessionsVersion)
		s.frozen = true
		return s
	}
	for _, rec := range doc.Sessions {
		if rec == nil || rec.SessionID == "" {
			continue
		}
		// This daemon did not start it, so it holds no connection to it. Said
		// on the record rather than left ambiguous: "the record survived" and
		// "the session is still running" are different facts and the fleet
		// must not conflate them.
		rec.Detached = true
		s.records[rec.SessionID] = rec
	}
	return s
}

// Rows projects the durable records into fleet rows.
//
// PaneID and WorkspaceID are left zero, which SessionState.MarshalJSON already
// emits as null: an SDK-backed session has NO TERMINAL, and the contract has
// always allowed that ("Zero PaneID and an empty WorkspaceID mean the session
// has no muxterm terminal attachment", sessionstate.go). No new wire field is
// needed for this slice, and none is added.
func (s *sdkSessionStore) Rows() []SessionState {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := make([]SessionState, 0, len(s.records))
	for _, rec := range s.records {
		doing := "SDK session (" + rec.Harness + ")"
		if rec.Detached {
			// Says what is true AND what happens next. The record is not
			// live, and it is not stranded either: the next turn reattaches
			// it to thread rec.ThreadID.
			doing = "SDK record detached from this daemon; next turn resumes thread " + shortThread(rec.ThreadID)
		}
		rows = append(rows, SessionState{
			SessionID: rec.SessionID,
			Harness:   rec.Harness,
			Project:   rec.Cwd,
			Name:      rec.Name,
			Label:     rec.Label,
			Mode:      ModeInteractive,
			State:     rec.State,
			Doing:     doing,
			Summary:   rec.Summary,
			// ExecutionID and TurnID are documented as native causal identity
			// observed from reports rather than inferred (sessionstate.go).
			// That is exactly what these are: the harness's own thread id and
			// the turn id it minted. This is also what lets mergeSDKRows
			// recognise a hook snapshot of a thread muxterm already owns.
			ExecutionID: rec.ThreadID,
			TurnID:      rec.LastTurnID,
			Origin:      LaneOriginAgent,
			UpdatedAt:   rec.UpdatedAt,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].SessionID < rows[j].SessionID })
	return rows
}

// Records returns a copy of every durable record, newest first.
func (s *sdkSessionStore) Records() []SDKSessionRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]SDKSessionRecord, 0, len(s.records))
	for _, rec := range s.records {
		out = append(out, *rec)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	return out
}

// Start creates a session through the harness SDK and records it durably.
//
// The record is written BEFORE this returns, so a daemon that dies immediately
// afterwards still knows the session exists and which thread it is. Writing it
// only on the first turn would leave a thread the harness has but muxterm does
// not -- the exact orphan the durable store exists to prevent.
func (s *sdkSessionStore) Start(ctx context.Context, harness, cwd, name string) (*SDKSessionRecord, error) {
	if harness != HarnessCodex {
		// Named refusal rather than a generic failure. Only one harness is
		// SDK-backed in this slice and saying which keeps the error honest.
		return nil, fmt.Errorf("SDK-backed sessions are implemented for harness %q only (got %q); "+
			"every other harness still starts on the PTY path", HarnessCodex, harness)
	}
	bin, err := exec.LookPath("codex")
	if err != nil {
		return nil, fmt.Errorf("harness %q is not installed: %w", harness, err)
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return nil, fmt.Errorf("resolve cwd: %w", err)
	}

	sessionID := newSDKSessionID()
	client, err := s.dial(ctx, bin, sessionID)
	if err != nil {
		return nil, err
	}
	thread, err := client.ThreadStart(ctx, abs, sdkSandboxMode, sdkApprovalPolicy)
	if err != nil {
		client.Close()
		return nil, fmt.Errorf("thread/start: %w", err)
	}
	now := time.Now().Unix()
	if name == "" {
		name = "SDK session " + thread.ID[:8]
	}
	rec := &SDKSessionRecord{
		SessionID: sessionID,
		ThreadID:  thread.ID,
		Harness:   harness,
		Cwd:       abs,
		Name:      name,
		Label:     "sdk session",
		// Interactive and waiting for its first turn. Stopped is the resting
		// state for an interactive session that is not mid-turn; it is not an
		// alarm (see NeedsInput in sessionstate.go).
		State:     SessionStateStopped,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.mu.Lock()
	s.records[sessionID] = rec
	s.clients[sessionID] = client
	s.persistLocked()
	out := *rec
	s.mu.Unlock()
	s.fire()
	return &out, nil
}

// dial launches one app server and routes its notifications at sessionID.
//
// Shared by Start and Resume so a resumed session is driven by exactly the
// same client, with exactly the same notification routing, as a fresh one --
// which is what makes "continue after a restart" the same code path as
// "continue", rather than a second, thinner implementation that drifts.
func (s *sdkSessionStore) dial(ctx context.Context, bin, sessionID string) (*sdkclient.Client, error) {
	return sdkclient.Start(ctx, bin, "muxterm", sdkClientVersion, func(n sdkclient.Notification) {
		s.onNotification(sessionID, n)
	})
}

// Resume reattaches a detached record to the harness thread it named.
//
// THIS IS THE GAP #220 LEFT OPEN, CLOSED. That slice demonstrated a record
// surviving a daemon restart carrying its harness-native thread id, and then
// refused every turn against it -- honestly, but uselessly: a conversation you
// can list and cannot continue is an epitaph. Resume spawns a new app server
// and calls thread/resume with the id the store persisted, so the harness
// reopens the rollout it already wrote. The turns delivered before the restart
// are still in that thread's context, which is a property of the harness's
// storage, not a claim muxterm makes.
//
// A session that is already live is returned unchanged rather than resumed a
// second time: the operation is idempotent, because Send calls it on a path
// where "is it attached?" is a race against every other caller.
func (s *sdkSessionStore) Resume(ctx context.Context, sessionID string) (*SDKSessionRecord, bool, error) {
	// One resume at a time, and never under s.mu: this spawns a process and
	// makes a protocol round trip.
	s.resumeMu.Lock()
	defer s.resumeMu.Unlock()

	s.mu.Lock()
	rec, ok := s.records[sessionID]
	client := s.clients[sessionID]
	s.mu.Unlock()
	if !ok {
		return nil, false, fmt.Errorf("no SDK-backed session %q", sessionID)
	}
	if client != nil && client.Alive() {
		out := *rec
		return &out, false, nil // already attached; nothing to do
	}
	if rec.ThreadID == "" {
		// Nothing to resume BY. Refused by name rather than by starting a
		// fresh thread under the old record's id, which would silently hand
		// the caller a different conversation wearing a familiar name.
		return nil, false, fmt.Errorf("SDK session %q carries no harness thread id; it cannot be resumed", sessionID)
	}
	if rec.Harness != HarnessCodex {
		return nil, false, fmt.Errorf("resume is implemented for harness %q only (got %q)", HarnessCodex, rec.Harness)
	}
	bin, err := exec.LookPath("codex")
	if err != nil {
		return nil, false, fmt.Errorf("harness %q is not installed: %w", rec.Harness, err)
	}
	fresh, err := s.dial(ctx, bin, sessionID)
	if err != nil {
		return nil, false, err
	}
	thread, err := fresh.ThreadResume(ctx, rec.ThreadID, rec.Cwd, sdkSandboxMode, sdkApprovalPolicy)
	if err != nil {
		fresh.Close()
		return nil, false, fmt.Errorf("thread/resume %s: %w", rec.ThreadID, err)
	}
	s.mu.Lock()
	// The harness is authoritative about the id of the thread it just
	// reopened. Taking its answer rather than assuming ours keeps the record
	// pointing at the thread that actually exists.
	rec.ThreadID = thread.ID
	rec.Detached = false
	rec.ResumeCount++
	rec.UpdatedAt = time.Now().Unix()
	s.clients[sessionID] = fresh
	s.persistLocked()
	out := *rec
	s.mu.Unlock()
	s.fire()
	return &out, true, nil
}

// Send delivers one turn and returns the harness's receipt.
//
// The returned Turn is the acknowledgement: an id the harness minted and a
// status it declared, both before any output exists. A caller that gets a nil
// error here can state that the turn was admitted, which is precisely what the
// PTY-backed managed-dispatch path cannot do -- it runs a subprocess and reads
// an exit code, so its failure mode is "uncertain" by construction
// (cmd/muxterm/session_send_cmd.go).
//
// A DETACHED SESSION RESUMES ITSELF HERE. #220 refused this turn and said so;
// refusing was honest but it made the durable record a museum piece. Sending
// into a session that survived a restart is now the ordinary verb, and the
// returned resumed flag reports which of the two happened rather than hiding
// it -- a caller is entitled to know that a fresh app server was spawned and
// a thread reopened under its request.
func (s *sdkSessionStore) Send(ctx context.Context, sessionID, text string) (*sdkclient.Turn, bool, error) {
	s.mu.Lock()
	rec, ok := s.records[sessionID]
	client := s.clients[sessionID]
	s.mu.Unlock()
	if !ok {
		return nil, false, fmt.Errorf("no SDK-backed session %q", sessionID)
	}
	resumed := false
	if client == nil || !client.Alive() {
		if _, did, err := s.Resume(ctx, sessionID); err != nil {
			// Still the honest error, just later: the record and the thread
			// id are here, the harness would not reopen the thread, so the
			// turn was NOT delivered and must not be reported as delivered.
			return nil, false, fmt.Errorf("SDK session %q has no live harness connection and could not be resumed: %w",
				sessionID, err)
		} else {
			resumed = did
		}
		s.mu.Lock()
		client = s.clients[sessionID]
		s.mu.Unlock()
	}
	if client == nil {
		return nil, false, fmt.Errorf("SDK session %q has no live harness connection", sessionID)
	}
	turn, err := client.TurnStart(ctx, rec.ThreadID, text)
	if err != nil {
		s.mu.Lock()
		rec.State = SessionStateFailed
		rec.UpdatedAt = time.Now().Unix()
		s.persistLocked()
		s.mu.Unlock()
		s.fire()
		return nil, resumed, err
	}
	s.mu.Lock()
	rec.LastTurnID = turn.ID
	rec.LastTurnStatus = turn.Status
	rec.TurnCount++
	rec.State = SessionStateWorking
	rec.UpdatedAt = time.Now().Unix()
	s.persistLocked()
	s.mu.Unlock()
	s.fire()
	return turn, resumed, nil
}

// onNotification applies a harness event to the record.
//
// THIS IS CRITERION (c) IN ONE FUNCTION. Every state transition below is caused
// by the harness saying something happened. Nothing here reads a screen, polls
// a process group, or waits for a hook to republish a snapshot into a spool.
func (s *sdkSessionStore) onNotification(sessionID string, n sdkclient.Notification) {
	s.mu.Lock()
	rec, ok := s.records[sessionID]
	if !ok {
		s.mu.Unlock()
		return
	}
	changed := true
	// drain forces the coalescing buffer out now rather than up to one flush
	// interval later. Set when the turn ends: the last fragment of an answer
	// is the one a reader is waiting on, and leaving it in a buffer behind a
	// row that already says "stopped" is the one place the delay is visible.
	drain := false
	switch n.Method {
	case sdkclient.NotifyTurnStarted:
		rec.State = SessionStateWorking
		if n.Turn != nil {
			rec.LastTurnID = n.Turn.ID
			rec.LastTurnStatus = n.Turn.Status
		}
	case sdkclient.NotifyTurnCompleted:
		drain = true
		// An interactive session that finished its turn is RESTING, not
		// broken: Stopped, never Failed. The distinction is the one Mode
		// exists to make (sessionstate.go).
		rec.State = SessionStateStopped
		if n.Turn != nil {
			rec.LastTurnID = n.Turn.ID
			rec.LastTurnStatus = n.Turn.Status
			if n.Turn.Status == "failed" {
				rec.State = SessionStateFailed
			}
		}
	case sdkclient.NotifyItemCompleted:
		// The harness's own final assistant message, copied verbatim. Only
		// final answers are taken; reasoning and tool items are not summaries.
		var payload struct {
			Item struct {
				Type  string `json:"type"`
				Text  string `json:"text"`
				Phase string `json:"phase"`
			} `json:"item"`
		}
		if err := json.Unmarshal(n.Raw, &payload); err != nil ||
			payload.Item.Type != "agentMessage" || payload.Item.Phase != "final_answer" {
			changed = false
			break
		}
		rec.Summary = payload.Item.Text
	case sdkclient.NotifyAgentMessageDelta:
		// THE ANSWER ARRIVING. #220 recorded this notification as already
		// present and unrendered, which is exactly what made an SDK session
		// unwatchable: a human saw a row go to working and, seconds later, a
		// finished summary, with the writing itself invisible.
		//
		// It touches no record field and persists nothing. A fragment of a
		// sentence is not session state -- it is a frame -- and writing the
		// store on every token would be a disk write per token for text the
		// completed item already carries in full.
		if n.Delta != "" {
			s.bufferOutputLocked(sessionID, rec.ThreadID, n)
		}
		changed = false
	default:
		changed = false
	}
	if changed {
		rec.UpdatedAt = time.Now().Unix()
		s.persistLocked()
	}
	s.mu.Unlock()
	if drain {
		s.flushOutput()
	}
	if changed {
		s.fire()
	}
}

// sdkOutputFlushEvery bounds how often accumulated assistant text is
// published. Short enough that a human reads it as the answer being written,
// long enough that a fast model does not turn into one advisory frame per
// token on a queue that drops when full.
const sdkOutputFlushEvery = 80 * time.Millisecond

// bufferOutputLocked accumulates one delta. s.mu MUST be held.
//
// It does not publish. Publishing under the store mutex would put a fan-out
// across every browser connection inside the same lock the notification
// goroutine, the control handlers and the fleet ticker all contend for.
func (s *sdkSessionStore) bufferOutputLocked(sessionID, threadID string, n sdkclient.Notification) {
	if s.onOutput == nil {
		return // nobody is watching: do not accumulate text no one will read
	}
	p := s.pending[sessionID]
	if p == nil {
		p = &sdkPendingOutput{}
		s.pending[sessionID] = p
	}
	p.threadID, p.turnID, p.itemID = threadID, n.TurnID, n.ItemID
	p.text.WriteString(n.Delta)
	if s.flushTimer == nil {
		s.flushTimer = time.AfterFunc(sdkOutputFlushEvery, s.flushOutput)
	}
}

// flushOutput publishes every session's accumulated text and clears it.
func (s *sdkSessionStore) flushOutput() {
	s.mu.Lock()
	s.flushTimer = nil
	fn := s.onOutput
	chunks := make([]SDKOutputChunk, 0, len(s.pending))
	for id, p := range s.pending {
		delete(s.pending, id)
		if p.text.Len() == 0 {
			continue
		}
		s.outSeq[id]++
		chunks = append(chunks, SDKOutputChunk{
			SessionID: id,
			ThreadID:  p.threadID,
			TurnID:    p.turnID,
			ItemID:    p.itemID,
			Text:      p.text.String(),
			Seq:       s.outSeq[id],
		})
	}
	s.mu.Unlock()
	if fn == nil {
		return
	}
	for _, c := range chunks {
		fn(c)
	}
}

// Close ends the live connection for one session, leaving its record durable.
func (s *sdkSessionStore) Close(sessionID string) error {
	s.mu.Lock()
	rec, ok := s.records[sessionID]
	client := s.clients[sessionID]
	if ok {
		delete(s.clients, sessionID)
		rec.State = SessionStateDone
		rec.Detached = true
		rec.UpdatedAt = time.Now().Unix()
		s.persistLocked()
	}
	s.mu.Unlock()
	if !ok {
		return fmt.Errorf("no SDK-backed session %q", sessionID)
	}
	if client != nil {
		client.Close()
	}
	s.fire()
	return nil
}

// Shutdown ends every live connection. Records are left on disk untouched.
func (s *sdkSessionStore) Shutdown() {
	s.mu.Lock()
	clients := make([]*sdkclient.Client, 0, len(s.clients))
	for id, c := range s.clients {
		clients = append(clients, c)
		delete(s.clients, id)
	}
	// Stop the coalescing timer and drop whatever it was holding: a fragment
	// of a sentence has nowhere to go once the connections are gone.
	if s.flushTimer != nil {
		s.flushTimer.Stop()
		s.flushTimer = nil
	}
	s.pending = map[string]*sdkPendingOutput{}
	s.mu.Unlock()
	for _, c := range clients {
		c.Close()
	}
}

func (s *sdkSessionStore) fire() {
	if s.notify != nil {
		s.notify()
	}
}

// persistLocked atomically rewrites the store.
//
// atomicfile.Write rather than the hand-rolled tmp+rename in trigger.go and
// projectstore.go: it is the same guarantee with the content sync those two
// omit, and it is already the repository's other durable-write pattern.
//
// A write failure is logged once and otherwise swallowed, following
// projectAssignments: the in-memory records stay correct for this daemon's
// lifetime, and taking the daemon down over a sidecar write would cost every
// terminal on the machine.
func (s *sdkSessionStore) persistLocked() {
	if s.frozen {
		return
	}
	recs := make([]*SDKSessionRecord, 0, len(s.records))
	for _, rec := range s.records {
		recs = append(recs, rec)
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].CreatedAt < recs[j].CreatedAt })
	err := os.MkdirAll(filepath.Dir(s.path), 0o700)
	if err == nil {
		var data []byte
		data, err = json.Marshal(sdkSessionsFile{V: sdkSessionsVersion, Sessions: recs})
		if err == nil {
			err = atomicfile.Write(s.path, data, 0o600)
		}
	}
	if err != nil && !s.writeErrLogged {
		s.writeErrLogged = true
		log.Printf("sessiond: could not persist SDK sessions %s: %v "+
			"(records remain in memory for this daemon's lifetime)", s.path, err)
	}
}

// mergeSDKRows folds SDK-backed sessions into the fleet, and resolves the one
// collision that turns out to exist in practice.
//
// THE COLLISION, FOUND BY RUNNING IT rather than by reading the code: a
// harness configured with its own notify hook reports the thread muxterm just
// started through the SDK, so the SAME conversation arrives twice -- once as
// this daemon's durable record (session id `sdk-...`) and once as a spool
// snapshot the hook wrote (session id `codex-<threadId>`). Both are truthful
// and they are not the same id, so id-equality de-duplication does not catch
// it, and the fleet reports two sessions where a human started one.
//
// It is resolved in favour of the SDK record, and the direction is the point:
// muxterm OWNS an SDK-backed session. The hook's snapshot is a second
// projection of a conversation this daemon is already authoritative about, and
// it is the projection that lives in the tmpfs spool and gets reclaimed. A row
// muxterm owns must not be shadowed by a republication of itself.
//
// Matching is on the HARNESS-NATIVE thread id, which is the one identifier
// both sides genuinely share: the hook names its snapshot after the thread.
// Substring rather than equality because the producer decides its own id
// spelling and only the thread id inside it is contractual.
//
// A spool row that is NOT one of this daemon's own threads is untouched. This
// function can only ever remove a duplicate of something muxterm started.
func mergeSDKRows(rows []SessionState, sdk []SessionState) []SessionState {
	if len(sdk) == 0 {
		return rows
	}
	threads := make(map[string]bool, len(sdk))
	for i := range sdk {
		if sdk[i].ExecutionID != "" {
			threads[sdk[i].ExecutionID] = true
		}
	}
	seen := make(map[string]bool, len(rows))
	kept := rows[:0]
	for i := range rows {
		if shadowsSDKThread(rows[i].SessionID, threads) {
			continue
		}
		seen[rows[i].SessionID] = true
		kept = append(kept, rows[i])
	}
	rows = kept
	for i := range sdk {
		if !seen[sdk[i].SessionID] {
			rows = append(rows, sdk[i])
		}
	}
	return rows
}

// shadowsSDKThread reports whether a spool row is a republication of a thread
// this daemon already owns.
func shadowsSDKThread(sessionID string, threads map[string]bool) bool {
	if sessionID == "" || len(threads) == 0 {
		return false
	}
	for threadID := range threads {
		// A thread id is a UUIDv7; a chance substring match is not a practical
		// concern, and requiring an exact id would tie this to one producer's
		// naming convention.
		if threadID != "" && strings.Contains(sessionID, threadID) {
			return true
		}
	}
	return false
}

// newSDKSessionID mints muxterm's own id for an SDK-backed session. The prefix
// makes the provenance of a row obvious in a log line without a lookup.
func newSDKSessionID() string {
	return fmt.Sprintf("sdk-%d-%d", time.Now().UnixNano(), os.Getpid())
}

// shortThread trims a thread id for a one-line fleet cell without losing which
// thread it is.
func shortThread(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

const (
	// sdkClientVersion is what muxterm announces to the harness at
	// initialize. It identifies the CLIENT protocol shape, not the muxterm
	// release.
	sdkClientVersion = "1"

	// sdkSandboxMode and sdkApprovalPolicy are fixed for this slice, and the
	// pairing is deliberate. An SDK-backed session has no terminal, so there
	// is no screen for an approval prompt to appear on and nobody to answer
	// it: a policy of anything but "never" would hang the session invisibly.
	// "never" is only safe because the sandbox is read-only. Loosening either
	// one without building the approval route is how a headless session
	// silently gains write access.
	sdkSandboxMode    = "read-only"
	sdkApprovalPolicy = "never"
)
