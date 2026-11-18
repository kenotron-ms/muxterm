package server

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"time"
)

const defaultWorkParallelism = 4

func (s *Server) wakeWork() {
	select {
	case s.workWake <- struct{}{}:
	default:
	}
}

func (h *sdkChatHost) workActiveCountLocked(projectID, exceptID string) int {
	count := 0
	for _, item := range h.workItems {
		if item.ID == exceptID || item.Status == "done" || item.Status == "cancelled" || item.Status == "blocked" || item.Status == "review" || (item.Status != "active" && item.Readiness != "ready") {
			continue
		}
		projects := h.workProjectIDsLocked(item)
		if len(projects) != 1 || projects[0] != projectID {
			continue
		}
		if item.Status == "active" || item.OwnerSessionID != "" || (item.Dispatch != nil && item.Dispatch.State != "failed") {
			count++
		}
	}
	return count
}

// One eligibility rule is used by the scheduler, manual start, next-item
// discovery, and direct claims. A failed dispatch needs explicit inspection
// before the scheduler considers it again.
func (h *sdkChatHost) workEligibleLocked(item *sdkWorkItem, allowFailedDispatch bool) bool {
	if item == nil || item.Status != "open" || item.Readiness != "ready" || item.HeldByHuman || item.OwnerSessionID != "" || len(h.workWaitingOnLocked(item)) != 0 {
		return false
	}
	if item.Dispatch != nil && (!allowFailedDispatch || item.Dispatch.State != "failed") {
		return false
	}
	projects := h.workProjectIDsLocked(item)
	if len(projects) != 1 {
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

func (s *Server) workLoop(ctx context.Context) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	s.reconcileWork(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.workWake:
		case <-ticker.C:
		}
		s.reconcileWork(ctx)
	}
}

func (s *Server) reconcileWork(ctx context.Context) {
	s.reconcileWorkFailures()
	for ctx.Err() == nil {
		h := s.sdkChats
		h.mu.Lock()
		ready := make([]*sdkWorkItem, 0)
		for _, item := range h.workItems {
			if h.workEligibleLocked(item, false) {
				ready = append(ready, item)
			}
		}
		sort.Slice(ready, func(i, j int) bool {
			if ready[i].CreatedAt.Equal(ready[j].CreatedAt) {
				return ready[i].ID < ready[j].ID
			}
			return ready[i].CreatedAt.Before(ready[j].CreatedAt)
		})
		if len(ready) == 0 {
			h.mu.Unlock()
			return
		}
		id := ready[0].ID
		h.mu.Unlock()
		body, _ := json.Marshal(map[string]string{"clientRef": "scheduler:" + id})
		req := httptest.NewRequestWithContext(ctx, http.MethodPost, "/api/sdk-work/"+id+"/start", bytes.NewReader(body))
		req.SetPathValue("id", id)
		response := httptest.NewRecorder()
		s.handleSDKWorkStart(response, req)
		if response.Code != 200 {
			log.Printf("work scheduler: start %s: %d %s", id, response.Code, response.Body.String())
			return
		}
	}
}

// A worker that exits before claiming, or fails after claiming, leaves an
// inspectable record and frees the project slot. It is never retried silently.
func (s *Server) reconcileWorkFailures() {
	h := s.sdkChats
	type notice struct{ sessionID, workID, title string }
	notices := []notice{}
	h.mu.Lock()
	for _, item := range h.workItems {
		if item.Readiness != "ready" || item.Status == "done" || item.Status == "cancelled" || item.Status == "blocked" || item.Status == "review" {
			continue
		}
		workerID := item.OwnerSessionID
		if workerID == "" && item.Dispatch != nil && item.Dispatch.State == "sent" {
			workerID = item.Dispatch.SessionID
		}
		worker := h.chats[workerID]
		if workerID == "" || (worker != nil && worker.State != "failed" && worker.State != "uncertain" && !(item.OwnerSessionID == "" && worker.State == "ready" && item.Dispatch != nil && time.Since(item.Dispatch.UpdatedAt) >= 30*time.Second)) {
			continue
		}
		if worker == nil && (item.Dispatch == nil || time.Since(item.Dispatch.UpdatedAt) < 30*time.Second) {
			continue
		}
		copy := *item
		now := time.Now().UTC()
		if copy.OwnerSessionID == "" && copy.Dispatch != nil {
			dispatch := *copy.Dispatch
			dispatch.State = "uncertain"
			dispatch.Detail = "selected chat did not claim the work; inspect its transcript before retrying"
			dispatch.UpdatedAt = now
			copy.Dispatch = &dispatch
		} else {
			copy.Status = "blocked"
			copy.NeedsHuman = true
			copy.BlockedReason = "Worker chat stopped unexpectedly; inspect its transcript before choosing how to resume."
		}
		copy.Updates = append(slices.Clone(copy.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "worker-state:" + sdkID(), At: now, Actor: sdkWorkActor{Kind: "external-tool"}, Text: "Worker chat stopped before completing work", LinkedSessionID: workerID, Status: copy.Status})
		copy.Revision++
		copy.UpdatedAt = now
		if err := h.saveWorkLocked(&copy); err != nil {
			log.Printf("work scheduler: record worker failure %s: %v", item.ID, err)
			continue
		}
		if creatorID := h.workCreatorLocked(item).SessionID; creatorID != "" && creatorID != workerID {
			notices = append(notices, notice{creatorID, item.ID, item.Title})
		}
	}
	h.mu.Unlock()
	for _, item := range notices {
		h.appendEvent(sdkEvent{SessionID: item.sessionID, Type: "work.attention", WorkID: item.workID, Text: "Work needs inspection: " + item.title + ". Open the Work tab for details."})
	}
}

func (s *Server) handleSDKProjectWorkControl(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	var req struct {
		Paused          *bool `json:"paused"`
		Parallelism     *int  `json:"parallelism"`
		ExpectedVersion int   `json:"expectedVersion"`
	}
	if r.Method == http.MethodPatch {
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req) != nil || (req.Paused == nil && req.Parallelism == nil) || (req.Parallelism != nil && (*req.Parallelism < 1 || *req.Parallelism > 8)) {
			http.Error(w, "paused or parallelism 1-8 required", 400)
			return
		}
	}
	h.mu.Lock()
	project := h.projects[id]
	if project == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	if r.Method == http.MethodPatch {
		version := project.WorkControlVersion
		if version == 0 {
			version = 1
		}
		if req.ExpectedVersion != version {
			h.mu.Unlock()
			http.Error(w, "project work controls changed; refresh", 409)
			return
		}
		previous := *project
		if req.Paused != nil {
			project.WorkPaused = *req.Paused
		}
		if req.Parallelism != nil {
			project.WorkParallelism = *req.Parallelism
		}
		project.WorkControlVersion = version + 1
		if err := h.saveProjectsLocked(); err != nil {
			*project = previous
			h.mu.Unlock()
			http.Error(w, err.Error(), 500)
			return
		}
		s.wakeWork()
	}
	limit := project.WorkParallelism
	if limit < 1 {
		limit = defaultWorkParallelism
	}
	version := project.WorkControlVersion
	if version == 0 {
		version = 1
	}
	result := map[string]any{"projectId": id, "paused": project.WorkPaused, "parallelism": limit, "version": version, "active": h.workActiveCountLocked(id, "")}
	h.mu.Unlock()
	writeSDKJSON(w, 200, result)
}
