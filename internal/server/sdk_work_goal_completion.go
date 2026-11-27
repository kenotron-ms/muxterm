package server

import (
	"context"
	"encoding/json"
	"log"
	"slices"
	"strings"
	"time"
)

// Called with h.mu held. A report belongs to the Work and chat goal revisions
// that were current when the assigned worker submitted it.
func (h *sdkChatHost) bindWorkGoalResultLocked(item *sdkWorkItem, update *sdkWorkUpdate) {
	if update.Actor.Kind != "chat" || update.Actor.SessionID != item.OwnerSessionID ||
		update.ExpectedRevision == nil || strings.TrimSpace(update.Outcome) == "" || len(update.Evidence) == 0 ||
		item.Status != "active" && item.Status != "review" ||
		!workPlanComplete(item.Plan) {
		return
	}
	chat := h.chats[item.OwnerSessionID]
	if chat == nil || chat.Archived {
		return
	}
	goal, err := h.goals.update(*chat, nil)
	if err == nil && workGoalMatches(item, chat.ID, goal) {
		update.ResultWorkGoalRevision = item.GoalRevision
		update.ResultChatGoalRevision = goal.RequestedRevision
	}
}

func (h *sdkChatHost) workGoalResultLocked(item *sdkWorkItem) (*sdkChat, goalDocument, *sdkWorkUpdate) {
	if item == nil || (item.Status != "active" && item.Status != "review") || item.Readiness != "ready" ||
		item.HeldByHuman || item.NeedsHuman || item.BlockedReason != "" || item.ReviewerSessionID != "" ||
		item.GoalReplacement != nil || !workGoalDispatchAuthorized(item) ||
		(item.Dispatch != nil && item.Dispatch.State != "claimed" && item.Dispatch.State != "sent") ||
		len(h.workWaitingOnLocked(item)) != 0 || !workPlanComplete(item.Plan) ||
		workCommentAttention(item, item.OwnerSessionID) != nil {
		return nil, goalDocument{}, nil
	}
	chat := h.chats[item.OwnerSessionID]
	if chat == nil || chat.Archived || chat.LastTurnOutcome == "cancelled" || (chat.State != "ready" && chat.State != "uncertain") {
		return nil, goalDocument{}, nil
	}
	goal, err := h.goals.update(*chat, nil)
	if err != nil || goal.HumanPaused || goal.AgentPauseRevision != 0 ||
		goal.RequestedRevision == 0 || goal.AppliedRevision != goal.RequestedRevision ||
		goal.ExecutionAuthorizedRevision != goal.RequestedRevision || !workGoalMatches(item, chat.ID, goal) {
		return nil, goalDocument{}, nil
	}
	acknowledgedAt := latestAcknowledgedWorkGoalControl(goal)
	for _, receipt := range goal.Receipts {
		if receipt.Revision == goal.RequestedRevision && (receipt.Status == "dispatching" || receipt.Status == "uncertain") &&
			!receipt.At.Before(acknowledgedAt) {
			return nil, goalDocument{}, nil
		}
	}
	for i := len(item.Updates) - 1; i >= 0; i-- {
		update := &item.Updates[i]
		if update.ResultWorkGoalRevision == item.GoalRevision && update.ResultChatGoalRevision == goal.RequestedRevision &&
			update.Actor.SessionID == chat.ID && update.Outcome == item.Outcome {
			return chat, goal, update
		}
		// These changes invalidate earlier delivery evidence.
		if update.Outcome != "" || update.OwnerSessionID != nil || update.Acceptance != nil || update.Brief != nil ||
			update.DependsOn != nil || update.ProjectIDs != nil ||
			update.PlanRequest != nil || len(update.StepUpdates) != 0 ||
			update.NeedsHuman != nil && *update.NeedsHuman ||
			update.BlockedReason != nil && *update.BlockedReason != "" ||
			update.Status == "blocked" || update.Status == "active" || update.Status == "open" {
			break
		}
	}
	return nil, goalDocument{}, nil
}

func latestAcknowledgedWorkGoalControl(goal goalDocument) time.Time {
	for i := len(goal.Receipts) - 1; i >= 0; i-- {
		receipt := goal.Receipts[i]
		if receipt.Revision == goal.RequestedRevision && receipt.Status == "acknowledged" {
			return receipt.At
		}
	}
	return time.Time{}
}

