package server

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// Work items coordinate sessions. A work item is neither a Chat Goal nor a
// command to start a harness; the person or session creating it decides when
// to send work to participants.
type sdkWorkItem struct {
	ID               string          `json:"id"`
	ClientRef        string          `json:"clientRef"`
	Title            string          `json:"title"`
	Brief            string          `json:"brief"`
	Status           string          `json:"status"`
	OwnerSessionID   string          `json:"ownerSessionId"`
	SessionIDs       []string        `json:"sessionIds"`
	CreateSessionIDs []string        `json:"createSessionIds"`
	Progress         string          `json:"progress,omitempty"`
	Outcome          string          `json:"outcome,omitempty"`
	Revision         int             `json:"revision"`
	CreatedAt        time.Time       `json:"createdAt"`
	UpdatedAt        time.Time       `json:"updatedAt"`
	Updates          []sdkWorkUpdate `json:"updates"`
}

type sdkWorkUpdate struct {
	ID              string    `json:"id"`
	ClientRef       string    `json:"clientRef"`
	At              time.Time `json:"at"`
	SessionID       string    `json:"sessionId,omitempty"`
	Text            string    `json:"text"`
	Status          string    `json:"status,omitempty"`
	Progress        string    `json:"progress,omitempty"`
	Outcome         string    `json:"outcome,omitempty"`
	Evidence        []string  `json:"evidence,omitempty"`
	LinkedSessionID string    `json:"linkedSessionId,omitempty"`
}

func validWorkStatus(status string) bool {
	return slices.Contains([]string{"open", "active", "blocked", "done", "cancelled"}, status)
}

func (h *sdkChatHost) workPath(id string) string {
	return filepath.Join(h.dir, "work", id+".json")
}

