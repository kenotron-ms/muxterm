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
	"unicode"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// Work items coordinate sessions. An approved goal condition is installed as
// the selected worker chat's native goal when the scheduler dispatches Work.
type sdkWorkItem struct {
	ID                string           `json:"id"`
	ClientRef         string           `json:"clientRef"`
	Title             string           `json:"title"`
	Brief             string           `json:"brief"`
	CreateTitle       *string          `json:"createTitle,omitempty"`
	CreateBrief       *string          `json:"createBrief,omitempty"`
	Source            string           `json:"source,omitempty"`
	Readiness         string           `json:"readiness"`
	HeldByHuman       bool             `json:"heldByHuman,omitempty"`
	NextAction        string           `json:"nextAction,omitempty"`
	CreateNextAction  string           `json:"createNextAction,omitempty"`
	Status            string           `json:"status"`
	CreatedBy         sdkWorkActor     `json:"createdBy"`
	OwnerSessionID    string           `json:"ownerSessionId"`
	CreateOwnerID     string           `json:"createOwnerSessionId,omitempty"`
	Acceptance        string           `json:"acceptanceCriteria,omitempty"`
	GoalCondition     string           `json:"goalCondition,omitempty"`
	GoalRevision      int              `json:"goalRevision,omitempty"`
	GoalApproved      int              `json:"goalApprovedRevision,omitempty"`
	GoalApprovedAt    *time.Time       `json:"goalApprovedAt,omitempty"`
	CreateAcceptance  *string          `json:"createAcceptanceCriteria,omitempty"`
	ReviewerSessionID string           `json:"reviewerSessionId,omitempty"`
	CreateReviewerID  string           `json:"createReviewerSessionId,omitempty"`
	BlockedReason     string           `json:"blockedReason,omitempty"`
	NeedsHuman        bool             `json:"needsHuman,omitempty"`
	ProjectIDs        []string         `json:"projectIds"`
	CreateProjectIDs  []string         `json:"createProjectIds"`
	Labels            []string         `json:"labels"`
	CreateLabels      []string         `json:"createLabels,omitempty"`
	SessionIDs        []string         `json:"sessionIds"`
	CreateSessionIDs  []string         `json:"createSessionIds"`
	DependsOn         []string         `json:"dependsOn"`
	CreateDependsOn   []string         `json:"createDependsOn,omitempty"`
	WaitingOn         []string         `json:"waitingOn"`
	Dispatch          *sdkWorkDispatch `json:"dispatch,omitempty"`
	Progress          string           `json:"progress,omitempty"`
	Outcome           string           `json:"outcome,omitempty"`
	Revision          int              `json:"revision"`
	CreatedAt         time.Time        `json:"createdAt"`
	UpdatedAt         time.Time        `json:"updatedAt"`
	Updates           []sdkWorkUpdate  `json:"updates"`
}

type sdkWorkUpdate struct {
	ID                string       `json:"id"`
	ClientRef         string       `json:"clientRef"`
	At                time.Time    `json:"at"`
	Actor             sdkWorkActor `json:"actor"`
	SessionID         string       `json:"sessionId,omitempty"`
	Text              string       `json:"text"`
	Title             *string      `json:"title,omitempty"`
	Brief             *string      `json:"brief,omitempty"`
	Acceptance        *string      `json:"acceptanceCriteria,omitempty"`
	GoalCondition     *string      `json:"goalCondition,omitempty"`
	GoalRevision      int          `json:"goalRevision,omitempty"`
	GoalApproved      bool         `json:"goalApproved,omitempty"`
	Readiness         *string      `json:"readiness,omitempty"`
	Status            string       `json:"status,omitempty"`
	Progress          string       `json:"progress,omitempty"`
	NextAction        *string      `json:"nextAction,omitempty"`
	Outcome           string       `json:"outcome,omitempty"`
	Evidence          []string     `json:"evidence,omitempty"`
	LinkedSessionID   string       `json:"linkedSessionId,omitempty"`
	ProjectIDs        *[]string    `json:"projectIds,omitempty"`
	Labels            *[]string    `json:"labels,omitempty"`
	OwnerSessionID    *string      `json:"ownerSessionId,omitempty"`
	ReviewerSessionID *string      `json:"reviewerSessionId,omitempty"`
	BlockedReason     *string      `json:"blockedReason,omitempty"`
	NeedsHuman        *bool        `json:"needsHuman,omitempty"`
	DependsOn         *[]string    `json:"dependsOn,omitempty"`
	ExpectedRevision  *int         `json:"expectedRevision,omitempty"`
}

