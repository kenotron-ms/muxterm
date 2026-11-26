package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"time"
)

const maxWorkOwnedContinuations = 24

// A human can pause the first turn before OpenCode has claimed Work. Once the
// cancelled turn settles, an explicit resume authorizes a fresh, fenced input
// for that same selected chat and filed condition. This is never an automatic
// replay of an uncertain kickoff.
func (s *Server) resumeUnclaimedWorkKickoff(chatID string, controlVersion int) {
	h := s.sdkChats
	h.mu.Lock()
	chat := h.chats[chatID]
	var item *sdkWorkItem
	for _, candidate := range h.workItems {
		if candidate.Status == "open" && candidate.OwnerSessionID == "" && candidate.Dispatch != nil &&
			candidate.Dispatch.SessionID == chatID && candidate.Dispatch.State == "sent" && candidate.Dispatch.GoalMode == "muxterm-work" {
			item = candidate
			break
		}
	}
	if chat == nil || chat.State != "ready" || chat.LastTurnOutcome != "cancelled" || item == nil {
		h.mu.Unlock()
		return
	}
	chatCopy, itemCopy := *chat, *item
	h.mu.Unlock()
	goal, err := h.goals.update(chatCopy, nil)
	if err != nil || goal.Mode != "muxterm-work" || goal.ControlVersion != controlVersion || goal.State != "active" || goal.HumanPaused ||
		goal.AppliedRevision != goal.RequestedRevision || goal.ExecutionAuthorizedRevision != goal.RequestedRevision {
		return
	}
	content := "Human resumed the Muxterm-owned Work goal after the first turn was paused. Read Work " + itemCopy.Reference +
		" and its comments, claim it if still open, then execute the exact filed condition. Keep plan, progress, next action, and evidence current.\n\nFiled Work condition:\n" + itemCopy.GoalCondition
	payload, _ := json.Marshal(map[string]string{"clientRef": "work-resume:" + itemCopy.ID + ":" + strconv.Itoa(controlVersion), "content": content})
	base, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ctx := context.WithValue(base, sdkWorkKickoffContextKey{}, itemCopy.ID)
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/sdk-chats/"+chatID+"/control-send", bytes.NewReader(payload))
	request.SetPathValue("id", chatID)
	response := httptest.NewRecorder()
	s.handleSDKControlSend(response, request)
	var receipt struct {
		Status string `json:"status"`
	}
	accepted := response.Code == http.StatusAccepted && json.Unmarshal(response.Body.Bytes(), &receipt) == nil && receipt.Status == "accepted"
	h.mu.Lock()
	defer h.mu.Unlock()
	current := h.workItems[itemCopy.ID]
	if current == nil || current.Status != "open" || current.OwnerSessionID != "" || current.Dispatch == nil || current.Dispatch.SessionID != chatID {
		return
	}
	copy := *current
	copy.UpdatedAt = time.Now().UTC()
	copy.Revision++
	summary := "Human resume delivered a new Work kickoff"
	if !accepted {
		copy.Status = "blocked"
		copy.BlockedReason = "Resumed Work kickoff delivery was not confirmed: " + response.Body.String()
		copy.NextAction = "Inspect the chat input receipt and transcript before retrying this selected worker."
		copy.NeedsHuman = true
		summary = "Resumed Work kickoff needs inspection"
	}
	copy.Updates = append(slices.Clone(current.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "work-resume-kickoff:" + itemCopy.ID + ":" + chatCopy.LastTurnEventID,
		At: copy.UpdatedAt, Actor: sdkWorkActor{Kind: "external-tool"}, Summary: summary,
		Text: "Muxterm-owned Work goal resume input delivery: " + receipt.Status + "."})
	if err := h.saveWorkLocked(&copy); err != nil {
		log.Printf("record resumed Work kickoff %s: %v", copy.ID, err)
	}
}

