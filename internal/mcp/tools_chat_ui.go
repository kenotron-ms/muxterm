package mcp

import (
	"encoding/json"
	"net/http"
)

func registerChatUITools(srv *Server) {
	pt := newPublishTools()
	call := func(args map[string]any, action string) (string, error) {
		if err := refuseRemote(args, "the Chat UI belongs to browsers connected to this muxterm serve process"); err != nil {
			return "", err
		}
		id, err := argString(args, "session_id")
		if err != nil {
			return "", err
		}
		payload := map[string]string{"action": action, "session_id": id}
		for _, key := range []string{"mode", "tab", "path"} {
			value, present, err := argStringOptional(args, key)
			if err != nil {
				return "", err
			}
			if present {
				payload[key] = value
			}
		}
		body, _ := json.Marshal(payload)
		result, err := pt.doRequest(http.MethodPost, "/api/chat-ui/navigate", body)
		if err != nil {
			return "", err
		}
		return string(result), nil
	}
	srv.Register("navigate_app", "Open a Chat in connected muxterm browsers, change its Chat/Split/Preview panel layout, or select its Plan/Files/PR/Trajectory tab. Use list_chats for session_id. Returns a browser count; zero means nobody saw the navigation. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"session_id": map[string]any{"type": "string", "description": "Chat ID"},
			"action":     map[string]any{"type": "string", "enum": []string{"chat", "panel", "tab"}},
			"mode":       map[string]any{"type": "string", "enum": []string{"chat", "split", "preview"}, "description": "required for action=panel"},
			"tab":        map[string]any{"type": "string", "enum": []string{"plan", "files", "pr", "trajectory"}, "description": "required for action=tab"},
		}), "required": []string{"session_id", "action"}},
		func(args map[string]any) (string, error) {
			action, err := argString(args, "action")
			if err != nil {
				return "", err
			}
			return call(args, action)
		})
	srv.Register("view_file", "Show a local file in a Chat's Files viewer in every connected muxterm browser. Requires the Chat ID and an absolute file path inside that Chat's folder. This opens the actual viewer for the human; read_file only reads for the agent. Returns a browser count; zero means nobody saw it. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"session_id": map[string]any{"type": "string", "description": "Chat ID"},
			"path":       map[string]any{"type": "string", "description": "absolute path inside the Chat's folder"},
		}), "required": []string{"session_id", "path"}},
		func(args map[string]any) (string, error) { return call(args, "file") })
}
