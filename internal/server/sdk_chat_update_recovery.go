package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"slices"
	"time"
)

const updateRecoveryWindow = 15 * time.Minute

func activeUpdateRecoveryGoal(goal goalDocument) bool {
	return goal.RequestedRevision > 0 && !goal.HumanPaused && goal.AppliedRevision == goal.RequestedRevision &&
		goal.ExecutionAuthorizedRevision == goal.RequestedRevision &&
		slices.Contains([]string{"active", "continuing", "awaiting-native-observation", "uncertain"}, goal.State)
}

// markUpdateRecovery records turns and approved active goals that could be
// interrupted by a verified update. A normal sidecar failure has no marker.
func (h *sdkChatHost) markUpdateRecovery() {
	h.mu.Lock()
	candidates := make([]sdkChat, 0, len(h.chats))
	for _, chat := range h.chats {
		if !chat.Archived && (chat.State == "ready" || chat.State == "working" || chat.State == "starting") {
			candidates = append(candidates, *chat)
		}
	}
	h.mu.Unlock()
	activeGoals := make(map[string]bool)
	for _, chat := range candidates {
		goal, err := h.goals.update(chat, nil)
		if err != nil {
			log.Printf("update recovery: read goal for chat %s: %v", chat.ID, err)
			continue
		}
		activeGoals[chat.ID] = activeUpdateRecoveryGoal(goal)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, chat := range h.chats {
		activeTurn := chat.State == "working" || chat.State == "starting"
		activeGoal := activeGoals[chat.ID] && (activeTurn || chat.State == "ready")
		if chat.Archived || (!activeTurn && !activeGoal) {
			continue
		}
		previous := chat.UpdateRecoveryUnix
		wasGoal := chat.UpdateRecoveryGoal
		chat.UpdateRecoveryUnix = time.Now().Unix()
		chat.UpdateRecoveryGoal = activeGoal
		if err := h.saveLocked(chat); err != nil {
			chat.UpdateRecoveryUnix = previous
			chat.UpdateRecoveryGoal = wasGoal
			log.Printf("update recovery: mark chat %s: %v", chat.ID, err)
		}
	}
}

func (h *sdkChatHost) clearUpdateRecovery() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, chat := range h.chats {
		if chat.UpdateRecoveryUnix == 0 {
			continue
		}
		previous := chat.UpdateRecoveryUnix
		wasGoal := chat.UpdateRecoveryGoal
		chat.UpdateRecoveryUnix = 0
		chat.UpdateRecoveryGoal = false
		if err := h.saveLocked(chat); err != nil {
			chat.UpdateRecoveryUnix = previous
			chat.UpdateRecoveryGoal = wasGoal
			log.Printf("update recovery: clear chat %s: %v", chat.ID, err)
		}
	}
}

