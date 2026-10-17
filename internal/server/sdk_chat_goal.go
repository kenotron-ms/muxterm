package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

type goalControlContextKey struct{}

type goalRequestError struct {
	status  int
	message string
}

func (err *goalRequestError) Error() string {
	return err.message
}

func (h *sdkChatHost) directGoalOperatorsLocked(id string) []string {
	operators := []string{}
	for _, candidate := range h.chats {
		if candidate.Operator && slices.Contains(candidate.OperatorLanes, id) {
			operators = append(operators, candidate.ID)
		}
	}
	slices.Sort(operators)
	return operators
}

func humanBrowserRequest(r *http.Request) bool {
	if r.Header.Get("X-Muxterm-Agent") != "" || r.Header.Get("Authorization") != "" {
		return false
	}
	if r.URL.Path == "/ws" && r.Header.Get("Sec-WebSocket-Key") != "" {
		origin, err := url.Parse(r.Header.Get("Origin"))
		return err == nil && origin.Host == r.Host && (origin.Scheme == "http" || origin.Scheme == "https")
	}
	return r.Header.Get("Sec-Fetch-Site") == "same-origin"
}

func (s *Server) handleGoalLedger(w http.ResponseWriter, r *http.Request) {
	if !humanBrowserRequest(r) {
		http.Error(w, "shared ledger requires a human browser; use scoped goal reads", 403)
		return
	}
	documents, err := s.sdkChats.goals.documents()
	if err != nil {
		http.Error(w, err.Error(), 503)
		return
	}
	s.sdkChats.mu.Lock()
	for index := range documents {
		documents[index].OperatorID = ""
		if operators := s.sdkChats.directGoalOperatorsLocked(documents[index].ChatID); len(operators) > 0 {
			documents[index].OperatorID = operators[0]
		}
	}
	s.sdkChats.mu.Unlock()
	writeSDKJSON(w, 200, documents)
}

