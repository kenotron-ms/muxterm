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
	srv.Register("create_work_item", "File project Work for automatic scheduling. Before calling, turn the request into a finite goalify-style goal_condition with a checkable outcome, scope boundary, blocked exit, and verification evidence; put the readable task in brief and acceptance_criteria. For product implementation, include a merged PR and published, verified release in the outcome unless the human explicitly scoped the item as design-only. The server checks the goal and rejects weak conditions with findings. Filing queues the Work immediately when project controls and dependencies allow; no second human review is required. Set draft=true only when the human explicitly asks for a draft; an explicit draft can omit the goal and will not run. For UI work set ui_work=true; develop design as part of the Work unless the human requests a design review first. Omit owner_session_id so the scheduler selects a suitable session; project_ids defaults to this chat's project. source records the request. labels are searchable tags; depends_on must finish before dispatch. client_ref makes retries idempotent.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"client_ref": stringProp, "title": stringProp, "brief": stringProp, "source": stringProp, "next_action": stringProp, "owner_session_id": stringProp, "acceptance_criteria": stringProp, "goal_condition": stringProp, "draft": map[string]any{"type": "boolean"}, "reviewer_session_id": stringProp, "session_ids": stringsProp, "project_ids": stringsProp, "labels": stringsProp, "ui_work": map[string]any{"type": "boolean"}, "depends_on": stringsProp}), "required": []string{"client_ref", "title", "brief"}},
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
			source, _, err := argStringOptional(args, "source")
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
			goal, _, err := argStringOptional(args, "goal_condition")
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
			bodyMap := map[string]any{"clientRef": ref, "title": title, "brief": brief, "source": source, "nextAction": nextAction, "ownerSessionId": owner, "acceptanceCriteria": acceptance, "goalCondition": goal, "reviewerSessionId": reviewer, "sessionIds": participants}
			if value, present := args["draft"]; present {
				flag, ok := value.(bool)
				if !ok {
					return "", fmt.Errorf("draft must be a boolean")
				}
				bodyMap["draft"] = flag
			}
			if value, present := args["ui_work"]; present {
				flag, ok := value.(bool)
				if !ok {
					return "", fmt.Errorf("ui_work must be a boolean")
				}
				bodyMap["uiWork"] = flag
			}
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
	srv.Register("get_next_work_item", "Fetch the oldest eligible filed Work item from the unassigned pile. Draft, held, paused-project, full-project, and dependency-waiting items are skipped. Filter by project_id or project_ids (OR), and labels (all required). Returns {\"work\":null} when none is ready. This read does not claim work. Use start_work_item for a new handoff; a direct claim requires this chat's exact native Work goal.",
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
	srv.Register("comment_work_item", "Post an attributed, idempotent coordination comment on Work. Comments appear in the activity list, do not change Work status or progress, and are never injected as owner chat prompts. Read get_work_item to inspect replies.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp, "client_ref": stringProp, "text": stringProp}), "required": []string{"work_id", "client_ref", "text"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "work_id")
			if err != nil {
				return "", err
			}
			ref, err := argString(args, "client_ref")
			if err != nil {
				return "", err
			}
			comment, err := argString(args, "text")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]string{"clientRef": ref, "text": comment})
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-work/"+url.PathEscape(id)+"/comments", body)
			return string(result), err
		})
	srv.Register("start_work_item", "Manually ask Muxterm to dispatch a filed Work item when the project's scheduler is playing, has capacity, and dependencies are done. Muxterm selects a suitable goal-free chat or creates one, installs the filed condition as its native Chat Goal, records a dispatch receipt, and asks it to claim. Inspect uncertain delivery before retrying. Reusing client_ref is idempotent.",
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
	srv.Register("reset_work_dispatch", "After inspecting the linked chat, explicitly mark an unclaimed uncertain Work kickoff as failed so start_work_item can retry with a new client_ref. Requires the current expected_revision and a reason recorded in the Work activity. Refuses while the selected chat is starting or working. Reusing client_ref is idempotent; this does not change a Chat Goal.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp, "client_ref": stringProp, "expected_revision": map[string]any{"type": "integer", "minimum": 1}, "reason": stringProp}), "required": []string{"work_id", "client_ref", "expected_revision", "reason"}},
		func(args map[string]any) (string, error) {
			id, err := argString(args, "work_id")
			if err != nil {
				return "", err
			}
			ref, err := argString(args, "client_ref")
			if err != nil {
				return "", err
			}
			reason, err := argString(args, "reason")
			if err != nil {
				return "", err
			}
			revision, ok := args["expected_revision"].(float64)
			if !ok || revision < 1 || revision != float64(int(revision)) {
				return "", fmt.Errorf("expected_revision must be a positive integer")
			}
			body, _ := json.Marshal(map[string]any{"clientRef": ref, "expectedRevision": int(revision), "reason": reason})
			result, err := pt.chatRequest(args, http.MethodPost, "/api/sdk-work/"+url.PathEscape(id)+"/dispatch/reset", body)
			return string(result), err
		})
	srv.Register("update_work_item", "Append progress, evidence, status, or a revision to a Work record. Give summary as one short sentence (160 characters max); put diagnostic detail in text as Markdown. The creator can revise goal_condition; it is checked automatically. A filed goal revision stays queued when its check passes. An explicitly requested draft can be filed with readiness=ready after its goal check passes. Scope changes without a revised goal return an unstarted item to draft. A human hold can only be released by a human. Direct claims require this chat's native goal to match the filed Work condition. Blocked work needs blocked_reason or text; status=review marks evidence ready for review.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"work_id": stringProp, "client_ref": stringProp, "session_id": stringProp, "linked_session_id": stringProp, "summary": map[string]any{"type": "string", "maxLength": 160}, "text": stringProp, "title": stringProp, "brief": stringProp, "acceptance_criteria": stringProp, "goal_condition": stringProp, "design_preview": map[string]any{"type": "object", "properties": map[string]any{"version": stringProp, "artifactUrl": stringProp, "desktopImageUrl": stringProp, "phoneImageUrl": stringProp, "affectsDesktop": map[string]any{"type": "boolean"}, "affectsPhone": map[string]any{"type": "boolean"}}, "required": []string{"version", "artifactUrl"}}, "readiness": map[string]any{"type": "string", "enum": []string{"draft", "ready", "held"}}, "status": map[string]any{"type": "string", "enum": []string{"open", "active", "blocked", "review", "done", "cancelled"}}, "progress": stringProp, "next_action": stringProp, "outcome": stringProp, "evidence": stringsProp, "project_ids": stringsProp, "labels": stringsProp, "depends_on": stringsProp, "owner_session_id": stringProp, "reviewer_session_id": stringProp, "blocked_reason": stringProp, "needs_human": map[string]any{"type": "boolean"}, "expected_revision": map[string]any{"type": "integer", "minimum": 1}}), "required": []string{"work_id", "client_ref"}},
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
			if preview, present := args["design_preview"]; present {
				if _, ok := preview.(map[string]any); !ok {
					return "", fmt.Errorf("design_preview must be an object")
				}
				bodyMap["designPreview"] = preview
			}
			for _, key := range []struct{ arg, json string }{{"session_id", "sessionId"}, {"linked_session_id", "linkedSessionId"}, {"summary", "summary"}, {"text", "text"}, {"title", "title"}, {"brief", "brief"}, {"acceptance_criteria", "acceptanceCriteria"}, {"goal_condition", "goalCondition"}, {"readiness", "readiness"}, {"status", "status"}, {"progress", "progress"}, {"next_action", "nextAction"}, {"outcome", "outcome"}, {"owner_session_id", "ownerSessionId"}, {"reviewer_session_id", "reviewerSessionId"}, {"blocked_reason", "blockedReason"}} {
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
			if value, present := args["needs_human"]; present {
				flag, ok := value.(bool)
				if !ok {
					return "", fmt.Errorf("needs_human must be a boolean")
				}
				bodyMap["needsHuman"] = flag
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
