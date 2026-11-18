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

func (h *sdkChatHost) eligibleWorkChatLocked(chat *sdkChat, item *sdkWorkItem, projects []string) bool {
	if chat == nil || chat.Archived || chat.VoiceHandoff || chat.SideParentID != "" || chat.State != "ready" {
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

func (h *sdkChatHost) chooseWorkChatLocked(item *sdkWorkItem, projects []string, goalReady map[string]bool) (string, bool) {
	if item.OwnerSessionID != "" {
		owner := h.chats[item.OwnerSessionID]
		if goalReady[item.OwnerSessionID] && h.eligibleWorkChatLocked(owner, item, projects) {
			return owner.ID, true
		}
		return "", false
	}
	choices := make([]*sdkChat, 0)
	for _, chat := range h.chats {
		if goalReady[chat.ID] && h.eligibleWorkChatLocked(chat, item, projects) {
			choices = append(choices, chat)
		}
	}
	sort.Slice(choices, func(i, j int) bool {
		if choices[i].UpdatedAt.Equal(choices[j].UpdatedAt) {
			return choices[i].ID < choices[j].ID
		}
		return choices[i].UpdatedAt.After(choices[j].UpdatedAt)
	})
	if len(choices) > 0 {
		return choices[0].ID, true
	}
	return sdkID(), false
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
	if item.Status != "open" || len(h.workWaitingOnLocked(item)) != 0 {
		h.mu.Unlock()
		http.Error(w, "work must be open with all prerequisites done", 409)
		return
	}
	projects := slices.Clone(h.workProjectIDsLocked(item))
	candidates := make([]sdkChat, 0)
	for _, chat := range h.chats {
		if h.eligibleWorkChatLocked(chat, item, projects) {
			candidates = append(candidates, *chat)
		}
	}
	h.mu.Unlock()
	goalReady := make(map[string]bool, len(candidates))
	for _, chat := range candidates {
		goal, err := h.goals.update(chat, nil)
		goalReady[chat.ID] = err == nil && !goal.HumanPaused
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
	if item.Status != "open" || len(h.workWaitingOnLocked(item)) != 0 {
		h.mu.Unlock()
		http.Error(w, "work must be open with all prerequisites done", 409)
		return
	}
	projects = slices.Clone(h.workProjectIDsLocked(item))
	workerID, existing := h.chooseWorkChatLocked(item, projects, goalReady)
	if workerID == "" {
		h.mu.Unlock()
		http.Error(w, "assigned chat is not ready", 409)
		return
	}
	actor := h.requestWorkActorLocked(r)
	harness := "codex"
	if creator := h.chats[h.workCreatorLocked(item).SessionID]; creator != nil && creator.Harness != "" {
		harness = creator.Harness
	}
	projectID := ""
	if len(projects) > 0 {
		projectID = projects[0]
	}
	now := time.Now().UTC()
	copy := *item
	copy.Dispatch = &sdkWorkDispatch{ClientRef: req.ClientRef, SessionID: workerID, State: "preparing", CreatedAt: now, UpdatedAt: now}
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "dispatch:" + req.ClientRef, At: now, Actor: actor, Text: "Selected chat for work kickoff", LinkedSessionID: workerID})
	copy.Revision++
	copy.UpdatedAt = now
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	prompt := "Muxterm selected this chat for Work item " + id + ". Your chat ID is " + workerID + ". Read the record with get_work_item. If it is no longer open, stop. If it is unassigned, claim it with update_work_item using your chat ID and the latest revision as expected_revision. Then carry out next_action, keep the Work record current, and report evidence or blockers there. Do not change a Chat Goal for this dispatch."
	state, detail := "sent", ""
	if existing {
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
	} else {
		payload, _ := json.Marshal(map[string]any{"WorkspaceID": projectID, "Harness": harness, "Prompt": prompt, "WorkMode": "local"})
		ctx := context.WithValue(r.Context(), workStartChatIDKey{}, workerID)
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
	if len(detail) > 4096 {
		detail = detail[:4096]
	}
	result, err := s.finishWorkDispatch(id, req.ClientRef, state, detail)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeSDKJSON(w, 200, result)
}
