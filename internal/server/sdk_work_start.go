package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"time"
)

type workStartChatIDKey struct{}
type workStartIdleChatKey struct{}

func (h *sdkChatHost) eligibleWorkChatLocked(chat *sdkChat, item *sdkWorkItem, projects []string) bool {
	if chat == nil || chat.Archived || chat.VoiceHandoff || chat.SideParentID != "" || chat.State != "ready" {
		return false
	}
	if chat.ID == h.workCreatorLocked(item).SessionID {
		return false
	}
	if len(projects) == 0 {
		if chat.WorkspaceID != "" {
			return false
		}
	} else if !slices.Contains(projects, chat.WorkspaceID) {
		return false
	}
	for _, other := range h.workItems {
		if other.ID != item.ID && other.OwnerSessionID == chat.ID && other.Status != "done" && other.Status != "cancelled" {
			return false
		}
		if other.ID != item.ID && other.Dispatch != nil && other.Dispatch.SessionID == chat.ID && other.Dispatch.State != "failed" && other.Status != "done" && other.Status != "cancelled" {
			return false
		}
	}
	return true
}

func (s *Server) finishWorkDispatch(id, ref, state, detail string) (sdkWorkItem, error) {
	h := s.sdkChats
	h.mu.Lock()
	defer h.mu.Unlock()
	item := h.workItems[id]
	if item == nil || item.Dispatch == nil || item.Dispatch.ClientRef != ref {
		return sdkWorkItem{}, errors.New("work dispatch reservation changed")
	}
	copy := *item
	if copy.Dispatch.State != "claimed" {
		dispatch := *copy.Dispatch
		dispatch.State, dispatch.Detail = state, detail
		dispatch.UpdatedAt = time.Now().UTC()
		copy.Dispatch = &dispatch
		copy.Revision++
		copy.UpdatedAt = dispatch.UpdatedAt
		if err := h.saveWorkLocked(&copy); err != nil {
			return sdkWorkItem{}, err
		}
	}
	copy.CreatedBy = h.workCreatorLocked(&copy)
	copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(&copy))
	copy.WaitingOn = h.workWaitingOnLocked(&copy)
	return copy, nil
}

