package sessiond

import (
	"encoding/json"
	"hash/fnv"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Session-state collection: read what sessions declare about themselves, and
// join it to the panes they are running in.
//
// The producer is the Amplifier hook in modules/hooks-muxterm-session, which
// writes one atomically-replaced JSON snapshot per session into a spool
// directory. See sessionstate.go for the contract and why a declared channel
// has to exist at all (short version: TIOCGPGRP cannot tell an agent that is
// thinking from an agent that is waiting for a human, and that distinction is
// the whole feature).
//
// Division of labour, and why it falls this way:
//
//   - The hook knows its own pid and nothing about muxterm. Teaching it about
//     panes would duplicate knowledge the registry already owns.
//   - The daemon knows which pane owns which process. It performs the join.
//
// So a snapshot on disk carries `pid` and omits paneId/workspaceId, and this
// file fills those in.

// sessionStateDirName is the spool subdirectory, resolved beneath the same
// socketDir() the control socket lives in. Deriving it from socketDir rather
// than hardcoding a path is what makes `make dev-local` isolation automatic:
// that target overrides XDG_RUNTIME_DIR, sessiond inherits it, panes inherit it
// from sessiond, and the hook -- running inside a pane -- computes the very
// same directory. A dev daemon can never read production's spool, and neither
// side needs to be told which world it is in.
const sessionStateDirName = "session-state"

// sessionStateAncestorHops bounds the walk from a session's pid up to a pane's
// root shell. Real depth is two or three (pane shell -> amplifier, sometimes
// with a wrapper); the cap exists so a /proc that lies, or a cycle that should
// be impossible, costs a bounded number of reads instead of a hung tick.
const sessionStateAncestorHops = 32

// sessionStateDir returns the directory the hook writes snapshots into.
func sessionStateDir() string {
	return filepath.Join(socketDir(), sessionStateDirName)
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
	PID int `json:"pid"`
}

// sessionStore holds the change gate for session-state pushes.
//
// It deliberately does NOT cache the snapshots themselves. The spool directory
// is already a durable store that the hook keeps current, and re-reading a
// handful of sub-kilobyte files from a tmpfs once a second is cheaper than the
// staleness bugs a second copy would invite. What must persist between ticks is
// only the answer to "did anything change?", which is one hash.
type sessionStore struct {
	dir      string
	lastHash uint64
	hasSent  bool
}

func newSessionStore() *sessionStore {
	return &sessionStore{dir: sessionStateDir()}
}

// rearm forces the next collection to publish even if nothing changed, so a
// connection that has just subscribed receives the current picture instead of
// waiting for some session to happen to change state.
func (s *sessionStore) rearm() {
	s.hasSent = false
	s.lastHash = 0
}

// changed reports whether rows differ from the last published set, recording
// them as the new baseline. Callers publish only when it returns true.
func (s *sessionStore) changed(rows []SessionState) bool {
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
// Snapshots that cannot be placed are dropped rather than guessed at: a row
// with no pane is a row the home view cannot act on, and inventing a location
// for it would be worse than omitting it. Snapshots whose process is gone are
// deleted from disk here -- a session that is killed rather than exited never
// gets to clean up after itself, so the reader has to be the one that does.
func (s *sessionStore) collect(views []workspaceLiveView) []SessionState {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		// No spool directory means no session has ever published here. That is
		// the ordinary state of a machine with the hook uninstalled, not an
		// error worth reporting on every tick.
		return nil
	}

	owners := paneOwners(views)
	rows := make([]SessionState, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			// Skip the hook's ".<session>.tmp" write-then-rename staging files;
			// they are only ever visible mid-write and are not documents.
			continue
		}
		path := filepath.Join(s.dir, entry.Name())
		snap, ok := readSessionSnapshot(path)
		if !ok {
			continue
		}
		if snap.PID <= 0 || !processLive(snap.PID) {
			// The session is gone. Reclaim the file; nothing else will.
			_ = os.Remove(path)
			continue
		}
		pane, ok := resolvePaneForPID(snap.PID, owners)
		if !ok {
			continue
		}
		row := snap.SessionState
		row.PaneID = pane.paneID
		row.WorkspaceID = pane.workspaceID
		rows = append(rows, row)
	}

	// Deterministic order, so an unchanged set hashes identically tick after
	// tick regardless of what order the filesystem handed the entries back.
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].WorkspaceID != rows[j].WorkspaceID {
			return rows[i].WorkspaceID < rows[j].WorkspaceID
		}
		if rows[i].PaneID != rows[j].PaneID {
			return rows[i].PaneID < rows[j].PaneID
		}
		return rows[i].SessionID < rows[j].SessionID
	})
	return rows
}

// paneRef is a pane's identity: everything the join needs to stamp onto a row.
type paneRef struct {
	workspaceID string
	paneID      int
}

// paneOwners maps each live pane's root process id to that pane's identity.
//
// rootPID is the shell sessiond spawned for the pane. Every process the user
// starts in that terminal -- including `amplifier` -- descends from it, which
// is what makes an ancestor walk a correct and complete join.
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
// (a pane spawned directly with an `amplifier` command rather than a shell)
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
		writeHashField(h, r.Project)
		writeHashField(h, r.Name)
		writeHashField(h, r.Mode)
		writeHashField(h, r.State)
		writeHashField(h, r.WaitingFor)
		writeHashField(h, r.Doing)
		writeHashField(h, r.DoneMeans)
		writeHashField(h, strconv.Itoa(r.PR))
		for _, k := range r.Knows {
			writeHashField(h, k)
		}
		// Row terminator, so ["a","b"] and ["ab"] cannot collide.
		writeHashField(h, "\x00row")
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
