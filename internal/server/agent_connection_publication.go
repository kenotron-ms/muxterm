package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// AgentConnectionPublication is an outbound reply intent. Dispatching means
// the source API call may have happened; a connector must reconcile that
// state with its source before it can attempt another send.
type AgentConnectionPublication struct {
	AgentID            string    `json:"agentId"`
	ConnectionID       string    `json:"connectionId"`
	SourceConversation string    `json:"sourceConversation"`
	SourceMessageID    string    `json:"sourceMessageId"`
	DeliveryID         string    `json:"deliveryId"`
	ChatID             string    `json:"chatId"`
	InputID            string    `json:"inputId"`
	TurnEventID        string    `json:"turnEventId"`
	Text               string    `json:"text"`
	Status             string    `json:"status"` // prepared | dispatching | uncertain | published
	PublishedMessageID string    `json:"publishedMessageId,omitempty"`
	CreatedAt          time.Time `json:"createdAt"`
	UpdatedAt          time.Time `json:"updatedAt"`
}

type connectionPublicationDisk struct {
	AgentConnectionPublication
	TurnHash string `json:"turnHash"`
}

var (
	ErrConnectionTurnPending          = errors.New("connection turn is not complete")
	ErrConnectionPublicationUncertain = errors.New("connection publication requires source reconciliation")
	ErrConnectionPublicationConflict  = errors.New("connection publication conflicts with its original turn")
)

func connectionPublicationPath(dir, connectionID, deliveryID string) string {
	sum := sha256.Sum256([]byte(connectionID + "\x00" + deliveryID))
	return filepath.Join(dir, "agent-publications", hex.EncodeToString(sum[:])+".json")
}

func connectionTurnHash(turn AgentConnectionTurn) string {
	data, _ := json.Marshal(turn)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func readConnectionPublication(path string) (connectionPublicationDisk, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return connectionPublicationDisk{}, err
	}
	var publication connectionPublicationDisk
	if err := json.Unmarshal(data, &publication); err != nil {
		return connectionPublicationDisk{}, fmt.Errorf("invalid connection publication: %w", err)
	}
	if publication.ConnectionID == "" || publication.DeliveryID == "" || publication.TurnEventID == "" || publication.TurnHash == "" ||
		(publication.Status != "prepared" && publication.Status != "dispatching" && publication.Status != "uncertain" && publication.Status != "published") ||
		(publication.Status == "published" && publication.PublishedMessageID == "") {
		return connectionPublicationDisk{}, errors.New("invalid connection publication")
	}
	return publication, nil
}

func writeConnectionPublication(path string, publication connectionPublicationDisk) error {
	data, err := json.Marshal(publication)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	return atomicfile.Write(path, append(data, '\n'), 0600)
}

// PrepareAgentConnectionPublication records a stable reply before a connector
// calls its source API. An existing publication remains authoritative even if
// later chat activity changes; the original completed turn is never replaced.
func (s *Server) PrepareAgentConnectionPublication(connectionID, deliveryID string) (AgentConnectionPublication, error) {
	turn, err := s.ReadAgentConnectionTurn(connectionID, deliveryID)
	if err != nil {
		return AgentConnectionPublication{}, err
	}
	if turn.Status != "completed" || turn.EventID == "" || turn.Text == "" {
		return AgentConnectionPublication{}, ErrConnectionTurnPending
	}
	receipt, err := s.InspectAgentConnectionInput(connectionID, deliveryID)
	if err != nil {
		return AgentConnectionPublication{}, err
	}
	path := connectionPublicationPath(s.sdkChats.dir, connectionID, deliveryID)
	h := s.sdkChats
	h.mu.Lock()
	defer h.mu.Unlock()
	if prior, err := readConnectionPublication(path); err == nil {
		if prior.ConnectionID != connectionID || prior.DeliveryID != deliveryID || prior.TurnHash != connectionTurnHash(turn) {
			return AgentConnectionPublication{}, ErrConnectionPublicationConflict
		}
		return prior.AgentConnectionPublication, nil
	} else if !os.IsNotExist(err) {
		return AgentConnectionPublication{}, err
	}
	now := time.Now().UTC()
	publication := connectionPublicationDisk{AgentConnectionPublication: AgentConnectionPublication{
		AgentID: receipt.AgentID, ConnectionID: connectionID, SourceConversation: receipt.SourceConversation,
		SourceMessageID: receipt.SourceMessageID, DeliveryID: deliveryID, ChatID: turn.ChatID,
		InputID: turn.InputID, TurnEventID: turn.EventID, Text: turn.Text,
		Status: "prepared", CreatedAt: now, UpdatedAt: now,
	}, TurnHash: connectionTurnHash(turn)}
	if err := writeConnectionPublication(path, publication); err != nil {
		return AgentConnectionPublication{}, err
	}
	return publication.AgentConnectionPublication, nil
}

