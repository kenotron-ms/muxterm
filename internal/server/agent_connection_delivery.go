package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// AgentConnectionInput is the platform-neutral input an authenticated
// connector gives to a Muxterm agent. The connector, not this struct, validates
// source credentials and current conversation access before calling Muxterm.
type AgentConnectionInput struct {
	AgentID            string `json:"agentId"`
	ConnectionID       string `json:"connectionId"`
	SourceConversation string `json:"sourceConversation"`
	SourceMessageID    string `json:"sourceMessageId"`
	DeliveryID         string `json:"deliveryId"`
	ActorID            string `json:"actorId"`
	ActorKind          string `json:"actorKind"`
	Audience           string `json:"audience"`
	Text               string `json:"text"`
}

// AgentConnectionReceipt records whether the original input reached its
// linked chat. Uncertain means the caller must reconcile; it must not submit
// the same message with a new delivery ID.
type AgentConnectionReceipt struct {
	AgentID            string    `json:"agentId"`
	ConnectionID       string    `json:"connectionId"`
	SourceConversation string    `json:"sourceConversation"`
	SourceMessageID    string    `json:"sourceMessageId"`
	DeliveryID         string    `json:"deliveryId"`
	ActorID            string    `json:"actorId"`
	ActorKind          string    `json:"actorKind"`
	Audience           string    `json:"audience"`
	ChatID             string    `json:"chatId"`
	InputID            string    `json:"inputId"`
	Status             string    `json:"status"` // dispatching | accepted | uncertain
	Detail             string    `json:"detail,omitempty"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type connectionReceiptDisk struct {
	AgentConnectionReceipt
	InputHash string `json:"inputHash"`
}

var (
	ErrAgentConversationUnlinked   = errors.New("agent conversation is not linked to a chat")
	ErrConnectionDeliveryConflict  = errors.New("delivery ID was already used for different input")
	ErrConnectionDeliveryUncertain = errors.New("connection input acceptance is uncertain")
)

func validConnectionInput(input AgentConnectionInput) bool {
	return input.AgentID != "" && len(input.AgentID) <= 128 &&
		input.ConnectionID != "" && len(input.ConnectionID) <= 128 &&
		input.SourceConversation != "" && len(input.SourceConversation) <= 2048 &&
		input.SourceMessageID != "" && len(input.SourceMessageID) <= 512 &&
		input.DeliveryID != "" && len(input.DeliveryID) <= 512 &&
		input.ActorID != "" && len(input.ActorID) <= 512 &&
		input.ActorKind == "person" &&
		(input.Audience == "private" || input.Audience == "shared") &&
		strings.TrimSpace(input.Text) != "" && len(input.Text) <= 32<<10
}

func connectionDeliveryPath(dir, connectionID, deliveryID string) string {
	sum := sha256.Sum256([]byte(connectionID + "\x00" + deliveryID))
	return filepath.Join(dir, "agent-deliveries", hex.EncodeToString(sum[:])+".json")
}

func connectionInputHash(input AgentConnectionInput) string {
	data, _ := json.Marshal(input)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func readConnectionReceipt(path string) (connectionReceiptDisk, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return connectionReceiptDisk{}, err
	}
	var receipt connectionReceiptDisk
	if err := json.Unmarshal(data, &receipt); err != nil {
		return connectionReceiptDisk{}, fmt.Errorf("invalid connection receipt: %w", err)
	}
	if receipt.DeliveryID == "" || receipt.InputID == "" || receipt.ChatID == "" || receipt.InputHash == "" ||
		(receipt.Status != "dispatching" && receipt.Status != "accepted" && receipt.Status != "uncertain") {
		return connectionReceiptDisk{}, errors.New("invalid connection receipt")
	}
	return receipt, nil
}

func writeConnectionReceipt(path string, receipt connectionReceiptDisk) error {
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return atomicfile.Write(path, append(data, '\n'), 0600)
}

// InspectAgentConnectionInput reconciles an original delivery after a lost
// response. A dispatching receipt becomes accepted only when the chat's durable
// input.accepted event proves admission; otherwise it becomes uncertain.
func (s *Server) InspectAgentConnectionInput(connectionID, deliveryID string) (AgentConnectionReceipt, error) {
	path := connectionDeliveryPath(s.sdkChats.dir, connectionID, deliveryID)
	h := s.sdkChats
	h.mu.Lock()
	defer h.mu.Unlock()
	record, err := readConnectionReceipt(path)
	if err != nil {
		return AgentConnectionReceipt{}, err
	}
	if record.ConnectionID != connectionID || record.DeliveryID != deliveryID {
		return AgentConnectionReceipt{}, ErrConnectionDeliveryConflict
	}
	if record.Status == "dispatching" || record.Status == "uncertain" {
		if h.acceptedEventLocked(record.ChatID, record.InputID) {
			record.Status, record.Detail = "accepted", ""
		} else {
			record.Status = "uncertain"
			record.Detail = "input acceptance unconfirmed; it was not retried"
		}
		record.UpdatedAt = time.Now().UTC()
		if err := writeConnectionReceipt(path, record); err != nil {
			return AgentConnectionReceipt{}, err
		}
	}
	return record.AgentConnectionReceipt, nil
}

// AcceptAgentConnectionInput admits a person-authored source message into an
// explicitly linked chat. It never creates an agent, source link, or Work item.
// A future connector calls this in process after source authentication.
func (s *Server) AcceptAgentConnectionInput(ctx context.Context, input AgentConnectionInput) (AgentConnectionReceipt, error) {
	if !validConnectionInput(input) {
		return AgentConnectionReceipt{}, errors.New("invalid connection input")
	}
	h := s.sdkChats
	if h.agentDataErr != nil {
		return AgentConnectionReceipt{}, fmt.Errorf("agent registry unavailable: %w", h.agentDataErr)
	}
	path := connectionDeliveryPath(h.dir, input.ConnectionID, input.DeliveryID)
	key := agentConversationKey(input.AgentID, input.ConnectionID, input.SourceConversation)
	h.mu.Lock()
	if prior, err := readConnectionReceipt(path); err == nil {
		h.mu.Unlock()
		if prior.InputHash != connectionInputHash(input) || prior.DeliveryID != input.DeliveryID || prior.ConnectionID != input.ConnectionID {
			return AgentConnectionReceipt{}, ErrConnectionDeliveryConflict
		}
		reconciled, err := s.InspectAgentConnectionInput(input.ConnectionID, input.DeliveryID)
		if err == nil && reconciled.Status == "uncertain" {
			err = ErrConnectionDeliveryUncertain
		}
		return reconciled, err
	} else if !os.IsNotExist(err) {
		h.mu.Unlock()
		return AgentConnectionReceipt{}, err
	}
	link := h.agentConversations[key]
	if h.agents[input.AgentID] == nil || link == nil {
		h.mu.Unlock()
		return AgentConnectionReceipt{}, ErrAgentConversationUnlinked
	}
	chat := h.chats[link.ChatID]
	if chat == nil || chat.Archived || chat.AgentID != input.AgentID {
		h.mu.Unlock()
		return AgentConnectionReceipt{}, ErrAgentConversationUnlinked
	}
	chatCopy := *chat
	now := time.Now().UTC()
	receipt := connectionReceiptDisk{AgentConnectionReceipt: AgentConnectionReceipt{
		AgentID: input.AgentID, ConnectionID: input.ConnectionID,
		SourceConversation: input.SourceConversation, SourceMessageID: input.SourceMessageID,
		DeliveryID: input.DeliveryID, ActorID: input.ActorID, ActorKind: input.ActorKind,
		Audience: input.Audience, ChatID: chat.ID, InputID: sdkID(),
		Status: "dispatching", CreatedAt: now, UpdatedAt: now,
	}, InputHash: connectionInputHash(input)}
	if err := writeConnectionReceipt(path, receipt); err != nil {
		h.mu.Unlock()
		return AgentConnectionReceipt{}, err
	}
	h.mu.Unlock()

	adapterLock := h.adapterLock(chatCopy.ID)
	adapterLock.Lock()
	defer adapterLock.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	if err := h.resume(ctx, &chatCopy); err != nil {
		// No send was attempted. The original delivery can be retried.
		if removeErr := os.Remove(path); removeErr != nil && !os.IsNotExist(removeErr) {
			return AgentConnectionReceipt{}, removeErr
		}
		return AgentConnectionReceipt{}, err
	}
	facts := map[string]string{
		"agentId":            input.AgentID,
		"connectionId":       input.ConnectionID,
		"sourceConversation": input.SourceConversation,
		"sourceMessageId":    input.SourceMessageID,
		"actorId":            input.ActorID,
		"actorKind":          input.ActorKind,
		"audience":           input.Audience,
	}
	factsJSON, _ := json.Marshal(facts)
	content := sdkChatInput(chatCopy.ID, "Connection turn facts (JSON): "+string(factsJSON)+"\n\nMessage:\n"+input.Text)
	h.workSendMu.RLock()
	defer h.workSendMu.RUnlock()
	notice, boundaryTokens := h.pendingWorkBoundaryNotice(chatCopy.ID)
	content += notice
	result, sendErr := h.call(ctx, "send", map[string]any{"sessionId": chatCopy.ID, "input": map[string]any{
		"kind": "user", "source": "connection", "id": receipt.InputID,
		"content": content, "displayContent": input.Text, "connectionFacts": facts,
		"model": chatCopy.Model, "effort": chatCopy.Effort,
	}})
	var ack struct{ Status, InputID string }
	accepted := sendErr == nil && json.Unmarshal(result, &ack) == nil && ack.Status == "accepted" && ack.InputID == receipt.InputID
	h.mu.Lock()
	if !accepted {
		accepted = h.acceptedEventLocked(chatCopy.ID, receipt.InputID)
	}
	if accepted {
		receipt.Status = "accepted"
	} else {
		receipt.Status = "uncertain"
		receipt.Detail = "input acceptance unconfirmed; it was not retried"
	}
	receipt.UpdatedAt = time.Now().UTC()
	err := writeConnectionReceipt(path, receipt)
	h.mu.Unlock()
	if err != nil {
		return AgentConnectionReceipt{}, err
	}
	if accepted && len(boundaryTokens) > 0 {
		h.markWorkBoundaryNotices(boundaryTokens)
	}
	if !accepted {
		return receipt.AgentConnectionReceipt, ErrConnectionDeliveryUncertain
	}
	return receipt.AgentConnectionReceipt, nil
}
