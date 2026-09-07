package mcp

import "fmt"

// fleetTools groups the MCP fleet tool handlers and holds a reference to the
// Client so handlers can reach the cached session-state snapshot and the
// sessiond connection.
type fleetTools struct {
	c *Client
}

// newFleetTools creates a fleetTools instance backed by c.
func newFleetTools(c *Client) *fleetTools {
	return &fleetTools{c: c}
}

// argBool extracts an optional boolean argument from args[key]. Absence is not
// an error: present reports whether the key was supplied, so a caller can tell
// "not provided" (take the default) from "provided false".
func argBool(args map[string]any, key string) (value bool, present bool, err error) {
	v, ok := args[key]
	if !ok {
		return false, false, nil
	}
	b, ok := v.(bool)
	if !ok {
		return false, true, fmt.Errorf("argument %s: expected boolean, got %T", key, v)
	}
	return b, true, nil
}

// fleetStatus returns every agent session the daemon knows about, across every
// workspace, with each row's full declared state.
//
// This is the structured answer to "what needs me?". The alternative it
// replaces is reading terminal screens with get_screen and inferring intent
// from rendered text -- which cannot work, because the two facts that decide
// whether a session wants a human are not on the screen at all: a session
// thinking and a session sitting at a permission prompt own the terminal
// identically, and a stop condition was never printed anywhere.
//
// NOT WORKSPACE-SCOPED, unlike every other sessiond-backed tool in this server.
// See the header comment in fleet.go: the daemon's session-state push carries
// the full set across every workspace, so this reports the fleet regardless of
// which workspace the MCP connection happens to be attached to.
func (ft *fleetTools) fleetStatus(args map[string]any) (string, error) {
	state, _, err := argStringOptional(args, "state")
	if err != nil {
		return "", err
	}
	if err := CheckStateFilter(state); err != nil {
		return "", err
	}
	workspace, _, err := argStringOptional(args, "workspace")
	if err != nil {
		return "", err
	}

	// Resolved BEFORE the snapshot is taken so a bad workspace name fails as a
	// bad filter, not as an empty fleet.
	workspaceID := ""
	if workspace != "" {
		workspaceID, err = ResolveWorkspaceName(ft.c.conn, workspace)
		if err != nil {
			return "", err
		}
	}

	rows, err := ft.c.Fleet()
	if err != nil {
		return "", err
	}
	rows = FilterFleet(rows, state, workspaceID)

	sessions := make([]map[string]any, 0, len(rows))
	for _, r := range rows {
		sessions = append(sessions, fleetRowJSON(r))
	}
	return jsonText(map[string]any{"sessions": sessions}), nil
}

// transcriptTurnJSON projects one turn into the MCP result shape (snake_case
// keys are irrelevant here -- every field is one word -- but the projection is
// kept explicit so the tool's output shape is visible in one place).
func transcriptTurnJSON(t TranscriptTurn) map[string]any {
	m := map[string]any{"role": t.Role, "text": t.Text}
	if t.Tool != "" {
		m["tool"] = t.Tool
	}
	if t.TS != "" {
		m["ts"] = t.TS
	}
	return m
}

// laneTranscript returns the last N turns of a session's conversation, read
// from whatever file its harness writes.
//
// The harness and the project directory both come from the cached fleet
// snapshot rather than from the caller, so a caller cannot ask for an arbitrary
// path: the only files this tool can open are the transcripts of sessions the
// daemon is currently reporting.
func (ft *fleetTools) laneTranscript(args map[string]any) (string, error) {
	sessionID, err := argString(args, "session_id")
	if err != nil {
		return "", err
	}
	lastN := transcriptDefaultTurns
	if v, intErr := argInt(args, "last_n"); intErr == nil {
		lastN = v
	}

	rows, err := ft.c.Fleet()
	if err != nil {
		return "", err
	}
	row, ok := FindSession(rows, sessionID)
	if !ok {
		return "", unknownSessionErr(sessionID, rows)
	}

	tr, err := ReadTranscript(row, lastN)
	if err != nil {
		return "", err
	}

	turns := make([]map[string]any, 0, len(tr.Turns))
	for _, t := range tr.Turns {
		turns = append(turns, transcriptTurnJSON(t))
	}
	return jsonText(map[string]any{
		"harness":   tr.Harness,
		"path":      tr.Path,
		"truncated": tr.Truncated,
		"turns":     turns,
	}), nil
}

// sessionSend types text into the pane of a known session, addressing it by
// SESSION id rather than by pane id.
//
// ⛔ SAFETY, NON-NEGOTIABLE: a session id that is not in the current fleet
// snapshot is REFUSED. This tool must never become a way to inject keystrokes
// into an arbitrary pane -- it addresses known sessions only, and the snapshot
// is the definition of "known". Resolving the pane id from the snapshot rather
// than accepting one from the caller is what makes that structural instead of
// merely intended: there is no argument here that names a pane.
//
// The pane is not otherwise privileged. send_input already exists and takes a
// raw pane id; what this adds is that the target is a session the daemon is
// reporting, so an agent steering a lane cannot typo its way into somebody
// else's shell.
//
// KNOWN HAZARD (shared with spawn_lane and switch_workspace): sending to a
// session in another workspace re-attaches this whole MCP connection, which
// discards its accumulated output buffers and armed prompt channels and
// replays the joined workspace's retained output. Drain anything you care
// about before calling this.
func (ft *fleetTools) sessionSend(args map[string]any) (string, error) {
	sessionID, err := argString(args, "session_id")
	if err != nil {
		return "", err
	}
	text, err := argString(args, "text")
	if err != nil {
		return "", err
	}
	submit := true
	if v, present, boolErr := argBool(args, "submit"); boolErr != nil {
		return "", boolErr
	} else if present {
		submit = v
	}

	rows, err := ft.c.Fleet()
	if err != nil {
		return "", err
	}
	row, ok := FindSession(rows, sessionID)
	if !ok {
		return "", fmt.Errorf("%w -- session_send addresses known sessions only, "+
			"never an arbitrary pane id", unknownSessionErr(sessionID, rows))
	}
	if row.PaneID == 0 || row.WorkspaceID == "" {
		return "", fmt.Errorf("session %q is reported without a pane (pane %d, workspace %q), so there is nowhere to send to",
			sessionID, row.PaneID, row.WorkspaceID)
	}

	// Pane input is resolved against the connection's ATTACHED workspace
	// server-side, so this attach is not bookkeeping -- it is what decides
	// which pane receives the bytes.
	if ft.c.Workspace() != row.WorkspaceID {
		if err := ft.c.AttachWorkspace(row.WorkspaceID); err != nil {
			return "", fmt.Errorf("attaching to workspace %s to reach session %q: %w",
				row.WorkspaceID, sessionID, err)
		}
	}

	// "\r", not "\n": a terminal's Enter key sends carriage return, which is
	// what namedKeys["Enter"] in send_input already sends and what a TUI
	// reading the pty expects. Sending "\n" instead works in a plain shell and
	// silently does nothing in several agent REPLs.
	payload := text
	if submit {
		payload += "\r"
	}
	if err := ft.c.conn.Input(uint32(row.PaneID), []byte(payload)); err != nil {
		return "", fmt.Errorf("sending to session %q (pane %d): %w", sessionID, row.PaneID, err)
	}

	return jsonText(map[string]any{
		"pane_id":      row.PaneID,
		"workspace_id": row.WorkspaceID,
	}), nil
}
