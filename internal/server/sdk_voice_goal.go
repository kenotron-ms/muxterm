package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
)

func (c *sdkVoiceCall) readGoal() string {
	chat, ok := c.host.chat(c.chatID)
	if !ok {
		return `{"error":"main chat unavailable"}`
	}
	document, err := c.host.chats.goals.update(chat, nil)
	if err != nil {
		return `{"error":"goal ledger unavailable"}`
	}
	receipts := document.Receipts
	if len(receipts) > 5 {
		receipts = receipts[len(receipts)-5:]
	}
	condition := ""
	if len(document.Revisions) > 0 {
		condition = document.Revisions[len(document.Revisions)-1].Condition
	}
	encoded, _ := json.Marshal(map[string]any{
		"condition": condition, "state": document.State, "controlVersion": document.ControlVersion,
		"requestedRevision": document.RequestedRevision, "appliedRevision": document.AppliedRevision,
		"humanPaused": document.HumanPaused, "operatorId": document.OperatorID,
		"operatorStart": document.Policy.OperatorStart, "executionAuthorizedRevision": document.ExecutionAuthorizedRevision,
		"agentPauseRevision": document.AgentPauseRevision, "gap": document.Gap, "recentReceipts": receipts,
	})
	return string(encoded)
}

// Use the same agent authorization and ledger admission path as the MCP goal
// tool. A voice call is bound to its chat ID, and the model cannot supply a
// different target, an origin capability, or a human-browser identity.
func (c *sdkVoiceCall) controlGoal(action string, expectedVersion *int, callID string) string {
	if action != "start" && action != "pause" && action != "resume" && action != "clear" {
		return `{"error":"unsupported goal action"}`
	}
	if expectedVersion == nil {
		return `{"error":"read_goal controlVersion is required"}`
	}
	body, _ := json.Marshal(map[string]any{"action": action, "expectedVersion": *expectedVersion, "clientRef": callID})
	req, err := http.NewRequestWithContext(c.ctx, http.MethodPatch, "/api/sdk-chats/"+c.chatID+"/goal", bytes.NewReader(body))
	if err != nil {
		return `{"error":"goal control unavailable"}`
	}
	req.SetPathValue("id", c.chatID)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Muxterm-Origin", c.host.chats.chatOriginToken(c.chatID))
	recorder := httptest.NewRecorder()
	c.host.server.handleSDKGoal(recorder, req)
	response := recorder.Result()
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		encoded, _ := json.Marshal(map[string]any{"error": recorder.Body.String(), "httpStatus": response.StatusCode})
		return string(encoded)
	}
	// Admission is not proof that the native task agent applied the command.
	// The assistant can call read_goal again to inspect its receipt.
	encoded, _ := json.Marshal(map[string]any{"status": "admitted", "controlVersion": *expectedVersion + 1, "receiptId": callID, "note": "Check read_goal for native acknowledgement before claiming completion."})
	return string(encoded)
}
