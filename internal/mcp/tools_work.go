package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

func registerWorkTools(srv *Server) {
	pt := newPublishTools()
	stringProp := map[string]any{"type": "string"}
	stringsProp := map[string]any{"type": "array", "items": stringProp}
	srv.Register("create_work_item", "Create a durable work record. Muxterm records who created it separately from its assignable owner_session_id. Omit owner_session_id to leave work unassigned; project_ids defaults to the owner's folder when present. labels are normalized, searchable tags. depends_on lists prerequisite Work IDs; each must reach done before this item can start. next_action is the concrete next step; acceptance_criteria says how completion will be judged. Assignment records ownership but does not wake an idle chat: send_chat_message explicitly to kick off its turn. This does not alter a Chat Goal. client_ref makes retries idempotent.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"client_ref": stringProp, "title": stringProp, "brief": stringProp, "next_action": stringProp, "owner_session_id": stringProp, "acceptance_criteria": stringProp, "reviewer_session_id": stringProp, "session_ids": stringsProp, "project_ids": stringsProp, "labels": stringsProp, "depends_on": stringsProp}), "required": []string{"client_ref", "title", "brief"}},
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
			nextAction, _, err := argStringOptional(args, "next_action")
			if err != nil {
				return "", err
			}
			owner, _, err := argStringOptional(args, "owner_session_id")
			if err != nil {
				return "", err
			}
			acceptance, _, err := argStringOptional(args, "acceptance_criteria")
			if err != nil {
				return "", err
			}
			reviewer, _, err := argStringOptional(args, "reviewer_session_id")
			if err != nil {
				return "", err
			}
			participants, err := argStringSlice(args, "session_ids")
			if err != nil {
				return "", err
			}
			bodyMap := map[string]any{"clientRef": ref, "title": title, "brief": brief, "nextAction": nextAction, "ownerSessionId": owner, "acceptanceCriteria": acceptance, "reviewerSessionId": reviewer, "sessionIds": participants}
			if projects, err := argStringSlice(args, "project_ids"); err != nil {
				return "", err
			} else if projects != nil {
				bodyMap["projectIds"] = projects
			}
			if dependencies, err := argStringSlice(args, "depends_on"); err != nil {
				return "", err
			} else if dependencies != nil {
				bodyMap["dependsOn"] = dependencies
			}
			if labels, err := argStringSlice(args, "labels"); err != nil {
				return "", err
			} else if labels != nil {
				bodyMap["labels"] = labels
			}
			body, _ := json.Marshal(bodyMap)
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-work", body)
			return string(result), err
		})
	srv.Register("list_work_items", "Inspect work status, creator, current owner, labels, and progress across sessions. Optionally filter by project_id or project_ids (OR), labels (all required), creator/owner/participant session, and/or status (open, active, blocked, review, done, cancelled).",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"project_id": stringProp, "project_ids": stringsProp, "labels": stringsProp, "session_id": stringProp, "status": stringProp})},
		func(args map[string]any) (string, error) {
			query := url.Values{}
			if value, present, err := argStringOptional(args, "project_id"); err != nil {
				return "", err
			} else if present {
				query.Set("project_id", value)
			}
			if values, err := argStringSlice(args, "project_ids"); err != nil {
				return "", err
			} else {
				for _, value := range values {
					query.Add("project_id", value)
				}
			}
			if values, err := argStringSlice(args, "labels"); err != nil {
				return "", err
			} else {
				for _, value := range values {
					query.Add("label", value)
				}
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
	srv.Register("get_next_work_item", "Fetch the oldest ready item from the unassigned work pile. Only open items with every depends_on prerequisite done are returned; blocked, assigned, completed, cancelled, and dependency-waiting items are skipped. Filter by project_id or project_ids (OR), and labels (all required). Returns {\"work\":null} when none is ready. This read does not claim work: use update_work_item with the returned id and revision as expected_revision; a competing claim returns 409.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"project_id": stringProp, "project_ids": stringsProp, "labels": stringsProp})},
		func(args map[string]any) (string, error) {
			query := url.Values{}
			if projectID, present, err := argStringOptional(args, "project_id"); err != nil {
				return "", err
			} else if present && projectID != "" {
				query.Add("project_id", projectID)
			}
			if values, err := argStringSlice(args, "project_ids"); err != nil {
				return "", err
			} else {
				for _, value := range values {
					query.Add("project_id", value)
				}
			}
			if values, err := argStringSlice(args, "labels"); err != nil {
				return "", err
			} else {
				for _, value := range values {
					query.Add("label", value)
				}
			}
			path := "/api/sdk-work/next"
			if len(query) > 0 {
				path += "?" + query.Encode()
			}
			result, err := pt.chatRequest(args, http.MethodGet, path, nil)
			return string(result), err
		})
	srv.Register("get_work_item", "Read a durable work record with creator, current owner, dependencies, waiting_on prerequisites, next action, acceptance criteria, reviewer, blocker, progress, outcome, evidence references, revision, and update history.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp}), "required": []string{"work_id"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "work_id")
			if err != nil {
				return "", err
			}
			result, err := pt.chatRequest(args, http.MethodGet, "/api/sdk-work/"+url.PathEscape(id), nil)
			return string(result), err
		})
	srv.Register("start_work_item", "Ask Muxterm to kick off an open Work item after its dependencies are done. Muxterm reserves one dispatch, chooses a ready chat in a matching project that owns no other unfinished work, or creates a chat. It sends the Work ID and instructs that chat to claim the item. The returned dispatch state is preparing, sent, claimed, uncertain, or failed; inspect an uncertain chat before attempting any new dispatch. Reusing client_ref is idempotent. This does not start or change a Chat Goal.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp, "client_ref": stringProp}), "required": []string{"work_id", "client_ref"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "work_id")
			if err != nil {
				return "", err
			}
			ref, err := argString(args, "client_ref")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]any{"clientRef": ref})
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-work/"+url.PathEscape(id)+"/start", body)
			return string(result), err
		})
	srv.Register("update_work_item", "Append an idempotent progress update or change status, next action, owner, reviewer, blocker, dependencies, labels, participants, or folder tags. depends_on and labels replace their respective lists; [] clears either. Dependency, label, and assignment changes require expected_revision. Cycles are rejected and work cannot become active, review, or done while waiting_on is nonempty. owner_session_id is the current assignee; pass an empty string to unassign. An unassigned item can be claimed by the calling chat for itself. A blocked item needs blocked_reason or text. status=review marks evidence ready for its reviewer. Assignment does not wake an idle chat; send_chat_message explicitly for that. This never controls a Chat Goal.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp, "client_ref": stringProp, "session_id": stringProp, "linked_session_id": stringProp, "text": stringProp, "status": map[string]any{"type": "string", "enum": []string{"open", "active", "blocked", "review", "done", "cancelled"}}, "progress": stringProp, "next_action": stringProp, "outcome": stringProp, "evidence": stringsProp, "project_ids": stringsProp, "labels": stringsProp, "depends_on": stringsProp, "owner_session_id": stringProp, "reviewer_session_id": stringProp, "blocked_reason": stringProp, "expected_revision": map[string]any{"type": "integer", "minimum": 1}}), "required": []string{"work_id", "client_ref"}},
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
			for _, key := range []struct{ arg, json string }{{"session_id", "sessionId"}, {"linked_session_id", "linkedSessionId"}, {"text", "text"}, {"status", "status"}, {"progress", "progress"}, {"next_action", "nextAction"}, {"outcome", "outcome"}, {"owner_session_id", "ownerSessionId"}, {"reviewer_session_id", "reviewerSessionId"}, {"blocked_reason", "blockedReason"}} {
				if value, present, err := argStringOptional(args, key.arg); err != nil {
					return "", err
				} else if present {
					bodyMap[key.json] = value
				}
			}
			if revision, present := args["expected_revision"]; present {
				value, ok := revision.(float64)
				if !ok || value < 1 || value != float64(int(value)) {
					return "", fmt.Errorf("expected_revision must be a positive integer")
				}
				bodyMap["expectedRevision"] = int(value)
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
			if _, present := args["depends_on"]; present {
				ids, err := argStringSlice(args, "depends_on")
				if err != nil {
					return "", err
				}
				if ids == nil {
					ids = []string{}
				}
				bodyMap["dependsOn"] = ids
			}
			if _, present := args["labels"]; present {
				labels, err := argStringSlice(args, "labels")
				if err != nil {
					return "", err
				}
				if labels == nil {
					labels = []string{}
				}
				bodyMap["labels"] = labels
			}
			body, _ := json.Marshal(bodyMap)
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-work/"+url.PathEscape(id)+"/updates", body)
			return string(result), err
		})
}
