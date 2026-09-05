package sessiond

import (
	"encoding/json"
	"errors"
	"hash/fnv"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Session-state collection: read what sessions declare about themselves, and
// join it to the panes they are running in.
//
// This file knows NOTHING about which coding-agent CLI wrote a snapshot. A
// producer writes one atomically-replaced JSON snapshot per session into a
// spool directory; this reads that directory. The shipped producers are the
// Amplifier hook (modules/hooks-muxterm-session), the `muxterm session report`
// verb, and the opt-in Claude Code adapter (claude_adapter.go), but the
// contract in docs/session-state-protocol.md is open to anything that can
// write a file. See sessionstate.go for why a declared channel has to exist at
// all (short version: TIOCGPGRP cannot tell an agent that is thinking from an
// agent that is waiting for a human, and that distinction is the whole
// feature).
//
// Division of labour, and why it falls this way:
//
//   - A producer knows its own pid and nothing about muxterm. Teaching it about
//     panes would duplicate knowledge the registry already owns, in every
//     language anybody ever writes a producer in.
//   - The daemon knows which pane owns which process. It performs the join.
//
// So a snapshot on disk carries `pid` and omits paneId/workspaceId, and this
// file fills those in.

// sessionStateDirName is the spool subdirectory, resolved beneath the same
// socketDir() the control socket lives in. See SessionStateDir for the full
// resolution order and why it is derived rather than hardcoded.
const sessionStateDirName = "session-state"

// sessionStateAncestorHops bounds the walk from a session's pid up to a pane's
// root shell. Real depth is two or three (pane shell -> agent CLI, sometimes
// with a wrapper); the cap exists so a /proc that lies, or a cycle that should
// be impossible, costs a bounded number of reads instead of a hung tick.
const sessionStateAncestorHops = 32

// maxSessionSnapshotBytes bounds one snapshot file. A snapshot is a handful of
// short display strings and a capped path list -- a few kilobytes at the very
// most. The cap exists so a file that is not what it claims to be cannot be
// read into the daemon once a second.
const maxSessionSnapshotBytes = 64 << 10

// sessionSnapshotVersion is the schema version this daemon writes and the
// highest it understands. A snapshot declaring a HIGHER version was written by
// a producer from the future and is skipped with a logged reason, because
// guessing at fields that did not exist when this code was written is how a
// forward-compatible format stops being one.
//
// Version 0 -- an absent `v` -- is the pre-versioning shape, which is
// field-identical to v1. It is accepted, so upgrading the daemon ahead of the
// producers does not blank the home view.
const sessionSnapshotVersion = 1

// SessionStateDir returns the directory session-state snapshots are spooled in.
//
// Exported because it is a PUBLIC INTEGRATION CONTRACT, not an implementation
// detail: `muxterm session report` writes here, third-party producers write
// here, and docs/session-state-protocol.md documents it. Resolution order:
//
//   - $MUXTERM_SESSION_STATE_DIR       (explicit override, tests and odd deploys)
//   - $XDG_RUNTIME_DIR/muxterm/session-state
//   - <tmp>/muxterm-<uid>/session-state
//
// The XDG-derived default is what makes `make dev-local` isolation automatic:
// that target overrides XDG_RUNTIME_DIR, sessiond inherits it, panes inherit it
// from sessiond, and a producer running inside a pane computes the very same
// directory. A dev daemon can never read production's spool, and neither side
// needs to be told which world it is in.
func SessionStateDir() string {
	if override := os.Getenv("MUXTERM_SESSION_STATE_DIR"); override != "" {
		return override
	}
	return filepath.Join(socketDir(), sessionStateDirName)
}

// sessionStateDir is the internal spelling, kept so call sites inside the
// package read the way the rest of this file does.
func sessionStateDir() string {
	return SessionStateDir()
}

// sessionSnapshot is one file on disk: the session's own declaration, plus the
// pid that lets the daemon locate it.
//
// SessionState is embedded rather than copied field-by-field so the pinned
// wire contract stays the single definition of these names. PID is the one
// addition, and it is consumed here and never forwarded -- a browser has no
// use for a pid, and publishing one would invite somebody to act on it.
type sessionSnapshot struct {
	SessionState
	// V is the snapshot schema version. It is on the ON-DISK type and not on
	// SessionState because it describes the producer contract, not the row: a
	// browser has no use for the version of a file it never sees, and putting
	// it on the wire type would invite the frontend to branch on it.
	//
	// Absent (0) means a pre-versioning producer; see sessionSnapshotVersion.
	V   int `json:"v,omitempty"`
	PID int `json:"pid"`
	// PIDStart is the process's start time from /proc/<pid>/stat, which turns
	// a pid into an identity. A pid alone is recycled: a snapshot outliving its
	// session would otherwise be walked up from a reassigned pid, matched to a
	// real pane, and published as a live row on a terminal it has nothing to do
	// with -- indistinguishable from a genuine row, for as long as the
	// recycling process lives.
	//
	// Zero means the writer could not determine it (non-Linux, or an unreadable
	// stat). That is treated as unverifiable rather than mismatched, degrading
	// to pid-only behaviour rather than dropping every row.
	PIDStart uint64 `json:"pidStart,omitempty"`
	// SID is the writer's POSIX session id, which for anything started inside
	// a muxterm pane is that pane's root shell pid -- the exact key the owners
	// map is built on. See processSessionID.
	//
	// Recorded by the producer rather than derived by the reader because the
	// reader may be looking at this file AFTER the writer has exited, and an
	// ancestor walk needs /proc entries that no longer exist. One integer,
	// captured while the process lived, is what lets a finished session's row
	// still be placed on the terminal it ran in.
	//
	// Zero means the producer did not supply one (an older hook, a non-Linux
	// writer). Such a snapshot falls back to the ancestor walk, which works
	// while the process lives and not afterwards.
	SID int `json:"sid,omitempty"`
}

// snapshotPIDMatches reports whether the process now holding snap.PID is the
// same process that wrote the snapshot.
func snapshotPIDMatches(snap sessionSnapshot) bool {
	if snap.PIDStart == 0 {
		return true // writer could not tell us; do not punish the row for it
	}
	start, ok := processStartTime(snap.PID)
	if !ok {
		return true // reader cannot tell either; same reasoning
	}
	return start == snap.PIDStart
}

// sessionStore holds the change gate for session-state pushes.
//
// It deliberately does NOT cache the snapshots themselves. The spool directory
// is already a durable store that the hook keeps current, and re-reading a
// handful of sub-kilobyte files from a tmpfs once a second is cheaper than the
// staleness bugs a second copy would invite. What must persist between ticks is
// only the answer to "did anything change?", which is one hash.
// The -Locked suffix on rearmLocked/changedLocked carries the contract the way
// this codebase does elsewhere: both mutate lastHash/hasSent and both MUST be
// called with Server.mu held. collect deliberately carries no such suffix -- it
// touches only dir (written once before the server is published) and does
// filesystem and /proc work that must never run under the server mutex.
type sessionStore struct {
	dir      string
	lastHash uint64
	hasSent  bool

	// warnedVersions remembers which (file, version) pairs have already been
	// logged as unreadable, so a snapshot from a future producer costs ONE log
	// line rather than one per tick forever. Touched only by collect, which
	// runs solely on the session-state ticker goroutine -- it is deliberately
	// NOT guarded by Server.mu, and must not be read from anywhere else.
	warnedVersions map[string]int
}

func newSessionStore() *sessionStore {
	return &sessionStore{dir: sessionStateDir(), warnedVersions: map[string]int{}}
}

// rearmLocked forces the next collection to publish even if nothing changed, so a
// connection that has just subscribed receives the current picture instead of
// waiting for some session to happen to change state.
func (s *sessionStore) rearmLocked() {
	s.hasSent = false
	s.lastHash = 0
}

// changedLocked reports whether rows differ from the last published set, recording
// them as the new baseline. Callers publish only when it returns true.
func (s *sessionStore) changedLocked(rows []SessionState) bool {
	h := sessionStateHash(rows)
	if s.hasSent && s.lastHash == h {
		return false
	}
	s.lastHash = h
	s.hasSent = true
	return true
}

// collect reads the spool directory, joins each snapshot to the pane running
// it, and returns the rows in a deterministic order.
//
// It takes the owners map rather than the registry view so the read-and-join is
// separable from the registry snapshot: the caller decides when to look at the
// registry (and pays for it under no lock), and this half can be exercised
// against any process tree.
//
// Snapshots that cannot be placed are dropped rather than guessed at: a row
// with no pane is a row the home view cannot act on, and inventing a location
// for it would be worse than omitting it.
//
// A session that ENDED outlives its process here. That is the whole point of
// the view -- it answers "how did it end?", which a row that vanishes the
// instant the agent exits cannot. Such a row is bounded to ONE per pane (the
// most recent ending), and is reclaimed the moment that pane starts another
// session or is closed. The pane's own
// lifetime is the row's lifetime, so no timer is needed and the spool stays
// bounded.
//
// Everything else whose process is gone is still deleted from disk here -- a
// session that is KILLED rather than exited never gets to write an ending, and
// nothing else will reclaim its file.
//
// None of that depends on having watched. An ending is placed from the `sid`
// the producer recorded into its own file, so a session that starts AND
// finishes with no browser open still has its row waiting when one opens.
func (s *sessionStore) collect(ownersFor func() map[int]paneRef) ([]SessionState, bool) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			// No spool directory means no session has ever published here --
			// the ordinary state of a machine with the hook uninstalled. An
			// authoritative empty set is the correct answer.
			return nil, true
		}
		// Anything else (EMFILE under load, a remount, a permission change) is
		// "I could not look", NOT "there is nothing there". Publishing nil here
		// would assert an empty set as a whole-state document and blank the
		// home view for a tick. Report failure and let the caller skip.
		return nil, false
	}

	// The owners map is resolved lazily, and only once, because building it
	// takes a full registry snapshot -- deep-copying every workspace's layout
	// and touching every pane's activity lock. On a machine with no snapshots
	// at all that would be a per-second cost for nothing.
	var owners map[int]paneRef
	rows := make([]SessionState, 0, len(entries))
	// Snapshots that survived reading, held back until the per-pane decision
	// below: whether a pane's ending is published depends on what ELSE that
	// pane has, which is not known until every entry has been read.
	pending := make([]pendingRow, 0, len(entries))
	// Rebuilt fresh each tick rather than mutated in place, so a snapshot that
	// is deleted and later replaced by a good one does not leave a permanent
	// entry behind, and the map cannot grow without bound.
	warned := make(map[string]int, len(s.warnedVersions))
	defer func() { s.warnedVersions = warned }()
	for _, entry := range entries {
		// Regular files only, and bounded. A symlink or a FIFO named "x.json"
		// would otherwise be handed to os.ReadFile: a FIFO with no writer
		// blocks FOREVER, and this runs synchronously on the ticker goroutine,
		// which would then never observe ctx.Done() again. The name filter also
		// skips the hook's ".<session>.tmp" staging files, which are only ever
		// visible mid-write and are not documents.
		if !entry.Type().IsRegular() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if info, err := entry.Info(); err != nil || info.Size() > maxSessionSnapshotBytes {
			continue
		}
		path := filepath.Join(s.dir, entry.Name())
		snap, ok := readSessionSnapshot(path)
		if !ok {
			continue
		}
		if snap.V > sessionSnapshotVersion {
			// Written by a producer newer than this daemon. Skip it rather
			// than render half of it: the whole point of shipping a version is
			// that the reader gets to decline, loudly, instead of silently
			// mis-displaying a shape it does not know. The file is left ALONE
			// (not deleted) -- a newer daemon may be about to read it, and
			// destroying another component's data over a version skew would be
			// the worst possible response.
			//
			// Logged once per (file, version), not once per tick: this runs
			// every second, and a stuck snapshot would otherwise fill the log.
			warned[path] = snap.V
			if s.warnedVersions[path] != snap.V {
				log.Printf("sessiond: ignoring session snapshot %s: schema v%d, this daemon understands up to v%d", entry.Name(), snap.V, sessionSnapshotVersion)
			}
			continue
		}
		if snap.PID <= 0 {
			// Not attributable to any process, now or ever.
			_ = os.Remove(path)
			continue
		}
		if owners == nil {
			owners = ownersFor()
		}

		if processLive(snap.PID) {
			if !snapshotPIDMatches(snap) {
				// The pid is live but it is somebody ELSE now: this snapshot
				// outlived its session and the kernel handed the number on.
				// Publishing it would pin a dead session's row to an unrelated
				// terminal, indistinguishable from a real one.
				_ = os.Remove(path)
				continue
			}
			pane, ok := placeSnapshot(snap, owners)
			if !ok {
				// Running, but not inside any pane of ours. Left on disk
				// rather than reclaimed: it is a live process's file, and it
				// is not ours to delete.
				continue
			}
			pending = append(pending, pendingRow{
				row:  stampPane(snap.SessionState, pane),
				path: path,
				pane: pane,
				live: true,
			})
			continue
		}

		// The process is gone. Whether the row goes with it depends on
		// whether the session ENDED or was killed.
		if !sessionStateIsTerminal(snap.State) {
			_ = os.Remove(path)
			continue
		}
		pane, ok := placeSnapshot(snap, owners)
		if !ok {
			// Its pane is gone -- or it never wrote a sid, in which case the
			// walk has nothing left to walk now that /proc has forgotten the
			// process. Either way there is no terminal to show this on, and
			// closing a pane is the user saying they are done with it,
			// endings included.
			_ = os.Remove(path)
			continue
		}
		pending = append(pending, pendingRow{
			row:  stampPane(snap.SessionState, pane),
			path: path,
			pane: pane,
		})
	}

	// Second phase: per pane, decide which of its snapshots to publish.
	//
	// A pane shows the sessions LIVE in it. Only when it has none does it show
	// how its most recent one ended -- exactly one row, so a pane that has run
	// twenty sessions today does not accumulate twenty tombstones. Everything
	// a pane does not publish is reclaimed, which is what bounds the spool
	// without a timer.
	byPane := make(map[paneRef][]int, len(pending))
	for i := range pending {
		byPane[pending[i].pane] = append(byPane[pending[i].pane], i)
	}
	keep := make([]bool, len(pending))
	for _, idxs := range byPane {
		hasLive := false
		for _, i := range idxs {
			if pending[i].live {
				hasLive = true
				break
			}
		}
		newest := -1
		for _, i := range idxs {
			if pending[i].live {
				keep[i] = true
				continue
			}
			if hasLive {
				// Superseded by whatever is running there now.
				continue
			}
			if newest < 0 || endingIsNewer(pending[i].row, pending[newest].row) {
				newest = i
			}
		}
		if newest >= 0 {
			keep[newest] = true
		}
	}
	for i := range pending {
		if !keep[i] {
			_ = os.Remove(pending[i].path)
			continue
		}
		rows = append(rows, pending[i].row)
	}

	// Deterministic order, so an unchanged set hashes identically tick after
	// tick regardless of what order the filesystem handed the entries back.
	// Stable, so two files somehow declaring the same session id cannot flap
	// the ordering (and therefore the hash) and republish on every tick.
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].WorkspaceID != rows[j].WorkspaceID {
			return rows[i].WorkspaceID < rows[j].WorkspaceID
		}
		if rows[i].PaneID != rows[j].PaneID {
			return rows[i].PaneID < rows[j].PaneID
		}
		return rows[i].SessionID < rows[j].SessionID
	})
	return rows, true
}

