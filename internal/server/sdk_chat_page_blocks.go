package server

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"path/filepath"
	"strings"
)

type pageChartPoint struct {
	Label  string  `json:"label"`
	Value  float64 `json:"value"`
	Detail string  `json:"detail,omitempty"`
}

type pageVisualization struct {
	Title     string           `json:"title"`
	Caption   string           `json:"caption,omitempty"`
	ChartType string           `json:"chartType"`
	Points    []pageChartPoint `json:"points"`
}

type pageBlocksRequest struct {
	Markdown      string             `json:"markdown,omitempty"`
	Visualization *pageVisualization `json:"visualization,omitempty"`
}

// An atomic append endpoint lets an agent write one page without replacing
// other pages (or losing the browser's current document version).
func (s *Server) handleSDKPageBlocks(w http.ResponseWriter, r *http.Request) {
	chatID, pageID := r.PathValue("id"), r.PathValue("pageID")
	s.sdkChats.mu.Lock()
	defer s.sdkChats.mu.Unlock()
	if !safePageID(chatID) || s.sdkChats.chats[chatID] == nil || !safePageID(pageID) {
		http.Error(w, "Page not found", http.StatusNotFound)
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128<<10))
	if err != nil {
		http.Error(w, "Page update too large", http.StatusRequestEntityTooLarge)
		return
	}
	var input pageBlocksRequest
	if json.Unmarshal(data, &input) != nil || (input.Markdown == "") == (input.Visualization == nil) {
		http.Error(w, "Provide markdown or visualization", http.StatusBadRequest)
		return
	}
	var additions []map[string]any
	if input.Markdown != "" {
		if len(input.Markdown) > 100<<10 {
			http.Error(w, "Markdown too large", http.StatusRequestEntityTooLarge)
			return
		}
		additions = markdownPageBlocks(input.Markdown)
		if len(additions) == 0 {
			http.Error(w, "Markdown has no blocks", http.StatusBadRequest)
			return
		}
	} else {
		v := input.Visualization
		if len(v.Title) == 0 || len(v.Title) > 200 || len(v.Caption) > 2000 || (v.ChartType != "bar" && v.ChartType != "line") || len(v.Points) == 0 || len(v.Points) > 100 {
			http.Error(w, "Invalid visualization", http.StatusBadRequest)
			return
		}
		for _, p := range v.Points {
			if len(p.Label) == 0 || len(p.Label) > 100 || len(p.Detail) > 1000 || math.IsNaN(p.Value) || math.IsInf(p.Value, 0) {
				http.Error(w, "Invalid visualization point", http.StatusBadRequest)
				return
			}
		}
		points, _ := json.Marshal(v.Points)
		additions = []map[string]any{{"type": "visualization", "props": map[string]any{"title": v.Title, "caption": v.Caption, "chartType": v.ChartType, "points": string(points)}}}
	}
	path := filepath.Join(sdkDataDir(), "pages", chatID+".json")
	doc, err := readUtilityPages(path)
	if err != nil {
		http.Error(w, "Cannot read pages", http.StatusInternalServerError)
		return
	}
	var page *utilityPage
	for i := range doc.Pages {
		if doc.Pages[i].ID == pageID {
			page = &doc.Pages[i]
			break
		}
	}
	if page == nil {
		http.Error(w, "Page not found", http.StatusNotFound)
		return
	}
	var content []map[string]any
	if len(page.Content) > 0 && json.Unmarshal(page.Content, &content) != nil {
		http.Error(w, "Invalid stored page", http.StatusInternalServerError)
		return
	}
	if len(content) == 0 && len(page.Blocks) > 0 {
		content = legacyNativePageBlocks(page.Blocks)
	}
	if len(content) == 1 && blankNativePageBlock(content[0]) {
		content = nil
	}
	if len(content)+len(additions) > 500 {
		http.Error(w, "Page has too many blocks", http.StatusRequestEntityTooLarge)
		return
	}
	content = append(content, additions...)
	page.Content, err = json.Marshal(content)
	if err != nil {
		http.Error(w, "Cannot encode page", http.StatusInternalServerError)
		return
	}
	page.Blocks = []utilityPageBlock{}
	doc.Version++
	output, err := json.Marshal(doc)
	if err != nil || len(output) > 1<<20 {
		http.Error(w, "Pages too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err := writeUtilityPages(path, output); err != nil {
		http.Error(w, "Cannot save page", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"page_id": pageID, "version": doc.Version, "blocks_added": len(additions)})
}

func blankNativePageBlock(block map[string]any) bool {
	if block["type"] != "paragraph" {
		return false
	}
	content, exists := block["content"]
	if !exists || content == nil {
		return true
	}
	if str, ok := content.(string); ok {
		return strings.TrimSpace(str) == ""
	}
	if items, ok := content.([]any); ok {
		return len(items) == 0
	}
	return false
}

func legacyNativePageBlocks(blocks []utilityPageBlock) []map[string]any {
	out := make([]map[string]any, 0, len(blocks))
	for _, block := range blocks {
		typeName := "paragraph"
		props := map[string]any{}
		switch block.Type {
		case "heading", "heading2", "heading3":
			typeName = "heading"
			level := 1
			if block.Type == "heading2" {
				level = 2
			}
			if block.Type == "heading3" {
				level = 3
			}
			props["level"] = level
		case "bullet":
			typeName = "bulletListItem"
		case "numbered":
			typeName = "numberedListItem"
		case "check":
			typeName = "checkListItem"
			props["checked"] = block.Checked
		case "code":
			typeName = "codeBlock"
		case "quote":
			typeName = "quote"
		case "divider":
			typeName = "divider"
		case "image", "file":
			typeName = block.Type
			if block.AttachmentID != "" {
				props["url"] = "/api/sdk-chat-attachments/" + block.AttachmentID
			}
			props["caption"] = block.Text
		case "page":
			if block.ChildPageID != "" {
				out = append(out, map[string]any{"type": "paragraph", "content": []map[string]any{{"type": "link", "href": "#muxterm-page-" + block.ChildPageID, "content": "↗ " + block.Text}}})
				continue
			}
		}
		item := map[string]any{"type": typeName}
		if typeName != "divider" && typeName != "image" && typeName != "file" {
			item["content"] = block.Text
		}
		if len(props) > 0 {
			item["props"] = props
		}
		out = append(out, item)
	}
	return out
}
