package sessiond

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The PRODUCER half of the session-state contract: how a snapshot gets onto
// disk. sessionstore.go is the consumer half.
//
// This exists as exported package API, rather than being inlined into the CLI
// verb that uses it, because there are already two in-tree producers written in
// Go -- `muxterm session report` (cmd/muxterm/session_report_cmd.go) and the
// Claude Code adapter (claude_adapter.go) -- and the atomic-write discipline,
// the validation, and the schema version must have exactly ONE home. A second
// copy is a second place to forget the .tmp rename.
//
// Producers in other languages reimplement this from
// docs/session-state-protocol.md; it is about twenty lines, which is the point
// of choosing a file as the transport.

// maxSessionIDLen bounds a session id. The id becomes a filename, so this is
// also the filename bound.
const maxSessionIDLen = 128

// ValidSessionID reports whether id is safe to use as a spool filename.
//
// This is a SECURITY boundary, not a style check. The session id is
// concatenated into a path, so an id containing a separator or a parent
// reference would let a producer write outside the spool directory entirely --
// and `muxterm session report --session-id ...` takes that id from whatever
// shell script is calling it. An id is therefore restricted to characters that
// cannot mean anything to a path resolver.
//
// A leading dot is rejected as well: the reader skips dotfiles as staging
// artifacts, so an id starting with one would produce a snapshot that is
// written successfully and then silently never read -- the most confusing
// possible outcome for someone integrating a new producer.
func ValidSessionID(id string) bool {
	if id == "" || len(id) > maxSessionIDLen || strings.HasPrefix(id, ".") {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// WriteSessionSnapshot writes one session-state snapshot into the spool
// directory and returns the path it wrote.
//
// pid is the process whose pane this session belongs to -- NOT necessarily the
// caller's own pid. The daemon locates a row by walking /proc ancestry from
// this pid up to a pane's root shell, so it must name a process that is alive
// and inside a muxterm pane. A short-lived reporter (a shell script, a CI step)
// should pass its parent's pid; see the --pid flag on `muxterm session report`.
//
// Validation is strict and errors are returned rather than swallowed. A
// producer that silently writes garbage is worse than one that fails: the
// garbage is skipped by the reader with no explanation, and the operator is
// left looking at a home view that is missing a row for no visible reason.
//
// PaneID and WorkspaceID on row are IGNORED and written as zero. They are the
// daemon's to fill during the pane join; accepting them here would let a
// producer assert a location it cannot possibly know.
func WriteSessionSnapshot(row SessionState, pid int) (string, error) {
	if !ValidSessionID(row.SessionID) {
		return "", fmt.Errorf("invalid session id %q: must be 1-%d chars of [A-Za-z0-9._-] and not start with '.'", row.SessionID, maxSessionIDLen)
	}
	if !ValidState(row.State) {
		return "", fmt.Errorf("invalid state %q: want one of %s", row.State, strings.Join([]string{
			SessionStateWorking, SessionStateBlocked, SessionStateDone,
			SessionStateFailed, SessionStateStopped,
		}, ", "))
	}
	if !ValidMode(row.Mode) {
		return "", fmt.Errorf("invalid mode %q: want %s or %s", row.Mode, ModeAutonomous, ModeInteractive)
	}
	if !ValidWaitingFor(row.WaitingFor) {
		return "", fmt.Errorf("invalid waitingFor %q: want one of %s", row.WaitingFor, strings.Join([]string{
			WaitingForPermission, WaitingForInput, WaitingForSandbox,
			WaitingForWorker, WaitingForDialog,
		}, ", "))
	}
	if pid <= 0 {
		return "", fmt.Errorf("invalid pid %d: must be a live process inside a muxterm pane", pid)
	}

	// The daemon fills these during the join; see the doc comment.
	row.PaneID = 0
	row.WorkspaceID = ""

	start, _ := processStartTime(pid)
	snap := sessionSnapshot{SessionState: row, V: sessionSnapshotVersion, PID: pid, PIDStart: start}
	body, err := json.Marshal(snap)
	if err != nil {
		return "", fmt.Errorf("encode snapshot: %w", err)
	}
	// Refuse here rather than let the reader silently skip an oversized file.
	// The producer is the only party that can do anything about it.
	if len(body) > maxSessionSnapshotBytes {
		return "", fmt.Errorf("snapshot is %d bytes, over the %d-byte limit: shorten doing/doneMeans or send fewer knows entries", len(body), maxSessionSnapshotBytes)
	}

	dir := SessionStateDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create spool %s: %w", dir, err)
	}
	path := filepath.Join(dir, row.SessionID+".json")
	// Write-then-rename, so a reader mid-tick sees either the previous whole
	// document or the next one, never a half-written one. The temp file is a
	// SIBLING so os.Rename stays within one filesystem, which is what makes it
	// atomic; and it is dot-prefixed and .tmp-suffixed so the reader's
	// name filter skips it while it exists.
	tmp := filepath.Join(dir, "."+row.SessionID+".tmp")
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return "", fmt.Errorf("write %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("replace %s: %w", path, err)
	}
	return path, nil
}

// RemoveSessionSnapshot deletes a session's snapshot.
//
// Producers do not have to call this: the daemon reclaims any snapshot whose
// process is gone. It exists for the producer that wants a row to disappear
// while its process keeps running -- an adapter polling an upstream that has
// stopped reporting a session, for instance.
func RemoveSessionSnapshot(sessionID string) error {
	if !ValidSessionID(sessionID) {
		return fmt.Errorf("invalid session id %q", sessionID)
	}
	err := os.Remove(filepath.Join(SessionStateDir(), sessionID+".json"))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
