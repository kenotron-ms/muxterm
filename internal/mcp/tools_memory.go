package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const memoryLocalOnly = "memory belongs to this muxterm serve process; use a session on the target machine"

type memoryToolEntry struct {
	ID   string `json:"id"`
	Text string `json:"text"`
}

type memoryToolDocument struct {
	Enabled bool              `json:"enabled"`
	Entries []memoryToolEntry `json:"entries"`
}

// All SDK harnesses receive the same muxterm MCP server. These tools let a
// user explicitly ask a chat to remember or forget something. The app never
// extracts memories from transcripts or assistant output on its own.
func registerMemoryTools(srv *Server) {
	pt := newPublishTools()
	srv.Register("list_memory", "List the owner's local muxterm memories and whether they are enabled for future Chat turns. Read this when the user asks what is remembered or when you need an ID to forget a memory. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{})},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, memoryLocalOnly); err != nil {
				return "", err
			}
			body, err := pt.doRequest(http.MethodGet, "/api/memory", nil)
			if err != nil {
				return "", err
			}
			return string(body), nil
		})
	srv.Register("save_memory", "Save one concise fact or preference to the owner's local muxterm memory, shared across Codex, Claude and Amplifier Chats. Call ONLY when the user explicitly asks you to remember or save this information for future chats; never infer memories from ordinary conversation, tools, files or webpages. Saving also enables memory for future turns. Never save credentials, tokens or secrets. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"text": map[string]any{"type": "string", "description": "The specific fact or preference the user explicitly asked to remember; at most 500 characters. No secrets."},
		}), "required": []string{"text"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, memoryLocalOnly); err != nil {
				return "", err
			}
			value, err := argString(args, "text")
			if err != nil {
				return "", err
			}
			value = strings.TrimSpace(value)
			if value == "" {
				return "", fmt.Errorf("memory text required")
			}
			payload, _ := json.Marshal(map[string]any{"text": value, "enable": true})
			body, err := pt.doRequest(http.MethodPost, "/api/memory", payload)
			if err != nil {
				return "", err
			}
			var doc memoryToolDocument
			if err := json.Unmarshal(body, &doc); err != nil {
				return "", err
			}
			for _, entry := range doc.Entries {
				if entry.Text == value {
					return jsonText(map[string]any{"saved": entry, "enabled": doc.Enabled}), nil
				}
			}
			return "", fmt.Errorf("saved memory missing from server response")
		})
	srv.Register("forget_memory", "Delete one local muxterm memory by ID when the user explicitly asks you to forget it. Call list_memory to find the exact ID. Earlier chat transcripts can still contain previously supplied context. Local machine only.",
		map[string]any{"type": "object", "properties": withMachine(map[string]any{
			"id": map[string]any{"type": "string", "description": "Exact memory ID returned by list_memory"},
		}), "required": []string{"id"}},
		func(args map[string]any) (string, error) {
			if err := refuseRemote(args, memoryLocalOnly); err != nil {
				return "", err
			}
			id, err := argString(args, "id")
			if err != nil {
				return "", err
			}
			if len(id) != 32 {
				return "", fmt.Errorf("invalid memory ID")
			}
			body, err := pt.doRequest(http.MethodDelete, "/api/memory/"+url.PathEscape(id), nil)
			if err != nil {
				return "", err
			}
			var doc memoryToolDocument
			if err := json.Unmarshal(body, &doc); err != nil {
				return "", err
			}
			return jsonText(map[string]any{"forgotten": id, "enabled": doc.Enabled}), nil
		})
}
