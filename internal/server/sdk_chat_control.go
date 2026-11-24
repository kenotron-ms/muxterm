package server

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// sdkControlReceipt is written before dispatch. A missing sidecar reply can
// never turn into a retry of the same input: only an input.accepted event can
// reconcile a dispatching receipt into accepted.
type sdkControlReceipt struct {
	SessionID string          `json:"sessionId"`
	ClientRef string          `json:"clientRef"`
	InputID   string          `json:"inputId"`
	Content   string          `json:"content"`
	Status    string          `json:"status"`
	Detail    string          `json:"detail,omitempty"`
	CreatedAt time.Time       `json:"createdAt"`
	Origin    *sdkEventOrigin `json:"origin,omitempty"`
	WorkID    string          `json:"workId,omitempty"` // Server-owned kickoff association.
}

type sdkWorkKickoffContextKey struct{}
type sdkWorkContinuationContextKey struct{}

func (h *sdkChatHost) controlPath(id, key string) string {
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(h.dir, "control", id, hex.EncodeToString(sum[:])+".json")
}

func (h *sdkChatHost) saveControlLocked(receipt sdkControlReceipt) error {
	path := h.controlPath(receipt.SessionID, receipt.ClientRef)
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return atomicfile.Write(path, data, 0600)
}

func (h *sdkChatHost) acceptedEventLocked(id, inputID string) bool {
	f, err := os.Open(filepath.Join(h.dir, id+".ndjson"))
	if err != nil {
		return false
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scan.Scan() {
		var event sdkEvent
		if json.Unmarshal(scan.Bytes(), &event) == nil && event.Type == "input.accepted" && event.InputID == inputID {
			return true
		}
	}
	return false
}

// A harness can acknowledge an input before its next model request. Work must
// not become protected while a peer input remains queued in that harness.
// Caller holds workSendMu, so no new control send can cross this file scan.
func (h *sdkChatHost) unresolvedPeerControlLocked(id string) (bool, error) {
	entries, err := os.ReadDir(filepath.Join(h.dir, "control", id))
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	accepted := map[string]bool{}
	open := map[string]bool{}
	terminal := map[string]bool{}
	f, err := os.Open(filepath.Join(h.dir, id+".ndjson"))
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	if err == nil {
		scan := bufio.NewScanner(f)
		scan.Buffer(make([]byte, 64*1024), 8*1024*1024)
		for scan.Scan() {
			var event sdkEvent
			if json.Unmarshal(scan.Bytes(), &event) != nil {
				continue
			}
			switch event.Type {
			case "input.accepted":
				accepted[event.InputID] = true
				open[event.InputID] = true
			case "turn.completed", "turn.cancelled":
				for _, inputID := range event.InputIDs {
					terminal[inputID] = true
					delete(open, inputID)
				}
			case "session.uncertain":
				// Sidecar failure does not replay accepted inputs. Some hosts
				// report the affected IDs; the supervisor reports the whole chat.
				if len(event.InputIDs) == 0 {
					for inputID := range open {
						terminal[inputID] = true
					}
					clear(open)
				} else {
					for _, inputID := range event.InputIDs {
						terminal[inputID] = true
						delete(open, inputID)
					}
				}
			}
		}
		err = scan.Err()
		_ = f.Close()
		if err != nil {
			return false, err
		}
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(h.dir, "control", id, entry.Name()))
		if err != nil {
			return false, err
		}
		var receipt sdkControlReceipt
		if err := json.Unmarshal(data, &receipt); err != nil {
			return false, err
		}
		if receipt.WorkID == "" && receipt.Origin != nil && receipt.Origin.Type == "chat-message" && receipt.Origin.ChatID != id && !terminal[receipt.InputID] {
			// A send whose three-minute sidecar call ended without any
			// acceptance event must not block Work ownership forever after
			// a crash between receipt persistence and dispatch.
			if !accepted[receipt.InputID] && receipt.Status != "accepted" && !receipt.CreatedAt.IsZero() && time.Since(receipt.CreatedAt) >= 4*time.Minute {
				continue
			}
			return true, nil
		}
	}
	return false, nil
}