// placeSnapshot resolves the pane a snapshot belongs to.
//
// sid first, when the producer wrote one: a pane's root shell leads its own
// POSIX session, so that single integer is the whole join and -- because it
// lives in the file rather than in /proc -- it still resolves after the writer
// has exited. That is what lets a finished session keep its row.
//
// The ancestor walk stays for producers that write no sid. It is correct while
// the process lives and impossible afterwards, which is exactly the old
// behaviour, unchanged for them.
func placeSnapshot(snap sessionSnapshot, owners map[int]paneRef) (paneRef, bool) {
	if snap.SID > 0 {
		if ref, ok := owners[snap.SID]; ok {
			return ref, true
		}
	}
	return resolvePaneForPID(snap.PID, owners)
}

// pendingRow is one snapshot that survived reading, waiting on collect's
// per-pane decision. It carries its own path so an unpublished one can be
// reclaimed without going back to the directory.
type pendingRow struct {
	row  SessionState
	path string
	pane paneRef
	// live distinguishes "the process is running" from "this is how it ended".
	live bool
}

// stampPane fills in the two fields a producer cannot know about itself.
func stampPane(row SessionState, pane paneRef) SessionState {
	row.PaneID = pane.paneID
	row.WorkspaceID = pane.workspaceID
	return row
}

