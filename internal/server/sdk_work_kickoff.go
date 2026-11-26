package server

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const maxWorkKickoffAttempts = 3

type workKickoffAdmission struct {
	ref     string
	attempt int
}

func workKickoffRef(item *sdkWorkItem) string {
	ref := "work-start:" + item.ID + ":" + item.Dispatch.ClientRef
	if len(ref) > 256 {
		return fmt.Sprintf("work-start:%s:%x", item.ID, sha256.Sum256([]byte(ref)))
	}
	return ref
}

func workStarting(item *sdkWorkItem) bool {
	return item != nil && item.Dispatch != nil && item.Dispatch.State == "starting" &&
		(item.Status == "open" && item.OwnerSessionID == "" ||
			item.Status == "active" && item.OwnerSessionID == item.Dispatch.SessionID)
}

func (h *sdkChatHost) workKickoffEligibleLocked(item *sdkWorkItem) bool {
	if !workStarting(item) || item.Dispatch.WorkGoalRevision != 0 && item.Dispatch.WorkGoalRevision != item.GoalRevision || item.Readiness != "ready" || item.HeldByHuman || !workGoalDispatchAuthorized(item) ||
		len(h.workWaitingOnLocked(item)) != 0 {
		return false
	}
	worker := h.chats[item.Dispatch.SessionID]
	projects := h.workProjectIDsLocked(item)
	if worker == nil || worker.Archived || len(projects) != 1 || worker.WorkspaceID != projects[0] {
		return false
	}
	project := h.projects[projects[0]]
	if project == nil || project.WorkPaused {
		return false
	}
	limit := project.WorkParallelism
	if limit < 1 {
		limit = defaultWorkParallelism
	}
	return h.workActiveCountLocked(projects[0], item.ID) < limit
}

func (h *sdkChatHost) checkWorkKickoffLocked(workID, chatID, ref string, admission workKickoffAdmission) bool {
	item := h.workItems[workID]
	if !h.workKickoffEligibleLocked(item) || item.Dispatch.SessionID != chatID ||
		item.Dispatch.ClientRef != admission.ref || item.Dispatch.KickoffAttempts != admission.attempt || workKickoffRef(item) != ref {
		return false
	}
	goal, err := h.goals.update(*h.chats[chatID], nil)
	if err != nil || goal.HumanPaused || goal.RequestedRevision == 0 || goal.AppliedRevision != goal.RequestedRevision ||
		goal.ExecutionAuthorizedRevision != goal.RequestedRevision || len(goal.Revisions) == 0 ||
		goal.Revisions[len(goal.Revisions)-1].Condition != item.GoalCondition {
		return false
	}
	receiptID := "work-start-goal:" + workID + ":" + admission.ref
	return slices.ContainsFunc(goal.Receipts, func(receipt goalReceipt) bool {
		return receipt.ID == receiptID && receipt.Status == "acknowledged" && receipt.Revision == goal.RequestedRevision
	})
}

// A missing receipt proves the control send did not reach the sidecar.
// Once its receipt exists, only positive evidence can resolve the ambiguity.
func (h *sdkChatHost) workKickoffReceiptLocked(item *sdkWorkItem) (exists, accepted bool, err error) {
	ref, chatID := workKickoffRef(item), item.Dispatch.SessionID
	data, err := os.ReadFile(h.controlPath(chatID, ref))
	if os.IsNotExist(err) {
		return false, false, nil
	}
	if err != nil {
		return true, false, err
	}
	var receipt sdkControlReceipt
	if json.Unmarshal(data, &receipt) != nil || receipt.SessionID != chatID || receipt.WorkID != item.ID ||
		receipt.ClientRef != ref || receipt.InputID == "" {
		return true, false, errors.New("invalid kickoff receipt")
	}
	if receipt.Status == "accepted" || h.workKickoffEventLocked(chatID, receipt.InputID) {
		return true, true, nil
	}
	if receipt.Detail != "" {
		return true, false, errors.New(receipt.Detail)
	}
	return true, false, nil
}

