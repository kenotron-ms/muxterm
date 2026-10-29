package server

import (
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

func plainNoteParagraph(value string) map[string]any {
	inline := []map[string]any{}
	if value != "" {
		inline = append(inline, map[string]any{"type": "text", "text": value, "styles": map[string]any{}})
	}
	return map[string]any{"type": "paragraph", "content": inline}
}

// Note controls are narrow, atomic mutations of the compatibility Pages store.
// The agent may use these routes without gaining whole-document Pages write access.
func (s *Server) handleSDKNoteControl(w http.ResponseWriter, r *http.Request) {
	chatID, noteID := r.PathValue("id"), r.PathValue("noteID")
	if !safePageID(chatID) || (noteID != "" && !safePageID(noteID)) {
		http.Error(w, "Note not found", http.StatusNotFound)
		return
	}
	s.sdkChats.mu.Lock()
	exists := s.sdkChats.chats[chatID] != nil
	if exists && !humanBrowserRequest(r) {
		token := r.Header.Get("X-Muxterm-Origin")
		origin, valid := s.sdkChats.controlOriginLocked(token, chatID)
		exists = token != "" && valid && (origin.ChatID == chatID || origin.Relation == "operator-to-lane" || origin.Relation == "lane-to-operator")
	}
	s.sdkChats.mu.Unlock()
	if !exists {
		http.Error(w, "Note capability unavailable", http.StatusForbidden)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128<<10))
	if err != nil {
		http.Error(w, "Note update too large", http.StatusRequestEntityTooLarge)
		return
	}
	var input struct {
		Title           *string `json:"title"`
		Body            *string `json:"body"`
		Markdown        *string `json:"markdown"`
		ExpectedVersion *int64  `json:"expectedVersion"`
	}
	if json.Unmarshal(data, &input) != nil {
		http.Error(w, "Invalid note update", http.StatusBadRequest)
		return
	}
	appendMode := strings.HasSuffix(r.URL.Path, "/append")
	if appendMode {
		if input.Markdown == nil || strings.TrimSpace(*input.Markdown) == "" || len(*input.Markdown) > 100<<10 {
			http.Error(w, "Provide markdown under 100 KB", http.StatusBadRequest)
			return
		}
	} else if input.Body == nil || len(*input.Body) > 100<<10 || (input.Title != nil && len(*input.Title) > 300) || (noteID == "" && (input.Title == nil || strings.TrimSpace(*input.Title) == "")) || (noteID != "" && (input.ExpectedVersion == nil || *input.ExpectedVersion < 0)) {
		http.Error(w, "Invalid note title, body, or expected version", http.StatusBadRequest)
		return
	}
	lock := s.pageDocumentLock(chatID)
	lock.Lock()
	defer lock.Unlock()
	path := filepath.Join(sdkDataDir(), "pages", chatID+".json")
	doc, err := readUtilityPages(path)
	if err != nil {
		http.Error(w, "Cannot read notes", http.StatusInternalServerError)
		return
	}
	var note *utilityPage
	for i := range doc.Pages {
		if doc.Pages[i].ID == noteID {
			note = &doc.Pages[i]
			break
		}
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if noteID == "" {
		if len(doc.Pages) >= 100 {
			http.Error(w, "Too many notes", http.StatusRequestEntityTooLarge)
			return
		}
		content, _ := json.Marshal([]map[string]any{plainNoteParagraph(*input.Body)})
		doc.Pages = append(doc.Pages, utilityPage{ID: sdkID(), Title: *input.Title, Blocks: []utilityPageBlock{}, Content: content, CreatedAt: now, UpdatedAt: now, Revision: 1})
		note = &doc.Pages[len(doc.Pages)-1]
	} else {
		if note == nil {
			http.Error(w, "Note not found", http.StatusNotFound)
			return
		}
		if !appendMode && doc.Version != *input.ExpectedVersion {
			http.Error(w, "Note changed elsewhere; reload before saving", http.StatusConflict)
			return
		}
		if appendMode {
			var content []map[string]any
			if len(note.Content) > 0 && json.Unmarshal(note.Content, &content) != nil {
				http.Error(w, "Invalid stored note", http.StatusInternalServerError)
				return
			}
			if len(content) == 0 && len(note.Blocks) > 0 {
				content = legacyNativePageBlocks(note.Blocks)
			}
			if len(content) == 1 && blankNativePageBlock(content[0]) {
				content = nil
			}
			additions := markdownPageBlocks(*input.Markdown)
			if len(additions) == 0 || len(content)+len(additions) > 500 {
				http.Error(w, "Invalid note blocks", http.StatusBadRequest)
				return
			}
			content = append(content, additions...)
			note.Content, err = json.Marshal(content)
		} else {
			if len(note.Blocks) > 0 {
				http.Error(w, "Rich note cannot be replaced as plain text; append instead", http.StatusConflict)
				return
			}
			if len(note.Content) > 0 {
				var blocks []map[string]json.RawMessage
				if json.Unmarshal(note.Content, &blocks) != nil || len(blocks) != 1 {
					http.Error(w, "Rich note cannot be replaced as plain text; append instead", http.StatusConflict)
					return
				}
				var kind string
				if json.Unmarshal(blocks[0]["type"], &kind) != nil || kind != "paragraph" || !plainNoteContent(blocks[0]["content"]) {
					http.Error(w, "Rich note cannot be replaced as plain text; append instead", http.StatusConflict)
					return
				}
			}
			if input.Title != nil {
				note.Title = *input.Title
			}
			note.Content, err = json.Marshal([]map[string]any{plainNoteParagraph(*input.Body)})
		}
		if err != nil {
			http.Error(w, "Cannot encode note", http.StatusInternalServerError)
			return
		}
		note.Blocks = []utilityPageBlock{}
		if note.CreatedAt == "" {
			note.CreatedAt = now
		}
		note.UpdatedAt = now
		note.Revision++
	}
	doc.Version++
	output, err := json.Marshal(doc)
	if err != nil || len(output) > 1<<20 {
		http.Error(w, "Notes too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err := writeUtilityPages(path, output); err != nil {
		http.Error(w, "Cannot save note", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"note_id": note.ID, "version": doc.Version, "note": note})
}

func plainNoteContent(content json.RawMessage) bool {
	var legacy string
	if json.Unmarshal(content, &legacy) == nil {
		return true
	}
	var inline []struct {
		Type   string         `json:"type"`
		Styles map[string]any `json:"styles"`
	}
	if json.Unmarshal(content, &inline) != nil || len(inline) > 1 {
		return false
	}
	return len(inline) == 0 || (inline[0].Type == "text" && len(inline[0].Styles) == 0)
}
