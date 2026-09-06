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

// Alive reports whether the recorded sidecar process still exists. Signal 0
// performs the permission and existence checks without delivering anything,
// which is the standard way to ask "is this pid still there".
//
// A pid can be recycled, so this is advisory: it distinguishes "clearly gone"
// from "probably still running", which is all a status command needs.
func (st State) Alive() bool {
	if st.PID <= 0 {
		return false
	}
	p, err := os.FindProcess(st.PID)
	if err != nil {
		return false
	}
	return p.Signal(syscall.Signal(0)) == nil
}

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

// writeState publishes the status file atomically (write-temp-then-rename), so
// a concurrent --status never reads a half-written file. Failures are logged,
// never fatal: this file is a convenience, not part of the protocol.
func (s *Supervisor) writeState(st State) {
	path := s.statePath()
	if path == "" {
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
func (s *Supervisor) removeState() {
	path := s.statePath()
	if path == "" {
		return
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		s.cfg.Logf("cos: remove status file: %v", err)
	}
}
