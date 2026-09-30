package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const sdkHistoryPageSize = 150

// Event-log byte offsets are stable cursors because the log is append-only.
// Reading backward avoids scanning an entire long conversation to open its tail.
func sdkPageStart(file *os.File, end int64, limit int) (int64, error) {
	position, newlines := end, 0
	buf := make([]byte, 64<<10)
	for position > 0 {
		start := position - int64(len(buf))
		if start < 0 {
			start = 0
		}
		n, err := file.ReadAt(buf[:position-start], start)
		if err != nil && !errors.Is(err, io.EOF) {
			return 0, err
		}
		for i := n - 1; i >= 0; i-- {
			absolute := start + int64(i)
			if absolute == end-1 {
				continue
			} // final line terminator
			if buf[i] == '\n' {
				newlines++
				if newlines == limit {
					return absolute + 1, nil
				}
			}
		}
		position = start
	}
	return 0, nil
}

func (s *Server) handleSDKChatHistory(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h := s.sdkChats
	h.mu.Lock()
	_, exists := h.chats[id]
	h.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(filepath.Join(h.dir, id+".ndjson"))
	if errors.Is(err, os.ErrNotExist) {
		writeSDKJSON(w, http.StatusOK, map[string]any{"from": 0, "to": 0, "hasMore": false, "events": []json.RawMessage{}})
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer file.Close()
	h.mu.Lock()
	info, err := file.Stat()
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	end := info.Size()
	if value := r.URL.Query().Get("before"); value != "" {
		end, err = strconv.ParseInt(value, 10, 64)
		if err != nil || end < 0 || end > info.Size() {
			http.Error(w, "invalid history cursor", 400)
			return
		}
		if end > 0 && end < info.Size() {
			var previous [1]byte
			if _, err := file.ReadAt(previous[:], end-1); err != nil || previous[0] != '\n' {
				http.Error(w, "history cursor is not line aligned", 400)
				return
			}
		}
	}
	view := r.URL.Query().Get("view")
	if view != "" && view != "messages" {
		http.Error(w, "invalid history view", 400)
		return
	}
	start, err := sdkPageStart(file, end, sdkHistoryPageSize)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	data := make([]byte, end-start)
	if _, err := file.ReadAt(data, start); err != nil && !errors.Is(err, io.EOF) {
		http.Error(w, err.Error(), 500)
		return
	}
	events := make([]json.RawMessage, 0, sdkHistoryPageSize)
	var assistant *sdkEvent
	flushAssistant := func() {
		if assistant == nil {
			return
		}
		encoded, _ := json.Marshal(assistant)
		events = append(events, encoded)
		assistant = nil
	}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(line) == 0 {
			continue
		}
		if view != "messages" {
			events = append(events, json.RawMessage(line))
			continue
		}
		var header struct {
			SessionID      string    `json:"sessionId"`
			At             time.Time `json:"at"`
			Type           string    `json:"type"`
			Text           string    `json:"text"`
			Name           string    `json:"name"`
			ToolID         string    `json:"toolId"`
			ChildSessionID string    `json:"childSessionId"`
			Kind           string    `json:"kind"`
			Failed         bool      `json:"failed"`
		}
		if err := json.Unmarshal(line, &header); err != nil {
			http.Error(w, "invalid history event", 500)
			return
		}
		if !sdkMessageHistoryEvent(header.Type) {
			continue
		}
		if header.Type == "assistant.delta" {
			if assistant == nil {
				assistant = &sdkEvent{SessionID: header.SessionID, At: header.At, Type: header.Type}
			}
			assistant.Text += header.Text
			continue
		}
		flushAssistant()
		if header.Type == "tool.started" || header.Type == "tool.completed" || header.Type == "delegate.step" {
			encoded, _ := json.Marshal(struct {
				SessionID      string    `json:"sessionId"`
				At             time.Time `json:"at"`
				Type           string    `json:"type"`
				Name           string    `json:"name"`
				ToolID         string    `json:"toolId"`
				ChildSessionID string    `json:"childSessionId,omitempty"`
				Kind           string    `json:"kind,omitempty"`
				Failed         bool      `json:"failed"`
				Summary        bool      `json:"summary"`
			}{header.SessionID, header.At, header.Type, header.Name, header.ToolID, header.ChildSessionID, header.Kind, header.Failed, true})
			events = append(events, encoded)
		} else {
			events = append(events, json.RawMessage(line))
		}
	}
	flushAssistant()
	writeSDKJSON(w, http.StatusOK, map[string]any{"from": start, "to": end, "hasMore": start > 0, "events": events})
}

func sdkMessageHistoryEvent(eventType string) bool {
	switch eventType {
	case "input.accepted", "assistant.delta", "tool.started", "tool.completed", "turn.completed", "turn.cancelled", "turn.continued", "error", "session.uncertain", "goal.progress", "session.renamed", "delegate.spawned", "delegate.completed", "delegate.message", "delegate.step":
		return true
	default:
		return false
	}
}

// The chat opens at its recent tail. This small, separately fetched index keeps
// older delegated work discoverable without loading every transcript page.
func (s *Server) handleSDKChatAgents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	h := s.sdkChats
	h.mu.Lock()
	_, exists := h.chats[id]
	h.mu.Unlock()
	if !exists {
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(filepath.Join(h.dir, id+".ndjson"))
	if errors.Is(err, os.ErrNotExist) {
		writeSDKJSON(w, http.StatusOK, []sdkEvent{})
		return
	}
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	defer file.Close()
	h.mu.Lock()
	info, err := file.Stat()
	h.mu.Unlock()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	reader := bufio.NewReader(io.NewSectionReader(file, 0, info.Size()))
	candidates := make([]sdkEvent, 0)
	toolIDs := make(map[string]bool)
	for {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			var event sdkEvent
			if err := json.Unmarshal(line, &event); err != nil {
				http.Error(w, "invalid delegation history event", 500)
				return
			}
			if strings.HasPrefix(event.Type, "delegate.") {
				candidates = append(candidates, event)
				if event.Type == "delegate.spawned" && event.ToolID != "" {
					toolIDs[event.ToolID] = true
				}
			} else if event.Type == "tool.started" || event.Type == "tool.completed" {
				candidates = append(candidates, event)
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				http.Error(w, readErr.Error(), 500)
				return
			}
			break
		}
	}
	events := make([]sdkEvent, 0, len(candidates))
	for _, event := range candidates {
		if strings.HasPrefix(event.Type, "delegate.") || (toolIDs[event.ToolID] && event.ToolID != "") {
			events = append(events, event)
		}
	}
	writeSDKJSON(w, http.StatusOK, events)
}

// sdkStreamLog streams exactly the bytes after cursor. The subscriber is
// registered before the initial end offset is captured, so appends during
// setup are covered by either the replay or the channel notification.
func sdkStreamLog(w http.ResponseWriter, path string, cursor int64, end int64) (int64, error) {
	if cursor >= end {
		return cursor, nil
	}
	file, err := os.Open(path)
	if err != nil {
		return cursor, err
	}
	defer file.Close()
	reader := bufio.NewReader(io.NewSectionReader(file, cursor, end-cursor))
	for cursor < end {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return cursor, err
		}
		cursor += int64(len(line))
		line = bytes.TrimSuffix(line, []byte{'\n'})
		if len(line) > 0 {
			if _, err := fmt.Fprintf(w, "id: %d\nevent: sdk\ndata: %s\n\n", cursor, line); err != nil {
				return cursor, err
			}
		}
	}
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	return cursor, nil
}
