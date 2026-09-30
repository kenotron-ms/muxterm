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
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(line) > 0 {
			events = append(events, json.RawMessage(line))
		}
	}
	writeSDKJSON(w, http.StatusOK, map[string]any{"from": start, "to": end, "hasMore": start > 0, "events": events})
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
