package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// A branch owns a new native session. Its copied display history is immutable;
// the first real input supplies that history to the new harness as context.
func (s *Server) handleSDKChatBranch(w http.ResponseWriter, r *http.Request) {
	h := s.sdkChats
	h.mu.Lock()
	source := h.chats[r.PathValue("id")]
	if source == nil {
		h.mu.Unlock()
		http.NotFound(w, r)
		return
	}
	parent := *source
	h.mu.Unlock()
	if parent.State == "working" || parent.State == "starting" {
		http.Error(w, "wait for the current turn to finish before branching", http.StatusConflict)
		return
	}
	if parent.Goal != "" || parent.Operator {
		http.Error(w, "branching is unavailable for managed chats", http.StatusUnprocessableEntity)
		return
	}
	var req struct {
		Mode, InputID, Content string
		Turn                   int
		Attachments            []string
	}
	if json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req) != nil || req.Turn < 0 || (req.Mode != "fork" && req.Mode != "edit") {
		http.Error(w, "invalid branch request", http.StatusBadRequest)
		return
	}
	if req.Mode == "edit" && (req.InputID == "" || strings.TrimSpace(req.Content) == "") {
		http.Error(w, "edited message is required", http.StatusBadRequest)
		return
	}
	attachments, err := s.resolveSDKAttachments(req.Attachments)
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnprocessableEntity)
		return
	}
	file, err := os.Open(filepath.Join(h.dir, parent.ID+".ndjson"))
	if err != nil {
		http.Error(w, "chat history is unavailable", http.StatusUnprocessableEntity)
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	var copied []sdkEvent
	var contextRows []string
	var turnEvents []sdkEvent
	completed := 0
	found := false
	var selectedUser bool
	var selectedAssistant bool
	addTurn := func(events []sdkEvent) {
		var userRows []sdkEvent
		var answer string
		var answerAt time.Time
		for _, event := range events {
			switch event.Type {
			case "input.accepted":
				if event.Kind == "user" || event.Kind == "steer" {
					userRows = append(userRows, event)
				}
			case "tool.started":
				answer = ""
			case "assistant.delta":
				answer += event.Text
				answerAt = event.At
			}
		}
		for _, event := range userRows {
			copied = append(copied, sdkEvent{Type: "input.accepted", At: event.At, Kind: event.Kind, Source: event.Source, InputID: event.InputID, Text: event.Text, Attachments: event.Attachments})
			line := "User: " + event.Text
			for _, attachment := range event.Attachments {
				line += "\n[Attachment: " + attachment.Name + "]"
			}
			contextRows = append(contextRows, line)
		}
		if answer != "" {
			copied = append(copied, sdkEvent{Type: "assistant.delta", At: answerAt, Text: answer})
			contextRows = append(contextRows, "Assistant: "+answer)
		}
		copied = append(copied, sdkEvent{Type: "turn.completed", At: events[len(events)-1].At})
		if completed == req.Turn {
			selectedAssistant = answer != ""
		}
	}
	for scanner.Scan() {
		var event sdkEvent
		if json.Unmarshal(scanner.Bytes(), &event) != nil {
			http.Error(w, "chat history is damaged", http.StatusUnprocessableEntity)
			return
		}
		if req.Mode == "edit" && completed == req.Turn && event.Type == "input.accepted" && event.Kind == "user" && event.InputID == req.InputID {
			selectedUser = true
		}
		turnEvents = append(turnEvents, event)
		if event.Type == "turn.cancelled" || event.Type == "error" || event.Type == "session.uncertain" {
			if completed == req.Turn {
				break
			}
			completed++
			turnEvents = nil
			continue
		}
		if event.Type != "turn.completed" {
			continue
		}
		if completed < req.Turn || (completed == req.Turn && req.Mode == "fork") {
			addTurn(turnEvents)
		}
		if completed == req.Turn {
			found = true
			break
		}
		completed++
		turnEvents = nil
	}
	if err := scanner.Err(); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if !found || (req.Mode == "fork" && !selectedAssistant) || (req.Mode == "edit" && !selectedUser) {
		http.Error(w, "selected message is no longer available as a completed turn", http.StatusConflict)
		return
	}
	contextText := "This is the prior conversation. Treat it as the history of this chat. Continue from its last message.\n\n" + strings.Join(contextRows, "\n\n")
	if len(contextText) > 1<<20 {
		http.Error(w, "conversation is too long to branch safely", http.StatusUnprocessableEntity)
		return
	}
	chat := &sdkChat{ID: sdkID(), WorkspaceID: parent.WorkspaceID, ProjectPath: parent.ProjectPath, SourceFolders: parent.SourceFolders,
		Title: parent.Title + " (branch)", TitleSource: "manual", Harness: parent.Harness, Provider: parent.Provider, Approval: "never",
		Model: parent.Model, Effort: parent.Effort, Permission: parent.Permission, Mode: parent.Mode, Bundle: parent.Bundle,
		State: "ready", WorkMode: parent.WorkMode, CreatedAt: time.Now().UTC(), BranchContext: contextText, BranchPending: true}
	if err := h.ensure(chat.Harness); err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	var lines []byte
	for _, event := range copied {
		event.SessionID = chat.ID
		line, _ := json.Marshal(event)
		lines = append(lines, line...)
		lines = append(lines, '\n')
	}
	h.mu.Lock()
	h.chats[chat.ID] = chat
	err = h.saveLocked(chat)
	if err == nil {
		err = os.WriteFile(filepath.Join(h.dir, chat.ID+".ndjson"), lines, 0600)
	}
	if err == nil {
		err = os.WriteFile(filepath.Join(h.dir, chat.ID+".branch-context"), []byte(contextText), 0600)
	}
	if err != nil {
		delete(h.chats, chat.ID)
		_ = os.Remove(filepath.Join(h.dir, chat.ID+".json"))
		_ = os.Remove(filepath.Join(h.dir, chat.ID+".ndjson"))
		_ = os.Remove(filepath.Join(h.dir, chat.ID+".branch-context"))
	} else {
		h.notifyCatalogLocked(chat.ID)
	}
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if req.Mode == "edit" {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
		defer cancel()
		if err = h.resume(ctx, chat); err == nil {
			var result json.RawMessage
			result, err = h.call(ctx, "send", map[string]any{"sessionId": chat.ID, "input": map[string]any{
				"kind": "user", "source": "browser", "id": sdkID(), "content": contextText + "\n\nContinue this conversation with the user's revised message:\n" + strings.TrimSpace(req.Content), "displayContent": strings.TrimSpace(req.Content), "attachments": attachments,
			}})
			if err == nil {
				var ack struct{ Status string }
				if json.Unmarshal(result, &ack) != nil || ack.Status != "accepted" {
					err = errors.New("harness did not confirm the revised message")
				}
			}
		}
		if err != nil {
			http.Error(w, fmt.Sprintf("branch %s was created but revised message was not accepted: %v", chat.ID, err), http.StatusBadGateway)
			return
		}
	}
	writeSDKJSON(w, http.StatusCreated, chat)
}
