package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
)

// Page tools operate on BlockNote documents in the serve layer. Markdown is
// converted there to native blocks; charts are typed widgets, never HTML.
func registerChatPageTools(srv *Server) {
	pt := newPublishTools()
	pagePath := func(args map[string]any, includePage bool) (string, error) {
		if err := refuseRemote(args, chatLocalOnly); err != nil {
			return "", err
		}
		chatID, err := argString(args, "session_id")
		if err != nil {
			return "", err
		}
		path := "/api/sdk-chats/" + url.PathEscape(chatID) + "/utility/pages"
		if includePage {
			pageID, err := argString(args, "page_id")
			if err != nil {
				return "", err
			}
			path += "/" + url.PathEscape(pageID) + "/blocks"
		}
		return path, nil
	}
	srv.Register("get_chat_pages", "Read a Chat's Pages, including page IDs, titles, and native BlockNote document JSON. Use the page ID with the page writing tools. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": map[string]any{"type": "string", "description": "Chat ID"}}), "required": []string{"session_id"}},
		func(args map[string]any) (string, error) {
			path, err := pagePath(args, false)
			if err != nil {
				return "", err
			}
			body, err := pt.doRequest(http.MethodGet, path, nil)
			if err != nil {
				return "", err
			}
			return string(body), nil
		})
	srv.Register("delete_chat_page", "Delete a Chat Page and all of its subpages by page ID. This permanently removes their titles and content. Use get_chat_pages to find the page ID. Returns the updated Pages document. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"session_id": map[string]any{"type": "string", "description": "Chat ID"},
			"page_id":    map[string]any{"type": "string", "description": "Page ID to delete, including its subpages"},
		}), "required": []string{"session_id", "page_id"}},
		func(args map[string]any) (string, error) {
			path, err := pagePath(args, false)
			if err != nil {
				return "", err
			}
			pageID, err := argString(args, "page_id")
			if err != nil {
				return "", err
			}
			body, err := pt.doRequest(http.MethodGet, path, nil)
			if err != nil {
				return "", fmt.Errorf("delete_chat_page: %w", err)
			}
			var doc struct {
				Version int64             `json:"version"`
				Pages   []json.RawMessage `json:"pages"`
			}
			if err := json.Unmarshal(body, &doc); err != nil {
				return "", fmt.Errorf("delete_chat_page: invalid Pages document: %w", err)
			}
			type pageRef struct {
				ID       string `json:"id"`
				ParentID string `json:"parentId"`
			}
			refs := make([]pageRef, len(doc.Pages))
			found := false
			for i, page := range doc.Pages {
				if err := json.Unmarshal(page, &refs[i]); err != nil {
					return "", fmt.Errorf("delete_chat_page: invalid page: %w", err)
				}
				if refs[i].ID == pageID {
					found = true
				}
			}
			if !found {
				return "", fmt.Errorf("delete_chat_page: page %q not found", pageID)
			}
			deleted := map[string]bool{pageID: true}
			for changed := true; changed; {
				changed = false
				for _, page := range refs {
					if !deleted[page.ID] && deleted[page.ParentID] {
						deleted[page.ID] = true
						changed = true
					}
				}
			}
			kept := make([]json.RawMessage, 0, len(doc.Pages)-len(deleted))
			for i, page := range doc.Pages {
				if !deleted[refs[i].ID] {
					kept = append(kept, page)
				}
			}
			doc.Pages = kept
			payload, err := json.Marshal(doc)
			if err != nil {
				return "", fmt.Errorf("delete_chat_page: %w", err)
			}
			result, err := pt.doRequest(http.MethodPut, path, payload)
			if err != nil {
				return "", fmt.Errorf("delete_chat_page: %w", err)
			}
			return string(result), nil
		})
	srv.Register("append_page_markdown", "Convert Markdown to native BlockNote prose blocks and append them to an existing Chat Page. Supports headings, lists, quotes, code, links, and inline emphasis. Use get_chat_pages for page_id. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"session_id": map[string]any{"type": "string", "description": "Chat ID"},
			"page_id":    map[string]any{"type": "string", "description": "Page ID"},
			"markdown":   map[string]any{"type": "string", "description": "Markdown prose to append"},
		}), "required": []string{"session_id", "page_id", "markdown"}},
		func(args map[string]any) (string, error) {
			path, err := pagePath(args, true)
			if err != nil {
				return "", err
			}
			markdown, err := argString(args, "markdown")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]any{"markdown": markdown})
			result, err := pt.doRequest(http.MethodPost, path, body)
			if err != nil {
				return "", fmt.Errorf("append_page_markdown: %w", err)
			}
			return string(result), nil
		})
	srv.Register("add_page_visualization", "Append an interactive bar or line chart widget to an existing Chat Page. Provide a title and numeric points with labels; optional details appear when a point is selected. Store structured chart data, not HTML or JavaScript. Use get_chat_pages for page_id. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"session_id": map[string]any{"type": "string", "description": "Chat ID"},
			"page_id":    map[string]any{"type": "string", "description": "Page ID"},
			"title":      map[string]any{"type": "string"},
			"caption":    map[string]any{"type": "string"},
			"chart_type": map[string]any{"type": "string", "enum": []string{"bar", "line"}},
			"points":     map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{"label": map[string]any{"type": "string"}, "value": map[string]any{"type": "number"}, "detail": map[string]any{"type": "string"}}, "required": []string{"label", "value"}}},
		}), "required": []string{"session_id", "page_id", "title", "chart_type", "points"}},
		func(args map[string]any) (string, error) {
			path, err := pagePath(args, true)
			if err != nil {
				return "", err
			}
			title, err := argString(args, "title")
			if err != nil {
				return "", err
			}
			chartType, err := argString(args, "chart_type")
			if err != nil {
				return "", err
			}
			payload := map[string]any{"title": title, "chartType": chartType, "points": args["points"]}
			if caption, ok := args["caption"].(string); ok {
				payload["caption"] = caption
			}
			body, _ := json.Marshal(map[string]any{"visualization": payload})
			result, err := pt.doRequest(http.MethodPost, path, body)
			if err != nil {
				return "", fmt.Errorf("add_page_visualization: %w", err)
			}
			return string(result), nil
		})
}
