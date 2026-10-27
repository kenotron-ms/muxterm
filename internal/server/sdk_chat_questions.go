package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// A Codex question is answered on its resident app-server request. The answer
// is never copied into the chat event journal, including for secret questions.
func (s *Server) handleSDKChatQuestion(w http.ResponseWriter, r *http.Request) {
	id, questionID := r.PathValue("id"), r.PathValue("questionId")
	if len(questionID) == 0 || len(questionID) > 128 {
		http.Error(w, "invalid question", http.StatusBadRequest)
		return
	}
	h := s.sdkChats
	h.mu.Lock()
	chat := h.chats[id]
	h.mu.Unlock()
	if chat == nil {
		http.NotFound(w, r)
		return
	}
	if chat.Harness != "codex" {
		http.Error(w, "questions are unavailable for this agent", http.StatusConflict)
		return
	}
	var request struct {
		Answers map[string]string `json:"answers"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&request); err != nil || len(request.Answers) == 0 || len(request.Answers) > 3 {
		http.Error(w, "invalid answers", http.StatusBadRequest)
		return
	}
	for key, value := range request.Answers {
		if key == "" || len(key) > 128 || strings.TrimSpace(value) == "" || len(value) > 4096 {
			http.Error(w, "invalid answers", http.StatusBadRequest)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	result, err := h.call(ctx, "answerQuestion", map[string]any{"sessionId": id, "questionId": questionID, "answers": request.Answers})
	if err != nil {
		if strings.Contains(err.Error(), "no longer waiting") || strings.Contains(err.Error(), "not resident") || strings.Contains(err.Error(), "no pending Codex question") {
			http.Error(w, "This question is no longer active", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeSDKJSON(w, http.StatusOK, result)
}
