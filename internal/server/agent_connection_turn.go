package server

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// AgentConnectionTurn is the current observed result of one admitted source
// input. A completed turn is not proof that any accepted Work was completed.
type AgentConnectionTurn struct {
	AgentID    string `json:"agentId"`
	DeliveryID string `json:"deliveryId"`
	ChatID     string `json:"chatId"`
	InputID    string `json:"inputId"`
	Status     string `json:"status"` // pending | completed | cancelled | uncertain
	Text       string `json:"text,omitempty"`
	EventID    string `json:"eventId,omitempty"`
}

// ReadAgentConnectionTurn observes the linked chat's durable event history.
// The caller publishes a completed result using the source platform's own
// delivery API, then records the platform receipt separately.
func (s *Server) ReadAgentConnectionTurn(connectionID, deliveryID string) (AgentConnectionTurn, error) {
	receipt, err := s.InspectAgentConnectionInput(connectionID, deliveryID)
	if err != nil {
		return AgentConnectionTurn{}, err
	}
	if receipt.Status != "accepted" {
		return AgentConnectionTurn{}, ErrConnectionDeliveryUncertain
	}
	result := AgentConnectionTurn{
		AgentID: receipt.AgentID, DeliveryID: receipt.DeliveryID,
		ChatID: receipt.ChatID, InputID: receipt.InputID, Status: "pending",
	}
	file, err := os.Open(filepath.Join(s.sdkChats.dir, receipt.ChatID+".ndjson"))
	if err != nil {
		return AgentConnectionTurn{}, err
	}
	defer file.Close()
	scan := bufio.NewScanner(file)
	scan.Buffer(make([]byte, 64<<10), 8<<20)
	started := false
	var answer strings.Builder
	for scan.Scan() {
		var event sdkEvent
		if json.Unmarshal(scan.Bytes(), &event) != nil {
			return AgentConnectionTurn{}, errors.New("invalid chat event in connection turn")
		}
		if !started {
			if event.Type == "input.accepted" && event.InputID == receipt.InputID {
				started = true
			}
			continue
		}
		switch event.Type {
		case "assistant.interim":
			answer.Reset()
		case "assistant.delta":
			if answer.Len()+len(event.Text) > 256<<10 {
				return AgentConnectionTurn{}, errors.New("connection turn output exceeds 256 KiB")
			}
			answer.WriteString(event.Text)
		case "turn.completed":
			if slices.Contains(event.InputIDs, receipt.InputID) {
				result.Status, result.EventID = "completed", event.ID
				result.Text = strings.TrimSpace(answer.String())
				return result, nil
			}
		case "turn.cancelled":
			if slices.Contains(event.InputIDs, receipt.InputID) {
				result.Status, result.EventID = "cancelled", event.ID
				return result, nil
			}
		case "session.uncertain":
			result.Status, result.EventID = "uncertain", event.ID
			return result, nil
		}
	}
	if err := scan.Err(); err != nil {
		return AgentConnectionTurn{}, err
	}
	if !started {
		return AgentConnectionTurn{}, ErrConnectionDeliveryUncertain
	}
	return result, nil
}
