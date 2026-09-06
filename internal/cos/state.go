package cos

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/kenotron-ms/muxterm/internal/sessiond"
)

// stateFileName is the status file the supervisor publishes while a sidecar is
// live. It sits beside the sessiond socket, which is deliberate: that
// directory is XDG_RUNTIME_DIR-scoped, so `make dev-local` (which overrides
// XDG_RUNTIME_DIR) reports on ITS sidecar and never on production's.
const stateFileName = "cos.json"

// State is the published status of a running sidecar. It exists because the
// sidecar is a CHILD of whatever process supervises it - the CLI verb today,
// the server later - so a separate `muxterm cos --status` invocation has no
// other way to see it. Same idea as sessiond's server.url file.
type State struct {
	// PID is the sidecar (python) process.
	PID int `json:"pid"`
	// OwnerPID is the muxterm process supervising it.
	OwnerPID  int       `json:"ownerPid"`
	SessionID string    `json:"sessionId"`
	Bundle    string    `json:"bundle,omitempty"`
	Tools     int       `json:"tools,omitempty"`
	BootMS    int64     `json:"bootMs,omitempty"`
	Resumed   bool      `json:"resumed,omitempty"`
	StartedAt time.Time `json:"startedAt"`
	Python    string    `json:"python,omitempty"`
	Script    string    `json:"script,omitempty"`
}

// StatePath returns the default status file path.
func StatePath() (string, error) {
	sock, err := sessiond.SocketPath()
	if err != nil {
		return "", fmt.Errorf("cos: resolve runtime dir: %w", err)
	}
	return filepath.Join(filepath.Dir(sock), stateFileName), nil
}

// processAlive reports whether pid names a process that still exists. Signal 0
// performs the permission and existence checks without delivering anything,
// which is the standard way to ask "is this pid still there".
//
// A pid can be recycled, so this is advisory: it distinguishes "clearly gone"
// from "probably still running", which is all a status command needs.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

// Alive reports whether the recorded sidecar process still exists.
func (st State) Alive() bool { return processAlive(st.PID) }

// OwnerAlive reports whether the muxterm process supervising the sidecar still
// exists. This is the one that matters for ownership: the owner is who to talk
// to, and who is entitled to rewrite or delete this file.
func (st State) OwnerAlive() bool { return processAlive(st.OwnerPID) }

// Uptime reports how long the sidecar has been running.
func (st State) Uptime() time.Duration {
	if st.StartedAt.IsZero() {
		return 0
	}
	return time.Since(st.StartedAt).Round(time.Second)
}

// ReadState loads the status file. An empty path uses StatePath().
func ReadState(path string) (State, error) {
	if path == "" {
		p, err := StatePath()
		if err != nil {
			return State{}, err
		}
		path = p
	}
	data, err := os.ReadFile(path) //nolint:gosec // path is process-owned runtime state
	if err != nil {
		return State{}, err
	}
	var st State
	if err := json.Unmarshal(data, &st); err != nil {
		return State{}, fmt.Errorf("cos: parse %s: %w", path, err)
	}
	return st, nil
}

// statePath resolves this supervisor's status file path, or "" when the status
// file is disabled.
func (s *Supervisor) statePath() string {
	if s.cfg.StatePath == "-" {
		return ""
	}
	if s.cfg.StatePath != "" {
		return s.cfg.StatePath
	}
	p, err := StatePath()
	if err != nil {
		s.cfg.Logf("cos: no status file: %v", err)
		return ""
	}
	return p
}

// foreignOwner reports the pid of a LIVE process, other than this one, that
// already published the status file at path.
//
// This is the ownership check behind writeState and removeState. The status
// file describes ONE sidecar, and the process that supervises that sidecar is
// its owner. A second muxterm process (the `muxterm cos` CLI verb beside a
// running server, say) has no business rewriting the owner's pid into it or
// deleting it on the way out -- do either and `muxterm cos --status` reports
// the server's live sidecar as gone.
//
// A stale file whose owner has exited is NOT foreign: it is debris, and the
// next owner is entitled to replace it.
func foreignOwner(path string) (int, bool) {
	st, err := ReadState(path)
	if err != nil {
		return 0, false // absent or unreadable: nobody owns it
	}
	if st.OwnerPID <= 0 || st.OwnerPID == os.Getpid() {
		return 0, false
	}
	if !st.OwnerAlive() {
		return 0, false
	}
	return st.OwnerPID, true
}

// writeState publishes the status file atomically (write-temp-then-rename), so
// a concurrent --status never reads a half-written file. Failures are logged,
// never fatal: this file is a convenience, not part of the protocol.
//
// It is a NO-OP when another live process owns the file. A second sidecar on
// this machine (started with its own --session-id) is legitimate; overwriting
// the first one's published status with its own is not, because that status is
// what the CLI, and anyone reading it, uses to find the owner.
func (s *Supervisor) writeState(st State) {
	path := s.statePath()
	if path == "" {
		return
	}
	if owner, ok := foreignOwner(path); ok {
		s.cfg.Logf("cos: not publishing a status file: pid %d already owns %s", owner, path)
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		s.cfg.Logf("cos: status file dir: %v", err)
		return
	}
	data, err := json.Marshal(st)
	if err != nil {
		s.cfg.Logf("cos: encode status: %v", err)
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		s.cfg.Logf("cos: write status file: %v", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		s.cfg.Logf("cos: publish status file: %v", err)
		_ = os.Remove(tmp)
	}
}

// removeState deletes the status file. Only the owning process removes it, so
// a crashed owner leaves a stale file behind - which is why readers must check
// Alive rather than trusting the file's existence.
//
// "Only the owning process" is ENFORCED here, not merely intended: a non-owner
// that deleted this on its way out would make the owner's live sidecar report
// as not running.
func (s *Supervisor) removeState() {
	path := s.statePath()
	if path == "" {
		return
	}
	if owner, ok := foreignOwner(path); ok {
		s.cfg.Logf("cos: leaving %s alone: pid %d owns it", path, owner)
		return
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		s.cfg.Logf("cos: remove status file: %v", err)
	}
}
