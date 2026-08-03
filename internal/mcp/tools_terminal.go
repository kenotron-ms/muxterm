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

// namedKeys maps case-sensitive key names to the literal bytes a real
// terminal/keyboard would produce for them. Modeled on tmux's send-keys
// vocabulary (Enter, Tab, C-c, arrows, etc).
//
// namedKeys is consulted ONLY via the separate keys argument to sendInput,
// never by pattern-matching the contents of text. An earlier version of this
// code translated text itself when it exactly equaled a key name (e.g.
// text == "Enter"), which meant a caller who genuinely needed to send the
// 5-character literal string "Enter" as data — not a keypress — had no way
// to express that unambiguously; the string's content alone decided its
// meaning. Splitting the two into separate parameters removes the ambiguity
// by construction: text is always literal bytes, keys are always key-name
// lookups, and there is no string that can be misinterpreted as the other.
var namedKeys = map[string]string{
	"Enter":     "\r",
	"Tab":       "\t",
	"Escape":    "\x1b",
	"Backspace": "\x7f",
	"Up":        "\x1b[A",
	"Down":      "\x1b[B",
	"Right":     "\x1b[C",
	"Left":      "\x1b[D",
	"C-c":       "\x03",
	"C-d":       "\x04",
	"C-z":       "\x1a",
}

// argStringSlice extracts an optional string-array argument from args[key].
// Returns (nil, nil) when the key is absent, so callers can distinguish
// "not provided" from "provided empty" if needed. Returns an error if the
// value is present but not an array of strings.
func argStringSlice(args map[string]any, key string) ([]string, error) {
	v, ok := args[key]
	if !ok {
		return nil, nil
	}
	arr, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("argument %s: expected array, got %T", key, v)
	}
	out := make([]string, 0, len(arr))
	for i, item := range arr {
		s, ok := item.(string)
		if !ok {
			return nil, fmt.Errorf("argument %s[%d]: expected string, got %T", key, i, item)
		}
		out = append(out, s)
	}
	return out, nil
}

// sendInput sends bytes to the pane identified by pane_id without waiting for
// any response. Suitable for interactive programs and control sequences.
//
// text (optional) is always sent as literal bytes, unchanged — no key-name
// lookup is ever performed on it, so it is safe for arbitrary payloads,
// including ones that happen to match a key name like "Enter".
//
// keys (optional) is a list of key names looked up in namedKeys (e.g.
// "Enter", "C-c", "Tab"); each is translated to its byte sequence. An unknown
// name is an error rather than being silently sent as literal text, since a
// typo'd key name silently degrading to literal junk bytes in the pane would
// be a confusing failure mode.
//
// If both are given, text is sent first, then keys, matching tmux's
// sequential-argument send-keys behavior (e.g. send-keys "ls -la" Enter).
// At least one of text/keys must be provided.
func (tt *terminalTools) sendInput(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	text, textErr := argString(args, "text")
	keys, keysErr := argStringSlice(args, "keys")
	if keysErr != nil {
		return "", keysErr
	}
	if textErr != nil && len(keys) == 0 {
		return "", fmt.Errorf("send_input: provide at least one of text or keys")
	}

	var payload []byte
	if textErr == nil {
		payload = append(payload, text...)
	}
	for _, k := range keys {
		b, ok := namedKeys[k]
		if !ok {
			return "", fmt.Errorf("send_input: unknown key name %q", k)
		}
		payload = append(payload, b...)
	}

	if err := tt.c.conn.Input(uint32(paneID), payload); err != nil {
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
