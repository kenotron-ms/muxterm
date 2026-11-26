package server

import (
	"log"
	"slices"
	"time"
)

// Resume the initial Codex goal after the worker's input is admitted. The
// goal receipt also fences a restart during the native resume itself.
func (s *Server) releaseWorkKickoffGoal(id string) {
	h := s.sdkChats
	h.workSendMu.Lock()
	defer h.workSendMu.Unlock()

	h.mu.Lock()
	item := h.workItems[id]
	if item == nil || item.Dispatch == nil || !item.Dispatch.KickoffGoalHeld ||
		(item.Dispatch.State != "sent" && item.Dispatch.State != "claimed") ||
		(item.Status != "open" && item.Status != "active") || item.HeldByHuman {
		h.mu.Unlock()
		return
	}
	worker := h.chats[item.Dispatch.SessionID]
	if worker == nil || worker.Archived {
		h.mu.Unlock()
		return
	}
	_, accepted, _ := h.workKickoffReceiptLocked(item)
	chat, dispatch, condition := *worker, *item.Dispatch, item.GoalCondition
	h.mu.Unlock()
	if !accepted {
		return
	}

	installID := "work-start-goal:" + id + ":" + dispatch.ClientRef
	releaseID := "work-release-goal:" + id + ":" + dispatch.ClientRef
	admitted := false
	document, err := h.goals.update(chat, func(goal *goalDocument) error {
		if goal.State != "paused" || goal.HumanPaused || goal.AgentPauseRevision != 0 ||
			goal.RequestedRevision == 0 || goal.AppliedRevision != goal.RequestedRevision ||
			goal.ExecutionAuthorizedRevision != goal.RequestedRevision {
			return nil
		}
		install := slices.IndexFunc(goal.Receipts, func(receipt goalReceipt) bool {
			return receipt.ID == installID && receipt.Status == "acknowledged" && receipt.Revision == goal.RequestedRevision
		})
		if install < 0 {
			return nil
		}
		for _, receipt := range goal.Receipts[install+1:] {
			if receipt.Status != "recorded" {
				return nil
			}
		}
		goal.ControlVersion++
		goal.Receipts = append(goal.Receipts, goalReceipt{ID: releaseID, Action: "resume", Objective: condition,
			Revision: goal.RequestedRevision, Actor: "work-kickoff:" + id, Status: "dispatching", At: time.Now().UTC()})
		admitted = true
		return nil
	})
	if err != nil {
		log.Printf("reserve Work kickoff goal release %s: %v", id, err)
		return
	}
	if admitted {
		h.dispatchGoal(chat, releaseID, "resume", condition, false, document.RequestedRevision, document.ControlVersion)
	}
}