// sessionStateIsTerminal reports whether a state is an ENDING rather than a
// moment.
//
// Only these three outlive their process. A `working` or `blocked` snapshot
// whose process is gone is a crash artifact -- the session was killed before
// its producer could write an ending -- and leaving it up would assert that a
// session is thinking, or waiting on a human, when it is neither. That is the
// one direction this view must never fail in.
func sessionStateIsTerminal(state string) bool {
	switch state {
	case SessionStateDone, SessionStateFailed, SessionStateStopped:
		return true
	}
	return false
}

// endingIsNewer orders two endings in the same pane, most recent first.
//
// The session id breaks ties. UpdatedAt is whole seconds, so two sessions
// ending in the same second is not exotic, and an unstable answer there would
// flap the published set on every tick.
func endingIsNewer(a, b SessionState) bool {
	if a.UpdatedAt != b.UpdatedAt {
		return a.UpdatedAt > b.UpdatedAt
	}
	return a.SessionID > b.SessionID
}

// paneRef is a pane's identity: everything the join needs to stamp onto a row.
type paneRef struct {
	workspaceID string
	paneID      int
}

// paneOwners maps each live pane's root process id to that pane's identity.
//
// rootPID is the shell sessiond spawned for the pane. Every process the user
// starts in that terminal -- whichever agent CLI it happens to be -- descends
// from it, which is what makes an ancestor walk a correct and complete join.
func paneOwners(views []workspaceLiveView) map[int]paneRef {
	owners := make(map[int]paneRef)
	for _, ws := range views {
		for _, p := range ws.Panes {
			snap := p.activitySnapshot()
			if snap.exited || snap.pid <= 0 {
				continue
			}
			owners[snap.pid] = paneRef{workspaceID: ws.ID, paneID: p.LocalID}
		}
	}
	return owners
}