func (s *Server) handleSDKWorkStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientRef string `json:"clientRef"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 {
		http.Error(w, "clientRef required", 400)
		return
	}
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	item := h.workItems[id]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if item.Dispatch != nil && (item.Dispatch.State != "failed" || item.Dispatch.ClientRef == req.ClientRef) {
		sameRef := item.Dispatch.ClientRef == req.ClientRef
		copy := *item
		copy.CreatedBy = h.workCreatorLocked(item)
		copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
		copy.WaitingOn = h.workWaitingOnLocked(item)
		h.mu.Unlock()
		if !sameRef {
			http.Error(w, "work already dispatched", 409)
			return
		}
		writeSDKJSON(w, 200, copy)
		return
	}
	if !h.workEligibleLocked(item, true) {
		h.mu.Unlock()
		http.Error(w, "work is not eligible to start", 409)
		return
	}
	projects := slices.Clone(h.workProjectIDsLocked(item))
	projectPath := h.projects[projects[0]].Path
	related := h.workContextCandidatesLocked(item)
	candidates := make([]sdkChat, 0)
	for _, chat := range h.chats {
		if h.eligibleWorkChatLocked(chat, item, projects) {
			candidates = append(candidates, *chat)
		}
	}
	h.mu.Unlock()
	sort.Slice(candidates, func(i, j int) bool {
		left, right := related[candidates[i].ID], related[candidates[j].ID]
		if left != right {
			return left < right
		}
		return candidates[i].ID < candidates[j].ID
	})
	goalReady := make(map[string]bool, len(candidates))
	for _, chat := range candidates {
		goal, err := h.goals.update(chat, nil)
		goalReady[chat.ID] = err == nil && !goal.HumanPaused && goal.RequestedRevision == 0 && supportsNativeGoalControl(chat.Harness)
	}
	config, relatedChatID, contextWorkID, fallback, err := s.selectWorkConfiguration(r.Context(), candidates, related, goalReady, projectPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	h.mu.Lock()
	item = h.workItems[id]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if item.Dispatch != nil && (item.Dispatch.State != "failed" || item.Dispatch.ClientRef == req.ClientRef) {
		sameRef := item.Dispatch.ClientRef == req.ClientRef
		copy := *item
		copy.CreatedBy = h.workCreatorLocked(item)
		copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
		copy.WaitingOn = h.workWaitingOnLocked(item)
		h.mu.Unlock()
		if !sameRef {
			http.Error(w, "work already dispatched", 409)
			return
		}
		writeSDKJSON(w, 200, copy)
		return
	}
	if !h.workEligibleLocked(item, true) {
		h.mu.Unlock()
		http.Error(w, "work is not eligible to start", 409)
		return
	}
	projects = slices.Clone(h.workProjectIDsLocked(item))
	workerID, existing := sdkID(), false
	if relatedChatID != "" {
		if h.workContextCandidatesLocked(item)[relatedChatID] != contextWorkID {
			h.mu.Unlock()
			http.Error(w, "related worker changed before dispatch; retry selection", 409)
			return
		}
		if !h.eligibleWorkChatLocked(h.chats[relatedChatID], item, projects) || !goalReady[relatedChatID] {
			h.mu.Unlock()
			http.Error(w, "related worker is no longer ready; retry selection", 409)
			return
		}
		workerID, existing = relatedChatID, true
	}
	actor := h.requestWorkActorLocked(r)
	projectID := ""
	if len(projects) > 0 {
		projectID = projects[0]
	}
	now := time.Now().UTC()
	copy := *item
	reason := "Created a fresh worker; no eligible completed prerequisite worker has compatible, goal-free task context."
	if existing {
		reason = "Reused this chat because it completed direct prerequisite Work " + contextWorkID + " and its configuration is compatible."
	}
	configuration := config
	copy.Dispatch = &sdkWorkDispatch{ClientRef: req.ClientRef, SessionID: workerID, State: "preparing", SelectionReason: reason, ContextWorkID: contextWorkID, Configuration: &configuration, Fallback: fallback, CreatedAt: now, UpdatedAt: now}
	setting := func(value string) string {
		if value == "" {
			return "none"
		}
		return value
	}
	selectionText := reason + " Effective worker: " + config.Harness + "/" + config.Provider + ", bundle=" + setting(config.Bundle) + ", model=" + setting(config.Model) + ", effort=" + setting(config.Effort) + "."
	if fallback != "" {
		selectionText += " Fallback: " + fallback + "."
	}
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "dispatch:" + req.ClientRef, At: now, Actor: actor, Summary: "Worker selected", Text: selectionText, LinkedSessionID: workerID})
	copy.Revision++
	copy.UpdatedAt = now
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	prompt := "Muxterm selected this chat for Work item " + id + ". Your chat ID is " + workerID + ". The human-approved Work condition has been installed as your native Chat Goal. Read the record with get_work_item. If it is no longer open, stop. If it is unassigned, claim it with update_work_item using your chat ID and the latest revision as expected_revision. Then carry out next_action, keep the Work record current, and report evidence or blockers in both the Work record and your native goal."
	state, detail := "sent", ""
	if existing {
		if err := s.applyReusedWorkConfiguration(r.Context(), workerID, config); err != nil {
			state, detail = "uncertain", err.Error()
		}
	} else {
		payload, _ := json.Marshal(map[string]any{"WorkspaceID": projectID, "Harness": config.Harness, "Provider": config.Provider, "Bundle": config.Bundle, "Model": config.Model, "Effort": config.Effort, "Prompt": "Work: " + copy.Title, "WorkMode": "local"})
		ctx := context.WithValue(r.Context(), workStartChatIDKey{}, workerID)
		ctx = context.WithValue(ctx, workStartIdleChatKey{}, true)
		request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/sdk-chats", bytes.NewReader(payload))
		response := httptest.NewRecorder()
		s.handleSDKChats(response, request)
		if response.Code != 201 {
			state, detail = "uncertain", strings.TrimSpace(response.Body.String())
			h.mu.Lock()
			if h.chats[workerID] == nil {
				state = "failed"
			}
			h.mu.Unlock()
		}
	}
	if state == "sent" {
		goalState, err := s.installApprovedWorkGoal(workerID, &copy)
		if err != nil {
			state, detail = goalState, err.Error()
		}
	}
	if state == "sent" {
		payload, _ := json.Marshal(map[string]any{"clientRef": "work-start:" + id + ":" + req.ClientRef, "content": prompt})
		request := httptest.NewRequestWithContext(r.Context(), http.MethodPost, "/api/sdk-chats/"+workerID+"/control-send", bytes.NewReader(payload))
		request.SetPathValue("id", workerID)
		if token := r.Header.Get("X-Muxterm-Origin"); token != "" {
			request.Header.Set("X-Muxterm-Origin", token)
			request.Header.Set("X-Muxterm-Agent", "1")
		}
		response := httptest.NewRecorder()
		s.handleSDKControlSend(response, request)
		if response.Code != 200 && response.Code != 202 {
			state, detail = "uncertain", strings.TrimSpace(response.Body.String())
			if response.Code >= 400 && response.Code < 500 {
				state = "failed"
			}
		} else {
			var receipt sdkControlReceipt
			if json.Unmarshal(response.Body.Bytes(), &receipt) != nil || receipt.Status != "accepted" {
				state, detail = "uncertain", "chat input acceptance was not confirmed"
			}
		}
	}
	if len(detail) > 4096 {
		detail = detail[:4096]
	}
	result, err := s.finishWorkDispatch(id, req.ClientRef, state, detail)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	if state == "uncertain" || state == "failed" {
		if creatorID := result.CreatedBy.SessionID; creatorID != "" && creatorID != result.Dispatch.SessionID {
			h.appendEvent(sdkEvent{SessionID: creatorID, Type: "work.attention", WorkID: id, Text: "Work kickoff needs inspection: " + result.Title + ". Open the Work tab for details."})
		}
	}
	writeSDKJSON(w, 200, result)
}

// An uncertain kickoff needs an explicit, revision-fenced resolution after the
// caller inspects the selected chat. It is never silently retried.
func (s *Server) handleSDKWorkDispatchReset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientRef        string `json:"clientRef"`
		ExpectedRevision int    `json:"expectedRevision"`
		Reason           string `json:"reason"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || req.ExpectedRevision < 1 || strings.TrimSpace(req.Reason) == "" || len(req.Reason) > 4096 {
		http.Error(w, "clientRef, expectedRevision, and reason required", 400)
		return
	}
	req.Reason = strings.TrimSpace(req.Reason)
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[r.PathValue("id")]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	actor := h.requestWorkActorLocked(r)
	if actor.Kind == "chat" && actor.SessionID != h.workCreatorLocked(item).SessionID && actor.SessionID != item.OwnerSessionID && (item.Dispatch == nil || actor.SessionID != item.Dispatch.SessionID) {
		h.mu.Unlock()
		http.Error(w, "only the creator, owner, or selected chat can resolve this dispatch", 403)
		return
	}
	resetRef := "dispatch-reset:" + req.ClientRef
	message := "Resolved uncertain kickoff as failed: " + req.Reason
	for _, update := range item.Updates {
		if update.ClientRef != resetRef {
			continue
		}
		if update.Text != message {
			h.mu.Unlock()
			http.Error(w, "clientRef already used with different reason", 409)
			return
		}
		copy := *item
		copy.CreatedBy = h.workCreatorLocked(item)
		copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
		copy.WaitingOn = h.workWaitingOnLocked(item)
		h.mu.Unlock()
		writeSDKJSON(w, 200, copy)
		return
	}
	if item.Revision != req.ExpectedRevision {
		h.mu.Unlock()
		http.Error(w, "work item changed; inspect before resolving dispatch", 409)
		return
	}
	if item.Status != "open" || item.OwnerSessionID != "" || item.Dispatch == nil || item.Dispatch.State != "uncertain" {
		h.mu.Unlock()
		http.Error(w, "only an unclaimed uncertain kickoff can be reset", 409)
		return
	}
	if chat := h.chats[item.Dispatch.SessionID]; chat != nil && (chat.State == "starting" || chat.State == "working") {
		h.mu.Unlock()
		http.Error(w, "selected chat is still running; inspect it before resolving dispatch", 409)
		return
	}
	now := time.Now().UTC()
	copy := *item
	dispatch := *item.Dispatch
	dispatch.State = "failed"
	dispatch.Detail = req.Reason
	dispatch.UpdatedAt = now
	copy.Dispatch = &dispatch
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: resetRef, At: now, Actor: actor, Text: message, LinkedSessionID: dispatch.SessionID, ExpectedRevision: &req.ExpectedRevision})
	copy.Revision++
	copy.UpdatedAt = now
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	copy.CreatedBy = h.workCreatorLocked(&copy)
	copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(&copy))
	copy.WaitingOn = h.workWaitingOnLocked(&copy)
	h.mu.Unlock()
	writeSDKJSON(w, 200, copy)
}
