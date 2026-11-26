package server

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"
)

type sdkWorkGoalReplacement struct {
	ClientRef      string `json:"clientRef"`
	Condition      string `json:"condition"`
	OwnerSessionID string `json:"ownerSessionId"`
	WorkRevision   int    `json:"workRevision"`
	DispatchRef    string `json:"dispatchRef"`
	ControlVersion int    `json:"controlVersion"`
}

// Approval files the replacement under the existing human pause. Starting it
// requires a separate resume after the adapter confirms the new revision.
func (s *Server) handleSDKWorkGoalReplace(w http.ResponseWriter, r *http.Request) {
	if !humanBrowserRequest(r) {
		http.Error(w, "replacing a Work goal requires human approval", http.StatusForbidden)
		return
	}
	var req struct {
		ClientRef      string `json:"clientRef"`
		Condition      string `json:"condition"`
		WorkRevision   int    `json:"workRevision"`
		ControlVersion int    `json:"controlVersion"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(&req) != nil ||
		strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 160 || req.WorkRevision < 1 {
		http.Error(w, "clientRef and Work revision are required", http.StatusBadRequest)
		return
	}
	condition := strings.TrimSpace(req.Condition)
	if condition == "" || len([]rune(condition)) > 4000 {
		http.Error(w, "a replacement condition must contain 1 to 4000 characters", http.StatusBadRequest)
		return
	}

	h := s.sdkChats
	h.workSendMu.Lock()
	defer h.workSendMu.Unlock()
	h.mu.Lock()
	defer h.mu.Unlock()
	item := h.workItems[r.PathValue("id")]
	if item == nil {
		http.NotFound(w, r)
		return
	}
	receiptID := "work-replace:" + item.ID + ":" + req.ClientRef
	for _, update := range item.Updates {
		if update.ClientRef != receiptID {
			continue
		}
		if update.GoalCondition == nil || *update.GoalCondition != condition || update.ExpectedRevision == nil || *update.ExpectedRevision != req.WorkRevision {
			http.Error(w, "clientRef already used for another replacement", http.StatusConflict)
			return
		}
		writeSDKJSON(w, http.StatusAccepted, item)
		return
	}
	if item.Dispatch == nil || item.Dispatch.SessionID != item.OwnerSessionID ||
		(item.Status != "active" && item.Status != "blocked") || item.GoalCondition == condition {
		http.Error(w, "Work changed or has no replaceable dispatched goal", http.StatusConflict)
		return
	}
	chat := h.chats[item.OwnerSessionID]
	if chat == nil || chat.Archived || chat.State != "ready" {
		http.Error(w, "wait for the owning chat to confirm it has stopped", http.StatusConflict)
		return
	}
	check := checkWorkGoal(condition, item.GoalRevision+1)
	if !check.Passed {
		writeSDKJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "revise the replacement condition", "goalCheck": check})
		return
	}
	goal, err := h.goals.update(*chat, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	replacement := sdkWorkGoalReplacement{ClientRef: req.ClientRef, Condition: condition, OwnerSessionID: chat.ID,
		DispatchRef: item.Dispatch.ClientRef, WorkRevision: req.WorkRevision, ControlVersion: req.ControlVersion}
	intent := item.GoalReplacement
	retrying := intent != nil && *intent == replacement && item.Revision == intent.WorkRevision+1
	if (!retrying && item.Revision != req.WorkRevision) || (intent != nil && !retrying) {
		http.Error(w, "Work changed or a replacement is awaiting reconciliation", http.StatusConflict)
		return
	}
	reserved := retrying && goal.ControlVersion == req.ControlVersion+1 &&
		slices.ContainsFunc(goal.Receipts, func(receipt goalReceipt) bool {
			return receipt.ID == receiptID && receipt.Revision == goal.RequestedRevision && receipt.Objective == condition
		})
	if !goal.HumanPaused || (!reserved && (goal.State != "paused" || goal.ControlVersion != req.ControlVersion ||
		goal.AppliedRevision != goal.RequestedRevision || !workGoalMatches(item, chat.ID, goal) ||
		slices.ContainsFunc(goal.Receipts, func(receipt goalReceipt) bool { return receipt.Status == "dispatching" }))) {
		http.Error(w, "the current filed goal must have a confirmed human pause", http.StatusConflict)
		return
	}
	if item.GoalReplacement == nil {
		copy := *item
		copy.GoalReplacement = &replacement
		copy.Revision++
		copy.UpdatedAt = time.Now().UTC()
		if err := h.saveWorkLocked(&copy); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		item = &copy
	}

	provenance := "human-work-replacement:" + item.ID
	document, err := h.goals.update(*chat, func(document *goalDocument) error {
		if reserved && document.ControlVersion == goal.ControlVersion && document.HumanPaused {
			for index := range document.Receipts {
				if document.Receipts[index].ID == receiptID {
					document.Receipts[index].Status = "dispatching"
					document.Receipts[index].Detail = ""
					return nil
				}
			}
		}
		if document.ControlVersion != req.ControlVersion || !document.HumanPaused || document.State != "paused" {
			return errGoalConflict
		}
		document.RequestedRevision++
		document.ControlVersion++
		document.ExecutionAuthorizedRevision = 0
		document.AgentPauseRevision = 0
		now := time.Now().UTC()
		document.Revisions = append(document.Revisions, goalRevision{Revision: document.RequestedRevision, Condition: condition, Provenance: provenance, At: now})
		document.Receipts = append(document.Receipts, goalReceipt{ID: receiptID, Action: "set", Objective: condition, Revision: document.RequestedRevision, Actor: provenance, Status: "dispatching", At: now})
		return nil
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	copy := *item
	now := time.Now().UTC()
	copy.GoalCondition = condition
	copy.GoalRevision++
	copy.GoalFiledRevision = copy.GoalRevision
	copy.GoalApproved = copy.GoalRevision
	copy.GoalApprovedAt = &now
	copy.GoalCheck = &check
	copy.GoalObservation = nil
	copy.GoalReplacement = nil
	copy.Revision++
	copy.UpdatedAt = now
	copy.Updates = append(slices.Clone(copy.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: receiptID, At: now,
		Actor: sdkWorkActor{Kind: "human"}, Summary: "Approved a replacement goal", Text: "The replacement remains paused until a human resumes it.",
		GoalCondition: &condition, GoalRevision: copy.GoalRevision, GoalApproved: true, ExpectedRevision: &req.WorkRevision})
	if err := h.saveWorkLocked(&copy); err != nil {
		http.Error(w, "replacement is awaiting reconciliation: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	action := "set"
	if document.Mode == "muxterm-work" {
		action = "pause"
	}
	go h.dispatchGoal(*chat, receiptID, action, condition, true, document.RequestedRevision, document.ControlVersion, "")
	writeSDKJSON(w, http.StatusAccepted, &copy)
}