// A reused chat can retain historical Work links. Only the selected owner's
// current filed condition can participate in the lifecycle.
func workGoalMatches(item *sdkWorkItem, chatID string, document goalDocument) bool {
	if item.OwnerSessionID != chatID || item.GoalRevision < 1 || (item.GoalFiledRevision != item.GoalRevision && item.GoalApproved != item.GoalRevision) {
		return false
	}
	for _, revision := range document.Revisions {
		if revision.Revision != document.RequestedRevision || revision.Condition != item.GoalCondition {
			continue
		}
		if item.Dispatch == nil {
			return true
		}
		return item.Dispatch.SessionID == chatID &&
			(revision.Provenance == "filed-work:"+item.ID ||
				revision.Provenance == "human-work-approval:"+item.ID ||
				revision.Provenance == "human-work-replacement:"+item.ID)
	}
	return false
}

func (h *sdkChatHost) workGoalControlMatchesLocked(workID, chatID string, document goalDocument) bool {
	item := h.workItems[workID]
	chat := h.chats[chatID]
	return item != nil && chat != nil && !chat.Archived &&
		(item.Status == "active" || item.Status == "blocked") &&
		workGoalMatches(item, chatID, document)
}

// Caller holds h.mu. Observation metadata never advances Work status or its
// evidence gates. The exact native objective and current ledger must agree.
func (h *sdkChatHost) projectWorkGoalObservationLocked(chat *sdkChat, event sdkEvent) {
	if (event.Type != "goal.progress" && event.Type != "goal.snapshot") || event.Goal == nil || event.GoalState == "" {
		return
	}
	document, err := h.goals.update(*chat, nil)
	if err != nil || document.RequestedRevision == 0 || document.AppliedRevision != document.RequestedRevision ||
		(event.GoalControlVersion != nil && *event.GoalControlVersion != document.ControlVersion) {
		return
	}
	for _, item := range h.workItems {
		if item.GoalCondition != *event.Goal || !workGoalMatches(item, chat.ID, document) ||
			(item.Status != "active" && item.Status != "blocked" && item.Status != "review") {
			continue
		}
		if item.GoalObservation != nil && (item.GoalObservation.EventID == event.ID || event.At.Before(item.GoalObservation.At)) {
			continue
		}
		copy := *item
		copy.GoalObservation = &sdkWorkGoalObservation{EventID: event.ID, State: event.GoalState, Summary: event.GoalSummary, At: event.At}
		if err := h.saveWorkLocked(&copy); err != nil {
			log.Printf("record Work goal observation %s: %v", item.ID, err)
		}
	}
}

// Caller holds h.mu. Work status, not model prose, closes a Muxterm-owned goal.
// Reconciliation repeats this projection after a crash between Work and ledger
// writes, without ever starting another agent turn.
func (h *sdkChatHost) syncWorkOwnedTerminalGoalLocked(item *sdkWorkItem) {
	if item.Dispatch == nil || item.Dispatch.GoalMode != "muxterm-work" || item.OwnerSessionID == "" {
		return
	}
	state := ""
	switch item.Status {
	case "done":
		state = "complete"
	case "review":
		state = "awaiting-review"
	case "active":
		state = "active"
	case "blocked":
		state = "blocked"
	case "cancelled":
		state = "cancelled"
	default:
		return
	}
	chat := h.chats[item.OwnerSessionID]
	if chat == nil {
		return
	}
	document, err := h.goals.update(*chat, nil)
	if err != nil || document.Mode != "muxterm-work" || !workGoalMatches(item, chat.ID, document) {
		if err != nil {
			log.Printf("read Work goal %s: %v", item.ID, err)
		}
		return
	}
	// A reviewer can return Work for more execution. Restore the goal only
	// from the review state; a human pause or another stopped state still
	// requires its own authorized control action.
	if item.Status == "active" && (document.HumanPaused || (document.State != "awaiting-review" && document.State != "active")) {
		return
	}
	if (document.HumanPaused && state != "complete" && state != "cancelled") || (document.State == "cleared" && item.Status == "blocked") {
		return
	}
	if document.State != state {
		_, err = h.goals.update(*chat, func(document *goalDocument) error {
			if document.Mode != "muxterm-work" || !workGoalMatches(item, chat.ID, *document) || (document.HumanPaused && state != "complete" && state != "cancelled") {
				return errGoalConflict
			}
			document.State = state
			if state == "complete" {
				document.AppliedRevision = document.RequestedRevision
			}
			return nil
		})
		if err != nil {
			log.Printf("sync Work goal %s: %v", item.ID, err)
			return
		}
	}
	if chat.GoalState != state || chat.GoalSummary != item.Outcome {
		chat.GoalState = state
		chat.GoalReason = "Muxterm-owned goal follows the Work record"
		chat.GoalSummary = item.Outcome
		if err := h.saveLocked(chat); err != nil {
			log.Printf("save Work goal projection %s: %v", item.ID, err)
		} else {
			h.notifyCatalogLocked(chat.ID)
		}
	}
}

