package sessiond

import (
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/kenotron-ms/muxterm/internal/config"
)

// expandTilde replaces a leading "~" with the user's home directory.
func expandTilde(path string) string {
	if !strings.HasPrefix(path, "~") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	return filepath.Join(home, path[1:])
}

// resolveRestoreCommand determines the best restore command for a pane.
// It reads the foreground process's argv, working directory, and environment,
// then evaluates each strategy in order. The first strategy whose detect
// condition is satisfied wins: its restore template is expanded using
// shell-style ${VAR} substitution and returned as the restore argv.
//
// Available template variables:
//   - ${ENV_VAR_NAME} — value of any env var present in the foreground process
//   - ${cwd} — working directory of the foreground process
//
// Falls back to captured argv and dir when no strategy matches.
func resolveRestoreCommand(p *Pane, strategies []config.RestoreStrategy) (argv []string, dir string) {
	fgArgv, fgDir, fgEnv := paneForegrounded(p)

	// Join argv to a single string for argv prefix matching.
	fgArgvStr := strings.Join(fgArgv, " ")

	for _, s := range strategies {
		cmd := s.Restore

		switch {
		case s.Detect.Argv != "":
			// Prefix match against the full argv string (as set by setproctitle).
			if !strings.HasPrefix(fgArgvStr, s.Detect.Argv) {
				continue
			}
			suffix := fgArgvStr[len(s.Detect.Argv):]
			cmd = strings.ReplaceAll(cmd, "${argv_suffix}", suffix)
			cmd = strings.ReplaceAll(cmd, "${cwd}", fgDir)

		case s.Detect.Env != "":
			// Env var must be present in the foreground process's environment.
			if _, ok := fgEnv[s.Detect.Env]; !ok {
				continue
			}
			for k, v := range fgEnv {
				cmd = strings.ReplaceAll(cmd, "${"+k+"}", v)
			}
			cmd = strings.ReplaceAll(cmd, "${cwd}", fgDir)

		case s.Detect.File != "":
			// File must exist and be non-empty. Its trimmed content is available
			// as ${file_content} in the restore template.
			path := expandTilde(s.Detect.File)
			data, err := os.ReadFile(path)
			if err != nil {
				continue // file missing — strategy doesn't apply
			}
			fileContent := strings.TrimSpace(string(data))
			if fileContent == "" {
				continue // empty file — strategy doesn't apply
			}
			cmd = strings.ReplaceAll(cmd, "${file_content}", fileContent)
			cmd = strings.ReplaceAll(cmd, "${cwd}", fgDir)

		default:
			continue
		}

		restoreArgv := strings.Fields(cmd)
		if len(restoreArgv) == 0 {
			continue
		}
		return restoreArgv, fgDir
	}
	return fgArgv, fgDir
}

// writeCrashSnapshot serializes the current registry state to path as JSON,
// using an atomic tempfile+rename write so a crash mid-write never corrupts
// the snapshot. Only the composition (workspaces, pane argv, layouts) is
// written — no scrollback or PTY FDs. The snapshot is used by
// RestoreFromCrashSnapshot to re-spawn panes after a daemon crash.
//
// strategies is evaluated for each terminal pane to produce a smarter restore
// command (e.g. "amplifier resume ${AMPLIFIER_SESSION_ID}") when the foreground
// process's environment matches a configured detect condition.
func writeCrashSnapshot(path string, reg *Registry, strategies []config.RestoreStrategy) error {
	reg.mu.Lock()
	payload := HandoffPayload{NextWSID: reg.nextWSID}

	wsIDs := make([]string, 0, len(reg.workspaces))
	for id := range reg.workspaces {
		wsIDs = append(wsIDs, id)
	}
	sort.Strings(wsIDs)

	for _, wsID := range wsIDs {
		ws := reg.workspaces[wsID]
		wss := WSState{
			ID:         ws.ID,
			Name:       ws.Name,
			ClientRef:  ws.ClientRef,
			NextPaneID: ws.nextPaneID,
			Layouts:    ws.Layouts,
		}

		paneIDs := make([]int, 0, len(ws.Panes))
		for id := range ws.Panes {
			paneIDs = append(paneIDs, id)
		}
		sort.Ints(paneIDs)

		for _, pid := range paneIDs {
			p := ws.Panes[pid]
			p.mu.Lock()
			cols, rows, title := p.cols, p.rows, p.Title
			p.mu.Unlock()

			// Resolve the best restore command for this pane: applies
			// configured strategies (e.g. amplifier resume ${AMPLIFIER_SESSION_ID})
			// before falling back to the captured foreground argv.
			fgArgv, fgDir := resolveRestoreCommand(p, strategies)

			ps := PaneState{
				LocalID:      p.LocalID,
				Title:        title,
				SurfaceKind:  p.SurfaceKind,
				Cols:         cols,
				Rows:         rows,
				FDIndex:      -1, // not used for crash snapshots
				Argv:         fgArgv,
				Dir:          fgDir,
			}
			wss.Panes = append(wss.Panes, ps)
		}
		payload.Workspaces = append(payload.Workspaces, wss)
	}
	reg.mu.Unlock()

	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "session-*.json.tmp")
	if err != nil {
		return err
	}
	tmpName := f.Name()
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(tmpName)
		if writeErr != nil {
			return writeErr
		}
		return closeErr
	}
	return os.Rename(tmpName, path)
}

