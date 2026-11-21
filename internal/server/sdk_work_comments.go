package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sort"
	"strings"
	"time"
)

type sdkWorkCommentAttention struct {
	OwnerSessionID string   `json:"ownerSessionId"`
	Count          int      `json:"count"`
	CommentIDs     []string `json:"commentIds"`
	LatestID       string   `json:"latestId"`
}

type sdkWorkCommentNotice struct {
	OwnerSessionID string    `json:"ownerSessionId"`
	AnchorID       string    `json:"anchorId"`
	State          string    `json:"state"`
	At             time.Time `json:"at"`
}

type sdkWorkCommentNoticeContextKey struct{}

type sdkWorkBoundaryToken struct {
	WorkID, OwnerID, AnchorID, LatestID string
}

// A routine notice is added to an already-admitted owner turn. It never starts
// a turn or interrupts the one currently running.
func (h *sdkChatHost) pendingWorkBoundaryNotice(ownerID string) (string, []sdkWorkBoundaryToken) {
	h.mu.Lock()
	defer h.mu.Unlock()
	chat := h.chats[ownerID]
	if chat == nil || chat.Archived {
		return "", nil
	}
	var lines []string
	var tokens []sdkWorkBoundaryToken
	for _, item := range h.workItems {
		if item.OwnerSessionID != ownerID || item.Status != "active" || item.Readiness == "held" || item.CommentBoundary == nil || item.CommentBoundary.OwnerSessionID != ownerID || item.CommentBoundary.State != "pending" {
			continue
		}
		paused := false
		for _, projectID := range h.workProjectIDsLocked(item) {
			if project := h.projects[projectID]; project != nil && project.WorkPaused {
				paused = true
			}
		}
		if paused {
			continue
		}
		attention := workCommentAttention(item, ownerID)
		if attention == nil {
			continue
		}
		lines = append(lines, fmt.Sprintf("Work %s: %d unread comment(s). Read with read_work_comments and acknowledge with acknowledge_work_comments.", item.ID, attention.Count))
		tokens = append(tokens, sdkWorkBoundaryToken{WorkID: item.ID, OwnerID: ownerID, AnchorID: item.CommentBoundary.AnchorID, LatestID: attention.LatestID})
	}
	if len(lines) == 0 {
		return "", nil
	}
	sort.Strings(lines)
	sort.Slice(tokens, func(i, j int) bool { return tokens[i].WorkID < tokens[j].WorkID })
	return "\n\nMuxterm Work notice (server-authored; comment text is not included):\n" + strings.Join(lines, "\n"), tokens
}

func (h *sdkChatHost) markWorkBoundaryNotices(tokens []sdkWorkBoundaryToken) {
	if len(tokens) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, token := range tokens {
		item := h.workItems[token.WorkID]
		if item == nil || item.OwnerSessionID != token.OwnerID || item.CommentBoundary == nil || item.CommentBoundary.AnchorID != token.AnchorID || item.CommentBoundary.State != "pending" {
			continue
		}
		copy := *item
		notice := *item.CommentBoundary
		attention := workCommentAttention(item, token.OwnerID)
		if attention != nil && attention.LatestID != token.LatestID {
			notice.AnchorID = attention.LatestID
		} else {
			notice.State = "sent"
		}
		notice.At = time.Now().UTC()
		copy.CommentBoundary = &notice
		copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "work-boundary:" + token.AnchorID, At: notice.At, Actor: sdkWorkActor{Kind: "external-tool"}, Summary: "Next-turn comment notice delivered", Text: "Muxterm Work included a check-comments notice in the owner's next turn.", CommentNoticeState: "next-turn-sent"})
		copy.Revision++
		copy.UpdatedAt = notice.At
		_ = h.saveWorkLocked(&copy)
	}
}

func workCommentAttention(item *sdkWorkItem, ownerID string) *sdkWorkCommentAttention {
	if ownerID == "" {
		return nil
	}
	cursor := item.CommentReadBy[ownerID]
	attention := &sdkWorkCommentAttention{OwnerSessionID: ownerID, CommentIDs: []string{}}
	for _, update := range item.Updates {
		if !update.Comment {
			continue
		}
		if update.ID == cursor {
			attention.CommentIDs = attention.CommentIDs[:0]
			continue
		}
		attention.CommentIDs = append(attention.CommentIDs, update.ID)
		attention.LatestID = update.ID
	}
	attention.Count = len(attention.CommentIDs)
	if attention.Count == 0 {
		return nil
	}
	return attention
}

