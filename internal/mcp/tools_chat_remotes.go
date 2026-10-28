package mcp

import (
	"encoding/json"
	"net/http"
	"net/url"
)

// These controls use the serve layer's registry, which also drives browser
// remote membership. They never operate on the production service manager.
func registerChatRemoteTools(srv *Server) {
	pt := newPublishTools()
	srv.Register("list_remotes", "List configured SSH remotes and their connected, discovered, or error state. Use the returned id as machine in Chat tools.",
		map[string]any{"type": "object", "properties": map[string]any{}},
		func(map[string]any) (string, error) {
			body, err := pt.doRequest(http.MethodGet, "/api/remotes", nil)
			return string(body), err
		})
	srv.Register("add_remote", "Add a muxterm-managed SSH remote entry. This updates SSH config but does not connect. Pass the returned id to connect_remote.",
		map[string]any{"type": "object", "properties": map[string]any{
			"name":   map[string]any{"type": "string", "description": "optional SSH alias"},
			"target": map[string]any{"type": "string", "description": "SSH target, such as user@host:22"},
		}, "required": []string{"target"}},
		func(args map[string]any) (string, error) {
			target, err := argString(args, "target")
			if err != nil {
				return "", err
			}
			name, _, err := argStringOptional(args, "name")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]string{"name": name, "target": target})
			result, err := pt.doRequest(http.MethodPost, "/api/remotes", body)
			return string(result), err
		})
	remoteAction := func(args map[string]any, method, suffix string) (string, error) {
		name, err := argString(args, "remote")
		if err != nil {
			return "", err
		}
		id, err := pt.remoteID(name)
		if err != nil {
			return "", err
		}
		body, err := pt.doRequest(method, "/api/remotes/"+url.PathEscape(id)+suffix, nil)
		return string(body), err
	}
	schema := map[string]any{"type": "object", "properties": map[string]any{
		"remote": map[string]any{"type": "string", "description": "id or unique name from list_remotes"},
	}, "required": []string{"remote"}}
	srv.Register("connect_remote", "Connect a configured SSH remote to this muxterm server and its browsers. This probes the target and admits it to the remote registry.", schema,
		func(args map[string]any) (string, error) { return remoteAction(args, http.MethodPost, "/connect") })
	srv.Register("disconnect_remote", "Disconnect an SSH remote from this muxterm server and its browsers. Remote chats and workspaces remain on that machine.", schema,
		func(args map[string]any) (string, error) { return remoteAction(args, http.MethodPost, "/disconnect") })
	srv.Register("remove_remote", "Remove a muxterm-managed SSH config entry and disconnect it. Hand-written SSH Host blocks cannot be removed by this tool.", schema,
		func(args map[string]any) (string, error) { return remoteAction(args, http.MethodDelete, "") })
}
