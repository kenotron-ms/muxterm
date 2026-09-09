package sessiond

// Firing a trigger: the four refusals, then the spawn.
//
// Read attemptFire top to bottom and the shape of the safety model is the
// shape of the function -- every early return writes a fire record saying what
// it refused and why, and only the bottom of the function spawns anything.
//
// That ordering is the point. amplifier-drumbeat's sharpest recorded lesson is
// that a run which produced nothing and a run which never happened were
// byte-identical from outside; here they are four distinct persisted outcomes.

import (
	"fmt"
	"log"
	"time"
)

// attemptFire is the ONLY path that starts trigger work. It is called solely
// from the engine goroutine.
//
// It ALWAYS records something. A fire attempt that leaves no trace is the
// failure mode this whole feature is defending against.
func (e *triggerEngine) attemptFire(id, reason string) {
	t, ok := e.store.Get(id)
	if !ok {
		return
	}
	now := time.Now().Unix()

	// Deleted or disabled between being scheduled and being fired. No record:
	// a disabled trigger having "not fired" is not an event.
	if !t.Enabled {
		return
	}

	// REFUSAL 1: max_runs. Checked before overlap so a trigger that has done
	// its work turns itself off rather than reporting skips forever.
	if t.MaxRuns > 0 && t.RunCount >= t.MaxRuns {
		detail := fmt.Sprintf("reached max_runs (%d)", t.MaxRuns)
		e.store.RecordFire(id, TriggerFire{At: now, Outcome: FireSkippedMaxRuns, Detail: detail},
			func(t *Trigger) {
				t.Enabled = false
				t.DisabledReason = detail
			})
		log.Printf("sessiond: trigger %q disabled itself: %s", t.Name, detail)
		return
	}

	// REFUSAL 2: OVERLAP. The single most important safeguard here.
	if running, why := e.laneRunning(t); running {
		e.store.RecordFire(id, TriggerFire{At: now, Outcome: FireSkippedOverlap, Detail: why}, nil)
		log.Printf("sessiond: trigger %q skipped (%s): %s", t.Name, reason, why)
		return
	}

	// REFUSAL 3: the global cap on trigger-spawned lanes. Triggers are not the
	// only thing spawning lanes on this machine and must not crowd out the
	// human.
	if n := e.concurrentLanes(id); n >= triggerMaxConcurrentLanes {
		detail := fmt.Sprintf("%d trigger lanes already running (cap %d)", n, triggerMaxConcurrentLanes)
		e.store.RecordFire(id, TriggerFire{At: now, Outcome: FireSkippedCap, Detail: detail}, nil)
		log.Printf("sessiond: trigger %q skipped (%s): %s", t.Name, reason, detail)
		return
	}

	// Nothing refused it. Spawn.
	wsID, paneID, err := e.srv.spawnTriggerLane(t)
	if err != nil {
		// A spawn that failed is NOT a lane that failed: no lane exists, so no
		// completion record will ever arrive to settle it. It counts against
		// the failure streak here directly, because a trigger whose workspace
		// name is invalid would otherwise retry forever without ever reaching
		// the failure-disable.
		detail := err.Error()
		disableReason := ""
		e.store.RecordFire(id, TriggerFire{At: now, Outcome: FireError, Detail: detail}, func(t *Trigger) {
			t.ConsecutiveFailures++
			if t.ConsecutiveFailures >= triggerFailureDisableThreshold {
				t.Enabled = false
				disableReason = fmt.Sprintf("%d consecutive failures (last: %s)", t.ConsecutiveFailures, detail)
				t.DisabledReason = disableReason
			}
		})
		log.Printf("sessiond: trigger %q could not spawn a lane: %v", t.Name, err)
		if disableReason != "" {
			e.store.RecordFire(id, TriggerFire{At: now, Outcome: FireDisabled, Detail: disableReason}, nil)
			log.Printf("sessiond: trigger %q disabled itself: %s", t.Name, disableReason)
		}
		return
	}

	e.store.RecordFire(id, TriggerFire{
		At:          now,
		Outcome:     FireFired,
		Detail:      reason,
		WorkspaceID: wsID,
		PaneID:      paneID,
	}, func(t *Trigger) {
		t.LastFireAt = now
		t.LastWorkspaceID = wsID
		t.LastPaneID = paneID
		// A fresh lane is unsettled by definition: its outcome does not exist
		// yet. Clearing this is what re-arms the settle pass.
		t.LastSettled = false
		t.RunCount++
	})
	log.Printf("sessiond: trigger %q fired (%s): lane in workspace %s pane %d", t.Name, reason, wsID, paneID)
}

