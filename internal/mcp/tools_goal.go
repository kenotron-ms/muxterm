package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

func registerGoalControlTools(srv *Server) {
	client := &publishTools{}
	srv.Register("report_goal_evidence", "Record evidence for your own goal, or propose a condition for yourself or a direct owned lane. Proposals are inert: they do not revise an approved condition, wake peers, or start execution.", map[string]any{"type": "object", "properties": map[string]any{"session_id": map[string]any{"type": "string"}, "client_ref": map[string]any{"type": "string"}, "expected_version": map[string]any{"type": "integer"}, "proposal": map[string]any{"type": "string"}, "evidence": map[string]any{"type": "array", "items": map[string]any{"type": "string"}}}, "required": []string{"session_id", "client_ref", "expected_version"}}, func(args map[string]any) (string, error) {
		id, err := argString(args, "session_id")
		if err != nil {
			return "", err
		}
		action := "evidence"
		if proposal, ok := args["proposal"].(string); ok && proposal != "" {
			action = "propose"
		}
		body, err := json.Marshal(map[string]any{"action": action, "objective": args["proposal"], "evidence": args["evidence"], "clientRef": args["client_ref"], "expectedVersion": args["expected_version"]})
		if err != nil {
			return "", err
		}
		result, err := client.doRequest(http.MethodPatch, "/api/sdk-chats/"+url.PathEscape(id)+"/goal", body)
		return string(result), err
	})
	properties := map[string]any{"session_id": map[string]any{"type": "string"}, "action": map[string]any{"type": "string", "enum": []string{"start", "pause", "resume", "clear"}}, "client_ref": map[string]any{"type": "string"}, "expected_version": map[string]any{"type": "integer"}}
	srv.Register("get_chat_goal", "Read this chat's durable goal ledger with session_id=self, or a direct operator/lane. Does not start or resume work. Use the ledger controlVersion for expected_version on mutations.", map[string]any{"type": "object", "properties": map[string]any{"session_id": properties["session_id"]}, "required": []string{"session_id"}}, func(args map[string]any) (string, error) {
		id, err := argString(args, "session_id")
		if err != nil {
			return "", err
		}
		result, err := client.doRequest(http.MethodGet, "/api/sdk-chats/"+url.PathEscape(id)+"/goal", nil)
		return string(result), err
	})
	srv.Register("control_chat_goal", "Request start, pause, resume, or clear for this chat or a direct owned lane. Starting an approved revision requires explicit human authorization for its direct operator. Agents cannot set/revise conditions or release a human pause. Admission is not native acknowledgement; inspect receipts before retrying.", map[string]any{"type": "object", "properties": properties, "required": []string{"session_id", "action", "client_ref", "expected_version"}}, func(args map[string]any) (string, error) {
		id, err := argString(args, "session_id")
		if err != nil {
			return "", err
		}
		action, err := argString(args, "action")
		if err != nil {
			return "", err
		}
		if action != "start" && action != "pause" && action != "resume" && action != "clear" {
			return "", fmt.Errorf("only execution controls are available to agents")
		}
		body, err := json.Marshal(map[string]any{"action": action, "clientRef": args["client_ref"], "expectedVersion": args["expected_version"]})
		if err != nil {
			return "", err
		}
		result, err := client.doRequest(http.MethodPatch, "/api/sdk-chats/"+url.PathEscape(id)+"/goal", body)
		return string(result), err
	})
}