func (s *Server) handleSDKGoal(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	id := r.PathValue("id")
	h.mu.Lock()
	current := h.chats[id]
	if current == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	chat := *current
	operatorID := ""
	operatorIDs := h.directGoalOperatorsLocked(id)
	if len(operatorIDs) > 0 {
		operatorID = operatorIDs[0]
	}
	h.mu.Unlock()
	if r.Method == http.MethodGet {
		document, err := h.goals.update(chat, nil)
		if err != nil {
			http.Error(w, err.Error(), 503)
			return
		}
		if document.Gap == "" {
			document.Gap = goalCapabilityGap(chat.Harness)
		}
		document.OperatorID = operatorID
		writeSDKJSON(w, 200, document)
		return
	}
	var req struct {
		Action          string   `json:"action"`
		Objective       string   `json:"objective"`
		ClientRef       string   `json:"clientRef"`
		ExpectedVersion *int     `json:"expectedVersion"`
		Evidence        []string `json:"evidence"`
		ProposalID      string   `json:"proposalId"`
		StartBy         string   `json:"startBy"`
	}
	if json.NewDecoder(io.LimitReader(r.Body, 32<<10)).Decode(&req) != nil || req.ClientRef == "" || len(req.ClientRef) > 200 || req.ExpectedVersion == nil {
		http.Error(w, "action, clientRef and expectedVersion are required", 400)
		return
	}
	human := humanBrowserRequest(r)
	actor := "human-browser"
	if human {
		actor = "human-browser:local-auth-bypass"
		if s.noAuth {
			actor = "human-browser:development-no-auth"
		}
		if cookie, err := r.Cookie(SessionCookieName); err == nil && s.authSrv != nil {
			if info, err := s.authSrv.Manager().LoadAccessToken(r.Context(), cookie.Value); err == nil {
				actor = "human:" + info.GetUserID()
			}
		}
	}
	if !human {
		h.mu.Lock()
		origin, valid := h.controlOriginLocked(r.Header.Get("X-Muxterm-Origin"), id)
		h.mu.Unlock()
		if !valid || origin.Type != "chat-message" || (origin.ChatID != id && origin.Relation != "operator-to-lane") {
			http.Error(w, "goal control requires a human browser or owner/direct operator capability", 403)
			return
		}
		actor = origin.ChatID
		if req.Action == "evidence" && origin.ChatID != id {
			http.Error(w, "agents can report evidence only for their own goal", 403)
			return
		}
		if req.Action == "set" || req.Action == "approve" || req.Action == "authorize" || req.Action == "revoke" {
			http.Error(w, "only a human may set or revise the stop condition", 403)
			return
		}
	}
	objective := strings.TrimSpace(req.Objective)
	if req.Action == "set" && (objective == "" || len([]rune(objective)) > 4000) {
		http.Error(w, "goal must contain 1 to 4000 characters", 400)
		return
	}
	if req.Action != "set" && req.Action != "pause" && req.Action != "resume" && req.Action != "clear" && req.Action != "evidence" && req.Action != "propose" && req.Action != "approve" && req.Action != "authorize" && req.Action != "revoke" && req.Action != "start" {
		http.Error(w, "unknown goal action", 400)
		return
	}
	if req.StartBy != "" && req.StartBy != "human" && req.StartBy != "operator" {
		http.Error(w, "startBy must be human or operator", 400)
		return
	}
	if req.Action == "propose" && (objective == "" || len([]rune(objective)) > 4000) {
		http.Error(w, "a proposal requires a condition of 1 to 4000 characters", 400)
		return
	}
	var admitted bool
	nativeAction := req.Action
	if len(req.Evidence) > 32 || len(objective) > 16000 {
		http.Error(w, "report is too large", 400)
		return
	}
	for _, reference := range req.Evidence {
		if len(reference) > 2000 {
			http.Error(w, "evidence reference is too large", 400)
			return
		}
	}
	document, err := h.goals.update(chat, func(document *goalDocument) error {
		for _, receipt := range document.Receipts {
			if receipt.ID == req.ClientRef {
				if receipt.Actor != actor || receipt.Action != req.Action || (req.Action != "approve" && receipt.Objective != objective) || receipt.ProposalID != req.ProposalID || receipt.StartBy != req.StartBy || !slices.Equal(receipt.Evidence, req.Evidence) {
					return &goalRequestError{http.StatusBadRequest, "clientRef already used for another request"}
				}
				return nil
			}
		}
		if document.ControlVersion != *req.ExpectedVersion {
			return errGoalConflict
		}
		if document.HumanPaused && !human && (req.Action == "resume" || req.Action == "start") {
			return &goalRequestError{http.StatusForbidden, "only a human can release a human pause"}
		}
		if (req.Action == "pause" || req.Action == "resume" || req.Action == "clear" || req.Action == "start" || req.Action == "authorize") && document.RequestedRevision == 0 {
			return &goalRequestError{http.StatusBadRequest, "no human goal is set"}
		}
		for _, receipt := range document.Receipts {
			if receipt.Status == "dispatching" {
				return &goalRequestError{http.StatusLocked, "native control acknowledgement is still pending; inspect ledger"}
			}
		}
		if req.Action == "approve" {
			found := false
			for index := range document.Receipts {
				proposal := &document.Receipts[index]
				if proposal.ID == req.ProposalID && proposal.Action == "propose" && proposal.Status == "recorded" {
					objective = proposal.Objective
					proposal.Status = "approved"
					found = true
					break
				}
			}
			if !found {
				return &goalRequestError{http.StatusNotFound, "pending proposal not found"}
			}
		}
		if req.Action == "set" || req.Action == "approve" {
			document.RequestedRevision++
			document.Revisions = append(document.Revisions, goalRevision{Revision: document.RequestedRevision, Condition: objective, Provenance: actor, At: time.Now().UTC()})
			document.Policy.OperatorStart = nil
			document.AgentPauseRevision = 0
		}
		if req.Action == "revoke" {
			document.Policy.OperatorStart = nil
		}
		if req.Action == "authorize" || (req.Action == "approve" && req.StartBy == "operator") {
			if operatorID == "" {
				return &goalRequestError{http.StatusBadRequest, "link a direct operator before authorizing a start"}
			}
			document.Policy.OperatorStart = &goalStartAuthorization{OperatorID: operatorID, Revision: document.RequestedRevision, GrantedBy: actor}
		}
		if req.Action == "start" || req.Action == "resume" {
			if !human && (req.Action == "start" || document.AgentPauseRevision != document.RequestedRevision || document.ExecutionAuthorizedRevision != document.RequestedRevision) {
				grant := document.Policy.OperatorStart
				if grant == nil || grant.OperatorID != actor || !slices.Contains(operatorIDs, actor) || grant.Revision != document.RequestedRevision || grant.ConsumedBy != "" {
					return &goalRequestError{http.StatusForbidden, "human authorization for this operator and revision is required"}
				}
				grant.ConsumedBy = req.ClientRef
			}
			document.ExecutionAuthorizedRevision = document.RequestedRevision
			document.AgentPauseRevision = 0
			nativeAction = "resume"
		}
		if human && req.Action == "pause" {
			document.HumanPaused = true
			document.Policy.OperatorStart = nil
		}
		if !human && req.Action == "pause" && slices.Contains([]string{"active", "continuing", "awaiting-native-observation"}, document.State) && document.ExecutionAuthorizedRevision == document.RequestedRevision {
			document.AgentPauseRevision = document.RequestedRevision
		}
		if req.Action == "clear" {
			document.AgentPauseRevision = 0
		}
		if human && (req.Action == "resume" || req.Action == "start" || (req.Action == "approve" && req.StartBy == "human")) {
			document.HumanPaused = false
		}
		document.OperatorID = operatorID
		document.ControlVersion++
		document.Gap = goalCapabilityGap(chat.Harness)
		status := "dispatching"
		if chat.Harness != "codex" && chat.Harness != "amplifier" && chat.Harness != "claude" {
			status = "unsupported"
		}
		if req.Action == "evidence" || req.Action == "propose" || req.Action == "authorize" || req.Action == "revoke" || (req.Action == "approve" && req.StartBy != "human") {
			status = "recorded"
		}
		if req.Action == "set" || (req.Action == "approve" && req.StartBy == "human") {
			document.ExecutionAuthorizedRevision = document.RequestedRevision
			if req.Action == "approve" {
				nativeAction = "resume"
			}
		}
		document.Receipts = append(document.Receipts, goalReceipt{ID: req.ClientRef, Action: req.Action, Objective: objective, Evidence: req.Evidence, Revision: document.RequestedRevision, Actor: actor, Status: status, ProposalID: req.ProposalID, StartBy: req.StartBy, At: time.Now().UTC()})
		admitted = status == "dispatching"
		return nil
	})
	if err != nil {
		status := http.StatusServiceUnavailable
		var rejection *goalRequestError
		if errors.As(err, &rejection) {
			status = rejection.status
		} else if errors.Is(err, errGoalConflict) {
			status = http.StatusConflict
		}
		http.Error(w, err.Error(), status)
		return
	}
	if admitted {
		condition := document.Revisions[len(document.Revisions)-1].Condition
		preserveStop := req.Action == "set" && document.RequestedRevision > 1 && slices.Contains([]string{"complete", "achieved", "stalled", "cap_hit", "cancelled", "error", "ended", "cleared", "uncertain"}, document.State)
		go h.dispatchGoal(chat, req.ClientRef, nativeAction, condition, document.HumanPaused || (document.State == "paused" && nativeAction != "resume") || preserveStop, document.RequestedRevision)
	}
	writeSDKJSON(w, http.StatusAccepted, document)
}