// recoverUpdateChats runs after the replacement server has started. The marker
// is removed before send, because a lost send acknowledgement must never cause
// the same recovery input to be replayed on another restart.
func (s *Server) recoverUpdateChats(ctx context.Context) {
	// Give the replacement server a moment to settle before dispatching user
	// input. An immediate follow-on restart leaves the unconsumed marker for the
	// next process to handle.
	startup := time.NewTimer(5 * time.Second)
	defer startup.Stop()
	select {
	case <-ctx.Done():
		return
	case <-startup.C:
	}
	h := s.sdkChats
	h.mu.Lock()
	ids := make([]string, 0)
	for _, chat := range h.chats {
		if chat.UpdateRecoveryUnix != 0 {
			ids = append(ids, chat.ID)
		}
	}
	h.mu.Unlock()
	for _, id := range ids {
		if ctx.Err() != nil {
			return
		}
		lock := h.adapterLock(id)
		lock.Lock()
		h.mu.Lock()
		chat := h.chats[id]
		if chat == nil || chat.UpdateRecoveryUnix == 0 {
			h.mu.Unlock()
			lock.Unlock()
			continue
		}
		goalMarked := chat.UpdateRecoveryGoal
		goalOnly := goalMarked && chat.State == "ready"
		eligible := !chat.Archived && (chat.State == "uncertain" || goalOnly) && time.Since(time.Unix(chat.UpdateRecoveryUnix, 0)) <= updateRecoveryWindow
		snapshot := *chat
		h.mu.Unlock()
		if eligible {
			goal, err := h.goals.update(snapshot, nil)
			if err != nil {
				log.Printf("update recovery: read goal for chat %s: %v", id, err)
				lock.Unlock()
				continue
			}
			if (goalMarked || goal.RequestedRevision > 0) && !activeUpdateRecoveryGoal(goal) {
				eligible = false
			}
		}
		if eligible {
			sendCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			_, err := s.sendSDKRecovery(sendCtx, chat, sdkID(), goalOnly, func() error {
				if err := sendCtx.Err(); err != nil {
					return err
				}
				if goalMarked {
					// The snapshot supplies the ID; update reads current goal state from SQLite.
					goal, err := h.goals.update(snapshot, nil)
					if err != nil || !activeUpdateRecoveryGoal(goal) {
						return fmt.Errorf("approved goal is no longer active")
					}
				}
				h.mu.Lock()
				defer h.mu.Unlock()
				current := h.chats[id]
				if current == nil || current.UpdateRecoveryUnix == 0 ||
					(goalOnly && (current.State != "ready" || !current.UpdateRecoveryGoal)) ||
					(!goalOnly && current.State != "uncertain") {
					return fmt.Errorf("chat is no longer eligible for update recovery")
				}
				previous := current.UpdateRecoveryUnix
				wasGoal := current.UpdateRecoveryGoal
				current.UpdateRecoveryUnix = 0
				current.UpdateRecoveryGoal = false
				if err := h.saveLocked(current); err != nil {
					current.UpdateRecoveryUnix = previous
					current.UpdateRecoveryGoal = wasGoal
					return fmt.Errorf("consume update recovery marker: %w", err)
				}
				return nil
			})
			cancel()
			if err != nil {
				log.Printf("update recovery: continue chat %s: %v", id, err)
				goalReady := goalMarked
				if goalMarked {
					if goal, goalErr := h.goals.update(snapshot, nil); goalErr == nil {
						goalReady = activeUpdateRecoveryGoal(goal)
					}
				}
				h.mu.Lock()
				if current := h.chats[id]; current != nil && current.UpdateRecoveryUnix != 0 &&
					current.State != "uncertain" && !(goalReady && current.State == "ready") {
					previous := current.UpdateRecoveryUnix
					wasGoal := current.UpdateRecoveryGoal
					current.UpdateRecoveryUnix = 0
					current.UpdateRecoveryGoal = false
					if saveErr := h.saveLocked(current); saveErr != nil {
						current.UpdateRecoveryUnix = previous
						current.UpdateRecoveryGoal = wasGoal
						log.Printf("update recovery: clear failed chat %s: %v", id, saveErr)
					}
				}
				h.mu.Unlock()
			}
		} else {
			h.mu.Lock()
			if current := h.chats[id]; current != nil && current.UpdateRecoveryUnix != 0 {
				previous := current.UpdateRecoveryUnix
				wasGoal := current.UpdateRecoveryGoal
				current.UpdateRecoveryUnix = 0
				current.UpdateRecoveryGoal = false
				if err := h.saveLocked(current); err != nil {
					current.UpdateRecoveryUnix = previous
					current.UpdateRecoveryGoal = wasGoal
					log.Printf("update recovery: clear ineligible chat %s: %v", id, err)
				}
			}
			h.mu.Unlock()
		}
		lock.Unlock()
	}
}

// sendSDKRecovery is shared by the manual Continue action and update recovery.
// The caller holds the chat adapter lock and has checked the chat state.
func (s *Server) sendSDKRecovery(ctx context.Context, chat *sdkChat, inputID string, goalOnly bool, beforeSend func() error) (json.RawMessage, error) {
	h := s.sdkChats
	content := "Muxterm updated while your approved goal was active. Inspect the conversation and current work. Continue only unfinished work toward the approved goal, and verify before repeating an action. Briefly note the update in your response."
	displayContent := "Continue goal after update"
	if !goalOnly {
		lastRequest, err := sdkLastRecoverableInput(filepath.Join(h.dir, chat.ID+".ndjson"))
		if err != nil {
			return nil, fmt.Errorf("read interrupted turn: %w", err)
		}
		content = "The previous turn was interrupted. Inspect the conversation and current work before acting. Continue only unfinished work, and verify before repeating an action. Briefly note the interruption in your response."
		if lastRequest != "" {
			content += "\n\nPrevious user request for reference:\n" + lastRequest
		}
		displayContent = "Continue after interruption"
	}
	if err := h.resume(ctx, chat); err != nil {
		return nil, err
	}
	h.mu.Lock()
	branchPending, branchContext := chat.BranchPending, chat.BranchContext
	model, effort := chat.Model, chat.Effort
	h.mu.Unlock()
	if branchPending {
		if branchContext == "" {
			contextData, err := os.ReadFile(filepath.Join(h.dir, chat.ID+".branch-context"))
			if err != nil {
				return nil, fmt.Errorf("branch history is unavailable: %w", err)
			}
			branchContext = string(contextData)
		}
		content = branchContext + "\n\nContinue this conversation with the user's new message:\n" + content
	}
	if beforeSend != nil {
		if err := beforeSend(); err != nil {
			return nil, err
		}
	}
	if s.voiceProvider() != "" {
		content = sdkTaskInputWithVoiceContext(content, h.recentVoiceContext(chat.ID))
	}
	content = sdkChatInput(chat.ID, content)
	h.workSendMu.RLock()
	defer h.workSendMu.RUnlock()
	notice, tokens := h.pendingWorkBoundaryNotice(chat.ID)
	content += notice
	result, err := h.call(ctx, "send", map[string]any{"sessionId": chat.ID, "input": map[string]any{"kind": "user", "source": "recovery", "id": inputID, "content": content, "displayContent": displayContent, "model": model, "effort": effort}})
	if err != nil {
		return nil, err
	}
	if len(tokens) > 0 {
		var ack struct{ Status string }
		if json.Unmarshal(result, &ack) == nil && ack.Status == "accepted" {
			h.markWorkBoundaryNotices(tokens)
		}
	}
	return result, nil
}