func (h *sdkChatHost) loadWorkItems() {
	entries, err := os.ReadDir(filepath.Join(h.dir, "work"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		log.Printf("read work items: %v", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(h.dir, "work", entry.Name()))
		if err != nil {
			log.Printf("read work item %s: %v", entry.Name(), err)
			continue
		}
		var item sdkWorkItem
		if err := json.Unmarshal(data, &item); err != nil || item.ID == "" || filepath.Base(item.ID+".json") != entry.Name() {
			log.Printf("invalid work item %s: %v", entry.Name(), err)
			continue
		}
		h.workItems[item.ID] = &item
	}
}

// Caller holds h.mu. The old in-memory record is untouched on write failure.
func (h *sdkChatHost) saveWorkLocked(item *sdkWorkItem) error {
	data, err := json.Marshal(item)
	if err != nil {
		return err
	}
	path := h.workPath(item.ID)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	if err := atomicfile.Write(path, data, 0600); err != nil {
		return err
	}
	h.workItems[item.ID] = item
	return nil
}

func (s *Server) handleSDKWork(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	if r.Method == http.MethodGet {
		owner := r.URL.Query().Get("session_id")
		status := r.URL.Query().Get("status")
		if status != "" && !validWorkStatus(status) {
			http.Error(w, "invalid work status", 400)
			return
		}
		h.mu.Lock()
		rows := make([]sdkWorkItem, 0, len(h.workItems))
		for _, item := range h.workItems {
			if owner != "" && item.OwnerSessionID != owner && !slices.Contains(item.SessionIDs, owner) {
				continue
			}
			if status != "" && item.Status != status {
				continue
			}
			copy := *item
			copy.Updates = nil
			rows = append(rows, copy)
		}
		h.mu.Unlock()
		sort.Slice(rows, func(i, j int) bool { return rows[i].UpdatedAt.After(rows[j].UpdatedAt) })
		writeSDKJSON(w, 200, map[string]any{"work": rows})
		return
	}
	var req struct {
		ClientRef      string   `json:"clientRef"`
		Title          string   `json:"title"`
		Brief          string   `json:"brief"`
		OwnerSessionID string   `json:"ownerSessionId"`
		SessionIDs     []string `json:"sessionIds"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || strings.TrimSpace(req.Title) == "" || len(req.Title) > 200 || len(req.Brief) > 32<<10 || req.OwnerSessionID == "" || len(req.SessionIDs) > 32 {
		http.Error(w, "clientRef, title, and ownerSessionId required", 400)
		return
	}
	sort.Strings(req.SessionIDs)
	req.SessionIDs = slices.Compact(req.SessionIDs)
	h.mu.Lock()
	if h.chats[req.OwnerSessionID] == nil {
		h.mu.Unlock()
		http.Error(w, "unknown owner session", 422)
		return
	}
	for _, id := range req.SessionIDs {
		if h.chats[id] == nil {
			h.mu.Unlock()
			http.Error(w, "unknown participant session: "+id, 422)
			return
		}
	}
	for _, item := range h.workItems {
		if item.OwnerSessionID == req.OwnerSessionID && item.ClientRef == req.ClientRef {
			createdWith := item.CreateSessionIDs
			if createdWith == nil {
				createdWith = item.SessionIDs // older records predate the create snapshot
			}
			if item.Title != req.Title || item.Brief != req.Brief || !slices.Equal(createdWith, req.SessionIDs) {
				h.mu.Unlock()
				http.Error(w, "clientRef already used for different work", 409)
				return
			}
			copy := *item
			h.mu.Unlock()
			writeSDKJSON(w, 200, copy)
			return
		}
	}
	now := time.Now().UTC()
	item := &sdkWorkItem{ID: sdkID(), ClientRef: req.ClientRef, Title: req.Title, Brief: req.Brief,
		Status: "open", OwnerSessionID: req.OwnerSessionID, SessionIDs: req.SessionIDs,
		CreateSessionIDs: append([]string{}, req.SessionIDs...),
		Revision:         1, CreatedAt: now, UpdatedAt: now, Updates: []sdkWorkUpdate{}}
	if err := h.saveWorkLocked(item); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	h.appendEvent(sdkEvent{SessionID: item.OwnerSessionID, Type: "work.created", WorkID: item.ID, Text: item.Title})
	writeSDKJSON(w, 201, item)
}

func (s *Server) handleSDKWorkItem(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[r.PathValue("id")]
	var copy sdkWorkItem
	if item != nil {
		copy = *item
	}
	h.mu.Unlock()
	if item == nil {
		http.NotFound(w, r)
		return
	}
	writeSDKJSON(w, 200, copy)
}

func (s *Server) handleSDKWorkUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientRef       string   `json:"clientRef"`
		SessionID       string   `json:"sessionId"`
		Text            string   `json:"text"`
		Status          string   `json:"status"`
		Progress        string   `json:"progress"`
		Outcome         string   `json:"outcome"`
		Evidence        []string `json:"evidence"`
		LinkedSessionID string   `json:"linkedSessionId"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || len(req.Text) > 16<<10 || len(req.Progress) > 4096 || len(req.Outcome) > 16<<10 || len(req.Evidence) > 20 || (req.Status != "" && !validWorkStatus(req.Status)) || (req.Text == "" && req.Status == "" && req.Progress == "" && req.Outcome == "" && req.LinkedSessionID == "") {
		http.Error(w, "clientRef and a valid work update required", 400)
		return
	}
	for _, evidence := range req.Evidence {
		if len(evidence) == 0 || len(evidence) > 2048 {
			http.Error(w, "invalid evidence reference", 400)
			return
		}
	}
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	item := h.workItems[id]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if req.SessionID != "" && h.chats[req.SessionID] == nil {
		h.mu.Unlock()
		http.Error(w, "unknown reporting session", 422)
		return
	}
	if req.LinkedSessionID != "" && h.chats[req.LinkedSessionID] == nil {
		h.mu.Unlock()
		http.Error(w, "unknown participant session", 422)
		return
	}
	for _, prior := range item.Updates {
		if prior.ClientRef == req.ClientRef {
			if prior.SessionID != req.SessionID || prior.Text != req.Text || prior.Status != req.Status || prior.Progress != req.Progress || prior.Outcome != req.Outcome || prior.LinkedSessionID != req.LinkedSessionID || !slices.Equal(prior.Evidence, req.Evidence) {
				h.mu.Unlock()
				http.Error(w, "clientRef already used for different update", 409)
				return
			}
			copy := *item
			h.mu.Unlock()
			writeSDKJSON(w, 200, copy)
			return
		}
	}
	copy := *item
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: req.ClientRef, At: time.Now().UTC(), SessionID: req.SessionID,
		Text: req.Text, Status: req.Status, Progress: req.Progress, Outcome: req.Outcome, Evidence: req.Evidence, LinkedSessionID: req.LinkedSessionID})
	if req.LinkedSessionID != "" && !slices.Contains(copy.SessionIDs, req.LinkedSessionID) && req.LinkedSessionID != copy.OwnerSessionID {
		copy.SessionIDs = append(slices.Clone(copy.SessionIDs), req.LinkedSessionID)
		sort.Strings(copy.SessionIDs)
	}
	if req.Status != "" {
		copy.Status = req.Status
	}
	if req.Progress != "" {
		copy.Progress = req.Progress
	} else if req.Text != "" {
		copy.Progress = req.Text
	}
	if req.Outcome != "" {
		copy.Outcome = req.Outcome
	}
	copy.Revision++
	copy.UpdatedAt = time.Now().UTC()
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	message := req.Text
	if message == "" {
		message = copy.Progress
	}
	if message == "" {
		if req.LinkedSessionID != "" {
			message = "Linked session " + req.LinkedSessionID
		} else {
			message = copy.Status
		}
	}
	h.appendEvent(sdkEvent{SessionID: copy.OwnerSessionID, Type: "work.updated", WorkID: copy.ID, Source: req.SessionID, Text: message})
	if req.SessionID != "" && req.SessionID != copy.OwnerSessionID {
		h.appendEvent(sdkEvent{SessionID: req.SessionID, Type: "work.updated", WorkID: copy.ID, Source: req.SessionID, Text: message})
	}
	writeSDKJSON(w, 200, copy)
}
