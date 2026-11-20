package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"
)

// installWorkGoal runs only after a dispatch reservation has pinned an
// exact filed or human-approved Work condition. It never clears a pause or replaces an
// existing goal on a reused chat. Once native dispatch has been recorded, any
// missing acknowledgement is uncertain and must be inspected, never replayed.
func (s *Server) installWorkGoal(chatID string, item *sdkWorkItem) (string, error) {
	if !workGoalDispatchAuthorized(item) {
		return "failed", errors.New("Work goal condition is not authorized for dispatch")
	}
	h := s.sdkChats
	h.mu.Lock()
	current := h.chats[chatID]
	if current == nil {
		h.mu.Unlock()
		return "failed", errors.New("selected Work chat is unavailable")
	}
	if current.Archived {
		h.mu.Unlock()
		return "failed", errors.New("archived chat cannot start Work")
	}
	chat := *current
	h.mu.Unlock()
	if !supportsNativeGoalControl(chat.Harness) {
		return "failed", errors.New("selected chat has no native goal control")
	}
	before, err := h.goals.update(chat, nil)
	if err != nil {
		return "failed", err
	}
	receiptID := "work-start-goal:" + item.ID + ":" + item.Dispatch.ClientRef
	provenance := "human-work-approval:" + item.ID
	if item.GoalFiledRevision == item.GoalRevision {
		provenance = "filed-work:" + item.ID
	}
	document, err := h.goals.update(chat, func(document *goalDocument) error {
		if document.ControlVersion != before.ControlVersion {
			return errGoalConflict
		}
		if document.HumanPaused || document.RequestedRevision != 0 {
			return errors.New("selected chat already has a native goal or human pause")
		}
		for _, receipt := range document.Receipts {
			if receipt.Status == "dispatching" {
				return errors.New("selected chat has pending native goal control")
			}
		}
		document.RequestedRevision++
		document.ExecutionAuthorizedRevision = document.RequestedRevision
		document.ControlVersion++
		document.Revisions = append(document.Revisions, goalRevision{Revision: document.RequestedRevision, Condition: item.GoalCondition, Provenance: provenance, At: time.Now().UTC()})
		document.Receipts = append(document.Receipts, goalReceipt{ID: receiptID, Action: "set", Objective: item.GoalCondition, Revision: document.RequestedRevision, Actor: provenance, Status: "dispatching", At: time.Now().UTC()})
		return nil
	})
	if err != nil {
		return "failed", err
	}
	goalRevision := document.RequestedRevision
	h.dispatchGoal(chat, receiptID, "set", item.GoalCondition, false, goalRevision)
	document, err = h.goals.update(chat, nil)
	if err != nil {
		return "uncertain", err
	}
	for _, receipt := range document.Receipts {
		if receipt.ID == receiptID {
			if receipt.Status == "acknowledged" {
				deadline := time.Now().Add(15 * time.Second)
				for document.AppliedRevision != goalRevision && time.Now().Before(deadline) {
					time.Sleep(100 * time.Millisecond)
					document, err = h.goals.update(chat, nil)
					if err != nil {
						return "uncertain", err
					}
					if document.RequestedRevision != goalRevision || document.HumanPaused {
						return "uncertain", errors.New("native Work goal changed or was paused before dispatch input")
					}
				}
				if document.AppliedRevision == goalRevision && document.RequestedRevision == goalRevision && !document.HumanPaused {
					return "sent", nil
				}
				return "uncertain", errors.New("native Work goal was acknowledged but its exact revision was not observed as applied")
			}
			return "uncertain", errors.New("native Work goal acknowledgement: " + receipt.Status + ": " + receipt.Detail)
		}
	}
	return "uncertain", errors.New("native Work goal receipt missing after dispatch")
}

// Approval belongs to the Work record before the scheduler chooses a worker.
// The browser must submit the exact condition it displayed, plus both revision
// fences, so a late click cannot approve a different draft.
func (s *Server) handleSDKWorkGoalApprove(w http.ResponseWriter, r *http.Request) {
	if !humanBrowserRequest(r) {
		http.Error(w, "only a human browser may approve a Work goal", http.StatusForbidden)
		return
	}
	var req struct {
		ClientRef        string `json:"clientRef"`
		ExpectedRevision int    `json:"expectedRevision"`
		GoalRevision     int    `json:"goalRevision"`
		Condition        string `json:"condition"`
		Ready            bool   `json:"ready"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || req.ExpectedRevision < 1 || req.GoalRevision < 1 || strings.TrimSpace(req.Condition) == "" {
		http.Error(w, "clientRef, revisions, and exact condition required", 400)
		return
	}
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[r.PathValue("id")]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	for _, update := range item.Updates {
		if update.ClientRef != "goal-approve:"+req.ClientRef {
			continue
		}
		if !update.GoalApproved || update.GoalRevision != req.GoalRevision || update.GoalCondition == nil || *update.GoalCondition != req.Condition || update.ExpectedRevision == nil || *update.ExpectedRevision != req.ExpectedRevision || (update.Readiness != nil) != req.Ready {
			h.mu.Unlock()
			http.Error(w, "clientRef already used for another approval", 409)
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
	if item.Revision != req.ExpectedRevision || item.GoalRevision != req.GoalRevision || item.GoalCondition != req.Condition {
		h.mu.Unlock()
		http.Error(w, "Work goal changed; refresh and review the current condition", 409)
		return
	}
	if item.Status != "open" || item.Dispatch != nil || item.OwnerSessionID != "" {
		h.mu.Unlock()
		http.Error(w, "Work is already in motion", 409)
		return
	}
	if !workGoalCheckCurrent(item) {
		h.mu.Unlock()
		http.Error(w, "check the current Work goal revision before approval", 409)
		return
	}
	if !workPreviewReady(item) {
		h.mu.Unlock()
		http.Error(w, "attach a versioned design artifact and previews for each affected screen before approval", 409)
		return
	}
	now := time.Now().UTC()
	copy := *item
	copy.GoalApproved = item.GoalRevision
	copy.GoalApprovedAt = &now
	copy.CreatedBy = h.workCreatorLocked(item)
	copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
	copy.WaitingOn = h.workWaitingOnLocked(item)
	var readiness *string
	if req.Ready {
		value := "ready"
		readiness = &value
		copy.Readiness = value
		copy.HeldByHuman = false
	}
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "goal-approve:" + req.ClientRef, At: now, Actor: sdkWorkActor{Kind: "human"}, Text: "Approved the exact goal condition", GoalCondition: &req.Condition, GoalRevision: req.GoalRevision, GoalApproved: true, Readiness: readiness, ExpectedRevision: &req.ExpectedRevision})
	copy.Revision++
	copy.UpdatedAt = now
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	writeSDKJSON(w, 200, copy)
}
