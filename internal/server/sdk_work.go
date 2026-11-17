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
	ID                string          `json:"id"`
	ClientRef         string          `json:"clientRef"`
	Title             string          `json:"title"`
	Brief             string          `json:"brief"`
	Status            string          `json:"status"`
	CreatedBy         sdkWorkActor    `json:"createdBy"`
	OwnerSessionID    string          `json:"ownerSessionId"`
	CreateOwnerID     string          `json:"createOwnerSessionId,omitempty"`
	Acceptance        string          `json:"acceptanceCriteria,omitempty"`
	ReviewerSessionID string          `json:"reviewerSessionId,omitempty"`
	CreateReviewerID  string          `json:"createReviewerSessionId,omitempty"`
	BlockedReason     string          `json:"blockedReason,omitempty"`
	ProjectIDs        []string        `json:"projectIds"`
	CreateProjectIDs  []string        `json:"createProjectIds"`
	SessionIDs        []string        `json:"sessionIds"`
	CreateSessionIDs  []string        `json:"createSessionIds"`
	Progress          string          `json:"progress,omitempty"`
	Outcome           string          `json:"outcome,omitempty"`
	Revision          int             `json:"revision"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
	Updates           []sdkWorkUpdate `json:"updates"`
}

type sdkWorkUpdate struct {
	ID                string       `json:"id"`
	ClientRef         string       `json:"clientRef"`
	At                time.Time    `json:"at"`
	Actor             sdkWorkActor `json:"actor"`
	SessionID         string       `json:"sessionId,omitempty"`
	Text              string       `json:"text"`
	Status            string       `json:"status,omitempty"`
	Progress          string       `json:"progress,omitempty"`
	Outcome           string       `json:"outcome,omitempty"`
	Evidence          []string     `json:"evidence,omitempty"`
	LinkedSessionID   string       `json:"linkedSessionId,omitempty"`
	ProjectIDs        *[]string    `json:"projectIds,omitempty"`
	OwnerSessionID    *string      `json:"ownerSessionId,omitempty"`
	ReviewerSessionID *string      `json:"reviewerSessionId,omitempty"`
	BlockedReason     *string      `json:"blockedReason,omitempty"`
	ExpectedRevision  *int         `json:"expectedRevision,omitempty"`
}

// CreatedBy is immutable provenance. The owner is a separate, assignable chat.
// A human browser has no stable personal identity in local muxterm, so it is
// recorded as human without inventing a user ID.
type sdkWorkActor struct {
	Kind      string `json:"kind"`
	SessionID string `json:"sessionId,omitempty"`
}

func (h *sdkChatHost) workCreatorLocked(item *sdkWorkItem) sdkWorkActor {
	if item.CreatedBy.Kind != "" {
		return item.CreatedBy
	}
	// Records written before creator provenance was stored used owner as the
	// creating chat. Freeze that interpretation before the first reassignment.
	return sdkWorkActor{Kind: "chat", SessionID: item.OwnerSessionID}
}

func (h *sdkChatHost) requestWorkActorLocked(r *http.Request) sdkWorkActor {
	if humanBrowserRequest(r) || r.Header.Get("X-Muxterm-Remote-Chat") == "1" {
		return sdkWorkActor{Kind: "human"}
	}
	if id := h.originTokenChats[r.Header.Get("X-Muxterm-Origin")]; id != "" {
		return sdkWorkActor{Kind: "chat", SessionID: id}
	}
	return sdkWorkActor{Kind: "external-tool"}
}

// A missing projectIds field means the work item predates folder tags.
func (h *sdkChatHost) workProjectIDsLocked(item *sdkWorkItem) []string {
	if item.ProjectIDs != nil {
		return item.ProjectIDs
	}
	if owner := h.chats[item.OwnerSessionID]; owner != nil && owner.WorkspaceID != "" {
		return []string{owner.WorkspaceID}
	}
	return []string{}
}

func normalizeWorkProjectIDs(ids []string) []string {
	ids = slices.Clone(ids)
	sort.Strings(ids)
	return slices.Compact(ids)
}

func validWorkStatus(status string) bool {
	return slices.Contains([]string{"open", "active", "blocked", "review", "done", "cancelled"}, status)
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
		projectID := r.URL.Query().Get("project_id")
		status := r.URL.Query().Get("status")
		if status != "" && !validWorkStatus(status) {
			http.Error(w, "invalid work status", 400)
			return
		}
		h.mu.Lock()
		rows := make([]sdkWorkItem, 0, len(h.workItems))
		for _, item := range h.workItems {
			projectIDs := h.workProjectIDsLocked(item)
			if projectID != "" && !slices.Contains(projectIDs, projectID) {
				continue
			}
			if owner != "" && item.OwnerSessionID != owner && h.workCreatorLocked(item).SessionID != owner && !slices.Contains(item.SessionIDs, owner) {
				continue
			}
			if status != "" && item.Status != status {
				continue
			}
			copy := *item
			copy.CreatedBy = h.workCreatorLocked(item)
			copy.ProjectIDs = slices.Clone(projectIDs)
			copy.Updates = nil
			rows = append(rows, copy)
		}
		h.mu.Unlock()
		sort.Slice(rows, func(i, j int) bool { return rows[i].UpdatedAt.After(rows[j].UpdatedAt) })
		writeSDKJSON(w, 200, map[string]any{"work": rows})
		return
	}
	var req struct {
		ClientRef         string    `json:"clientRef"`
		Title             string    `json:"title"`
		Brief             string    `json:"brief"`
		OwnerSessionID    string    `json:"ownerSessionId"`
		Acceptance        string    `json:"acceptanceCriteria"`
		ReviewerSessionID string    `json:"reviewerSessionId"`
		SessionIDs        []string  `json:"sessionIds"`
		ProjectIDs        *[]string `json:"projectIds"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || strings.TrimSpace(req.Title) == "" || len(req.Title) > 200 || len(req.Brief) > 32<<10 || len(req.Acceptance) > 16<<10 || len(req.SessionIDs) > 32 || (req.ProjectIDs != nil && len(*req.ProjectIDs) > 32) {
		http.Error(w, "clientRef and title required", 400)
		return
	}
	sort.Strings(req.SessionIDs)
	req.SessionIDs = slices.Compact(req.SessionIDs)
	h.mu.Lock()
	creator := h.requestWorkActorLocked(r)
	if req.OwnerSessionID != "" && h.chats[req.OwnerSessionID] == nil {
		h.mu.Unlock()
		http.Error(w, "unknown owner session", 422)
		return
	}
	projectIDs := []string{}
	if req.ProjectIDs != nil {
		projectIDs = normalizeWorkProjectIDs(*req.ProjectIDs)
	} else if req.OwnerSessionID != "" && h.chats[req.OwnerSessionID].WorkspaceID != "" {
		id := h.chats[req.OwnerSessionID].WorkspaceID
		projectIDs = []string{id}
	}
	if req.ReviewerSessionID != "" && h.chats[req.ReviewerSessionID] == nil {
		h.mu.Unlock()
		http.Error(w, "unknown reviewer session", 422)
		return
	}
	for _, id := range projectIDs {
		if h.projects[id] == nil {
			h.mu.Unlock()
			http.Error(w, "unknown project folder: "+id, 422)
			return
		}
	}
	for _, id := range req.SessionIDs {
		if h.chats[id] == nil {
			h.mu.Unlock()
			http.Error(w, "unknown participant session: "+id, 422)
			return
		}
	}
	for _, item := range h.workItems {
		if h.workCreatorLocked(item) == creator && item.ClientRef == req.ClientRef {
			createdWith := item.CreateSessionIDs
			if createdWith == nil {
				createdWith = item.SessionIDs // older records predate the create snapshot
			}
			createdProjects := item.CreateProjectIDs
			if createdProjects == nil {
				createdProjects = h.workProjectIDsLocked(item)
			}
			createOwner := item.CreateOwnerID
			if createOwner == "" && item.CreatedBy.Kind == "" {
				createOwner = item.OwnerSessionID
			}
			createReviewer := item.CreateReviewerID
			if item.CreatedBy.Kind == "" {
				createReviewer = item.ReviewerSessionID
			}
			if item.Title != req.Title || item.Brief != req.Brief || item.Acceptance != req.Acceptance || createReviewer != req.ReviewerSessionID || createOwner != req.OwnerSessionID || !slices.Equal(createdWith, req.SessionIDs) || !slices.Equal(createdProjects, projectIDs) {
				h.mu.Unlock()
				http.Error(w, "clientRef already used for different work", 409)
				return
			}
			copy := *item
			copy.CreatedBy = h.workCreatorLocked(item)
			copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
			h.mu.Unlock()
			writeSDKJSON(w, 200, copy)
			return
		}
	}
	now := time.Now().UTC()
	item := &sdkWorkItem{ID: sdkID(), ClientRef: req.ClientRef, Title: req.Title, Brief: req.Brief,
		Status: "open", CreatedBy: creator, OwnerSessionID: req.OwnerSessionID, CreateOwnerID: req.OwnerSessionID, Acceptance: req.Acceptance, ReviewerSessionID: req.ReviewerSessionID, CreateReviewerID: req.ReviewerSessionID, ProjectIDs: projectIDs, CreateProjectIDs: slices.Clone(projectIDs), SessionIDs: req.SessionIDs,
		CreateSessionIDs: append([]string{}, req.SessionIDs...),
		Revision:         1, CreatedAt: now, UpdatedAt: now, Updates: []sdkWorkUpdate{}}
	if err := h.saveWorkLocked(item); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	if item.OwnerSessionID != "" {
		h.appendEvent(sdkEvent{SessionID: item.OwnerSessionID, Type: "work.created", WorkID: item.ID, Text: item.Title})
	}
	writeSDKJSON(w, 201, item)
}