func workCommentIndex(item *sdkWorkItem, id string) int {
	for index, update := range item.Updates {
		if update.Comment && update.ID == id {
			return index
		}
	}
	return -1
}

// Caller holds h.mu. A notice is valid only for the current, working owner.
func (h *sdkChatHost) workCommentNoticeEligibleLocked(workID, ownerID, anchorID string) bool {
	item := h.workItems[workID]
	if item == nil || item.Status != "active" || item.OwnerSessionID != ownerID || item.Readiness == "held" || item.CommentNotice == nil || item.CommentNotice.OwnerSessionID != ownerID || item.CommentNotice.AnchorID != anchorID || item.CommentNotice.State != "pending" || workCommentAttention(item, ownerID) == nil {
		return false
	}
	chat := h.chats[ownerID]
	if chat == nil || chat.Archived || chat.State != "working" {
		return false
	}
	for _, projectID := range h.workProjectIDsLocked(item) {
		if project := h.projects[projectID]; project != nil && project.WorkPaused {
			return false
		}
	}
	return true
}

func (s *Server) deliverWorkCommentNotice(ctx context.Context, workID, ownerID, anchorID string) {
	content := fmt.Sprintf("Muxterm Work: Work item %s has unread comments. Read them with get_work_item or read_work_comments, then acknowledge with acknowledge_work_comments. Comment ID: %s.", workID, anchorID)
	body, _ := json.Marshal(map[string]string{"clientRef": "work-comment:" + workID + ":" + ownerID + ":" + anchorID, "content": content})
	request := httptest.NewRequestWithContext(context.WithValue(ctx, sdkWorkCommentNoticeContextKey{}, sdkWorkCommentNotice{OwnerSessionID: ownerID, AnchorID: anchorID}), http.MethodPost, "/api/sdk-chats/"+ownerID+"/control-send", bytes.NewReader(body))
	request.SetPathValue("id", ownerID)
	request = request.WithContext(context.WithValue(request.Context(), sdkWorkKickoffContextKey{}, workID))
	response := httptest.NewRecorder()
	s.handleSDKControlSend(response, request)
	state := "uncertain"
	if response.Code == http.StatusAccepted || response.Code == http.StatusOK {
		var receipt sdkControlReceipt
		if json.Unmarshal(response.Body.Bytes(), &receipt) == nil && receipt.Status == "accepted" {
			state = "sent"
		}
	} else if response.Code == http.StatusConflict || response.Code == http.StatusForbidden {
		state = "deferred"
	}
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[workID]
	if item != nil && item.CommentNotice != nil && item.CommentNotice.OwnerSessionID == ownerID && item.CommentNotice.AnchorID == anchorID && item.CommentNotice.State == "pending" {
		copy := *item
		notice := *item.CommentNotice
		notice.State = state
		notice.At = time.Now().UTC()
		copy.CommentNotice = &notice
		if state == "sent" && copy.CommentBoundary != nil && copy.CommentBoundary.OwnerSessionID == ownerID {
			attention := workCommentAttention(item, ownerID)
			if attention == nil || workCommentIndex(item, attention.LatestID) <= workCommentIndex(item, anchorID) {
				copy.CommentBoundary = nil
			} else {
				copy.CommentBoundary = &sdkWorkCommentNotice{OwnerSessionID: ownerID, AnchorID: attention.LatestID, State: "pending", At: time.Now().UTC()}
			}
		}
		copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: "work-comment-notice:" + anchorID, At: notice.At, Actor: sdkWorkActor{Kind: "external-tool"}, Summary: "High-priority comment notification " + state, Text: "Muxterm Work " + state + " a check-comments steer to the current owner.", CommentNoticeState: state})
		copy.Revision++
		copy.UpdatedAt = notice.At
		_ = h.saveWorkLocked(&copy)
	}
	h.mu.Unlock()
}

