package server

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type goalRevision struct {
	Revision   int       `json:"revision"`
	Condition  string    `json:"condition"`
	Provenance string    `json:"provenance"`
	At         time.Time `json:"at"`
}

type goalReceipt struct {
	ID         string          `json:"id"`
	Action     string          `json:"action"`
	Objective  string          `json:"objective,omitempty"`
	Revision   int             `json:"revision"`
	Actor      string          `json:"actor"`
	Status     string          `json:"status"`
	Detail     string          `json:"detail,omitempty"`
	Native     json.RawMessage `json:"native,omitempty"`
	Evidence   []string        `json:"evidence,omitempty"`
	At         time.Time       `json:"at"`
	ProposalID string          `json:"proposalId,omitempty"`
	StartBy    string          `json:"startBy,omitempty"`
}

type goalStartAuthorization struct {
	OperatorID string `json:"operatorId"`
	Revision   int    `json:"revision"`
	GrantedBy  string `json:"grantedBy"`
	ConsumedBy string `json:"consumedBy,omitempty"`
}

type goalPolicy struct {
	OperatorStart *goalStartAuthorization `json:"operatorStart,omitempty"`
}

type goalObservation struct {
	At       time.Time `json:"at"`
	NativeID string    `json:"nativeId,omitempty"`
	Event    sdkEvent  `json:"event"`
}

type goalDocument struct {
	Schema                      int               `json:"schema"`
	ChatID                      string            `json:"chatId"`
	Harness                     string            `json:"harness"`
	OperatorID                  string            `json:"operatorId,omitempty"`
	Version                     int               `json:"version"`
	ControlVersion              int               `json:"controlVersion"`
	RequestedRevision           int               `json:"requestedRevision"`
	AppliedRevision             int               `json:"appliedRevision"`
	HumanPaused                 bool              `json:"humanPaused"`
	State                       string            `json:"state"`
	ExecutionState              string            `json:"executionState,omitempty"`
	Gap                         string            `json:"gap,omitempty"`
	Revisions                   []goalRevision    `json:"revisions"`
	Receipts                    []goalReceipt     `json:"receipts"`
	Observations                []goalObservation `json:"observations"`
	Policy                      goalPolicy        `json:"policy"`
	ExecutionAuthorizedRevision int               `json:"executionAuthorizedRevision,omitempty"`
	AgentPauseRevision          int               `json:"agentPauseRevision,omitempty"`
}

type goalLedger struct {
	mu  sync.Mutex
	db  *sql.DB
	err error
}

var errGoalConflict = errors.New("goal ledger changed; refresh before trying again")