func (s *Server) handleSDKWorkItem(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[r.PathValue("id")]
	var copy sdkWorkItem
	if item != nil {
		copy = *item
		copy.CreatedBy = h.workCreatorLocked(item)
		copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
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
		ClientRef         string    `json:"clientRef"`
		SessionID         string    `json:"sessionId"`
		Text              string    `json:"text"`
		Status            string    `json:"status"`
		Progress          string    `json:"progress"`
		Outcome           string    `json:"outcome"`
		Evidence          []string  `json:"evidence"`
		LinkedSessionID   string    `json:"linkedSessionId"`
		ProjectIDs        *[]string `json:"projectIds"`
		OwnerSessionID    *string   `json:"ownerSessionId"`
		ReviewerSessionID *string   `json:"reviewerSessionId"`
		BlockedReason     *string   `json:"blockedReason"`
		ExpectedRevision  *int      `json:"expectedRevision"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || len(req.Text) > 16<<10 || len(req.Progress) > 4096 || len(req.Outcome) > 16<<10 || len(req.Evidence) > 20 || (req.ProjectIDs != nil && len(*req.ProjectIDs) > 32) || (req.Status != "" && !validWorkStatus(req.Status)) || (req.OwnerSessionID != nil && len(*req.OwnerSessionID) > 256) || (req.ReviewerSessionID != nil && len(*req.ReviewerSessionID) > 256) || (req.BlockedReason != nil && len(*req.BlockedReason) > 4096) || (req.Text == "" && req.Status == "" && req.Progress == "" && req.Outcome == "" && req.LinkedSessionID == "" && req.ProjectIDs == nil && req.OwnerSessionID == nil && req.ReviewerSessionID == nil && req.BlockedReason == nil) {
		http.Error(w, "clientRef and a valid work update required", 400)
		return
	}
	if (req.OwnerSessionID != nil || req.ReviewerSessionID != nil) && req.ExpectedRevision == nil {
		http.Error(w, "expectedRevision required to change assignment", 400)
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
	actor := h.requestWorkActorLocked(r)
	if actor.Kind == "chat" {
		if req.SessionID != "" && req.SessionID != actor.SessionID {
			h.mu.Unlock()
			http.Error(w, "reporting session must be the calling chat", 403)
			return
		}
		req.SessionID = actor.SessionID
	}
	if req.OwnerSessionID != nil && *req.OwnerSessionID != "" && h.chats[*req.OwnerSessionID] == nil {
		h.mu.Unlock()
		http.Error(w, "unknown owner session", 422)
		return
	}
	if req.ReviewerSessionID != nil && *req.ReviewerSessionID != "" && h.chats[*req.ReviewerSessionID] == nil {
		h.mu.Unlock()
		http.Error(w, "unknown reviewer session", 422)
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
	if req.ProjectIDs != nil {
		ids := normalizeWorkProjectIDs(*req.ProjectIDs)
		for _, projectID := range ids {
			if h.projects[projectID] == nil {
				h.mu.Unlock()
				http.Error(w, "unknown project folder: "+projectID, 422)
				return
			}
		}
		req.ProjectIDs = &ids
	}
	for _, prior := range item.Updates {
		if prior.ClientRef == req.ClientRef {
			if (prior.Actor.Kind != "" && prior.Actor != actor) || prior.SessionID != req.SessionID || prior.Text != req.Text || prior.Status != req.Status || prior.Progress != req.Progress || prior.Outcome != req.Outcome || prior.LinkedSessionID != req.LinkedSessionID || !slices.Equal(prior.Evidence, req.Evidence) || (prior.ProjectIDs == nil) != (req.ProjectIDs == nil) || (prior.ProjectIDs != nil && !slices.Equal(*prior.ProjectIDs, *req.ProjectIDs)) || (prior.OwnerSessionID == nil) != (req.OwnerSessionID == nil) || (prior.OwnerSessionID != nil && *prior.OwnerSessionID != *req.OwnerSessionID) || (prior.ReviewerSessionID == nil) != (req.ReviewerSessionID == nil) || (prior.ReviewerSessionID != nil && *prior.ReviewerSessionID != *req.ReviewerSessionID) || (prior.BlockedReason == nil) != (req.BlockedReason == nil) || (prior.BlockedReason != nil && *prior.BlockedReason != *req.BlockedReason) || (prior.ExpectedRevision == nil) != (req.ExpectedRevision == nil) || (prior.ExpectedRevision != nil && *prior.ExpectedRevision != *req.ExpectedRevision) {
				h.mu.Unlock()
				http.Error(w, "clientRef already used for different update", 409)
				return
			}
			copy := *item
			copy.CreatedBy = h.workCreatorLocked(item)
			copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
			h.mu.Unlock()
			writeSDKJSON(w, 200, copy)
			return
		}
	}
	if req.ExpectedRevision != nil && *req.ExpectedRevision != item.Revision {
		h.mu.Unlock()
		http.Error(w, "work item changed; refresh before assigning", 409)
		return
	}
	if actor.Kind == "chat" && (req.OwnerSessionID != nil || req.ReviewerSessionID != nil) && actor.SessionID != item.OwnerSessionID && actor.SessionID != h.workCreatorLocked(item).SessionID && !(item.OwnerSessionID == "" && req.OwnerSessionID != nil && *req.OwnerSessionID == actor.SessionID && req.ReviewerSessionID == nil) {
		h.mu.Unlock()
		http.Error(w, "only the creator or owner can assign this work; an unassigned item may be claimed", 403)
		return
	}
	copy := *item
	copy.CreatedBy = h.workCreatorLocked(item)
	copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: req.ClientRef, At: time.Now().UTC(), Actor: actor, SessionID: req.SessionID,
		Text: req.Text, Status: req.Status, Progress: req.Progress, Outcome: req.Outcome, Evidence: req.Evidence, LinkedSessionID: req.LinkedSessionID, ProjectIDs: req.ProjectIDs, OwnerSessionID: req.OwnerSessionID, ReviewerSessionID: req.ReviewerSessionID, BlockedReason: req.BlockedReason, ExpectedRevision: req.ExpectedRevision})
	previousOwner := copy.OwnerSessionID
	if req.OwnerSessionID != nil {
		copy.OwnerSessionID = *req.OwnerSessionID
		if previousOwner != "" && previousOwner != copy.OwnerSessionID && !slices.Contains(copy.SessionIDs, previousOwner) && previousOwner != copy.CreatedBy.SessionID {
			copy.SessionIDs = append(slices.Clone(copy.SessionIDs), previousOwner)
		}
	}
	if req.ReviewerSessionID != nil {
		copy.ReviewerSessionID = *req.ReviewerSessionID
	}
	if req.ProjectIDs != nil {
		copy.ProjectIDs = slices.Clone(*req.ProjectIDs)
	}
	if req.LinkedSessionID != "" && !slices.Contains(copy.SessionIDs, req.LinkedSessionID) && req.LinkedSessionID != copy.OwnerSessionID {
		copy.SessionIDs = append(slices.Clone(copy.SessionIDs), req.LinkedSessionID)
		sort.Strings(copy.SessionIDs)
	}
	if req.Status != "" {
		copy.Status = req.Status
		if req.Status != "blocked" && req.BlockedReason == nil {
			copy.BlockedReason = ""
		}
	}
	if req.BlockedReason != nil {
		copy.BlockedReason = strings.TrimSpace(*req.BlockedReason)
	}
	if copy.Status == "blocked" && copy.BlockedReason == "" {
		if req.Text != "" {
			copy.BlockedReason = strings.TrimSpace(req.Text)
		}
		if copy.BlockedReason == "" {
			h.mu.Unlock()
			http.Error(w, "blocked work requires a reason", 400)
			return
		}
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
	if message == "" && req.BlockedReason != nil {
		message = strings.TrimSpace(*req.BlockedReason)
	}
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
	if copy.OwnerSessionID != "" {
		h.appendEvent(sdkEvent{SessionID: copy.OwnerSessionID, Type: "work.updated", WorkID: copy.ID, Source: req.SessionID, Text: message})
	}
	if req.SessionID != "" && req.SessionID != copy.OwnerSessionID {
		h.appendEvent(sdkEvent{SessionID: req.SessionID, Type: "work.updated", WorkID: copy.ID, Source: req.SessionID, Text: message})
	}
	writeSDKJSON(w, 200, copy)
}