// The capability is issued by the serve process to one harness MCP process.
// Tool arguments and message text cannot assert a chat identity or relation.
func (h *sdkChatHost) chatOriginToken(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.originTokens[id] == "" {
		token := sdkID() + sdkID()
		h.originTokens[id] = token
		h.originTokenChats[token] = id
	}
	return h.originTokens[id]
}

func (h *sdkChatHost) forgetChatOriginLocked(id string) {
	if token := h.originTokens[id]; token != "" {
		delete(h.originTokenChats, token)
		delete(h.originTokens, id)
	}
}

// A live chat capability may address any chat on this muxterm server. The
// origin relation describes the sender for display; goal controls
// enforce their own, narrower authority separately.
func (h *sdkChatHost) authorizedChatSenderLocked(token, targetID string) (string, bool) {
	if token == "" {
		return "", true // External local tools keep their existing auth path.
	}
	senderID := h.originTokenChats[token]
	sender := h.chats[senderID]
	target := h.chats[targetID]
	if sender == nil || target == nil || sender.Archived || h.originTokens[senderID] != token {
		return "", false
	}
	return senderID, true
}

func (h *sdkChatHost) controlOriginLocked(token, targetID string) (sdkEventOrigin, bool) {
	if token == "" {
		return sdkEventOrigin{Type: "external-tool", TargetChatID: targetID, Name: "External tool"}, true
	}
	sender := h.chats[h.originTokenChats[token]]
	if sender == nil {
		return sdkEventOrigin{}, false
	}
	return sdkEventOrigin{Type: "chat-message", ChatID: sender.ID, TargetChatID: targetID, Name: sender.Title, Harness: sender.Harness, Status: sender.State, Relation: "chat-to-chat"}, true
}