func openGoalLedger(dir string) *goalLedger {
	ledger := &goalLedger{}
	if ledger.err = os.MkdirAll(dir, 0700); ledger.err != nil {
		return ledger
	}
	ledger.db, ledger.err = sql.Open("sqlite", filepath.Join(dir, "goals.sqlite")+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if ledger.err != nil {
		return ledger
	}
	ledger.db.SetMaxOpenConns(1)
	_, ledger.err = ledger.db.Exec(`CREATE TABLE IF NOT EXISTS goals (chat_id TEXT PRIMARY KEY, version INTEGER NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)))`)
	if ledger.err == nil {
		ledger.err = ledger.recover()
	}
	return ledger
}

func (ledger *goalLedger) documents() ([]goalDocument, error) {
	if ledger.err != nil {
		return nil, ledger.err
	}
	rows, err := ledger.db.Query("SELECT document FROM goals ORDER BY chat_id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	documents := []goalDocument{}
	for rows.Next() {
		var data []byte
		var document goalDocument
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(data, &document); err != nil {
			return nil, err
		}
		if document.Schema != 1 {
			return nil, fmt.Errorf("unsupported goal schema")
		}
		documents = append(documents, document)
	}
	return documents, rows.Err()
}

func (ledger *goalLedger) recover() error {
	documents, err := ledger.documents()
	if err != nil {
		return err
	}
	for _, existing := range documents {
		_, err = ledger.update(sdkChat{ID: existing.ChatID, Harness: existing.Harness}, func(document *goalDocument) error {
			for index := range document.Receipts {
				if document.Receipts[index].Status == "dispatching" {
					document.Receipts[index].Status = "uncertain"
					document.Receipts[index].Detail = "Server restarted before acknowledgement; not replayed."
					document.State = "uncertain"
				}
			}
			if document.State == "active" || document.State == "continuing" {
				document.State = "uncertain"
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (ledger *goalLedger) update(chat sdkChat, change func(*goalDocument) error) (goalDocument, error) {
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	var document goalDocument
	if ledger.err != nil {
		return document, ledger.err
	}
	transaction, err := ledger.db.Begin()
	if err != nil {
		return document, err
	}
	defer transaction.Rollback()
	var data []byte
	err = transaction.QueryRow("SELECT document FROM goals WHERE chat_id = ?", chat.ID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		document = goalDocument{Schema: 1, ChatID: chat.ID, Harness: chat.Harness, State: "not-set", Revisions: []goalRevision{}, Receipts: []goalReceipt{}, Observations: []goalObservation{}}
	} else if err != nil {
		return document, err
	} else if err = json.Unmarshal(data, &document); err != nil {
		return document, err
	}
	if document.Schema != 1 || document.ChatID != chat.ID {
		return document, fmt.Errorf("unsupported or invalid goal document")
	}
	if change == nil {
		return document, nil
	}
	previousVersion := document.Version
	if err = change(&document); err != nil {
		return document, err
	}
	unchanged, err := json.Marshal(document)
	if err != nil {
		return document, err
	}
	if bytes.Equal(data, unchanged) {
		return document, nil
	}
	document.Version++
	data, err = json.Marshal(document)
	if err != nil {
		return document, err
	}
	result, err := transaction.Exec(`INSERT INTO goals(chat_id, version, document) VALUES(?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET version=excluded.version, document=excluded.document WHERE goals.version=?`, chat.ID, document.Version, string(data), previousVersion)
	if err != nil {
		return document, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return document, errGoalConflict
	}
	return document, transaction.Commit()
}

func goalCapabilityGap(harness string) string {
	switch harness {
	case "codex":
		return "Experimental native goal API; execution and continuation belong to Codex."
	case "amplifier":
		return "Native loop-live goals; pause prevents future continuation, not rollback of current tool effects."
	case "claude":
		return "Native /goal commands. Suspend clears the native goal; reactivation resets native goal counters. Application awaits native observation."
	default:
		return "Native goal controls are unavailable for this harness."
	}
}

func (h *sdkChatHost) observeGoalLocked(chat *sdkChat, event sdkEvent) {
	if event.Type != "goal.progress" && event.Type != "goal.snapshot" && event.Type != "goal.proposal" && event.Type != "goal.command" && event.Type != "goal.capability" && event.Type != "session.uncertain" && event.Type != "error" && event.Type != "turn.started" && event.Type != "turn.completed" && event.Type != "turn.cancelled" && event.Type != "generation.finished" {
		return
	}
	_, err := h.goals.update(*chat, func(document *goalDocument) error {
		if document.RequestedRevision == 0 && event.Type != "goal.progress" && event.Type != "goal.proposal" {
			return nil
		}
		if event.Type == "goal.proposal" {
			if event.InputID == "" || event.Message == "" {
				return nil
			}
			for _, receipt := range document.Receipts {
				if receipt.ID == event.InputID {
					return nil
				}
			}
			document.Receipts = append(document.Receipts, goalReceipt{ID: event.InputID, Action: "propose", Objective: event.Message, Actor: chat.ID, Status: "recorded", At: time.Now().UTC()})
			document.ControlVersion++
		}
		document.Observations = append(document.Observations, goalObservation{At: time.Now().UTC(), NativeID: chat.NativeID, Event: event})
		if event.Type == "goal.progress" || event.Type == "goal.snapshot" {
			document.State = event.GoalState
			if event.Goal != nil {
				if *event.Goal != "" {
					document.AppliedRevision = 0
				}
				for index := len(document.Revisions) - 1; index >= 0; index-- {
					if document.Revisions[index].Condition == *event.Goal {
						document.AppliedRevision = document.Revisions[index].Revision
						break
					}
				}
			}
		} else if event.Type == "goal.command" {
			document.State = "awaiting-native-observation"
		} else if event.Type == "session.uncertain" {
			document.State = "uncertain"
		} else if event.Type == "goal.capability" {
			document.Gap = event.Message
		} else {
			document.ExecutionState = event.Type
		}
		return nil
	})
	if err != nil {
		chat.GoalReason = "Goal ledger unavailable: " + err.Error()
	}
}