func (h *sdkChatHost) dispatchGoal(chat sdkChat, receiptID, action, objective string, paused bool, revision int) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, goalControlContextKey{}, true)
	err := h.resume(ctx, &chat)
	var result json.RawMessage
	if err == nil {
		result, err = h.call(ctx, "goal", map[string]any{"sessionId": chat.ID, "action": action, "objective": objective, "paused": paused, "revision": revision})
	}
	var native struct {
		Unsupported bool   `json:"unsupported"`
		Message     string `json:"message"`
	}
	if err == nil && len(result) > 0 {
		_ = json.Unmarshal(result, &native)
	}
	_, saveErr := h.goals.update(chat, func(document *goalDocument) error {
		for index := range document.Receipts {
			receipt := &document.Receipts[index]
			if receipt.ID != receiptID {
				continue
			}
			receipt.Status = "acknowledged"
			receipt.Native = result
			if native.Unsupported {
				receipt.Status = "unsupported"
				receipt.Detail = native.Message
				document.Gap = native.Message
			}
			if err != nil {
				receipt.Status = "uncertain"
				receipt.Detail = err.Error()
				document.Gap = "Native control unconfirmed: " + err.Error()
				document.State = "uncertain"
			}
		}
		return nil
	})
	if saveErr != nil {
		h.appendEvent(sdkEvent{SessionID: chat.ID, Type: "session.uncertain", Message: "Goal receipt persistence failed: " + saveErr.Error()})
	}
}