func (s *Server) handleSDKControlSend(w http.ResponseWriter, r *http.Request) {
	s.sdkChats.workSendMu.RLock()
	defer s.sdkChats.workSendMu.RUnlock()
	id := r.PathValue("id")
	adapterLock := s.sdkChats.adapterLock(id)
	adapterLock.Lock()
	defer adapterLock.Unlock()
	var req struct{ ClientRef, Content, OriginToken string }
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil ||
		strings.TrimSpace(req.ClientRef) == "" || strings.TrimSpace(req.Content) == "" || len(req.ClientRef) > 256 {
		http.Error(w, "clientRef and content required", 400)
		return
	}
	h := s.sdkChats
	workID, _ := r.Context().Value(sdkWorkKickoffContextKey{}).(string)
	continuationEventID, _ := r.Context().Value(sdkWorkContinuationContextKey{}).(string)
	workNotice, isWorkNotice := r.Context().Value(sdkWorkCommentNoticeContextKey{}).(sdkWorkCommentNotice)
	remoteSender := ""
	if s.remoteAgentChatRequest(r) {
		remoteSender = r.Header.Get("X-Muxterm-Remote-Origin-Chat")
		req.OriginToken = "" // The home capability cannot authenticate on this server.
	}
	if !humanBrowserRequest(r) {
		if remoteSender == "" && req.OriginToken != "" && req.OriginToken != r.Header.Get("X-Muxterm-Origin") {
			http.Error(w, "sender capability mismatch", http.StatusForbidden)
			return
		}
		req.OriginToken = r.Header.Get("X-Muxterm-Origin")
	}
	h.mu.Lock()
	originToken := r.Header.Get("X-Muxterm-Origin")
	if r.Header.Get("X-Muxterm-Agent") == "1" && originToken == "" && remoteSender == "" {
		h.mu.Unlock()
		http.Error(w, "chat capability required", http.StatusForbidden)
		return
	}
	originChatID, authorized := h.authorizedChatSenderLocked(originToken, id)
	if remoteSender != "" {
		originChatID, authorized = remoteSender, true
	}
	if !authorized {
		h.mu.Unlock()
		http.Error(w, "valid chat capability required", http.StatusForbidden)
		return
	}
	c := h.chats[id]
	if c == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	chat := *c
	if continuationEventID != "" && !h.workContinuationEligibleLocked(workID, id, continuationEventID) {
		h.mu.Unlock()
		http.Error(w, "Work continuation changed before admission", http.StatusConflict)
		return
	}
	if isWorkNotice && (workID == "" || !h.workCommentNoticeEligibleLocked(workID, id, workNotice.AnchorID)) {
		h.mu.Unlock()
		http.Error(w, "Work comment notice is no longer eligible", http.StatusConflict)
		return
	}
	if !humanBrowserRequest(r) {
		document, err := h.goals.update(chat, nil)
		if err != nil {
			h.mu.Unlock()
			http.Error(w, "goal ledger unavailable; agent send was not admitted", http.StatusServiceUnavailable)
			return
		}
		if document.HumanPaused {
			h.mu.Unlock()
			http.Error(w, "human pause held; agent sends cannot wake this goal", http.StatusForbidden)
			return
		}
	}
	// A missing token is an external tool input; an invalid token is rejected.
	// Only serve issues tokens that identify a sending chat.
	origin, valid := h.controlOriginLocked(req.OriginToken, id)
	if isWorkNotice {
		origin = sdkEventOrigin{Type: "work-comment", TargetChatID: id, Name: "Muxterm Work"}
		valid = true
	}
	if remoteSender != "" {
		origin = sdkEventOrigin{Type: "chat-message", ChatID: remoteSender, TargetChatID: id, Name: "Remote chat", Relation: "chat-to-chat"}
		valid = true
	}
	if !valid {
		h.mu.Unlock()
		http.Error(w, "invalid chat origin", http.StatusForbidden)
		return
	}
	path := h.controlPath(id, req.ClientRef)
	if data, err := os.ReadFile(path); err == nil {
		var prior sdkControlReceipt
		if json.Unmarshal(data, &prior) != nil || prior.ClientRef != req.ClientRef || prior.Content != req.Content || prior.WorkID != workID ||
			(prior.Origin == nil && req.OriginToken != "") ||
			(prior.Origin != nil && (prior.Origin.Type != origin.Type || prior.Origin.ChatID != origin.ChatID)) {
			h.mu.Unlock()
			http.Error(w, "clientRef already used with different content or invalid receipt", 409)
			return
		}
		if prior.Status != "accepted" && h.acceptedEventLocked(id, prior.InputID) {
			prior.Status, prior.Detail = "accepted", ""
			if err := h.saveControlLocked(prior); err != nil {
				h.mu.Unlock()
				http.Error(w, "acceptance proved but receipt persistence failed: "+err.Error(), 500)
				return
			}
		}
		if prior.Status != "accepted" {
			prior.Status = "uncertain"
			prior.Detail = "acceptance unconfirmed; input was not retried"
		}
		h.mu.Unlock()
		writeSDKJSON(w, 200, prior)
		return
	} else if !os.IsNotExist(err) {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	if workID == "" && h.protectedWorkOwnerLocked(id) && (remoteSender != "" || originChatID != id) && !humanBrowserRequest(r) {
		h.mu.Unlock()
		http.Error(w, "active Work owner is protected; read Work status or post a Work comment", http.StatusForbidden)
		return
	}
	// Resume before recording dispatch intent. A failed resume cannot have
	// submitted this input. Hold no mutex across the sidecar operation.
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	if err := h.resume(ctx, &chat); err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	h.mu.Lock()
	// A concurrent caller may have admitted the same key while resume ran.
	currentOrigin, stillAuthorized := h.authorizedChatSenderLocked(originToken, id)
	if remoteSender != "" {
		currentOrigin, stillAuthorized = remoteSender, s.remoteAgentChatRequest(r)
	}
	if !stillAuthorized || currentOrigin != originChatID {
		h.mu.Unlock()
		http.Error(w, "chat capability was revoked before dispatch", http.StatusForbidden)
		return
	}
	if continuationEventID != "" && !h.workContinuationEligibleLocked(workID, id, continuationEventID) {
		h.mu.Unlock()
		http.Error(w, "Work continuation changed before dispatch", http.StatusConflict)
		return
	}
	if workID == "" && h.protectedWorkOwnerLocked(id) && (remoteSender != "" || originChatID != id) && !humanBrowserRequest(r) {
		h.mu.Unlock()
		http.Error(w, "active Work owner is protected; read Work status or post a Work comment", http.StatusForbidden)
		return
	}
	if isWorkNotice && !h.workCommentNoticeEligibleLocked(workID, id, workNotice.AnchorID) {
		h.mu.Unlock()
		http.Error(w, "Work comment notice is no longer eligible", http.StatusConflict)
		return
	}
	if _, err := os.Stat(path); err == nil {
		h.mu.Unlock()
		http.Error(w, "clientRef admitted concurrently; query the same key again", 409)
		return
	}
	receipt := sdkControlReceipt{SessionID: id, ClientRef: req.ClientRef, InputID: sdkID(), Content: req.Content, WorkID: workID,
		Status: "dispatching", CreatedAt: time.Now().UTC(), Origin: &origin}
	if err := h.saveInputOrigin(id, receipt.InputID, origin); err != nil {
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	if err := h.saveControlLocked(receipt); err != nil {
		_ = os.Remove(h.controlPath(id, "input-origin:"+receipt.InputID))
		h.mu.Unlock()
		http.Error(w, err.Error(), 500)
		return
	}
	h.mu.Unlock()
	kind := "user"
	if chat.State == "working" {
		kind = "steer"
	}
	voiceContext := ""
	if s.voiceProvider() != "" {
		voiceContext = h.recentVoiceContext(id)
	}
	content := sdkTaskInputWithVoiceContext(req.Content, voiceContext)
	var boundaryTokens []sdkWorkBoundaryToken
	if kind == "user" {
		var notice string
		notice, boundaryTokens = h.pendingWorkBoundaryNotice(id)
		content += notice
	}
	source := "chat-message"
	if isWorkNotice {
		source = "work-comment"
	}
	result, err := h.call(ctx, "send", map[string]any{"sessionId": id,
		"input": map[string]any{"kind": kind, "source": source, "id": receipt.InputID,
			"content": content, "displayContent": req.Content}})
	var ack struct{ Status, InputID string }
	if err == nil {
		err = json.Unmarshal(result, &ack)
	}
	if err == nil && (ack.Status != "accepted" || ack.InputID != receipt.InputID) {
		err = fmt.Errorf("sidecar did not confirm input acceptance")
	}
	if err == nil {
		h.markWorkBoundaryNotices(boundaryTokens)
	}
	h.mu.Lock()
	if err != nil {
		receipt.Status, receipt.Detail = "uncertain", "acceptance unconfirmed: "+err.Error()+"; input was not retried"
	} else {
		receipt.Status = "accepted"
	}
	saveErr := h.saveControlLocked(receipt)
	h.mu.Unlock()
	if saveErr != nil {
		http.Error(w, "acceptance outcome uncertain: receipt persistence failed: "+saveErr.Error(), 500)
		return
	}
	writeSDKJSON(w, 202, receipt)
}

func (s *Server) handleSDKControlHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h := s.sdkChats
	h.mu.Lock()
	c := h.chats[id]
	var chat sdkChat
	if c != nil {
		chat = *c
	}
	h.mu.Unlock()
	if c == nil {
		http.NotFound(w, r)
		return
	}
	data, err := os.ReadFile(filepath.Join(h.dir, id+".ndjson"))
	if err != nil && !os.IsNotExist(err) {
		http.Error(w, err.Error(), 500)
		return
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	events := make([]sdkEvent, 0, min(len(lines), 200))
	milestones := make([]sdkEvent, 0, min(len(lines), 100))
	var output strings.Builder
	for _, line := range lines {
		var event sdkEvent
		if json.Unmarshal([]byte(line), &event) != nil {
			continue
		}
		if event.Type == "assistant.delta" {
			output.WriteString(event.Text)
		}
		if event.Type == "input.accepted" || event.Type == "input.delivered" || event.Type == "goal.progress" || event.Type == "turn.completed" || event.Type == "turn.cancelled" || event.Type == "error" || event.Type == "session.uncertain" {
			milestones = append(milestones, event)
		}
		if event.Type == "input.accepted" || event.Type == "input.delivered" || event.Type == "assistant.delta" || event.Type == "tool.started" || event.Type == "tool.completed" || event.Type == "goal.progress" || event.Type == "turn.continued" || event.Type == "turn.completed" || event.Type == "turn.cancelled" || event.Type == "error" || event.Type == "session.uncertain" {
			events = append(events, event)
		}
	}
	if len(events) > 200 {
		events = events[len(events)-200:]
	}
	if len(milestones) > 100 {
		milestones = milestones[len(milestones)-100:]
	}
	writeSDKJSON(w, 200, map[string]any{"session": chat, "events": events, "milestones": milestones, "recentOutput": sdkTail(output.String(), 8000)})
}