func (h *sdkChatHost) workKickoffEventLocked(chatID, inputID string) bool {
	f, err := os.Open(filepath.Join(h.dir, chatID+".ndjson"))
	if err != nil {
		return false
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scan.Scan() {
		var event sdkEvent
		if json.Unmarshal(scan.Bytes(), &event) != nil {
			continue
		}
		switch event.Type {
		case "input.accepted", "input.delivered":
			if event.InputID == inputID {
				return true
			}
		case "turn.completed", "turn.cancelled":
			if slices.Contains(event.InputIDs, inputID) {
				return true
			}
		}
	}
	return false
}

// Recognize blocks written by the dispatcher itself. A later status decision
// takes precedence over receipt reconciliation.
func awaitingLateWorkKickoff(item *sdkWorkItem) bool {
	if item.Dispatch == nil || item.Dispatch.State != "uncertain" || item.OwnerSessionID != "" && item.OwnerSessionID != item.Dispatch.SessionID ||
		item.Status != "blocked" || item.HeldByHuman || item.Readiness != "ready" {
		return false
	}
	if item.Dispatch.Detail != "chat input acceptance was not confirmed" &&
		!strings.HasPrefix(item.Dispatch.Detail, "Kickoff delivery could not be confirmed.") &&
		!strings.HasPrefix(item.Dispatch.Detail, "Native goal activation could not be confirmed.") {
		return false
	}
	for index := len(item.Updates) - 1; index >= 0; index-- {
		update := item.Updates[index]
		if update.Status != "" {
			return update.Status == "blocked" && update.ClientRef == "dispatch-outcome:"+item.Dispatch.ClientRef
		}
	}
	return false
}

func (s *Server) reconcileWorkKickoffs(ctx context.Context) {
	h := s.sdkChats
	var pending []string
	h.mu.Lock()
	for id, item := range h.workItems {
		if workStarting(item) || awaitingLateWorkKickoff(item) {
			pending = append(pending, id)
		}
	}
	h.mu.Unlock()
	for _, id := range pending {
		if ctx.Err() != nil {
			return
		}
		s.reconcileWorkKickoff(ctx, id)
	}
}

func (h *sdkChatHost) recoverLateWorkKickoffLocked(item *sdkWorkItem) {
	copy := *item
	dispatch := *item.Dispatch
	now := time.Now().UTC()
	dispatch.State, dispatch.Detail, dispatch.UpdatedAt = "sent", "", now
	copy.Dispatch = &dispatch
	copy.Status, copy.BlockedReason, copy.NeedsHuman = "open", "", false
	copy.NextAction = "The selected worker started and can claim this Work."
	if copy.OwnerSessionID == dispatch.SessionID {
		copy.Status = "active"
		copy.NextAction = "The assigned worker can continue this Work."
	}
	copy.UpdatedAt = now
	copy.Revision++
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{
		ID: sdkID(), ClientRef: "dispatch-recovered:" + dispatch.ClientRef, At: now,
		Actor: sdkWorkActor{Kind: "external-tool"}, Summary: "Confirmed the original worker received kickoff",
		Status: copy.Status, NextAction: &copy.NextAction, LinkedSessionID: dispatch.SessionID,
	})
	if err := h.saveWorkLocked(&copy); err != nil {
		log.Printf("recover late Work kickoff %s: %v", item.ID, err)
	}
}

