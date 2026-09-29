package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const chatLocalOnly = "Chats belong to this muxterm serve process; use a session on the target machine"

// These tools use the same authenticated serve-layer handoff as publications.
// They address Go-owned SDK chat IDs, never terminal pane IDs.
func registerChatControlTools(srv *Server) {
	pt := newPublishTools()
	srv.Register("list_chat_sessions", "List addressable Chats with stable IDs, project, harness, title, current state, last activity and recent output. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{})},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			chats, err := pt.doRequest(http.MethodGet, "/api/sdk-chats", nil)
			if err != nil {
				return "", err
			}
			projects, err := pt.doRequest(http.MethodGet, "/api/sdk-projects", nil)
			if err != nil {
				return "", err
			}
			return jsonText(map[string]any{"sessions": json.RawMessage(chats), "projects": json.RawMessage(projects)}), nil
		})
	srv.Register("spawn_chat", "Create a normal Chat with an opening turn in a named project (or Ungrouped when project is omitted). Returns its stable session ID. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"project": map[string]any{"type": "string", "description": "exact name of an existing project; omit for Ungrouped"},
			"harness": map[string]any{"type": "string", "enum": []string{"amplifier", "claude", "codex"}},
			"prompt":  map[string]any{"type": "string", "description": "opening user turn"},
		}), "required": []string{"harness", "prompt"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			harness, err := argString(args, "harness")
			if err != nil {
				return "", err
			}
			if harness != "amplifier" && harness != "claude" && harness != "codex" {
				return "", fmt.Errorf("unsupported harness %q", harness)
			}
			prompt, err := argString(args, "prompt")
			if err != nil {
				return "", err
			}
			if strings.TrimSpace(prompt) == "" {
				return "", fmt.Errorf("prompt required")
			}
			project, _, err := argStringOptional(args, "project")
			if err != nil {
				return "", err
			}
			payload := map[string]any{"harness": harness, "prompt": prompt}
			if project != "" {
				body, err := pt.doRequest(http.MethodGet, "/api/sdk-projects", nil)
				if err != nil {
					return "", err
				}
				var projects []struct{ ID, Name string }
				if err = json.Unmarshal(body, &projects); err != nil {
					return "", err
				}
				matches := 0
				for _, p := range projects {
					if p.Name == project {
						payload["workspaceId"] = p.ID
						matches++
					}
				}
				if matches != 1 {
					return "", fmt.Errorf("project %q matched %d projects; name must identify exactly one", project, matches)
				}
			}
			body, _ := json.Marshal(payload)
			result, err := pt.doRequest(http.MethodPost, "/api/sdk-chats", body)
			if err != nil {
				return "", fmt.Errorf("spawn_chat outcome uncertain; list_chat_sessions before creating another chat: %w", err)
			}
			return string(result), nil
		})
	srv.Register("send_chat_message", "Submit a durable, idempotent turn to a Chat by stable ID. While Amplifier is running, steering is delivered at its next request boundary. Accepted proves admission, not completion; read_chat_session shows delivery and output. Reuse client_ref to query the same receipt; uncertain never retries the input.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"session_id": map[string]any{"type": "string"},
			"client_ref": map[string]any{"type": "string", "description": "caller-chosen stable idempotency key; reuse exactly on uncertain results"},
			"content":    map[string]any{"type": "string"},
		}), "required": []string{"session_id", "client_ref", "content"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			key, err := argString(args, "client_ref")
			if err != nil {
				return "", err
			}
			content, err := argString(args, "content")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]string{"clientRef": key, "content": content})
			result, err := pt.doRequest(http.MethodPost, "/api/sdk-chats/"+url.PathEscape(id)+"/control-send", body)
			if err != nil {
				return "", fmt.Errorf("send_chat_message delivery uncertain; retry only with the same client_ref: %w", err)
			}
			return string(result), nil
		})
	srv.Register("read_chat_session", "Read a Chat's recent persisted events and output by stable ID. Milestones retain input acceptance, delivery, and completion across long streamed replies. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": map[string]any{"type": "string"}}), "required": []string{"session_id"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, chatLocalOnly); err != nil {
				return "", err
			}
			id, err := argString(args, "session_id")
			if err != nil {
				return "", err
			}
			result, err := pt.doRequest(http.MethodGet, "/api/sdk-chats/"+url.PathEscape(id)+"/control-history", nil)
			if err != nil {
				return "", err
			}
			return string(result), nil
		})
}
