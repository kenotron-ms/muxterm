package mcp

import (
	"encoding/json"
	"net/http"
	"net/url"
)

func registerWorkTools(srv *Server) {
	pt := newPublishTools()
	stringProp := map[string]any{"type": "string"}
	stringsProp := map[string]any{"type": "array", "items": stringProp}
	srv.Register("create_work_item", "Create a durable work record linked to an owner session and optional participant sessions. project_ids tags it with one or more project folders; omit to use the owner's folder or pass [] for no folders. This does not start an agent or alter a Chat Goal. client_ref makes retries idempotent.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"client_ref": stringProp, "title": stringProp, "brief": stringProp, "owner_session_id": stringProp, "session_ids": stringsProp, "project_ids": stringsProp}), "required": []string{"client_ref", "title", "brief", "owner_session_id"}},
		func(args map[string]any) (string, error) {
			ref, err := argString(args, "client_ref")
			if err != nil {
				return "", err
			}
			title, err := argString(args, "title")
			if err != nil {
				return "", err
			}
			brief, err := argString(args, "brief")
			if err != nil {
				return "", err
			}
			owner, err := argString(args, "owner_session_id")
			if err != nil {
				return "", err
			}
			participants, err := argStringSlice(args, "session_ids")
			if err != nil {
				return "", err
			}
			bodyMap := map[string]any{"clientRef": ref, "title": title, "brief": brief, "ownerSessionId": owner, "sessionIds": participants}
			if projects, err := argStringSlice(args, "project_ids"); err != nil {
				return "", err
			} else if projects != nil {
				bodyMap["projectIds"] = projects
			}
			body, _ := json.Marshal(bodyMap)
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-work", body)
			return string(result), err
		})
	srv.Register("list_work_items", "Inspect work status and progress across sessions. Optionally filter by project folder, participating session, and/or status (open, active, blocked, done, cancelled).",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"project_id": stringProp, "session_id": stringProp, "status": stringProp})},
		func(args map[string]any) (string, error) {
			query := url.Values{}
			if value, present, err := argStringOptional(args, "project_id"); err != nil {
				return "", err
			} else if present {
				query.Set("project_id", value)
			}
			if value, present, err := argStringOptional(args, "session_id"); err != nil {
				return "", err
			} else if present {
				query.Set("session_id", value)
			}
			if value, present, err := argStringOptional(args, "status"); err != nil {
				return "", err
			} else if present {
				query.Set("status", value)
			}
			path := "/api/sdk-work"
			if len(query) > 0 {
				path += "?" + query.Encode()
			}
			result, err := pt.chatRequest(args, http.MethodGet, path, nil)
			return string(result), err
		})
	srv.Register("get_work_item", "Read a durable work record with its complete progress, status, outcome, evidence references, and update history.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp}), "required": []string{"work_id"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "work_id")
			if err != nil {
				return "", err
			}
			result, err := pt.chatRequest(args, http.MethodGet, "/api/sdk-work/"+url.PathEscape(id), nil)
			return string(result), err
		})
	srv.Register("update_work_item", "Append an idempotent progress update, evidence, outcome, status change, linked participant session, or replacement set of project-folder tags. Pass project_ids=[] to remove all folder tags. Any authorized caller may start work by setting status=active; Goal controls stay separate. session_id identifies the reporting session when there is one.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp, "client_ref": stringProp, "session_id": stringProp, "linked_session_id": stringProp, "text": stringProp, "status": map[string]any{"type": "string", "enum": []string{"open", "active", "blocked", "done", "cancelled"}}, "progress": stringProp, "outcome": stringProp, "evidence": stringsProp, "project_ids": stringsProp}), "required": []string{"work_id", "client_ref"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "work_id")
			if err != nil {
				return "", err
			}
			ref, err := argString(args, "client_ref")
			if err != nil {
				return "", err
			}
			bodyMap := map[string]any{"clientRef": ref}
			for _, key := range []struct{ arg, json string }{{"session_id", "sessionId"}, {"linked_session_id", "linkedSessionId"}, {"text", "text"}, {"status", "status"}, {"progress", "progress"}, {"outcome", "outcome"}} {
				if value, present, err := argStringOptional(args, key.arg); err != nil {
					return "", err
				} else if present {
					bodyMap[key.json] = value
				}
			}
			if evidence, err := argStringSlice(args, "evidence"); err != nil {
				return "", err
			} else if evidence != nil {
				bodyMap["evidence"] = evidence
			}
			if projects, err := argStringSlice(args, "project_ids"); err != nil {
				return "", err
			} else if projects != nil {
				bodyMap["projectIds"] = projects
			}
			body, _ := json.Marshal(bodyMap)
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-work/"+url.PathEscape(id)+"/updates", body)
			return string(result), err
		})
}
