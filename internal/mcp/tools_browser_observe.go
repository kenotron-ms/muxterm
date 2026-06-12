package mcp

import (
	"context"
	"encoding/json"
)

// browserSnapshot returns the browser's accessibility tree snapshot for the
// pane identified by args["pane_id"]. The shim action "snapshot" replies with
// a plain-text accessibility tree in Message.Snapshot. Returns
// {"snapshot":"..."} on success or {"error":"..."} on shim error.
func (bt *browserTools) browserSnapshot(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserTimeout)
	defer cancel()
	res, err := bt.c.SendBrowserAction(ctx, paneID, "snapshot", nil)
	if err != nil {
		return "", err
	}
	if res.Error != "" {
		return jsonText(map[string]any{"error": res.Error}), nil
	}
	return jsonText(map[string]any{"snapshot": res.Snapshot}), nil
}

// browserEval evaluates a JavaScript expression in the browser pane identified
// by args["pane_id"]. Required arg "expr" is the JS expression to evaluate.
// Optional arg "ref" is an element reference forwarded to the shim as the el
// argument for element-scoped eval. Returns {"result":<json>} on success or
// {"error":"..."} on shim error.
func (bt *browserTools) browserEval(args map[string]any) (string, error) {
	paneID, err := argInt(args, "pane_id")
	if err != nil {
		return "", err
	}
	expr, err := argString(args, "expr")
	if err != nil {
		return "", err
	}
	params := map[string]any{"expr": expr}
	if ref, ok := args["ref"].(string); ok && ref != "" {
		params["ref"] = ref
	}
	ctx, cancel := context.WithTimeout(context.Background(), browserTimeout)
	defer cancel()
	res, err := bt.c.SendBrowserAction(ctx, paneID, "eval_", params)
	if err != nil {
		return "", err
	}
	if res.Error != "" {
		return jsonText(map[string]any{"error": res.Error}), nil
	}
	result := res.Result
	if len(result) == 0 {
		result = json.RawMessage("null")
	}
	out, _ := json.Marshal(map[string]json.RawMessage{"result": result})
	return string(out), nil
}

// browserScreenshot is a Phase 5 placeholder. The shim does not implement a
// screenshot action in Phase 5, so this returns a structured error without
// touching the daemon.
// TODO(Phase 6): implement a real screenshot path in the shim.
func (bt *browserTools) browserScreenshot(args map[string]any) (string, error) {
	if _, err := argInt(args, "pane_id"); err != nil {
		return "", err
	}
	return jsonText(map[string]any{"error": "screenshot not available in Phase 5"}), nil
}