// Caller holds h.mu. The event fence prevents an old completion from sending
// after a new turn, Work update, or human pause changed the target.
func (h *sdkChatHost) workContinuationEligibleLocked(workID, chatID, eventID string) bool {
	item := h.workItems[workID]
	chat := h.chats[chatID]
	return item != nil && chat != nil && item.Status == "active" && item.OwnerSessionID == chatID &&
		item.Dispatch != nil && item.Dispatch.GoalMode == "muxterm-work" &&
		item.Dispatch.ContinuationEventID == eventID && item.Dispatch.ContinuationState == "preparing" &&
		chat.State == "ready" && chat.LastTurnEventID == eventID && !chat.Archived
}

// A Muxterm-owned Work goal continues only after a durable completed turn. A
// reserved continuation is never replayed after an uncertain send or restart.
func (s *Server) reconcileWorkOwnedGoals(ctx context.Context) {
	h := s.sdkChats
	h.mu.Lock()
	for _, item := range h.workItems {
		h.syncWorkOwnedTerminalGoalLocked(item)
	}
	var reserved sdkWorkItem
	var chatID, eventID string
	for _, item := range h.workItems {
		if item.Status != "active" || item.OwnerSessionID == "" || item.Dispatch == nil || item.Dispatch.GoalMode != "muxterm-work" {
			continue
		}
		chat := h.chats[item.OwnerSessionID]
		if chat == nil || chat.Archived || chat.State != "ready" || chat.LastTurnEventID == "" || chat.LastTurnEventID == item.Dispatch.ContinuationEventID {
			continue
		}
		goal, err := h.goals.update(*chat, nil)
		if err != nil || goal.Mode != "muxterm-work" || !workGoalMatches(item, chat.ID, goal) || goal.HumanPaused || goal.State == "paused" || goal.State == "cleared" {
			continue
		}
		if goal.State != "active" || goal.RequestedRevision == 0 || goal.AppliedRevision != goal.RequestedRevision || goal.ExecutionAuthorizedRevision != goal.RequestedRevision {
			s.blockWorkOwnedGoalLocked(item, "Muxterm Work goal is not active or its exact filed revision is uncertain; inspect the goal ledger before resuming.")
			continue
		}
		if item.Dispatch.ContinuationCount >= maxWorkOwnedContinuations {
			s.blockWorkOwnedGoalLocked(item, "Muxterm Work goal reached its continuation limit without completion; inspect progress before resuming.")
			continue
		}
		copy := *item
		dispatch := *item.Dispatch
		dispatch.ContinuationEventID = chat.LastTurnEventID
		dispatch.ContinuationState = "preparing"
		dispatch.ContinuationCount++
		copy.Dispatch = &dispatch
		copy.Revision++
		copy.UpdatedAt = time.Now().UTC()
		if err := h.saveWorkLocked(&copy); err != nil {
			log.Printf("reserve Work goal continuation %s: %v", item.ID, err)
			continue
		}
		reserved, chatID, eventID = copy, chat.ID, chat.LastTurnEventID
		break
	}
	h.mu.Unlock()
	if chatID == "" {
		return
	}
	content := "Continue Work " + reserved.Reference + " from its current plan and next action. Read the Work record and any unread comments first. Keep its status, steps, progress, next action, and evidence current. Stop if Work is done, blocked, or human-paused. The exact filed condition remains:\n\n" + reserved.GoalCondition
	payload, _ := json.Marshal(map[string]string{"clientRef": "work-continue:" + reserved.ID + ":" + eventID, "content": content})
	sendCtx := context.WithValue(ctx, sdkWorkKickoffContextKey{}, reserved.ID)
	sendCtx = context.WithValue(sendCtx, sdkWorkContinuationContextKey{}, eventID)
	request := httptest.NewRequestWithContext(sendCtx, http.MethodPost, "/api/sdk-chats/"+chatID+"/control-send", bytes.NewReader(payload))
	request.SetPathValue("id", chatID)
	response := httptest.NewRecorder()
	s.handleSDKControlSend(response, request)
	var receipt struct {
		Status string `json:"status"`
	}
	accepted := response.Code == http.StatusAccepted && json.Unmarshal(response.Body.Bytes(), &receipt) == nil && receipt.Status == "accepted"
	h.mu.Lock()
	current := h.workItems[reserved.ID]
	if current == nil || current.Dispatch == nil || current.Dispatch.ContinuationEventID != eventID || current.Dispatch.ContinuationState != "preparing" {
		h.mu.Unlock()
		return
	}
	copy := *current
	dispatch := *current.Dispatch
	paused := false
	if !accepted && response.Code == http.StatusForbidden {
		if chat := h.chats[chatID]; chat != nil {
			goal, err := h.goals.update(*chat, nil)
			paused = err == nil && goal.Mode == "muxterm-work" && goal.HumanPaused
		}
	}
	if accepted {
		dispatch.ContinuationState = "accepted"
	} else if paused {
		// The pause rejected admission before an input receipt was reserved.
		// Clearing this event fence lets an explicit human resume continue it.
		dispatch.ContinuationEventID = ""
		dispatch.ContinuationState = "paused"
	} else {
		dispatch.ContinuationState = "uncertain"
		if copy.Status == "active" {
			copy.Status = "blocked"
			copy.BlockedReason = "Work continuation delivery was not confirmed: " + response.Body.String()
			copy.NextAction = "Inspect the chat input receipt and transcript before resuming this Work goal."
			copy.NeedsHuman = true
		}
	}
	copy.Dispatch = &dispatch
	now := time.Now().UTC()
	summary := "Muxterm Work goal continued after a completed turn"
	if paused {
		summary = "Muxterm Work goal continuation held by human pause"
	} else if !accepted {
		summary = "Muxterm Work goal continuation needs inspection"
	}
	copy.Updates = append(slices.Clone(current.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "work-continuation:" + eventID,
		At: now, Actor: sdkWorkActor{Kind: "external-tool"}, Summary: summary,
		Text: "Muxterm-owned Work continuation for completed chat event " + eventID + "; delivery state: " + dispatch.ContinuationState + ".",
		Status: func() string {
			if copy.Status == "blocked" {
				return "blocked"
			}
			return ""
		}()})
	copy.Revision++
	copy.UpdatedAt = now
	if err := h.saveWorkLocked(&copy); err != nil {
		log.Printf("record Work goal continuation %s: %v", reserved.ID, err)
	}
	h.mu.Unlock()
}

// Caller holds h.mu.
func (s *Server) blockWorkOwnedGoalLocked(item *sdkWorkItem, reason string) {
	copy := *item
	copy.Status = "blocked"
	copy.BlockedReason = reason
	copy.NextAction = "Inspect the Work goal ledger and chat transcript; resume only after confirming the filed condition and input receipts."
	copy.NeedsHuman = true
	copy.UpdatedAt = time.Now().UTC()
	copy.Revision++
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "work-goal-block:" + sdkID(), At: copy.UpdatedAt,
		Actor: sdkWorkActor{Kind: "external-tool"}, Summary: "Muxterm Work goal needs inspection", Text: reason, Status: "blocked"})
	if err := s.sdkChats.saveWorkLocked(&copy); err != nil {
		log.Printf("block Work goal %s: %v", item.ID, err)
	}
}
