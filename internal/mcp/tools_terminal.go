package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// terminalTools groups the MCP terminal tool handlers and holds a reference to
// the Client so handlers can invoke sessiond operations.
type terminalTools struct {
	c *Client
}

// newTerminalTools creates a terminalTools instance backed by c.
func newTerminalTools(c *Client) *terminalTools {
	return &terminalTools{c: c}
}

// argInt extracts an integer argument from args[key]. JSON numbers decode as
// float64 by encoding/json, so both float64 and int are accepted. Returns an
// error when the key is absent or the value is neither float64 nor int.
func argInt(args map[string]any, key string) (int, error) {
	v, ok := args[key]
	if !ok {
		return 0, fmt.Errorf("missing required argument: %s", key)
	}
	switch n := v.(type) {
	case float64:
		return int(n), nil
	case int:
		return n, nil
	default:
		return 0, fmt.Errorf("argument %s: expected number, got %T", key, v)
	}
}

// argString extracts a string argument from args[key]. Returns an error when
// the key is absent or the value is not a string.
func argString(args map[string]any, key string) (string, error) {
	v, ok := args[key]
	if !ok {
		return "", fmt.Errorf("missing required argument: %s", key)
	}
	s, ok := v.(string)
	if !ok {
		return "", fmt.Errorf("argument %s: expected string, got %T", key, v)
	}
	return s, nil
}

// jsonText marshals v to compact JSON and returns it as a string. The error
// return from json.Marshal is intentionally dropped because marshalling a
// map[string]any built from basic Go types never fails.
func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// runCommand sends command to the pane identified by pane_id (required), waits
// for the shell to emit an OSC 133 ;D marker, then returns the accumulated
// pane output (ANSI stripped) and exit code as JSON.
//
// Optional timeout_ms (default 30 000 ms) controls how long to wait for the
// prompt marker. If the shell does not emit the marker within the timeout the
// function returns exit_code -1 and whatever output was accumulated — the
// accepted Phase 4 fallback for shells without OSC 133 integration.
func (tt *terminalTools) runCommand(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	command, err := argString(args, "command")
	if err != nil {
		return "", err
	}

	timeoutMs := 30000
	if v, intErr := argInt(args, "timeout_ms"); intErr == nil {
		timeoutMs = v
	}

	tt.c.ClearOutput(paneID)
	tt.c.ArmPrompt(paneID)

	if err := tt.c.conn.Input(uint32(paneID), []byte(command+"\n")); err != nil {
		return "", fmt.Errorf("sending command to pane %d: %w", paneID, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()

	exitCode, waitErr := tt.c.WaitForPrompt(ctx, paneID)
	if waitErr != nil {
		exitCode = -1
	}

	output := StripANSI(string(tt.c.OutputBuffer(paneID)))

	return jsonText(map[string]any{
		"output":    output,
		"exit_code": exitCode,
	}), nil
}

// sendInput sends raw bytes to the pane identified by pane_id without waiting
// for any response. Suitable for interactive programs and control sequences.
func (tt *terminalTools) sendInput(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	text, err := argString(args, "text")
	if err != nil {
		return "", err
	}

	if err := tt.c.conn.Input(uint32(paneID), []byte(text)); err != nil {
		return "", fmt.Errorf("sending input to pane %d: %w", paneID, err)
	}

	return jsonText(map[string]any{"ok": true}), nil
}

// getScreen returns the current VT-grid state of the pane identified by
// pane_id as plain text plus a cursor position object.
func (tt *terminalTools) getScreen(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}

	snap, err := tt.c.conn.ScreenSnapshot(paneID)
	if err != nil {
		return "", fmt.Errorf("screen snapshot for pane %d: %w", paneID, err)
	}

	cursor := map[string]any{"row": 0, "col": 0}
	if snap.Cursor != nil {
		cursor["row"] = snap.Cursor.Row
		cursor["col"] = snap.Cursor.Col
	}

	return jsonText(map[string]any{
		"text":   snap.Text,
		"cursor": cursor,
	}), nil
}
