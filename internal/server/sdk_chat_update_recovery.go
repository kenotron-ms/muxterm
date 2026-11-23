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

// markUpdateRecovery records only turns that were running when a verified
// update was installed. A normal sidecar failure has no such marker.
func (h *sdkChatHost) markUpdateRecovery() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, chat := range h.chats {
		if chat.Archived || chat.State != "working" && chat.State != "starting" {
			continue
		}
		chat.UpdateRecoveryUnix = time.Now().Unix()
		if err := h.saveLocked(chat); err != nil {
			chat.UpdateRecoveryUnix = 0
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
		chat.UpdateRecoveryUnix = 0
		if err := h.saveLocked(chat); err != nil {
			chat.UpdateRecoveryUnix = previous
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
		eligible := !chat.Archived && chat.State == "uncertain" && time.Since(time.Unix(chat.UpdateRecoveryUnix, 0)) <= updateRecoveryWindow
		snapshot := *chat
		h.mu.Unlock()
		if eligible {
			goal, err := h.goals.update(snapshot, nil)
			if err != nil {
				log.Printf("update recovery: read goal for chat %s: %v", id, err)
				lock.Unlock()
				continue
			}
			if goal.RequestedRevision > 0 && (goal.HumanPaused || goal.AppliedRevision != goal.RequestedRevision ||
				goal.ExecutionAuthorizedRevision != goal.RequestedRevision ||
				!slices.Contains([]string{"active", "continuing", "awaiting-native-observation", "uncertain"}, goal.State)) {
				eligible = false
			}
		}
		if eligible {
			sendCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			_, err := s.sendSDKRecovery(sendCtx, chat, sdkID(), func() error {
				if err := sendCtx.Err(); err != nil {
					return err
				}
				h.mu.Lock()
				defer h.mu.Unlock()
				current := h.chats[id]
				if current == nil || current.State != "uncertain" || current.UpdateRecoveryUnix == 0 {
					return fmt.Errorf("chat is no longer eligible for update recovery")
				}
				previous := current.UpdateRecoveryUnix
				current.UpdateRecoveryUnix = 0
				if err := h.saveLocked(current); err != nil {
					current.UpdateRecoveryUnix = previous
					return fmt.Errorf("consume update recovery marker: %w", err)
				}
				return nil
			})
			cancel()
			if err != nil {
				log.Printf("update recovery: continue chat %s: %v", id, err)
			}
		} else {
			h.mu.Lock()
			if current := h.chats[id]; current != nil && current.UpdateRecoveryUnix != 0 {
				previous := current.UpdateRecoveryUnix
				current.UpdateRecoveryUnix = 0
				if err := h.saveLocked(current); err != nil {
					current.UpdateRecoveryUnix = previous
					log.Printf("update recovery: clear ineligible chat %s: %v", id, err)
				}
			}
			h.mu.Unlock()
		}
		lock.Unlock()
	}
}

// sendSDKRecovery is shared by the manual Continue action and update recovery.
// The caller holds the chat adapter lock and has checked the uncertain state.
func (s *Server) sendSDKRecovery(ctx context.Context, chat *sdkChat, inputID string, beforeSend func() error) (json.RawMessage, error) {
	h := s.sdkChats
	lastRequest, err := sdkLastRecoverableInput(filepath.Join(h.dir, chat.ID+".ndjson"))
	if err != nil {
		return nil, fmt.Errorf("read interrupted turn: %w", err)
	}
	content := "The previous turn was interrupted. Inspect the conversation and current work before acting. Continue only unfinished work, and verify before repeating an action. Briefly note the interruption in your response."
	if lastRequest != "" {
		content += "\n\nPrevious user request for reference:\n" + lastRequest
	}
	if err := h.resume(ctx, chat); err != nil {
		return nil, err
	}
	h.mu.Lock()
	branchPending, branchContext := chat.BranchPending, chat.BranchContext
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
	result, err := h.call(ctx, "send", map[string]any{"sessionId": chat.ID, "input": map[string]any{"kind": "user", "source": "recovery", "id": inputID, "content": content, "displayContent": "Continue after interruption", "model": chat.Model, "effort": chat.Effort}})
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
