package sessiond

import (
	"fmt"
	"time"
)

const updateGateLifetime = 3 * time.Minute

// SetRestoreEnabled records what this daemon actually read at boot. Reading
// config.toml from the web process can disagree with a running daemon and
// must never authorize an unattended restart.
func (s *Server) SetRestoreEnabled(enabled bool) {
	s.updateGateMu.Lock()
	s.restoreEnabled = enabled
	s.updateGateMu.Unlock()
}

func (s *Server) updateGateActive() bool {
	s.updateGateMu.Lock()
	defer s.updateGateMu.Unlock()
	return time.Now().Before(s.updateGateUntil)
}

func (s *Server) releaseUpdateGate() {
	s.updateGateMu.Lock()
	s.updateGateUntil = time.Time{}
	s.updateGateMu.Unlock()
}

// prepareUpdate temporarily refuses new input, panes, and trigger launches.
// It then inspects each pane twice using the same daemon-owned authority used
// for destructive close. Unknown is unsafe. A successful snapshot write proves
// that the destination for the imminent restore is writable now. The web
// process must still recheck its own active Work and switch before rename.
func (s *Server) prepareUpdate() (bool, string) {
	s.updateGateMu.Lock()
	if !s.restoreEnabled {
		s.updateGateMu.Unlock()
		return false, "The running terminal daemon did not start with session restore enabled."
	}
	if time.Now().Before(s.updateGateUntil) {
		s.updateGateMu.Unlock()
		return false, "Another update is preparing."
	}
	s.updateGateUntil = time.Now().Add(updateGateLifetime)
	s.updateGateMu.Unlock()

	s.mu.Lock()
	for client := range s.conns {
		if client.kind == ClientKindInteractive && client.attached != "" {
			s.mu.Unlock()
			s.releaseUpdateGate()
			return false, "A browser is connected to a terminal; update deferred until it disconnects."
		}
	}
	s.mu.Unlock()

	for pass := 0; pass < 2; pass++ {
		if pass == 1 {
			time.Sleep(750 * time.Millisecond)
		}
		for _, workspace := range s.reg.snapshotView() {
			for _, pane := range workspace.Panes {
				assessment := pane.ClassifyActivity()
				if assessment.Classification != ActivityIdle {
					s.releaseUpdateGate()
					return false, fmt.Sprintf("Pane %d in %s is %s (%s).", pane.LocalID, workspace.ID, assessment.Classification, assessment.Reason)
				}
			}
		}
	}
	if err := WriteSnapshot(DefaultSnapshotPath(), BuildSnapshot(s.reg, "automatic-update-prepare")); err != nil {
		s.releaseUpdateGate()
		return false, "Could not write a restore snapshot: " + err.Error()
	}
	return true, ""
}
