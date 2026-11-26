package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"
)

func (h *sdkChatHost) dispatchMuxtermWorkGoal(chat sdkChat, receiptID, action, objective string, revision, controlVersion int) {
	ctx, cancel := context.WithTimeout(h.goalDispatch.ctx, 45*time.Second)
	defer cancel()
	document, err := h.goals.update(chat, nil)
	if err == nil && (document.Mode != "muxterm-work" || document.ControlVersion != controlVersion) {
		err = errGoalConflict
	}
	if err == nil && (action == "pause" || action == "clear") {
		h.mu.Lock()
		working := h.chats[chat.ID] != nil && h.chats[chat.ID].State == "working"
		h.mu.Unlock()
		if working {
			_, err = h.call(ctx, "interrupt", map[string]any{"sessionId": chat.ID})
			if err != nil {
				h.mu.Lock()
				settled := h.chats[chat.ID] != nil && h.chats[chat.ID].State == "ready"
				h.mu.Unlock()
				if settled {
					err = nil
				}
			}
		}
	}
	state := "active"
	if action == "pause" {
		state = "paused"
	} else if action == "clear" {
		state = "cleared"
	}
	_, saveErr := h.goals.update(chat, func(document *goalDocument) error {
		if document.Mode != "muxterm-work" {
			return errors.New("Muxterm Work goal mode changed")
		}
		for index := range document.Receipts {
			receipt := &document.Receipts[index]
			if receipt.ID != receiptID {
				continue
			}
			if receipt.Status != "dispatching" {
				return nil
			}
			if document.ControlVersion != controlVersion || document.RequestedRevision != revision || err != nil {
				receipt.Status = "uncertain"
				if err != nil {
					receipt.Detail = err.Error()
				} else {
					receipt.Detail = "Work goal control changed before acknowledgement"
				}
				document.State = "uncertain"
				return nil
			}
			receipt.Status = "acknowledged"
			receipt.Detail = "Muxterm-owned Work goal control; no native OpenCode goal API was called."
			document.State = state
			if state == "cleared" {
				document.AppliedRevision = 0
			} else {
				document.AppliedRevision = revision
			}
			return nil
		}
		return errors.New("Muxterm Work control receipt missing")
	})
	if saveErr != nil {
		h.appendEvent(sdkEvent{SessionID: chat.ID, Type: "session.uncertain", Message: "Work goal receipt persistence failed: " + saveErr.Error()})
		return
	}
	if err != nil {
		h.appendEvent(sdkEvent{SessionID: chat.ID, Type: "session.uncertain", Message: "Work goal control uncertain: " + err.Error()})
		return
	}
	goal := objective
	if state == "cleared" {
		goal = ""
	}
	h.appendEvent(sdkEvent{SessionID: chat.ID, Type: "goal.snapshot", Goal: &goal, GoalState: state,
		GoalReason: "Muxterm-owned Work goal control", GoalControlVersion: &controlVersion,
		Raw: json.RawMessage(`{"source":"muxterm-work"}`)})
	if state == "cleared" {
		h.mu.Lock()
		for _, item := range h.workItems {
			if item.OwnerSessionID == chat.ID && item.Status == "active" && item.Dispatch != nil && item.Dispatch.GoalMode == "muxterm-work" {
				copy := *item
				copy.Status = "blocked"
				copy.BlockedReason = "Human cleared the Muxterm-owned Work goal. The filed condition remains on the Work record."
				copy.NextAction = "Review the Work record and assign a new goal-authorized worker before resuming."
				copy.NeedsHuman = true
				copy.Revision++
				copy.UpdatedAt = time.Now().UTC()
				if saveErr := h.saveWorkLocked(&copy); saveErr != nil {
					log.Printf("Work goal clear could not update Work %s: %v", item.ID, saveErr)
				}
			}
		}
		h.mu.Unlock()
	}
	if state == "active" && h.onWorkChange != nil {
		h.onWorkChange()
	}
	if state == "active" && action == "resume" && h.onWorkResume != nil {
		h.onWorkResume(chat.ID, controlVersion)
	}
}

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
	if !supportsWorkGoalControl(chat.Harness) {
		return "failed", errors.New("selected chat has no safe Work goal control")
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
	if item.Dispatch.GoalMode == "native" {
		h.mu.Lock()
		current := h.workItems[item.ID]
		if !h.workKickoffEligibleLocked(current) || current.Dispatch.ClientRef != item.Dispatch.ClientRef ||
			current.Dispatch.SessionID != chatID || current.Dispatch.KickoffAttempts != item.Dispatch.KickoffAttempts {
			h.mu.Unlock()
			return "failed", errors.New("Work kickoff changed before native activation")
		}
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
		if item.Dispatch.GoalMode == "muxterm-work" {
			document.Mode = "muxterm-work"
			document.Gap = "Muxterm-owned Work goal. OpenCode ACP does not expose native goal state or controls; Work status and this ledger are authoritative."
		}
		return nil
	})
	if item.Dispatch.GoalMode == "native" {
		h.mu.Unlock()
	}
	if err != nil {
		return "failed", err
	}
	goalRevision := document.RequestedRevision
	if item.Dispatch.GoalMode == "muxterm-work" {
		_, err = h.goals.update(chat, func(document *goalDocument) error {
			if document.ControlVersion != before.ControlVersion+1 || document.RequestedRevision != goalRevision || document.HumanPaused {
				return errGoalConflict
			}
			for index := range document.Receipts {
				if document.Receipts[index].ID == receiptID && document.Receipts[index].Status == "dispatching" {
					document.Receipts[index].Status = "acknowledged"
					document.Receipts[index].Detail = "Muxterm Work ledger recorded the exact filed condition; kickoff input has a separate delivery receipt."
					document.AppliedRevision = goalRevision
					document.State = "active"
					return nil
				}
			}
			return errors.New("Muxterm Work goal receipt missing or changed")
		})
		if err != nil {
			return "uncertain", err
		}
		goal := item.GoalCondition
		h.appendEvent(sdkEvent{SessionID: chat.ID, Type: "goal.snapshot", Goal: &goal, GoalState: "active",
			GoalReason:         "Muxterm-owned Work goal; the exact condition is sent in the kickoff input",
			GoalControlVersion: &document.ControlVersion, Raw: json.RawMessage(`{"source":"muxterm-work"}`)})
		return "sent", nil
	}
	h.dispatchGoal(chat, receiptID, "set", item.GoalCondition, false, goalRevision, document.ControlVersion)
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