// spawnTriggerLane starts a trigger's lane: resolve-or-create the workspace,
// then create the pane with the harness argv.
//
// This is the server-side twin of mcp.spawnLane, and it exists because a
// trigger fires when NOBODY IS CONNECTED. The MCP path is connection-scoped by
// construction -- conn.createPane targets whatever workspace that connection is
// attached to -- and there is no connection at 3am. The daemon has to be able
// to do this itself.
//
// It is deliberately the same SHAPE as conn.createPane, including the
// autolabel, so a triggered lane is indistinguishable from a hand-started one
// everywhere it is later displayed. The one intentional difference is that
// nothing is ACKed to a caller: the broadcast is the only notification, because
// the only interested parties are browsers that were not the ones who asked.
func (s *Server) spawnTriggerLane(t Trigger) (wsID string, paneID int, err error) {
	argv, err := LaneArgv(t.Harness, t.Prompt, t.Goal)
	if err != nil {
		return "", 0, err
	}

	wsID, created := s.resolveOrCreateWorkspace(t.Workspace)
	if wsID == "" {
		return "", 0, fmt.Errorf("could not resolve or create workspace %q", t.Workspace)
	}

	localID, ok := s.reg.AllocPaneID(wsID)
	if !ok {
		return "", 0, fmt.Errorf("workspace %q vanished while spawning", t.Workspace)
	}
	cols, rows := sizeOrDefault(0, 0)
	p, perr := NewPane(
		localID,
		argv,
		cols, rows,
		nil, // VTBuffer, as for any live-created pane -- get_screen needs it.
		func(id int, data []byte) { s.broadcastPaneData(wsID, id, data) },
		func(id int, exitCode int, runtimeMs int64) { s.handlePaneExit(wsID, id, exitCode, runtimeMs) },
		func(id int, m *Message) {
			m.WorkspaceID = wsID
			m.PaneID = id
			s.broadcast(wsID, m)
		},
		"", // cwd: no override, matching a live-created pane.
	)
	if perr != nil {
		// A FAILED FIRE LEAVES NOTHING BEHIND, on the same reasoning spawn_lane
		// gives: an empty workspace in the dock is a false record of work
		// having started. Only a workspace THIS call created is removed.
		if created {
			if panes, _, ok := s.reg.CloseWorkspace(wsID); ok {
				for _, pane := range panes {
					pane.Close()
				}
				s.broadcastWorkspaceClosed(wsID)
			}
		}
		return "", 0, fmt.Errorf("spawning %s lane in workspace %q: %w", t.Harness, t.Workspace, perr)
	}

	if title := labelFromPrompt(promptFromArgv(argv)); title != "" {
		p.setTitleDerived(title)
	}
	s.reg.PutPane(wsID, p)
	s.broadcast(wsID, &Message{
		Type:        TypePaneAdded,
		WorkspaceID: wsID,
		PaneID:      localID,
		Cols:        cols,
		Rows:        rows,
		Title:       labelFromPrompt(promptFromArgv(argv)),
	})
	// The dock has to learn about a workspace that appeared with nobody
	// asking for it. Sent for an existing workspace too, because its pane
	// count changed.
	s.broadcastWorkspaceList()
	return wsID, localID, nil
}

// resolveOrCreateWorkspace is the daemon-side twin of
// mcp.ResolveOrCreateWorkspace: exact, case-sensitive name match, first match
// in list order wins, create when nothing carries that name.
//
// Kept identical on purpose. A trigger naming the same workspace as a spawn_lane
// call has to land in the same place, or "run this every morning in my review
// workspace" quietly accumulates a new workspace every morning.
func (s *Server) resolveOrCreateWorkspace(name string) (id string, created bool) {
	for _, ws := range s.reg.List() {
		if ws.Name == name {
			return ws.WorkspaceID, false
		}
	}
	return s.reg.AddWorkspace(name, ""), true
}