// resolvePaneForPID walks up the process tree from pid until it reaches a pane's
// root process, bounded by sessionStateAncestorHops.
//
// The pid itself is checked first, so a pane whose root process IS the agent
// (a pane spawned directly with an agent command rather than a shell)
// resolves without any walk at all.
func resolvePaneForPID(pid int, owners map[int]paneRef) (paneRef, bool) {
	current := pid
	for hop := 0; hop < sessionStateAncestorHops; hop++ {
		if ref, ok := owners[current]; ok {
			return ref, true
		}
		parent, ok := parentPID(current)
		if !ok || parent == current || parent <= 1 {
			return paneRef{}, false
		}
		current = parent
	}
	return paneRef{}, false
}

// readSessionSnapshot decodes one snapshot file.
//
// A malformed or truncated file is skipped silently rather than logged: the
// hook writes with write-then-rename so a partial document should be
// impossible, but if one ever appears, the next event repairs it. Snapshots are
// whole-state documents, which is precisely what makes a lost or unreadable one
// self-healing instead of a permanently wrong delta.
func readSessionSnapshot(path string) (sessionSnapshot, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return sessionSnapshot{}, false
	}
	var snap sessionSnapshot
	if err := json.Unmarshal(data, &snap); err != nil {
		return sessionSnapshot{}, false
	}
	if snap.SessionID == "" {
		return sessionSnapshot{}, false
	}
	return snap, true
}

