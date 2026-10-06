package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type utilityPageBlock struct {
	ID           string `json:"id"`
	Type         string `json:"type"`
	Text         string `json:"text"`
	Checked      bool   `json:"checked,omitempty"`
	AttachmentID string `json:"attachmentId,omitempty"`
	ChildPageID  string `json:"childPageId,omitempty"`
}

type utilityPage struct {
	ID       string             `json:"id"`
	ParentID string             `json:"parentId,omitempty"`
	Title    string             `json:"title"`
	Blocks   []utilityPageBlock `json:"blocks"`
	// Content stores BlockNote's lossless document JSON; Blocks remains for older pages.
	Content json.RawMessage `json:"content,omitempty"`
}

type utilityPagesDocument struct {
	Version int64         `json:"version"`
	Pages   []utilityPage `json:"pages"`
}

func (s *Server) handleSDKUtilityPages(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.sdkChats.mu.Lock()
	defer s.sdkChats.mu.Unlock()
	if !safePageID(id) || s.sdkChats.chats[id] == nil {
		http.Error(w, "Chat not found", http.StatusNotFound)
		return
	}
	path := filepath.Join(sdkDataDir(), "pages", id+".json")
	if r.Method == http.MethodGet {
		data, err := os.ReadFile(path)
		if errors.Is(err, os.ErrNotExist) {
			writeJSON(w, http.StatusOK, utilityPagesDocument{Pages: []utilityPage{}})
			return
		}
		if err != nil {
			http.Error(w, "Cannot read pages", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(data)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		http.Error(w, "Pages too large", http.StatusRequestEntityTooLarge)
		return
	}
	var doc utilityPagesDocument
	if json.Unmarshal(data, &doc) != nil || len(doc.Pages) > 100 {
		http.Error(w, "Invalid pages", http.StatusBadRequest)
		return
	}
	current, err := readUtilityPages(path)
	if err != nil {
		http.Error(w, "Cannot read pages", http.StatusInternalServerError)
		return
	}
	if doc.Version != current.Version {
		http.Error(w, "Pages changed elsewhere; reload before saving", http.StatusConflict)
		return
	}
	seen := map[string]bool{}
	for _, page := range doc.Pages {
		if !safePageID(page.ID) || seen[page.ID] || len(page.Title) > 300 || len(page.Blocks) > 500 || (page.ParentID != "" && (!safePageID(page.ParentID) || page.ParentID == page.ID)) {
			http.Error(w, "Invalid page", http.StatusBadRequest)
			return
		}
		seen[page.ID] = true
		if len(page.Content) > 0 {
			var content []json.RawMessage
			if json.Unmarshal(page.Content, &content) != nil || len(content) > 500 {
				http.Error(w, "Invalid page content", http.StatusBadRequest)
				return
			}
		}
		blocks := map[string]bool{}
		for _, block := range page.Blocks {
			if !safePageID(block.ID) || blocks[block.ID] || len(block.Text) > 20000 || !validPageBlockType(block.Type) || (block.AttachmentID != "" && !safePageID(block.AttachmentID)) || (block.ChildPageID != "" && !safePageID(block.ChildPageID)) {
				http.Error(w, "Invalid block", http.StatusBadRequest)
				return
			}
			blocks[block.ID] = true
		}
	}
	for _, page := range doc.Pages {
		if page.ParentID != "" && !seen[page.ParentID] {
			http.Error(w, "Parent page not found", http.StatusBadRequest)
			return
		}
	}
	doc.Version++
	data, err = json.Marshal(doc)
	if err != nil || len(data) > 1<<20 {
		http.Error(w, "Pages too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err := writeUtilityPages(path, data); err != nil {
		http.Error(w, "Cannot save pages", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func readUtilityPages(path string) (utilityPagesDocument, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return utilityPagesDocument{Pages: []utilityPage{}}, nil
	}
	if err != nil {
		return utilityPagesDocument{}, err
	}
	var doc utilityPagesDocument
	if err := json.Unmarshal(data, &doc); err != nil {
		return utilityPagesDocument{}, err
	}
	return doc, nil
}

func writeUtilityPages(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".pages-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Chmod(0600)
	}
	if err == nil {
		err = tmp.Close()
	} else {
		_ = tmp.Close()
	}
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	return err
}

func safePageID(id string) bool {
	if len(id) < 1 || len(id) > 80 {
		return false
	}
	for _, ch := range id {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return false
		}
	}
	return !strings.HasPrefix(id, "-")
}

func validPageBlockType(kind string) bool {
	switch kind {
	case "text", "heading", "heading2", "heading3", "bullet", "numbered", "check", "code", "quote", "divider", "instructions", "image", "file", "page":
		return true
	default:
		return false
	}
}