type sdkWorkDispatch struct {
	ClientRef string    `json:"clientRef"`
	SessionID string    `json:"sessionId"`
	State     string    `json:"state"`
	Detail    string    `json:"detail,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
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
	// Same-user external tools are trusted to administer Work across chats.
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

func normalizeWorkLabels(labels []string) ([]string, error) {
	if len(labels) > 32 {
		return nil, errors.New("too many work labels")
	}
	result := make([]string, 0, len(labels))
	for _, value := range labels {
		label := strings.ToLower(strings.TrimSpace(value))
		if label == "" || len(label) > 64 {
			return nil, errors.New("work labels must be 1-64 characters")
		}
		for _, character := range label {
			if unicode.IsControl(character) {
				return nil, errors.New("work labels cannot contain control characters")
			}
		}
		result = append(result, label)
	}
	sort.Strings(result)
	return slices.Compact(result), nil
}

func workMatchesProjects(itemProjects, filter []string) bool {
	if len(filter) == 0 {
		return true
	}
	for _, id := range filter {
		if slices.Contains(itemProjects, id) {
			return true
		}
	}
	return false
}

func workMatchesLabels(itemLabels, filter []string) bool {
	for _, label := range filter {
		if !slices.Contains(itemLabels, label) {
			return false
		}
	}
	return true
}

func normalizeWorkDependencies(ids []string) []string {
	ids = slices.Clone(ids)
	sort.Strings(ids)
	return slices.Compact(ids)
}

// Caller holds h.mu. Recompute WaitingOn for every response so another item's
// completion is reflected without mutating this record's revision.
func (h *sdkChatHost) workWaitingOnLocked(item *sdkWorkItem) []string {
	waiting := []string{}
	for _, id := range item.DependsOn {
		dependency := h.workItems[id]
		if dependency == nil || dependency.Status != "done" {
			waiting = append(waiting, id)
		}
	}
	return waiting
}

func (h *sdkChatHost) workDependenciesValidLocked(itemID string, ids []string) bool {
	visited := map[string]bool{}
	var reachesItem func(string) bool
	reachesItem = func(id string) bool {
		if id == itemID {
			return true
		}
		if visited[id] {
			return false
		}
		visited[id] = true
		item := h.workItems[id]
		if item == nil {
			return false
		}
		for _, next := range item.DependsOn {
			if reachesItem(next) {
				return true
			}
		}
		return false
	}
	for _, id := range ids {
		if h.workItems[id] == nil || reachesItem(id) {
			return false
		}
	}
	return true
}

func validWorkStatus(status string) bool {
	return slices.Contains([]string{"open", "active", "blocked", "review", "done", "cancelled"}, status)
}

func validWorkReadiness(value string) bool {
	return slices.Contains([]string{"draft", "ready", "held"}, value)
}

func (h *sdkChatHost) workPath(id string) string {
	return filepath.Join(h.dir, "work", id+".json")
}

func (h *sdkChatHost) loadWorkItems() {
	// Startup is single-threaded; h.mu is not yet shared with request handlers.
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
		if item.Readiness == "" {
			// Older records had no readiness field. Keep claimed work in motion,
			// but require an explicit ready instruction before dispatching the
			// unclaimed pile after an upgrade.
			if item.Status == "active" || item.OwnerSessionID != "" || item.Dispatch != nil {
				item.Readiness = "ready"
			} else {
				item.Readiness = "draft"
			}
			if err := h.saveWorkLocked(&item); err != nil {
				log.Printf("migrate work readiness %s: %v", item.ID, err)
			}
		}
		if item.Dispatch != nil && item.Dispatch.State == "preparing" {
			item.Dispatch.State = "uncertain"
			item.Dispatch.Detail = "server restarted before dispatch acknowledgement; inspect the selected chat before retrying"
			item.Dispatch.UpdatedAt = time.Now().UTC()
			if err := h.saveWorkLocked(&item); err != nil {
				log.Printf("mark work dispatch uncertain %s: %v", item.ID, err)
			}
		}
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
	if h.onWorkChange != nil {
		h.onWorkChange()
	}
	return nil
}

func workQueryFilters(r *http.Request) ([]string, []string, error) {
	projects := r.URL.Query()["project_id"]
	if len(projects) > 32 {
		return nil, nil, errors.New("too many project filters")
	}
	for _, id := range projects {
		if strings.TrimSpace(id) == "" {
			return nil, nil, errors.New("empty project filter")
		}
	}
	projects = normalizeWorkProjectIDs(projects)
	labels, err := normalizeWorkLabels(r.URL.Query()["label"])
	return projects, labels, err
}

// handleSDKNextWork returns the oldest unassigned, open item whose direct
// prerequisites are all done. The read does not reserve work: callers claim
// with update_work_item and expectedRevision, so competing workers cannot
// silently take the same item.
func (s *Server) handleSDKNextWork(w http.ResponseWriter, r *http.Request) {
	projectIDs, labels, err := workQueryFilters(r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	h := s.sdkChats
	h.mu.Lock()
	for _, id := range projectIDs {
		if h.projects[id] == nil {
			h.mu.Unlock()
			http.Error(w, "unknown project folder: "+id, http.StatusUnprocessableEntity)
			return
		}
	}
	var next *sdkWorkItem
	for _, item := range h.workItems {
		if !h.workEligibleLocked(item, false) {
			continue
		}
		if !workMatchesProjects(h.workProjectIDsLocked(item), projectIDs) || !workMatchesLabels(item.Labels, labels) {
			continue
		}
		if next == nil || item.CreatedAt.Before(next.CreatedAt) || (item.CreatedAt.Equal(next.CreatedAt) && item.ID < next.ID) {
			next = item
		}
	}
	if next == nil {
		h.mu.Unlock()
		writeSDKJSON(w, 200, map[string]any{"work": nil})
		return
	}
	copy := *next
	copy.CreatedBy = h.workCreatorLocked(next)
	copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(next))
	copy.WaitingOn = h.workWaitingOnLocked(next)
	copy.Updates = nil
	h.mu.Unlock()
	writeSDKJSON(w, 200, map[string]any{"work": copy})
}

func (s *Server) handleSDKWork(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	if r.Method == http.MethodGet {
		projectIDs, labels, err := workQueryFilters(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		owner := r.URL.Query().Get("session_id")
		status := r.URL.Query().Get("status")
		if status != "" && !validWorkStatus(status) {
			http.Error(w, "invalid work status", 400)
			return
		}
		h.mu.Lock()
		for _, id := range projectIDs {
			if h.projects[id] == nil {
				h.mu.Unlock()
				http.Error(w, "unknown project folder: "+id, http.StatusUnprocessableEntity)
				return
			}
		}
		rows := make([]sdkWorkItem, 0, len(h.workItems))
		for _, item := range h.workItems {
			itemProjects := h.workProjectIDsLocked(item)
			if !workMatchesProjects(itemProjects, projectIDs) || !workMatchesLabels(item.Labels, labels) {
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
			copy.ProjectIDs = slices.Clone(itemProjects)
			copy.WaitingOn = h.workWaitingOnLocked(item)
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
		Source            string    `json:"source"`
		NextAction        string    `json:"nextAction"`
		OwnerSessionID    string    `json:"ownerSessionId"`
		Acceptance        string    `json:"acceptanceCriteria"`
		ReviewerSessionID string    `json:"reviewerSessionId"`
		SessionIDs        []string  `json:"sessionIds"`
		ProjectIDs        *[]string `json:"projectIds"`
		Labels            []string  `json:"labels"`
		DependsOn         []string  `json:"dependsOn"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || strings.TrimSpace(req.Title) == "" || len(req.Title) > 200 || len(req.Brief) > 32<<10 || len(req.Source) > 4096 || len(req.NextAction) > 4096 || len(req.Acceptance) > 16<<10 || len(req.SessionIDs) > 32 || len(req.DependsOn) > 32 || (req.ProjectIDs != nil && len(*req.ProjectIDs) > 32) {
		http.Error(w, "clientRef and title required", 400)
		return
	}
	labels, err := normalizeWorkLabels(req.Labels)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	sort.Strings(req.SessionIDs)
	req.SessionIDs = slices.Compact(req.SessionIDs)
	req.DependsOn = normalizeWorkDependencies(req.DependsOn)
	h.mu.Lock()
	if !h.workDependenciesValidLocked("", req.DependsOn) {
		h.mu.Unlock()
		http.Error(w, "unknown or cyclic work dependency", 422)
		return
	}
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
	} else if creator.Kind == "chat" {
		if chat := h.chats[creator.SessionID]; chat != nil && chat.WorkspaceID != "" {
			projectIDs = []string{chat.WorkspaceID}
		}
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
			createNextAction := item.CreateNextAction
			if item.CreatedBy.Kind == "" {
				createNextAction = item.NextAction
			}
			createdDependencies := item.CreateDependsOn
			createTitle, createBrief, createAcceptance := item.Title, item.Brief, item.Acceptance
			if item.CreateTitle != nil {
				createTitle = *item.CreateTitle
			}
			if item.CreateBrief != nil {
				createBrief = *item.CreateBrief
			}
			if item.CreateAcceptance != nil {
				createAcceptance = *item.CreateAcceptance
			}
			if createTitle != req.Title || createBrief != req.Brief || item.Source != strings.TrimSpace(req.Source) || createNextAction != strings.TrimSpace(req.NextAction) || createAcceptance != req.Acceptance || createReviewer != req.ReviewerSessionID || createOwner != req.OwnerSessionID || !slices.Equal(createdWith, req.SessionIDs) || !slices.Equal(createdProjects, projectIDs) || !slices.Equal(createdDependencies, req.DependsOn) || !slices.Equal(item.CreateLabels, labels) {
				h.mu.Unlock()
				http.Error(w, "clientRef already used for different work", 409)
				return
			}
			copy := *item
			copy.CreatedBy = h.workCreatorLocked(item)
			copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
			copy.WaitingOn = h.workWaitingOnLocked(item)
			h.mu.Unlock()
			writeSDKJSON(w, 200, copy)
			return
		}
	}
	now := time.Now().UTC()
	item := &sdkWorkItem{ID: sdkID(), ClientRef: req.ClientRef, Title: req.Title, Brief: req.Brief, CreateTitle: &req.Title, CreateBrief: &req.Brief, Source: strings.TrimSpace(req.Source), Readiness: "draft", NextAction: strings.TrimSpace(req.NextAction), CreateNextAction: strings.TrimSpace(req.NextAction),
		Status: "open", CreatedBy: creator, OwnerSessionID: req.OwnerSessionID, CreateOwnerID: req.OwnerSessionID, Acceptance: req.Acceptance, CreateAcceptance: &req.Acceptance, ReviewerSessionID: req.ReviewerSessionID, CreateReviewerID: req.ReviewerSessionID, ProjectIDs: projectIDs, CreateProjectIDs: slices.Clone(projectIDs), Labels: labels, CreateLabels: append([]string{}, labels...), SessionIDs: req.SessionIDs,
		CreateSessionIDs: append([]string{}, req.SessionIDs...), DependsOn: req.DependsOn, CreateDependsOn: append([]string{}, req.DependsOn...), WaitingOn: h.workWaitingOnLocked(&sdkWorkItem{DependsOn: req.DependsOn}),
		Revision: 1, CreatedAt: now, UpdatedAt: now, Updates: []sdkWorkUpdate{}}
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
		copy.WaitingOn = h.workWaitingOnLocked(item)
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
		Title             *string   `json:"title"`
		Brief             *string   `json:"brief"`
		Acceptance        *string   `json:"acceptanceCriteria"`
		GoalCondition     *string   `json:"goalCondition"`
		Readiness         *string   `json:"readiness"`
		Status            string    `json:"status"`
		Progress          string    `json:"progress"`
		NextAction        *string   `json:"nextAction"`
		Outcome           string    `json:"outcome"`
		Evidence          []string  `json:"evidence"`
		LinkedSessionID   string    `json:"linkedSessionId"`
		ProjectIDs        *[]string `json:"projectIds"`
		Labels            *[]string `json:"labels"`
		OwnerSessionID    *string   `json:"ownerSessionId"`
		ReviewerSessionID *string   `json:"reviewerSessionId"`
		BlockedReason     *string   `json:"blockedReason"`
		NeedsHuman        *bool     `json:"needsHuman"`
		DependsOn         *[]string `json:"dependsOn"`
		ExpectedRevision  *int      `json:"expectedRevision"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || len(req.ClientRef) > 256 || len(req.Text) > 16<<10 || (req.Title != nil && (strings.TrimSpace(*req.Title) == "" || len(*req.Title) > 200)) || (req.Brief != nil && len(*req.Brief) > 32<<10) || (req.Acceptance != nil && len(*req.Acceptance) > 16<<10) || (req.GoalCondition != nil && (strings.TrimSpace(*req.GoalCondition) == "" || len([]rune(*req.GoalCondition)) > 4000)) || len(req.Progress) > 4096 || (req.Readiness != nil && !validWorkReadiness(*req.Readiness)) || (req.NextAction != nil && len(*req.NextAction) > 4096) || len(req.Outcome) > 16<<10 || len(req.Evidence) > 20 || (req.ProjectIDs != nil && len(*req.ProjectIDs) > 32) || (req.DependsOn != nil && len(*req.DependsOn) > 32) || (req.Status != "" && !validWorkStatus(req.Status)) || (req.OwnerSessionID != nil && len(*req.OwnerSessionID) > 256) || (req.ReviewerSessionID != nil && len(*req.ReviewerSessionID) > 256) || (req.BlockedReason != nil && len(*req.BlockedReason) > 4096) || (req.Text == "" && req.Title == nil && req.Brief == nil && req.Acceptance == nil && req.GoalCondition == nil && req.Readiness == nil && req.Status == "" && req.Progress == "" && req.NextAction == nil && req.Outcome == "" && req.LinkedSessionID == "" && req.ProjectIDs == nil && req.Labels == nil && req.OwnerSessionID == nil && req.ReviewerSessionID == nil && req.BlockedReason == nil && req.NeedsHuman == nil && req.DependsOn == nil) {
		http.Error(w, "clientRef and a valid work update required", 400)
		return
	}
	if (req.Title != nil || req.Brief != nil || req.Acceptance != nil || req.GoalCondition != nil || req.Readiness != nil || req.OwnerSessionID != nil || req.ReviewerSessionID != nil || req.DependsOn != nil || req.Labels != nil) && req.ExpectedRevision == nil {
		http.Error(w, "expectedRevision required to change assignment or dependencies", 400)
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
	if req.Labels != nil {
		labels, err := normalizeWorkLabels(*req.Labels)
		if err != nil {
			h.mu.Unlock()
			http.Error(w, err.Error(), 400)
			return
		}
		req.Labels = &labels
	}
	if req.DependsOn != nil {
		ids := normalizeWorkDependencies(*req.DependsOn)
		if !h.workDependenciesValidLocked(item.ID, ids) {
			h.mu.Unlock()
			http.Error(w, "unknown or cyclic work dependency", 422)
			return
		}
		req.DependsOn = &ids
	}
	for _, prior := range item.Updates {
		if prior.ClientRef == req.ClientRef {
			if (prior.Actor.Kind != "" && prior.Actor != actor) || prior.SessionID != req.SessionID || prior.Text != req.Text || (prior.Title == nil) != (req.Title == nil) || (prior.Title != nil && *prior.Title != *req.Title) || (prior.Brief == nil) != (req.Brief == nil) || (prior.Brief != nil && *prior.Brief != *req.Brief) || (prior.Acceptance == nil) != (req.Acceptance == nil) || (prior.Acceptance != nil && *prior.Acceptance != *req.Acceptance) || (prior.GoalCondition == nil) != (req.GoalCondition == nil) || (prior.GoalCondition != nil && *prior.GoalCondition != *req.GoalCondition) || (prior.Readiness == nil) != (req.Readiness == nil) || (prior.Readiness != nil && *prior.Readiness != *req.Readiness) || prior.Status != req.Status || prior.Progress != req.Progress || (prior.NextAction == nil) != (req.NextAction == nil) || (prior.NextAction != nil && *prior.NextAction != *req.NextAction) || prior.Outcome != req.Outcome || prior.LinkedSessionID != req.LinkedSessionID || !slices.Equal(prior.Evidence, req.Evidence) || (prior.ProjectIDs == nil) != (req.ProjectIDs == nil) || (prior.ProjectIDs != nil && !slices.Equal(*prior.ProjectIDs, *req.ProjectIDs)) || (prior.Labels == nil) != (req.Labels == nil) || (prior.Labels != nil && !slices.Equal(*prior.Labels, *req.Labels)) || (prior.DependsOn == nil) != (req.DependsOn == nil) || (prior.DependsOn != nil && !slices.Equal(*prior.DependsOn, *req.DependsOn)) || (prior.OwnerSessionID == nil) != (req.OwnerSessionID == nil) || (prior.OwnerSessionID != nil && *prior.OwnerSessionID != *req.OwnerSessionID) || (prior.ReviewerSessionID == nil) != (req.ReviewerSessionID == nil) || (prior.ReviewerSessionID != nil && *prior.ReviewerSessionID != *req.ReviewerSessionID) || (prior.BlockedReason == nil) != (req.BlockedReason == nil) || (prior.BlockedReason != nil && *prior.BlockedReason != *req.BlockedReason) || (prior.NeedsHuman == nil) != (req.NeedsHuman == nil) || (prior.NeedsHuman != nil && *prior.NeedsHuman != *req.NeedsHuman) || (prior.ExpectedRevision == nil) != (req.ExpectedRevision == nil) || (prior.ExpectedRevision != nil && *prior.ExpectedRevision != *req.ExpectedRevision) {
				h.mu.Unlock()
				http.Error(w, "clientRef already used for different update", 409)
				return
			}
			copy := *item
			copy.CreatedBy = h.workCreatorLocked(item)
			copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
			copy.WaitingOn = h.workWaitingOnLocked(item)
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
	if req.Readiness != nil {
		if *req.Readiness == "ready" && (item.GoalCondition == "" || item.GoalRevision < 1 || item.GoalApproved != item.GoalRevision || item.GoalApprovedAt == nil || req.GoalCondition != nil || req.Title != nil || req.Brief != nil || req.Acceptance != nil || req.NextAction != nil || req.DependsOn != nil || req.ProjectIDs != nil) {
			h.mu.Unlock()
			http.Error(w, "approve the current Work goal condition before marking ready", 409)
			return
		}
		if item.HeldByHuman && *req.Readiness != "held" && actor.Kind != "human" {
			h.mu.Unlock()
			http.Error(w, "only a human can release this hold", 403)
			return
		}
		if (*req.Readiness == "ready" || *req.Readiness == "draft") && item.Status != "open" {
			h.mu.Unlock()
			http.Error(w, "only open work can change readiness", 409)
			return
		}
	}
	if req.OwnerSessionID != nil && item.Dispatch != nil && item.Dispatch.State != "failed" && item.OwnerSessionID == "" && *req.OwnerSessionID != item.Dispatch.SessionID {
		h.mu.Unlock()
		http.Error(w, "work is reserved for another session", 409)
		return
	}
	if req.OwnerSessionID != nil && item.OwnerSessionID == "" && *req.OwnerSessionID != "" {
		reserved := item.Dispatch != nil && item.Dispatch.SessionID == *req.OwnerSessionID && item.Dispatch.State != "failed"
		projects := h.workProjectIDsLocked(item)
		owner := h.chats[*req.OwnerSessionID]
		if !reserved && (!h.workEligibleLocked(item, false) || len(projects) != 1 || owner == nil || owner.WorkspaceID != projects[0] || owner.Archived || owner.VoiceHandoff || owner.SideParentID != "" || *req.OwnerSessionID == h.workCreatorLocked(item).SessionID) {
			h.mu.Unlock()
			http.Error(w, "work is not ready for a direct claim", 409)
			return
		}
		if !reserved {
			goal, err := h.goals.update(*owner, nil)
			if err != nil || goal.HumanPaused || goal.RequestedRevision == 0 || goal.AppliedRevision != goal.RequestedRevision || goal.ExecutionAuthorizedRevision != goal.RequestedRevision || len(goal.Revisions) == 0 || goal.Revisions[len(goal.Revisions)-1].Condition != item.GoalCondition {
				h.mu.Unlock()
				http.Error(w, "direct claim requires the exact approved condition as this chat's active native goal; use Work start for a handoff", 409)
				return
			}
		}
	}
	if req.GoalCondition != nil && (item.Dispatch != nil || item.OwnerSessionID != "" || item.Status != "open") {
		h.mu.Unlock()
		http.Error(w, "goal condition cannot change after work is dispatched", 409)
		return
	}
	if actor.Kind == "chat" && (req.Title != nil || req.Brief != nil || req.Acceptance != nil || req.GoalCondition != nil || req.Readiness != nil || req.OwnerSessionID != nil || req.ReviewerSessionID != nil || req.DependsOn != nil || req.Labels != nil) && actor.SessionID != item.OwnerSessionID && actor.SessionID != h.workCreatorLocked(item).SessionID && !(req.Title == nil && req.Brief == nil && req.Acceptance == nil && req.GoalCondition == nil && req.Readiness == nil && item.OwnerSessionID == "" && req.OwnerSessionID != nil && *req.OwnerSessionID == actor.SessionID && req.ReviewerSessionID == nil && req.DependsOn == nil && req.Labels == nil) {
		h.mu.Unlock()
		http.Error(w, "only the creator or owner can assign this work; an unassigned item may be claimed", 403)
		return
	}
	copy := *item
	copy.CreatedBy = h.workCreatorLocked(item)
	copy.ProjectIDs = slices.Clone(h.workProjectIDsLocked(item))
	if copy.CreateTitle == nil {
		original := item.Title
		copy.CreateTitle = &original
	}
	if copy.CreateBrief == nil {
		original := item.Brief
		copy.CreateBrief = &original
	}
	if copy.CreateAcceptance == nil {
		original := item.Acceptance
		copy.CreateAcceptance = &original
	}
	goalRevision := 0
	if req.GoalCondition != nil {
		goalRevision = item.GoalRevision + 1
	}
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: req.ClientRef, At: time.Now().UTC(), Actor: actor, SessionID: req.SessionID,
		Text: req.Text, Title: req.Title, Brief: req.Brief, Acceptance: req.Acceptance, GoalCondition: req.GoalCondition, GoalRevision: goalRevision, Readiness: req.Readiness, Status: req.Status, Progress: req.Progress, NextAction: req.NextAction, Outcome: req.Outcome, Evidence: req.Evidence, LinkedSessionID: req.LinkedSessionID, ProjectIDs: req.ProjectIDs, Labels: req.Labels, DependsOn: req.DependsOn, OwnerSessionID: req.OwnerSessionID, ReviewerSessionID: req.ReviewerSessionID, BlockedReason: req.BlockedReason, NeedsHuman: req.NeedsHuman, ExpectedRevision: req.ExpectedRevision})
	if req.Title != nil {
		copy.Title = strings.TrimSpace(*req.Title)
	}
	if req.Brief != nil {
		copy.Brief = *req.Brief
	}
	if req.Acceptance != nil {
		copy.Acceptance = *req.Acceptance
	}
	if req.GoalCondition != nil {
		copy.GoalCondition = strings.TrimSpace(*req.GoalCondition)
		copy.GoalRevision++
	}
	if (req.GoalCondition != nil || req.Title != nil || req.Brief != nil || req.Acceptance != nil || req.NextAction != nil || req.DependsOn != nil || req.ProjectIDs != nil) && copy.Dispatch == nil && copy.OwnerSessionID == "" {
		copy.GoalApproved = 0
		copy.GoalApprovedAt = nil
		if copy.Readiness == "ready" && copy.Dispatch == nil && copy.OwnerSessionID == "" {
			copy.Readiness = "draft"
		}
	}
	previousOwner := copy.OwnerSessionID
	if req.OwnerSessionID != nil {
		copy.OwnerSessionID = *req.OwnerSessionID
		if copy.Dispatch != nil && copy.OwnerSessionID == copy.Dispatch.SessionID {
			dispatch := *copy.Dispatch
			dispatch.State = "claimed"
			dispatch.Detail = ""
			dispatch.UpdatedAt = time.Now().UTC()
			copy.Dispatch = &dispatch
		}
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
	if req.Labels != nil {
		copy.Labels = slices.Clone(*req.Labels)
	}
	if req.DependsOn != nil {
		copy.DependsOn = slices.Clone(*req.DependsOn)
	}
	if req.Readiness != nil {
		copy.Readiness = *req.Readiness
		copy.HeldByHuman = *req.Readiness == "held" && (actor.Kind == "human" || item.HeldByHuman)
	}
	copy.WaitingOn = h.workWaitingOnLocked(&copy)
	status := copy.Status
	if req.Status != "" {
		status = req.Status
	}
	if len(copy.WaitingOn) > 0 && (status == "active" || status == "review" || status == "done") {
		h.mu.Unlock()
		http.Error(w, "work dependencies must be done before work can start or complete", 409)
		return
	}
	if item.Status == "done" && req.Status != "" && req.Status != "done" {
		for _, dependent := range h.workItems {
			if slices.Contains(dependent.DependsOn, item.ID) && (dependent.Status == "active" || dependent.Status == "review" || dependent.Status == "done") {
				h.mu.Unlock()
				http.Error(w, "completed prerequisite is required by work already in progress", 409)
				return
			}
		}
	}
	if req.LinkedSessionID != "" && !slices.Contains(copy.SessionIDs, req.LinkedSessionID) && req.LinkedSessionID != copy.OwnerSessionID {
		copy.SessionIDs = append(slices.Clone(copy.SessionIDs), req.LinkedSessionID)
		sort.Strings(copy.SessionIDs)
	}
	if req.Status != "" {
		if req.Status == "active" && copy.Status == "open" && copy.Readiness != "ready" {
			h.mu.Unlock()
			http.Error(w, "work must be ready before starting", 409)
			return
		}
		copy.Status = req.Status
		if (req.Status == "done" || req.Status == "cancelled") && req.NextAction == nil {
			copy.NextAction = ""
		}
		if req.Status != "blocked" && req.BlockedReason == nil {
			copy.BlockedReason = ""
		}
	}
	if req.BlockedReason != nil {
		copy.BlockedReason = strings.TrimSpace(*req.BlockedReason)
	}
	if req.NeedsHuman != nil {
		copy.NeedsHuman = *req.NeedsHuman
	} else if req.Status != "" && req.Status != "blocked" {
		copy.NeedsHuman = false
	}
	if req.NextAction != nil {
		copy.NextAction = strings.TrimSpace(*req.NextAction)
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
	if message == "" && (req.Title != nil || req.Brief != nil || req.Acceptance != nil) {
		message = "Work details revised"
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
	if req.GoalCondition != nil && copy.CreatedBy.SessionID != "" {
		h.appendEvent(sdkEvent{SessionID: copy.CreatedBy.SessionID, Type: "work.goal.proposed", WorkID: copy.ID, Source: req.SessionID, Text: "Goal condition ready for review: " + copy.Title})
	}
	if req.SessionID != "" && req.SessionID != copy.OwnerSessionID {
		h.appendEvent(sdkEvent{SessionID: req.SessionID, Type: "work.updated", WorkID: copy.ID, Source: req.SessionID, Text: message})
	}
	creatorID := copy.CreatedBy.SessionID
	if creatorID != "" && creatorID != copy.OwnerSessionID {
		notice := ""
		switch {
		case item.OwnerSessionID == "" && copy.OwnerSessionID != "":
			notice = "Work claimed: " + copy.Title
		case copy.Status == "blocked" && copy.NeedsHuman && (item.Status != "blocked" || !item.NeedsHuman):
			notice = "Decision needed for Work: " + copy.Title
		case copy.Status == "blocked" && item.Status != "blocked":
			notice = "Work blocked: " + copy.Title
		case copy.Status == "review" && item.Status != "review":
			notice = "Work ready for review: " + copy.Title
		case copy.Status == "done" && item.Status != "done":
			notice = "Work completed: " + copy.Title
		case copy.Status == "cancelled" && item.Status != "cancelled":
			notice = "Work stopped: " + copy.Title
		}
		if notice != "" {
			h.appendEvent(sdkEvent{SessionID: creatorID, Type: "work.attention", WorkID: copy.ID, Text: notice + ". Open the Work tab for details."})
		}
	}
	writeSDKJSON(w, 200, copy)
}