// sessionStateHash summarizes a published set so an unchanged one costs nothing.
//
// It covers every field the browser renders, and deliberately EXCLUDES
// UpdatedAt: the hook stamps that on each write, so including it would make
// every snapshot rewrite look like a change and defeat the gate entirely. Two
// sets that would render identically must hash identically.
func sessionStateHash(rows []SessionState) uint64 {
	h := fnv.New64a()
	for _, r := range rows {
		writeHashField(h, r.SessionID)
		writeHashField(h, r.WorkspaceID)
		writeHashField(h, strconv.Itoa(r.PaneID))
		writeHashField(h, r.Harness)
		writeHashField(h, r.Project)
		writeHashField(h, r.Name)
		writeHashField(h, r.Label)
		writeHashField(h, r.Mode)
		writeHashField(h, r.State)
		writeHashField(h, r.WaitingFor)
		writeHashField(h, r.Doing)
		writeHashField(h, r.DoneMeans)
		writeHashField(h, strconv.Itoa(r.PR))
		// The row's variable-length tail is framed by a LEADING COUNT, not by a
		// trailing sentinel. A sentinel would itself be just another
		// length-delimited field, and Knows entries are unvalidated strings
		// straight out of artifact:read -- an entry equal to the sentinel would
		// close its row early and let the following entries be consumed as the
		// next row's fixed fields, so two genuinely different sets could hash
		// identically and a real change would be silently suppressed. A leading
		// count makes the boundary structural, so no value can forge one.
		writeHashField(h, strconv.Itoa(len(r.Knows)))
		for _, k := range r.Knows {
			writeHashField(h, k)
		}
	}
	return h.Sum64()
}

// writeHashField appends a length-delimited field, so adjacent values cannot be
// rearranged into the same digest.
func writeHashField(h interface{ Write([]byte) (int, error) }, s string) {
	_, _ = h.Write([]byte(strconv.Itoa(len(s))))
	_, _ = h.Write([]byte{':'})
	_, _ = h.Write([]byte(s))
}