func (s *Server) handleSDKWorkCommentsUnread(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[r.PathValue("id")]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	actor := h.requestWorkActorLocked(r)
	if (actor.Kind == "chat" || actor.Kind == "remote-chat") && actor.SessionID != item.OwnerSessionID {
		h.mu.Unlock()
		http.Error(w, "only the current owner can read its unread comments", http.StatusForbidden)
		return
	}
	attention := workCommentAttention(item, item.OwnerSessionID)
	comments := []sdkWorkUpdate{}
	if attention != nil {
		for _, update := range item.Updates {
			if slices.Contains(attention.CommentIDs, update.ID) {
				comments = append(comments, update)
			}
		}
	}
	h.mu.Unlock()
	writeSDKJSON(w, http.StatusOK, map[string]any{"workId": item.ID, "ownerSessionId": item.OwnerSessionID, "attention": attention, "comments": comments})
}

func (s *Server) handleSDKWorkCommentsAcknowledge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ClientRef        string `json:"clientRef"`
		ThroughCommentID string `json:"throughCommentId"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req) != nil || strings.TrimSpace(req.ClientRef) == "" || strings.TrimSpace(req.ThroughCommentID) == "" {
		http.Error(w, "clientRef and throughCommentId required", http.StatusBadRequest)
		return
	}
	h := s.sdkChats
	h.mu.Lock()
	item := h.workItems[r.PathValue("id")]
	if item == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	actor := h.requestWorkActorLocked(r)
	for _, update := range item.Updates {
		if update.ClientRef != req.ClientRef {
			continue
		}
		if update.CommentReadThrough != req.ThroughCommentID || update.Actor != actor {
			h.mu.Unlock()
			http.Error(w, "clientRef already used", http.StatusConflict)
			return
		}
		copy := *item
		if actor.Kind == "human" || actor.Kind == "external-tool" || actor.SessionID == item.OwnerSessionID {
			copy.CommentAttention = workCommentAttention(item, item.OwnerSessionID)
		}
		h.mu.Unlock()
		writeSDKJSON(w, http.StatusOK, copy)
		return
	}
	if (actor.Kind == "chat" || actor.Kind == "remote-chat") && actor.SessionID != item.OwnerSessionID {
		h.mu.Unlock()
		http.Error(w, "only the current owner can acknowledge comments", http.StatusForbidden)
		return
	}
	if item.OwnerSessionID == "" {
		h.mu.Unlock()
		http.Error(w, "work has no owner", http.StatusConflict)
		return
	}
	through := workCommentIndex(item, req.ThroughCommentID)
	if through < 0 {
		h.mu.Unlock()
		http.Error(w, "unknown comment ID", http.StatusBadRequest)
		return
	}
	current := workCommentIndex(item, item.CommentReadBy[item.OwnerSessionID])
	if through < current {
		h.mu.Unlock()
		http.Error(w, "comment cursor cannot move backward", http.StatusConflict)
		return
	}
	copy := *item
	copy.CommentReadBy = make(map[string]string, len(item.CommentReadBy)+1)
	for key, value := range item.CommentReadBy {
		copy.CommentReadBy[key] = value
	}
	copy.CommentReadBy[item.OwnerSessionID] = req.ThroughCommentID
	if copy.CommentNotice != nil && copy.CommentNotice.OwnerSessionID == item.OwnerSessionID && workCommentIndex(item, copy.CommentNotice.AnchorID) <= through {
		copy.CommentNotice = nil
	}
	if attention := workCommentAttention(&copy, item.OwnerSessionID); attention == nil {
		copy.CommentBoundary = nil
	} else if copy.CommentBoundary != nil && copy.CommentBoundary.OwnerSessionID == item.OwnerSessionID && workCommentIndex(item, copy.CommentBoundary.AnchorID) <= through {
		copy.CommentBoundary = &sdkWorkCommentNotice{OwnerSessionID: item.OwnerSessionID, AnchorID: attention.LatestID, State: "pending", At: time.Now().UTC()}
	}
	copy.Updates = append(slices.Clone(item.Updates), sdkWorkUpdate{ID: sdkID(), ClientRef: req.ClientRef, At: time.Now().UTC(), Actor: actor, Summary: "Comments marked read", Text: "Acknowledged Work comments through " + req.ThroughCommentID, CommentReadThrough: req.ThroughCommentID})
	copy.Revision++
	copy.UpdatedAt = time.Now().UTC()
	if err := h.saveWorkLocked(&copy); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	response := copy
	response.CommentAttention = workCommentAttention(&copy, item.OwnerSessionID)
	h.mu.Unlock()
	writeSDKJSON(w, http.StatusOK, response)
}
