package mcp

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

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
		sessions = append(sessions, fleetRowJSON(r, ft.c.Machine()))
	}
	return jsonText(map[string]any{"sessions": sessions, "machine": ft.c.Machine()}), nil
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

	// Read through the daemon on the session's OWN machine. Same call for a
	// local session and a remote one -- the client already is whichever
	// machine the caller named.
	tr, err := ReadTranscriptOn(ft.c, row, lastN)
	if err != nil {
		return "", err
	}

	turns := make([]map[string]any, 0, len(tr.Turns))
	for _, t := range tr.Turns {
		turns = append(turns, transcriptTurnJSON(t))
	}
	return jsonText(map[string]any{
		"machine":   ft.c.Machine(),
		"harness":   tr.Harness,
		"path":      tr.Path,
		"truncated": tr.Truncated,
		"turns":     turns,
	}), nil
}

// sessionSend admits a durable native-resume turn by session identity. It does
// not resolve or write a pane: pane-less sessions work, and ordinary terminal
// input remains the separate, explicit send_input capability.
func (ft *fleetTools) sessionSend(args map[string]any) (string, error) {
	sessionID, err := argString(args, "session_id")
	if err != nil {
		return "", err
	}
	text, err := argString(args, "text")
	if err != nil {
		return "", err
	}
	clientRef, err := argString(args, "client_ref")
	if err != nil {
		return "", err
	}
	cursor := ""
	if value, ok := args["cursor"]; ok {
		cursor, ok = value.(string)
		if !ok {
			return "", fmt.Errorf("argument cursor: expected string, got %T", value)
		}
	}
	if err := guardCosConfig(text); err != nil {
		return "", err
	}
	if ft.c.IsRemote() {
		return "", errors.New("managed session turns are not available across a remote machine transport")
	}
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	argv := []string{"session", "send", sessionID, "--prompt", text, "--client-ref", clientRef, "--json"}
	if strings.TrimSpace(cursor) != "" {
		argv = append(argv, "--cursor", cursor)
	}
	cmd := exec.Command(self, argv...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("managed session turn failed: %s", detail)
	}
	return strings.TrimSpace(stdout.String()), nil
}
