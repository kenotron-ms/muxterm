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
	SessionID string    `json:"sessionId"`
	ClientRef string    `json:"clientRef"`
	InputID   string    `json:"inputId"`
	Content   string    `json:"content"`
	Status    string    `json:"status"`
	Detail    string    `json:"detail,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

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

func (s *Server) handleSDKControlSend(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var req struct{ ClientRef, Content string }
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil ||
		strings.TrimSpace(req.ClientRef) == "" || strings.TrimSpace(req.Content) == "" || len(req.ClientRef) > 256 {
		http.Error(w, "clientRef and content required", 400)
		return
	}
	h := s.sdkChats
	h.mu.Lock()
	c := h.chats[id]
	if c == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	chat := *c
	path := h.controlPath(id, req.ClientRef)
	if data, err := os.ReadFile(path); err == nil {
		var prior sdkControlReceipt
		if json.Unmarshal(data, &prior) != nil || prior.ClientRef != req.ClientRef || prior.Content != req.Content {
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
	if _, err := os.Stat(path); err == nil {
		h.mu.Unlock()
		http.Error(w, "clientRef admitted concurrently; query the same key again", 409)
		return
	}
	receipt := sdkControlReceipt{SessionID: id, ClientRef: req.ClientRef, InputID: sdkID(), Content: req.Content,
		Status: "dispatching", CreatedAt: time.Now().UTC()}
	if err := h.saveControlLocked(receipt); err != nil {
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
	if s.sdkVoice != nil {
		voiceContext = h.recentVoiceContext(id)
	}
	content := h.operatorInput(id, sdkTaskInputWithVoiceContext(req.Content, voiceContext))
	result, err := h.call(ctx, "send", map[string]any{"sessionId": id,
		"input": map[string]any{"kind": kind, "source": "user", "id": receipt.InputID,
			"content": content, "displayContent": req.Content}})
	var ack struct{ Status, InputID string }
	if err == nil {
		err = json.Unmarshal(result, &ack)
	}
	if err == nil && (ack.Status != "accepted" || ack.InputID != receipt.InputID) {
		err = fmt.Errorf("sidecar did not confirm input acceptance")
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