// LoadCrashSnapshot reads and parses the crash snapshot at path. It returns
// (payload, true, nil) when the file exists and is valid, (zero, false, nil)
// when the file does not exist, and (zero, false, err) for other errors.
func LoadCrashSnapshot(path string) (HandoffPayload, bool, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return HandoffPayload{}, false, nil
		}
		return HandoffPayload{}, false, err
	}
	var payload HandoffPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		// Corrupt snapshot — log and treat as missing so we start fresh.
		log.Printf("sessiond: crash snapshot at %s is corrupt (%v); starting fresh", path, err)
		return HandoffPayload{}, false, nil
	}
	return payload, true, nil
}

// RestoreFromCrashSnapshot reconstructs a Server from a crash snapshot by
// re-spawning each terminal pane's saved argv and rebuilding browser panes.
// Workspaces are installed in the registry before panes are spawned so that
// pane-exit callbacks can correctly remove panes from the registry even if a
// process exits immediately after spawn.
func RestoreFromCrashSnapshot(snap HandoffPayload, socketPath string) (*Server, error) {
	srv, err := NewServer(socketPath)
	if err != nil {
		return nil, err
	}

	// Step 1: install all workspaces into the registry (without panes) so
	// that handlePaneExit can look them up the moment a pane goroutine fires.
	srv.reg.mu.Lock()
	srv.reg.nextWSID = snap.NextWSID
	for _, wss := range snap.Workspaces {
		layouts := wss.Layouts
		if layouts == nil {
			layouts = make(map[string]string)
		}
		ws := &Workspace{
			ID:         wss.ID,
			Name:       wss.Name,
			ClientRef:  wss.ClientRef,
			Panes:      make(map[int]*Pane),
			Layouts:    layouts,
			nextPaneID: wss.NextPaneID,
		}
		srv.reg.workspaces[wss.ID] = ws
	}
	srv.reg.mu.Unlock()

	// Step 2: spawn panes and install them. Done outside the registry lock so
	// handlePaneExit (which takes reg.mu) can run safely if a process exits
	// during the brief spawn window.
	for _, wss := range snap.Workspaces {
		wsID := wss.ID
		for _, ps := range wss.Panes {
			var p *Pane
			switch ps.SurfaceKind {
			case "browser":
				p = newBrowserCDPPane(ps.LocalID)
			default:
				p, err = NewPane(
					ps.LocalID,
					ps.Argv, // re-spawn the captured foreground command
					ps.Dir,  // working directory at snapshot time
					ps.Cols, ps.Rows,
					nil, // nil → VTBuffer default
					func(id int, data []byte) { srv.broadcastPaneData(wsID, id, data) },
					func(id int) { srv.handlePaneExit(wsID, id) },
				)
				if err != nil {
					log.Printf("sessiond: crash restore: pane %d (argv=%v) spawn failed: %v; skipping",
						ps.LocalID, ps.Argv, err)
					continue
				}
				p.SetTitle(ps.Title)
			}
			srv.reg.PutPane(wsID, p)
		}
	}

	wsCount := len(snap.Workspaces)
	log.Printf("sessiond: crash restore complete — restored %d workspace(s)", wsCount)
	return srv, nil
}