func (s *Server) reconcileWorkKickoff(ctx context.Context, id string) {
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[id]
	if item != nil && item.Dispatch != nil && item.Dispatch.GoalMode == "native" {
		h.mu.Unlock()
		s.reconcileNativeWorkKickoff(ctx, id)
		return
	}
	if item != nil && awaitingLateWorkKickoff(item) {
		_, accepted, _ := h.workKickoffReceiptLocked(item)
		worker := h.chats[item.Dispatch.SessionID]
		if accepted && worker != nil && !worker.Archived && len(h.workWaitingOnLocked(item)) == 0 {
			h.recoverLateWorkKickoffLocked(item)
		}
		h.mu.Unlock()
		return
	}
	if !workStarting(item) {
		h.mu.Unlock()
		return
	}
	dispatch := *item.Dispatch
	exists, accepted, receiptErr := h.workKickoffReceiptLocked(item)
	elapsed := time.Since(dispatch.UpdatedAt)
	state, detail := "", ""
	switch {
	case accepted:
		state = "sent"
	case exists && elapsed >= 4*time.Minute:
		state, detail = "uncertain", "Kickoff delivery could not be confirmed. Open the selected chat and inspect its transcript before resolving the dispatch."
		if receiptErr != nil {
			detail += " Receipt error: " + receiptErr.Error()
		}
	case !exists && (h.chats[dispatch.SessionID] == nil || h.chats[dispatch.SessionID].Archived):
		state, detail = "failed", "The selected chat is missing or archived."
	case !exists && dispatch.KickoffAttempts >= maxWorkKickoffAttempts && elapsed >= time.Minute:
		state, detail = "failed", "The selected chat could not receive kickoff after three attempts. Check its availability and reopen Work to retry."
	}
	if state != "" {
		result, err := h.finishWorkDispatchLocked(id, dispatch.ClientRef, state, detail)
		h.mu.Unlock()
		if err != nil {
			log.Printf("reconcile Work kickoff %s: %v", id, err)
		} else if state != "sent" {
			h.notifyWorkKickoffFailure(result)
		}
		return
	}
	backoff := time.Duration(dispatch.KickoffAttempts) * 15 * time.Second
	admission := workKickoffAdmission{ref: dispatch.ClientRef, attempt: dispatch.KickoffAttempts}
	if exists || dispatch.KickoffAttempts >= maxWorkKickoffAttempts || elapsed < backoff || !h.checkWorkKickoffLocked(id, dispatch.SessionID, workKickoffRef(item), admission) {
		h.mu.Unlock()
		return
	}
	copy := *item
	dispatch.KickoffAttempts++
	dispatch.UpdatedAt = time.Now().UTC()
	copy.Dispatch = &dispatch
	// An attempt is internal progress. Keep the revision stable for a worker
	// that races its first Work update against receipt reconciliation.
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		log.Printf("reserve Work kickoff attempt %s: %v", id, err)
		return
	}
	h.mu.Unlock()

	admission.attempt = dispatch.KickoffAttempts
	payload, _ := json.Marshal(map[string]string{"clientRef": workKickoffRef(&copy), "content": workKickoffPrompt(&copy)})
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, sdkWorkKickoffContextKey{}, id)
	ctx = context.WithValue(ctx, workKickoffAdmission{}, admission)
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/sdk-chats/"+dispatch.SessionID+"/control-send", bytes.NewReader(payload))
	request.SetPathValue("id", dispatch.SessionID)
	response := httptest.NewRecorder()
	s.handleSDKControlSend(response, request)

	h.mu.Lock()
	current := h.workItems[id]
	if current != nil && current.Dispatch != nil && current.Dispatch.ClientRef == dispatch.ClientRef &&
		current.Dispatch.State == "starting" && current.Dispatch.KickoffAttempts == admission.attempt {
		_, accepted, _ := h.workKickoffReceiptLocked(current)
		if !accepted && response.Code >= 400 {
			next := *current
			outcome := *current.Dispatch
			outcome.Detail = sdkTail(response.Body.String(), 4096)
			next.Dispatch = &outcome
			if err := h.saveWorkLocked(&next); err != nil {
				log.Printf("record Work kickoff attempt %s: %v", id, err)
			}
		}
		if accepted {
			if _, err := h.finishWorkDispatchLocked(id, dispatch.ClientRef, "sent", ""); err != nil {
				log.Printf("confirm Work kickoff %s: %v", id, err)
			}
		}
	}
	h.mu.Unlock()
}
