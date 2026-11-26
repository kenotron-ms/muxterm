package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
		if !valid || origin.Type != "chat-message" || origin.ChatID != id {
			http.Error(w, "goal control requires a human browser or owner chat capability", 403)
			return
		}
		actor = origin.ChatID
		if req.Action == "evidence" && origin.ChatID != id {
			http.Error(w, "agents can report evidence only for their own goal", 403)
			return
		}
		if req.Action == "set" || req.Action == "approve" {
			http.Error(w, "only a human may set or revise the stop condition", 403)
			return
		}
	}
	objective := strings.TrimSpace(req.Objective)
	if req.Action == "set" && (objective == "" || len([]rune(objective)) > 4000) {
		http.Error(w, "goal must contain 1 to 4000 characters", 400)
		return
	}
	if req.Action != "set" && req.Action != "pause" && req.Action != "resume" && req.Action != "clear" && req.Action != "evidence" && req.Action != "propose" && req.Action != "approve" && req.Action != "start" {
		http.Error(w, "unknown goal action", 400)
		return
	}
	currentGoal, err := h.goals.update(chat, nil)
	if err != nil {
		http.Error(w, "goal ledger unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	workOwned := chat.Harness == "opencode" && currentGoal.Mode == "muxterm-work"
	if workOwned {
		// Control sends hold the read side through admission. A human pause
		// waits for in-flight admission, then closes the gate before another
		// Work continuation can enter the adapter.
		h.workSendMu.Lock()
		defer h.workSendMu.Unlock()
	}
	if workOwned && slices.Contains([]string{"set", "approve"}, req.Action) {
		http.Error(w, "Muxterm-owned Work goal conditions are filed on the Work record", http.StatusConflict)
		return
	}
	if !supportsNativeGoalControl(chat.Harness) && !workOwned && slices.Contains([]string{"set", "approve", "start", "pause", "resume", "clear"}, req.Action) {
		http.Error(w, goalCapabilityGap(chat.Harness), http.StatusUnprocessableEntity)
		return
	}
	if req.StartBy != "" && req.StartBy != "human" {
		http.Error(w, "startBy must be human", 400)
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
		if (req.Action == "pause" || req.Action == "resume" || req.Action == "clear" || req.Action == "start") && document.RequestedRevision == 0 {
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
			document.AgentPauseRevision = 0
		}
		if req.Action == "start" || req.Action == "resume" {
			if !human && (req.Action == "start" || document.AgentPauseRevision != document.RequestedRevision || document.ExecutionAuthorizedRevision != document.RequestedRevision) {
				return &goalRequestError{http.StatusForbidden, "only a human may start or resume this goal"}
			}
			document.ExecutionAuthorizedRevision = document.RequestedRevision
			document.AgentPauseRevision = 0
			nativeAction = "resume"
		}
		if human && req.Action == "pause" {
			document.HumanPaused = true
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
		document.ControlVersion++
		if document.Mode != "muxterm-work" {
			document.Gap = goalCapabilityGap(chat.Harness)
		}
		status := "dispatching"
		if !supportsNativeGoalControl(chat.Harness) && document.Mode != "muxterm-work" {
			status = "unsupported"
		}
		if req.Action == "evidence" || req.Action == "propose" {
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
		// A new human /goal command retries a blocked native goal. Setting only
		// the condition leaves Codex's blocked status intact.
		if req.Action == "set" && document.State == "blocked" && !document.HumanPaused {
			nativeAction = "resume"
		}
		preserveStop := req.Action == "set" && document.RequestedRevision > 1 && slices.Contains([]string{"complete", "achieved", "stalled", "cap_hit", "cancelled", "error", "ended", "cleared", "uncertain"}, document.State)
		go h.dispatchGoal(chat, req.ClientRef, nativeAction, condition, document.HumanPaused || (document.State == "paused" && nativeAction != "resume") || preserveStop, document.RequestedRevision, document.ControlVersion)
	}
	writeSDKJSON(w, http.StatusAccepted, document)
}

func (h *sdkChatHost) waitForCopilotIdle(ctx context.Context, chatID string) error {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	var lastErr error
	for {
		h.mu.Lock()
		running := h.running
		chat := h.chats[chatID]
		locallyActive := chat != nil && (chat.State == "working" || chat.State == "starting")
		h.mu.Unlock()
		if !running {
			if !locallyActive {
				return nil
			}
		} else {
			checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			busy, err := h.sharedBusy(checkCtx)
			cancel()
			if err == nil {
				if !slices.Contains(busy, chatID) {
					return nil
				}
			} else {
				lastErr = err
			}
		}
		select {
		case <-ctx.Done():
			if lastErr != nil {
				return fmt.Errorf("Copilot turn did not reach a safe boundary; native goal control was not sent because idleness could not be confirmed: %v: %w", lastErr, ctx.Err())
			}
			return fmt.Errorf("Copilot turn did not reach a safe boundary; native goal control was not sent: %w", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (h *sdkChatHost) dispatchGoal(chat sdkChat, receiptID, action, objective string, paused bool, revision, controlVersion int) {
	h.goalDispatch.mu.Lock()
	if h.goalDispatch.closed {
		h.goalDispatch.mu.Unlock()
		return
	}
	h.goalDispatch.wg.Add(1)
	h.goalDispatch.mu.Unlock()
	defer h.goalDispatch.wg.Done()
	if chat.Harness == "opencode" {
		if document, err := h.goals.update(chat, nil); err == nil && document.Mode == "muxterm-work" {
			h.dispatchMuxtermWorkGoal(chat, receiptID, action, objective, revision, controlVersion)
			return
		}
	}
	ctx, cancel := context.WithTimeout(h.goalDispatch.ctx, 45*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, goalControlContextKey{}, true)
	var err error
	if chat.Harness == "copilot" && action != "pause" {
		err = h.waitForCopilotIdle(ctx, chat.ID)
	}
	if err == nil {
		err = h.resume(ctx, &chat)
	}
	var result json.RawMessage
	if err == nil {
		result, err = h.call(ctx, "goal", map[string]any{"sessionId": chat.ID, "action": action, "objective": objective, "paused": paused, "revision": revision, "goalControlVersion": controlVersion})
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