// BeginAgentConnectionPublication crosses the local/source effect boundary.
// Only a prepared intent may start a source send; an interrupted dispatch is
// uncertain even if no network request was actually made.
func (s *Server) BeginAgentConnectionPublication(connectionID, deliveryID string) (AgentConnectionPublication, error) {
	return s.changeAgentConnectionPublication(connectionID, deliveryID, "begin", "")
}

// FinishAgentConnectionPublication stores the source API's message ID. It is
// also the reconciliation path when a prior dispatch was marked uncertain.
func (s *Server) FinishAgentConnectionPublication(connectionID, deliveryID, publishedMessageID string) (AgentConnectionPublication, error) {
	if publishedMessageID == "" || len(publishedMessageID) > 512 {
		return AgentConnectionPublication{}, errors.New("invalid published message ID")
	}
	return s.changeAgentConnectionPublication(connectionID, deliveryID, "finish", publishedMessageID)
}

// MarkAgentConnectionPublicationUncertain records a source call that failed
// without a definitive no-send response. The connector must inspect source
// state and may finish with the discovered message ID, but cannot send again.
func (s *Server) MarkAgentConnectionPublicationUncertain(connectionID, deliveryID string) (AgentConnectionPublication, error) {
	return s.changeAgentConnectionPublication(connectionID, deliveryID, "uncertain", "")
}

// InspectAgentConnectionPublication reads the durable source-send state.
func (s *Server) InspectAgentConnectionPublication(connectionID, deliveryID string) (AgentConnectionPublication, error) {
	publication, err := readConnectionPublication(connectionPublicationPath(s.sdkChats.dir, connectionID, deliveryID))
	if err != nil {
		return AgentConnectionPublication{}, err
	}
	if publication.ConnectionID != connectionID || publication.DeliveryID != deliveryID {
		return AgentConnectionPublication{}, ErrConnectionPublicationConflict
	}
	return publication.AgentConnectionPublication, nil
}

func (s *Server) changeAgentConnectionPublication(connectionID, deliveryID, action, messageID string) (AgentConnectionPublication, error) {
	path := connectionPublicationPath(s.sdkChats.dir, connectionID, deliveryID)
	h := s.sdkChats
	h.mu.Lock()
	defer h.mu.Unlock()
	publication, err := readConnectionPublication(path)
	if err != nil {
		return AgentConnectionPublication{}, err
	}
	if publication.ConnectionID != connectionID || publication.DeliveryID != deliveryID {
		return AgentConnectionPublication{}, ErrConnectionPublicationConflict
	}
	switch action {
	case "begin":
		if publication.Status == "published" {
			return publication.AgentConnectionPublication, nil
		}
		if publication.Status != "prepared" {
			return publication.AgentConnectionPublication, ErrConnectionPublicationUncertain
		}
		publication.Status = "dispatching"
	case "finish":
		if publication.Status == "published" {
			if publication.PublishedMessageID != messageID {
				return AgentConnectionPublication{}, ErrConnectionPublicationConflict
			}
			return publication.AgentConnectionPublication, nil
		}
		if publication.Status != "dispatching" && publication.Status != "uncertain" {
			return AgentConnectionPublication{}, ErrConnectionPublicationConflict
		}
		publication.Status, publication.PublishedMessageID = "published", messageID
	case "uncertain":
		if publication.Status == "published" || publication.Status == "uncertain" {
			return publication.AgentConnectionPublication, nil
		}
		if publication.Status != "dispatching" {
			return AgentConnectionPublication{}, ErrConnectionPublicationConflict
		}
		publication.Status = "uncertain"
	default:
		return AgentConnectionPublication{}, errors.New("unknown publication action")
	}
	publication.UpdatedAt = time.Now().UTC()
	if err := writeConnectionPublication(path, publication); err != nil {
		return AgentConnectionPublication{}, err
	}
	return publication.AgentConnectionPublication, nil
}
