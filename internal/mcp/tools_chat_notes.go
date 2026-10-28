package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Notes use the existing Pages document as a compatibility store. Existing
// Page IDs and BlockNote content remain readable and editable as Notes.
func registerChatNoteTools(srv *Server) {
	pt := newPublishTools()
	notePath := func(args map[string]any) (string, error) {
		if err := refuseRemote(args, chatLocalOnly); err != nil {
			return "", err
		}
		chatID, err := argString(args, "session_id")
		if err != nil {
			return "", err
		}
		return "/api/sdk-chats/" + url.PathEscape(chatID) + "/utility/pages", nil
	}
	type document struct {
		Version int64            `json:"version"`
		Pages   []map[string]any `json:"pages"`
	}
	load := func(path string) (document, error) {
		body, err := pt.doRequest(http.MethodGet, path, nil)
		if err != nil {
			return document{}, err
		}
		var doc document
		if err := json.Unmarshal(body, &doc); err != nil {
			return document{}, err
		}
		if doc.Pages == nil {
			doc.Pages = []map[string]any{}
		}
		return doc, nil
	}
	controlPath := func(path string) string { return strings.TrimSuffix(path, "/utility/pages") + "/control-notes" }
	find := func(doc document, id string) map[string]any {
		for _, note := range doc.Pages {
			if note["id"] == id {
				return note
			}
		}
		return nil
	}
	baseProps := map[string]any{"session_id": map[string]any{"type": "string", "description": "Owning Chat ID"}}
	withID := func() map[string]any {
		return withMachine(map[string]any{"session_id": baseProps["session_id"], "note_id": map[string]any{"type": "string", "description": "Stable Note ID"}})
	}
	srv.Register("list_chat_notes", "List and search Notes in a Chat, including existing Pages as compatible Notes. Returns stable IDs, titles, timestamps, revisions, and document version. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": baseProps["session_id"], "query": map[string]any{"type": "string", "description": "Optional title or body search"}}), "required": []string{"session_id"}},
		func(args map[string]any) (string, error) {
			path, err := notePath(args)
			if err != nil {
				return "", err
			}
			doc, err := load(path)
			if err != nil {
				return "", err
			}
			query, _, err := argStringOptional(args, "query")
			if err != nil {
				return "", err
			}
			query = strings.ToLower(strings.TrimSpace(query))
			notes := make([]map[string]any, 0, len(doc.Pages))
			for _, note := range doc.Pages {
				content, _ := json.Marshal(note["content"])
				blocks, _ := json.Marshal(note["blocks"])
				if query != "" && !strings.Contains(strings.ToLower(fmt.Sprint(note["title"])), query) && !strings.Contains(strings.ToLower(string(content)), query) && !strings.Contains(strings.ToLower(string(blocks)), query) {
					continue
				}
				notes = append(notes, map[string]any{"id": note["id"], "title": note["title"], "parentId": note["parentId"], "createdAt": note["createdAt"], "updatedAt": note["updatedAt"], "revision": note["revision"]})
			}
			result, _ := json.Marshal(map[string]any{"version": doc.Version, "notes": notes})
			return string(result), nil
		})
	srv.Register("read_chat_note", "Read one Note by stable ID, including its native BlockNote content and document version. Existing Pages are readable as Notes. Local machine only.",
		map[string]any{"type": "object", "properties": withID(), "required": []string{"session_id", "note_id"}},
		func(args map[string]any) (string, error) {
			path, err := notePath(args)
			if err != nil {
				return "", err
			}
			id, err := argString(args, "note_id")
			if err != nil {
				return "", err
			}
			doc, err := load(path)
			if err != nil {
				return "", err
			}
			note := find(doc, id)
			if note == nil {
				return "", fmt.Errorf("note %q not found", id)
			}
			result, _ := json.Marshal(map[string]any{"version": doc.Version, "note": note})
			return string(result), nil
		})
	srv.Register("create_chat_note", "Create a chat-linked editable Note. Does not navigate the browser or steal focus. Body is plain text. Returns the stored document and stable ID. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": baseProps["session_id"], "title": map[string]any{"type": "string"}, "body": map[string]any{"type": "string"}}), "required": []string{"session_id", "title"}},
		func(args map[string]any) (string, error) {
			path, err := notePath(args)
			if err != nil {
				return "", err
			}
			title, err := argString(args, "title")
			if err != nil {
				return "", err
			}
			body, _, err := argStringOptional(args, "body")
			if err != nil {
				return "", err
			}
			payload, _ := json.Marshal(map[string]any{"title": title, "body": body})
			result, err := pt.doRequest(http.MethodPost, controlPath(path), payload)
			if err != nil {
				return "", fmt.Errorf("create_chat_note: %w", err)
			}
			return string(result), nil
		})
	srv.Register("replace_chat_note", "Replace a Note title and plain-text body at an expected document version. A stale version refuses with conflict, preserving the other edit. Does not navigate. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": baseProps["session_id"], "note_id": map[string]any{"type": "string"}, "expected_version": map[string]any{"type": "integer"}, "title": map[string]any{"type": "string"}, "body": map[string]any{"type": "string"}}), "required": []string{"session_id", "note_id", "expected_version", "body"}},
		func(args map[string]any) (string, error) {
			path, err := notePath(args)
			if err != nil {
				return "", err
			}
			id, err := argString(args, "note_id")
			if err != nil {
				return "", err
			}
			body, err := argString(args, "body")
			if err != nil {
				return "", err
			}
			version, err := argInt(args, "expected_version")
			if err != nil || version < 0 {
				return "", fmt.Errorf("expected_version must be a nonnegative integer")
			}
			payload := map[string]any{"expectedVersion": version, "body": body}
			if title, present, err := argStringOptional(args, "title"); err != nil {
				return "", err
			} else if present {
				payload["title"] = title
			}
			encoded, _ := json.Marshal(payload)
			result, err := pt.doRequest(http.MethodPut, controlPath(path)+"/"+url.PathEscape(id), encoded)
			return string(result), err
		})
	srv.Register("append_chat_note", "Append Markdown to a Note without navigating the browser. Preserves its existing BlockNote content and reports the new document version. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{"session_id": baseProps["session_id"], "note_id": map[string]any{"type": "string"}, "markdown": map[string]any{"type": "string"}}), "required": []string{"session_id", "note_id", "markdown"}},
		func(args map[string]any) (string, error) {
			path, err := notePath(args)
			if err != nil {
				return "", err
			}
			id, err := argString(args, "note_id")
			if err != nil {
				return "", err
			}
			markdown, err := argString(args, "markdown")
			if err != nil {
				return "", err
			}
			body, _ := json.Marshal(map[string]string{"markdown": markdown})
			result, err := pt.doRequest(http.MethodPost, controlPath(path)+"/"+url.PathEscape(id)+"/append", body)
			if err != nil {
				return "", fmt.Errorf("append_chat_note: %w", err)
			}
			return string(result), nil
		})
}
