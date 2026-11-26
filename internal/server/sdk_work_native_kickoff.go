package server

import (
	"context"
	"log"
	"slices"
	"time"
)

// The native goal operation is the only start signal for this Work path.
// Its ledger receipt precedes native invocation, so an absent receipt allows
// a retry while a pending or uncertain receipt can only be observed.
func (s *Server) reconcileNativeWorkKickoff(ctx context.Context, id string) {
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[id]
	if item == nil || item.Dispatch == nil || item.Dispatch.GoalMode != "native" ||
		!(workStarting(item) || awaitingLateWorkKickoff(item)) {
		h.mu.Unlock()
		return
	}
	dispatch := *item.Dispatch
	worker := h.chats[dispatch.SessionID]
	if worker == nil || worker.Archived {
		result, err := h.finishWorkDispatchLocked(id, dispatch.ClientRef, "failed", "The selected chat is missing or archived.")
		h.mu.Unlock()
		if err == nil {
			h.notifyWorkKickoffFailure(result)
		} else {
			log.Printf("record native Work kickoff failure %s: %v", id, err)
		}
		return
	}
	chat := *worker
	goal, err := h.goals.update(chat, nil)
	if err != nil {
		h.mu.Unlock()
		log.Printf("read native Work kickoff receipt %s: %v", id, err)
		return
	}
	receiptID := "work-start-goal:" + id + ":" + dispatch.ClientRef
	index := slices.IndexFunc(goal.Receipts, func(receipt goalReceipt) bool { return receipt.ID == receiptID })
	if item.Status == "blocked" {
		if index >= 0 && nativeWorkStartObserved(item, goal, goal.Receipts[index]) && len(h.workWaitingOnLocked(item)) == 0 {
			h.recoverLateWorkKickoffLocked(item)
		}
		h.mu.Unlock()
		return
	}
	elapsed := time.Since(dispatch.UpdatedAt)
	if index >= 0 && chat.State == "uncertain" && goal.State == "uncertain" && !goal.HumanPaused &&
		(chat.Harness == "codex" || chat.Harness == "copilot") && elapsed < 4*time.Minute {
		h.mu.Unlock()
		// Reattach to the existing thread to observe the native goal.
		// Resume of the adapter does not invoke goal activation again.
		inspect, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		if err := h.resume(inspect, &chat); err != nil {
			log.Printf("observe native Work kickoff %s: %v", id, err)
		}
		return
	}
	state, detail := "", ""
	switch {
	case index >= 0 && nativeWorkStartObserved(item, goal, goal.Receipts[index]):
		state = "sent"
	case index >= 0 && (goal.Receipts[index].Status == "unsupported" || elapsed >= 4*time.Minute):
		state, detail = "uncertain", "Native goal activation could not be confirmed. Open the selected chat and inspect its goal before resolving this dispatch."
	case index < 0 && dispatch.KickoffAttempts >= maxWorkKickoffAttempts && elapsed >= time.Minute:
		state, detail = "failed", "The selected native goal could not be started after three attempts."
	}
	if state != "" {
		result, err := h.finishWorkDispatchLocked(id, dispatch.ClientRef, state, detail)
		h.mu.Unlock()
		if err != nil {
			log.Printf("reconcile native Work kickoff %s: %v", id, err)
		} else if state != "sent" {
			h.notifyWorkKickoffFailure(result)
		}
		return
	}
	if index >= 0 {
		h.mu.Unlock()
		return
	}
	if goal.HumanPaused || !h.workKickoffEligibleLocked(item) ||
		dispatch.KickoffAttempts >= maxWorkKickoffAttempts || elapsed < time.Duration(dispatch.KickoffAttempts)*15*time.Second {
		h.mu.Unlock()
		return
	}
	copy := *item
	dispatch.KickoffAttempts++
	dispatch.UpdatedAt = time.Now().UTC()
	copy.Dispatch = &dispatch
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		log.Printf("reserve native Work kickoff %s: %v", id, err)
		return
	}
	h.mu.Unlock()

	_, err = s.installWorkGoal(chat.ID, &copy)
	if err != nil {
		h.mu.Lock()
		if current := h.workItems[id]; workStarting(current) &&
			current.Dispatch.ClientRef == dispatch.ClientRef && current.Dispatch.State == "starting" {
			next := *current
			outcome := *current.Dispatch
			outcome.Detail = sdkTail(err.Error(), 4096)
			next.Dispatch = &outcome
			if saveErr := h.saveWorkLocked(&next); saveErr != nil {
				log.Printf("record native Work kickoff attempt %s: %v", id, saveErr)
			}
		}
		h.mu.Unlock()
	}
}

func nativeWorkStartObserved(item *sdkWorkItem, goal goalDocument, receipt goalReceipt) bool {
	if receipt.Revision == 0 || receipt.Revision != goal.RequestedRevision || receipt.Revision != goal.AppliedRevision ||
		len(goal.Revisions) == 0 || goal.Revisions[len(goal.Revisions)-1].Condition != item.GoalCondition ||
		receipt.Objective != item.GoalCondition {
		return false
	}
	if receipt.Status == "acknowledged" {
		return true
	}
	return slices.ContainsFunc(goal.Observations, func(observation goalObservation) bool {
		event := observation.Event
		return !observation.At.Before(receipt.At) && event.Goal != nil && *event.Goal == item.GoalCondition &&
			(event.GoalState == "active" || event.GoalState == "continuing" || event.GoalState == "complete")
	})
}
