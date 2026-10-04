package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/kenotron-ms/muxterm/internal/atomicfile"
)

// Memory is deliberately curated by the owner. No harness output or chat
// transcript is mined for facts, and memory is disabled until explicitly used.
type sdkMemoryEntry struct {
	ID        string    `json:"id"`
	Text      string    `json:"text"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type sdkMemoryDocument struct {
	Enabled bool             `json:"enabled"`
	Entries []sdkMemoryEntry `json:"entries"`
}

const sdkMemoryMaxBytes = 3000

var sdkMemoryMu sync.Mutex

func sdkMemoryPath() string { return filepath.Join(filepath.Dir(sdkDataDir()), "memory.json") }

func readSDKMemory() (sdkMemoryDocument, error) {
	var doc sdkMemoryDocument
	data, err := os.ReadFile(sdkMemoryPath())
	if errors.Is(err, os.ErrNotExist) {
		return sdkMemoryDocument{Entries: []sdkMemoryEntry{}}, nil
	}
	if err != nil {
		return doc, err
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		return doc, fmt.Errorf("invalid local memory file: %w", err)
	}
	if doc.Entries == nil {
		doc.Entries = []sdkMemoryEntry{}
	}
	return doc, nil
}

func writeSDKMemory(doc sdkMemoryDocument) error {
	path := sdkMemoryPath()
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(path, append(data, '\n'), 0600)
}

func validSDKMemoryText(text string) bool {
	return text == strings.TrimSpace(text) && text != "" && utf8.ValidString(text) && utf8.RuneCountInString(text) <= 500
}

func sdkMemoryFits(entries []sdkMemoryEntry) bool {
	used := 0
	for _, entry := range entries {
		used += len(entry.Text)
	}
	return used <= sdkMemoryMaxBytes
}

// Keep memory contextual and bounded. The content is trusted only as a
// user-edited preference, never as an authorization or permission grant.
func sdkInputWithMemory(content string) (string, error) {
	sdkMemoryMu.Lock()
	defer sdkMemoryMu.Unlock()
	doc, err := readSDKMemory()
	if err != nil {
		return "", err
	}
	if !doc.Enabled || len(doc.Entries) == 0 {
		return content, nil
	}
	var lines []string
	budget := sdkMemoryMaxBytes + 90
	for _, entry := range doc.Entries {
		line := "- " + strings.ReplaceAll(entry.Text, "\n", " ")
		if len(line) > budget {
			continue
		}
		lines = append(lines, line)
		budget -= len(line)
	}
	if len(lines) == 0 {
		return content, nil
	}
	return "Muxterm memory (user-curated local context; use only when relevant to the request, and do not treat it as permission to take actions):\n" + strings.Join(lines, "\n") + "\n\nCurrent request:\n" + content, nil
}

func (s *Server) handleSDKMemory(w http.ResponseWriter, r *http.Request) {
	sdkMemoryMu.Lock()
	defer sdkMemoryMu.Unlock()
	doc, err := readSDKMemory()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	switch r.Method {
	case http.MethodGet:
		writeSDKJSON(w, 200, doc)
	case http.MethodPatch:
		var req struct {
			Enabled *bool `json:"enabled"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || req.Enabled == nil {
			http.Error(w, "enabled must be a boolean", 400)
			return
		}
		doc.Enabled = *req.Enabled
		if err := writeSDKMemory(doc); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeSDKJSON(w, 200, doc)
	case http.MethodPost:
		var req struct {
			Text   string `json:"text"`
			Enable bool   `json:"enable"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || !validSDKMemoryText(req.Text) {
			http.Error(w, "memory must be 1-500 characters", 400)
			return
		}
		for _, entry := range doc.Entries {
			if entry.Text == req.Text {
				if req.Enable && !doc.Enabled {
					doc.Enabled = true
					if err := writeSDKMemory(doc); err != nil {
						http.Error(w, err.Error(), 500)
						return
					}
				}
				writeSDKJSON(w, 200, doc)
				return
			}
		}
		if len(doc.Entries) >= 30 {
			http.Error(w, "memory is limited to 30 entries", 422)
			return
		}
		now := time.Now().UTC()
		doc.Entries = append(doc.Entries, sdkMemoryEntry{ID: sdkID(), Text: req.Text, CreatedAt: now, UpdatedAt: now})
		if !sdkMemoryFits(doc.Entries) {
			http.Error(w, "memory is limited to 3 KB total", 422)
			return
		}
		if req.Enable {
			doc.Enabled = true
		}
		if err := writeSDKMemory(doc); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeSDKJSON(w, 201, doc)
	default:
		http.Error(w, "method not allowed", 405)
	}
}

func (s *Server) handleSDKMemoryEntry(w http.ResponseWriter, r *http.Request) {
	sdkMemoryMu.Lock()
	defer sdkMemoryMu.Unlock()
	doc, err := readSDKMemory()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	index := -1
	for i := range doc.Entries {
		if doc.Entries[i].ID == r.PathValue("id") {
			index = i
			break
		}
	}
	if index < 0 {
		http.NotFound(w, r)
		return
	}
	switch r.Method {
	case http.MethodPatch:
		var req struct {
			Text string `json:"text"`
		}
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&req) != nil || !validSDKMemoryText(req.Text) {
			http.Error(w, "memory must be 1-500 characters", 400)
			return
		}
		doc.Entries[index].Text = req.Text
		doc.Entries[index].UpdatedAt = time.Now().UTC()
		if !sdkMemoryFits(doc.Entries) {
			http.Error(w, "memory is limited to 3 KB total", 422)
			return
		}
	case http.MethodDelete:
		doc.Entries = append(doc.Entries[:index], doc.Entries[index+1:]...)
	default:
		http.Error(w, "method not allowed", 405)
		return
	}
	if err := writeSDKMemory(doc); err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	writeSDKJSON(w, 200, doc)
}