func workAntigravityGoalAchieved(condition string, goal goalDocument, chat *sdkChat) bool {
	if goal.State != "complete" {
		return false
	}
	for i := len(goal.Observations) - 1; i >= 0; i-- {
		observation := goal.Observations[i]
		event := observation.Event
		if event.Type != "goal.snapshot" && event.Type != "goal.progress" {
			continue
		}
		var marker struct {
			Revision int    `json:"revision"`
			Source   string `json:"source"`
		}
		return event.GoalState == "complete" && event.Goal != nil && *event.Goal == condition &&
			observation.NativeID == chat.NativeID && event.At.After(latestAcknowledgedWorkGoalControl(goal)) &&
			json.Unmarshal(event.Raw, &marker) == nil && marker.Revision == goal.RequestedRevision && marker.Source == "agy-acp-marker"
	}
	return false
}

func (s *Server) reconcileWorkGoalCompletion(ctx context.Context) {
	h := s.sdkChats
	h.mu.Lock()
	ids := make([]string, 0)
	for id, item := range h.workItems {
		if _, _, report := h.workGoalResultLocked(item); report != nil {
			ids = append(ids, id)
		}
	}
	h.mu.Unlock()
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		s.completeWorkGoal(ctx, id)
	}
}

func (s *Server) completeWorkGoal(ctx context.Context, id string) {
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[id]
	chat, goal, report := h.workGoalResultLocked(item)
	if report == nil {
		h.mu.Unlock()
		return
	}
	if item.Dispatch != nil && item.Dispatch.GoalMode == "muxterm-work" && goal.Mode == "muxterm-work" {
		if goal.State == "active" || goal.State == "awaiting-review" || (goal.State == "uncertain" && chat.State == "ready") {
			h.saveAchievedWorkGoalLocked(item, report)
		}
		h.mu.Unlock()
		return
	}
	if chat.Harness == "antigravity" {
		if workAntigravityGoalAchieved(item.GoalCondition, goal, chat) {
			h.saveAchievedWorkGoalLocked(item, report)
		}
		h.mu.Unlock()
		return
	}
	if chat.Harness != "codex" && chat.Harness != "copilot" {
		h.mu.Unlock()
		return
	}
	chatCopy, workRevision, reportID := *chat, item.Revision, report.ID
	h.mu.Unlock()

	// Ask the harness itself. An old event for an identical objective can
	// still reach the ledger after a replacement, and a missed event can
	// leave the ledger active after the native goal has actually completed.
	probeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result, err := h.call(probeCtx, "goal-snapshot", map[string]any{"sessionId": chatCopy.ID})
	if err != nil {
		if err := h.resume(probeCtx, &chatCopy); err != nil {
			return
		}
		result, err = h.call(probeCtx, "goal-snapshot", map[string]any{"sessionId": chatCopy.ID})
	}
	var snapshot struct {
		Goal      string `json:"goal"`
		GoalState string `json:"goalState"`
	}
	if err != nil || json.Unmarshal(result, &snapshot) != nil ||
		snapshot.Goal != item.GoalCondition || (snapshot.GoalState != "complete" && snapshot.GoalState != "achieved") {
		return
	}
	h.mu.Lock()
	item = h.workItems[id]
	chat, current, report := h.workGoalResultLocked(item)
	if report == nil || report.ID != reportID || item.Revision != workRevision || chat.NativeID != chatCopy.NativeID ||
		chat.LastTurnEventID != chatCopy.LastTurnEventID || !chat.TurnStartedAt.Equal(chatCopy.TurnStartedAt) ||
		current.ControlVersion != goal.ControlVersion ||
		(current.Version != goal.Version && current.State != snapshot.GoalState) {
		h.mu.Unlock()
		return
	}
	saved := h.saveAchievedWorkGoalLocked(item, report)
	h.mu.Unlock()
	if saved && current.State != snapshot.GoalState {
		h.appendEvent(sdkEvent{SessionID: chatCopy.ID, Type: "goal.snapshot", Goal: &snapshot.Goal,
			GoalState: snapshot.GoalState, GoalControlVersion: &current.ControlVersion})
	}
}

func (h *sdkChatHost) saveAchievedWorkGoalLocked(item *sdkWorkItem, report *sdkWorkUpdate) bool {
	copy := *item
	copy.Status = "done"
	copy.NextAction = ""
	copy.Revision++
	copy.UpdatedAt = time.Now().UTC()
	update := sdkWorkUpdate{
		ID: sdkID(), ClientRef: "work-goal-complete:" + report.ID, At: copy.UpdatedAt,
		Actor: sdkWorkActor{Kind: "external-tool"}, SessionID: item.OwnerSessionID,
		Summary: "Filed Work goal achieved", Status: "done", Outcome: report.Outcome,
		Evidence: slices.Clone(report.Evidence),
	}
	update.JobEvent = newJobWorkEvent(&copy, &update)
	copy.Updates = append(slices.Clone(item.Updates), update)
	if err := h.saveWorkLocked(&copy); err != nil {
		log.Printf("complete achieved Work goal %s: %v", item.ID, err)
		return false
	}
	return true
}
